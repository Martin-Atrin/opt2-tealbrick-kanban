// The owner board: one project at a time, six fixed columns, cards with the agent's name and status. Dragging a card
// to another column is `board_issue_update {status}` through the person session (keyboard: open the card, pick the
// column). Goals and recent activity sit next to the board.
import { useAgents, useScopes } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { type DragEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  type Activity,
  type Agent,
  type BoardData,
  COLUMNS,
  errorText,
  type Issue,
  type IssueDetail,
  PRIORITIES,
  type Priority,
  type Project,
  run,
  STATUS_LABEL,
  type Status,
  when,
} from "./api.ts";

const REFRESH_MS = 15_000;

export function useBoard(project: string | null) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    run("board_view", project ? { project } : {})
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [project]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);
  return { data, error, reload };
}

/** Active agents, plus `keep` (an issue's current assignee that has left the workspace) so it still shows. */
function assigneeOptions(agents: Agent[], keep?: string) {
  return [
    { value: "", label: "Nobody" },
    { value: "owner", label: "Me (owner)" },
    ...agents.filter((a) => a.active || a.id === keep).map((a) => ({ value: a.id, label: a.active ? a.name : `${a.name} (left)` })),
  ];
}
const priorityTone = (p: Priority) => (p === "high" ? "action" : "neutral");

function Card({ issue, onOpen }: { issue: Issue; onOpen: () => void }) {
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData("text/x-kanban-issue", issue.id);
    e.dataTransfer.effectAllowed = "move";
  };
  return (
    <li className="kb-card" draggable onDragStart={onDragStart}>
      <button type="button" className="kb-card-open" onClick={onOpen} aria-label={`${issue.title}, ${STATUS_LABEL[issue.status]}, open`}>
        <span className="kb-card-title">{issue.title}</span>
        <span className="kb-card-meta">
          {issue.priority !== "medium" ? <Tag tone={priorityTone(issue.priority)}>{issue.priority}</Tag> : null}
          {issue.ready ? <Tag tone="ok">ready</Tag> : null}
          {issue.status === "todo" && !issue.ready ? <Tag tone="neutral">waiting</Tag> : null}
          {issue.documents.length ? <Tag tone="neutral">{`${issue.documents.length} doc`}</Tag> : null}
        </span>
        {issue.blockedReason ? <span className="kb-card-reason">{issue.blockedReason}</span> : null}
        <span className="kb-card-who">{issue.assignee ? issue.assignee.name : "Unassigned"}</span>
      </button>
    </li>
  );
}

function Column({ status, label, issues, onDrop, onOpen }: { status: Status; label: string; issues: Issue[]; onDrop: (id: string, status: Status) => void; onOpen: (id: string) => void }) {
  const [over, setOver] = useState(false);
  return (
    <section
      className={over ? "kb-col kb-col-over" : "kb-col"}
      aria-label={`${label}: ${issues.length}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/x-kanban-issue")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/x-kanban-issue");
        if (id) onDrop(id, status);
      }}
    >
      <h3 className="kb-col-head">
        {label} <span className="kb-count">{issues.length}</span>
      </h3>
      <ul className="kb-cards">
        {issues.map((i) => (
          <Card key={i.id} issue={i} onOpen={() => onOpen(i.id)} />
        ))}
      </ul>
    </section>
  );
}

/** Moving to blocked or done asks for the reason / result (optional), as the agent ops do. */
function MoveDialog({ move, onClose, onDone }: { move: { issue: Issue; status: Status } | null; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (move) setText("");
  }, [move]);
  if (!move) return null;
  const blocked = move.status === "blocked";
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const extra = text.trim() ? (blocked ? { blockedReason: text.trim() } : { result: text.trim() }) : {};
      await run("board_issue_update", { issue: move.issue.id, status: move.status, ...extra });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Move "${move.issue.title}" to ${STATUS_LABEL[move.status]}`}
      onClose={onClose}
      busy={busy}
      footer={
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          Move
        </Button>
      }
    >
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <Field label={blocked ? "What decision or input is needed?" : "Result (what shipped, where it is)"} hint="Optional">
        <TextInput value={text} maxLength={blocked ? 1000 : 4000} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function NewIssue({ open, project, data, onClose, onDone }: { open: boolean; project: string; data: BoardData; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState<Status>("todo");
  const [priority, setPriority] = useState<Priority>("medium");
  const [assignee, setAssignee] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await run("board_issue_create", {
        project,
        title: title.trim(),
        summary,
        status,
        priority,
        ...(assignee ? { assignee } : {}),
        ...(goal ? { goal } : {}),
      });
      setTitle("");
      setSummary("");
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="New issue"
      onClose={onClose}
      busy={busy}
      footer={
        <Button variant="primary" onClick={() => void save()} disabled={busy || !title.trim()}>
          Create
        </Button>
      }
    >
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <Field label="Title">
        <TextInput value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Summary">
        <TextInput value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <Field label="Column">
        <Select value={status} options={COLUMNS.map((c) => ({ value: c.status, label: c.label }))} onChange={(e) => setStatus(e.target.value as Status)} />
      </Field>
      <Field label="Priority">
        <Select value={priority} options={PRIORITIES} onChange={(e) => setPriority(e.target.value as Priority)} />
      </Field>
      <Field label="Assignee">
        <Select value={assignee} options={assigneeOptions(data.agents)} onChange={(e) => setAssignee(e.target.value)} />
      </Field>
      {data.goals.length ? (
        <Field label="Goal">
          <Select value={goal} options={[{ value: "", label: "None" }, ...data.goals.map((g) => ({ value: g.id, label: g.title }))]} onChange={(e) => setGoal(e.target.value)} />
        </Field>
      ) : null}
    </Dialog>
  );
}

function IssueDialog({ id, data, onClose, onChanged }: { id: string | null; data: BoardData; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [comment, setComment] = useState("");
  const [dep, setDep] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const load = useCallback(() => {
    if (!id) return;
    run("board_issue", { issue: id })
      .then(setDetail)
      .catch((e: unknown) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    setConfirmDelete(false);
    load();
  }, [load]);
  if (!id) return null;
  const act = async (fn: () => Promise<unknown>, close = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
      if (close) onClose();
      else load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const issue = detail?.issue;
  const titleOf = (x: string) => data.issues.find((i) => i.id === x)?.title ?? x;
  const candidates = data.issues.filter((i) => issue && i.id !== issue.id && !issue.dependsOn.includes(i.id));
  return (
    <Dialog open title={issue?.title ?? "Issue"} eyebrow={issue ? STATUS_LABEL[issue.status] : undefined} onClose={onClose} busy={busy} size="lg">
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      {!issue ? (
        <p className="kb-muted">Loading…</p>
      ) : (
        <div className="kb-detail">
          {issue.summary ? <p>{issue.summary}</p> : null}
          <div className="kb-grid">
            <Field label="Column">
              <Select
                value={issue.status}
                disabled={busy}
                options={COLUMNS.map((c) => ({ value: c.status, label: c.label }))}
                onChange={(e) => void act(() => run("board_issue_update", { issue: issue.id, status: e.target.value as Status }))}
              />
            </Field>
            <Field label="Priority">
              <Select value={issue.priority} disabled={busy} options={PRIORITIES} onChange={(e) => void act(() => run("board_issue_update", { issue: issue.id, priority: e.target.value as Priority }))} />
            </Field>
            <Field label="Assignee">
              <Select
                value={issue.assignee ? (issue.assignee.kind === "owner" ? "owner" : issue.assignee.id) : ""}
                disabled={busy}
                options={assigneeOptions(data.agents, issue.assignee?.kind === "agent" ? issue.assignee.id : undefined)}
                onChange={(e) => void act(() => run("board_issue_update", { issue: issue.id, assignee: e.target.value || null }))}
              />
            </Field>
          </div>
          <p className="kb-muted">
            Created by {issue.createdBy.name} · {when(issue.createdAt)}
            {issue.ready ? " · ready to start" : ""}
          </p>
          {issue.blockedReason ? <Notice tone="action">Blocked: {issue.blockedReason}</Notice> : null}
          {issue.result ? <Notice tone="ok">Result: {issue.result}</Notice> : null}

          <h4>Depends on</h4>
          {issue.dependsOn.length === 0 ? <p className="kb-muted">Nothing.</p> : null}
          <ul className="kb-list">
            {issue.dependsOn.map((d) => (
              <li key={d}>
                {titleOf(d)}{" "}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => run("board_issue_link", { issue: issue.id, dependsOn: d, remove: true }))}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          {candidates.length ? (
            <div className="kb-row">
              <Select aria-label="Add a dependency" value={dep} options={[{ value: "", label: "Add a dependency…" }, ...candidates.map((c) => ({ value: c.id, label: c.title }))]} onChange={(e) => setDep(e.target.value)} />
              <Button
                size="sm"
                disabled={busy || !dep}
                onClick={() =>
                  void act(async () => {
                    await run("board_issue_link", { issue: issue.id, dependsOn: dep });
                    setDep("");
                  })
                }
              >
                Add
              </Button>
            </div>
          ) : null}
          {detail.dependents.length ? <p className="kb-muted">Waiting for this: {detail.dependents.map(titleOf).join(", ")}</p> : null}

          {issue.documents.length ? (
            <>
              <h4>Documents</h4>
              <ul className="kb-list">
                {issue.documents.map((d) => (
                  <li key={d.id}>{d.title}</li>
                ))}
              </ul>
            </>
          ) : null}

          <h4>Comments</h4>
          <ul className="kb-list">
            {detail.comments.map((c) => (
              <li key={c.id}>
                <strong>{c.author.name}</strong> <span className="kb-muted">{when(c.createdAt)}</span>
                <p className="kb-pre">{c.body}</p>
              </li>
            ))}
          </ul>
          <div className="kb-row">
            <TextInput aria-label="Comment" value={comment} maxLength={8000} placeholder="Add a comment" onChange={(e) => setComment(e.target.value)} />
            <Button
              size="sm"
              disabled={busy || !comment.trim()}
              onClick={() =>
                void act(async () => {
                  await run("board_comment_add", { issue: issue.id, body: comment });
                  setComment("");
                })
              }
            >
              Comment
            </Button>
          </div>

          <h4>Activity</h4>
          <ActivityList items={detail.activity} />

          <div className="kb-row kb-danger">
            {confirmDelete ? (
              <>
                <span>Delete this issue with its comments and activity?</span>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void act(() => run("board_issue_delete", { issue: issue.id }), true)}>
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete issue
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function ActivityList({ items }: { items: Activity[] }) {
  if (!items.length) return <p className="kb-muted">No activity yet.</p>;
  return (
    <ul className="kb-list kb-activity">
      {items.map((a) => (
        <li key={a.id}>
          <span className="kb-muted">{when(a.createdAt)}</span> <strong>{a.actor.name}</strong> {a.summary}
        </li>
      ))}
    </ul>
  );
}

type SetAccess = ReturnType<typeof useScopes>["set"];

/**
 * Shared projects give every current agent "Read and work" (QA S2). The SDK's `shared` default reaches only agents
 * seen after the project existed, so the owner UI applies it to everyone else, once per (project, agent): Kanban
 * records applied pairs (board_share_sync), so a later owner edit such as "No access" is never undone. Agents come
 * from the slice (tb.agents_list), so agents that never called Kanban are covered too. Runs when the board opens
 * and after a project is created or shared.
 */
export function useShareSync(): { ready: boolean; sync: () => Promise<string | null> } {
  const { agents, loading: agentsLoading } = useAgents();
  const { access, loading: accessLoading, set } = useScopes();
  const ready = !agentsLoading && !accessLoading;
  const sync = useCallback(async (): Promise<string | null> => {
    const state = await run("board_share_sync", {});
    const done = new Set(state.applied.map((x) => `${x.project}|${x.agent}`));
    const hasRow = new Set(access.filter((r) => r.type === "project").map((r) => `${r.instanceId}|${r.agent}`));
    const applied: { project: string; agent: string }[] = [];
    const failed: string[] = [];
    for (const project of state.shared)
      for (const a of agents) {
        const key = `${project}|${a.id}`;
        if (done.has(key)) continue;
        try {
          if (!hasRow.has(key)) await set(a.id, "project", project, "contribute");
          applied.push({ project, agent: a.id });
        } catch {
          failed.push(a.name);
        }
      }
    if (applied.length) await run("board_share_sync", { applied });
    return failed.length ? `Shared-project access could not be set for: ${[...new Set(failed)].join(", ")}. Set it under Agents & scopes.` : null;
  }, [agents, access, set]);
  return { ready, sync };
}
/** Sets one access level (null = none) on a project for every listed agent; returns the names that failed. */
async function grantAll(set: SetAccess, agents: Agent[], project: string, level: string | null): Promise<string[]> {
  const failed: string[] = [];
  for (const a of agents) {
    try {
      await set(a.id as never, "project", project, level);
    } catch {
      failed.push(a.name);
    }
  }
  return failed;
}

function NewProject({ open, sync, onClose, onDone }: { open: boolean; sync: () => Promise<string | null>; onClose: () => void; onDone: (id: string, warning: string | null) => void }) {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await run("board_project_create", { name: name.trim(), summary, shared });
      setName("");
      setSummary("");
      onDone(r.project.id, shared ? await sync() : null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="New project"
      onClose={onClose}
      busy={busy}
      footer={
        <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
          Create
        </Button>
      }
    >
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <Field label="Name">
        <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Summary">
        <TextInput value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <label className="kb-check">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Shared: every agent can read it and work in it (change per agent under Agents &amp;
        scopes)
      </label>
    </Dialog>
  );
}

/** Rename, share / unshare, delete. Defaults apply once per agent, so this dialog changes the existing grants too:
 *  share = every active agent may read and work; unshare and delete = every agent loses access (the agent that owns
 *  an own project keeps it). */
function EditProject({
  project,
  agents,
  sync,
  onClose,
  onDone,
}: {
  project: Project | null;
  agents: Agent[];
  sync: () => Promise<string | null>;
  onClose: () => void;
  onDone: (deleted: boolean, warning: string | null) => void;
}) {
  const { set } = useScopes();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [shared, setShared] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setSummary(project.summary);
    setShared(project.shared);
    setConfirm(false);
    setError(null);
  }, [project]);
  if (!project) return null;
  const others = agents.filter((a) => a.id !== project.ownerAgent);
  const warn = (failed: string[]) => (failed.length ? `Access could not be changed for: ${failed.join(", ")}. Check Agents & scopes.` : null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await run("board_project_update", { project: project.id, name: name.trim(), summary, shared });
      let failed: string[] = [];
      if (shared !== project.shared && !shared) failed = await grantAll(set, others, project.id, null);
      onDone(false, shared && !project.shared ? await sync() : warn(failed));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await run("board_project_delete", { project: project.id });
      onDone(true, warn(await grantAll(set, others, project.id, null)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Project settings"
      onClose={onClose}
      busy={busy}
      footer={
        <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
          Save
        </Button>
      }
    >
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <Field label="Name">
        <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Summary">
        <TextInput value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <label className="kb-check">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Shared: every agent can read it and work in it. Turning this off removes
        their access.
      </label>
      <div className="kb-row kb-danger">
        {confirm ? (
          <>
            <span>Delete this project with all its goals, issues, comments and activity?</span>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            Delete project
          </Button>
        )}
      </div>
    </Dialog>
  );
}

function NewGoal({ open, project, onClose, onDone }: { open: boolean; project: string; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [horizon, setHorizon] = useState<"short" | "medium" | "long">("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await run("board_goal_create", { project, title: title.trim(), horizon });
      setTitle("");
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      title="New goal"
      onClose={onClose}
      busy={busy}
      footer={
        <Button variant="primary" onClick={() => void save()} disabled={busy || !title.trim()}>
          Create
        </Button>
      }
    >
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <Field label="Goal">
        <TextInput value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Horizon">
        <Select
          value={horizon}
          options={[
            { value: "short", label: "Short" },
            { value: "medium", label: "Medium" },
            { value: "long", label: "Long" },
          ]}
          onChange={(e) => setHorizon(e.target.value as "short" | "medium" | "long")}
        />
      </Field>
    </Dialog>
  );
}

export function Board({ project, setProject }: { project: string | null; setProject: (id: string | null) => void }) {
  const { data, error, reload } = useBoard(project);
  const { ready: shareReady, sync } = useShareSync();
  const [synced, setSynced] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [move, setMove] = useState<{ issue: Issue; status: Status } | null>(null);
  const [dialog, setDialog] = useState<"issue" | "project" | "goal" | "settings" | null>(null);
  const [who, setWho] = useState("");
  const [moveError, setMoveError] = useState<string | null>(null);
  // once per visit: give agents the access of projects that were shared before they were seen (QA S2)
  useEffect(() => {
    if (!shareReady || synced) return;
    setSynced(true);
    sync()
      .then((w) => {
        if (w) setMoveError(w);
      })
      .catch((e: unknown) => setMoveError(errorText(e)));
  }, [shareReady, synced, sync]);
  const shown = useMemo(
    () => (data?.issues ?? []).filter((i) => !who || (who === "none" ? !i.assignee : who === "owner" ? i.assignee?.kind === "owner" : i.assignee?.id === who)),
    [data, who],
  );
  if (!data) return error ? <Notice tone="action" role="alert">{error}</Notice> : <p className="kb-muted">Loading the board…</p>;
  const current = data.project;
  const onDrop = (id: string, status: Status) => {
    const issue = data.issues.find((i) => i.id === id);
    if (!issue || issue.status === status) return;
    if (status === "blocked" || status === "done") return setMove({ issue, status });
    setMoveError(null);
    run("board_issue_update", { issue: id, status })
      .then(reload)
      .catch((e: unknown) => setMoveError(errorText(e)));
  };
  return (
    <div>
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      {moveError ? <Notice tone="action" role="alert">{moveError}</Notice> : null}
      <div className="kb-toolbar">
        {data.projects.length ? (
          <Select
            aria-label="Project"
            value={current ?? ""}
            options={data.projects.map((p) => ({ value: p.id, label: `${p.name}${p.shared ? "" : p.ownerAgent ? " (own project)" : " (private)"}` }))}
            onChange={(e) => setProject(e.target.value)}
          />
        ) : null}
        <Select
          aria-label="Assignee filter"
          value={who}
          options={[{ value: "", label: "Everyone" }, { value: "none", label: "Unassigned" }, ...assigneeOptions(data.agents).slice(1)]}
          onChange={(e) => setWho(e.target.value)}
        />
        <Button size="sm" variant="primary" disabled={!current} onClick={() => setDialog("issue")}>
          New issue
        </Button>
        <Button size="sm" disabled={!current} onClick={() => setDialog("goal")}>
          New goal
        </Button>
        <Button size="sm" onClick={() => setDialog("project")}>
          New project
        </Button>
        <Button size="sm" disabled={!current} onClick={() => setDialog("settings")}>
          Project settings
        </Button>
        <Button size="sm" variant="ghost" onClick={reload}>
          Refresh
        </Button>
      </div>
      {!current ? (
        <Notice tone="action">No project yet. Each agent gets its own project when it is connected; create a shared project for work several agents do together.</Notice>
      ) : (
        <>
          {data.goals.length ? (
            <ul className="kb-goals" aria-label="Goals">
              {data.goals.map((g) => (
                <li key={g.id} className="kb-goal">
                  <span>{g.title}</span>{" "}
                  <Tag tone={g.status === "done" ? "ok" : "progress"}>{`${g.issues.done}/${g.issues.total} done`}</Tag>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="kb-board">
            {COLUMNS.map((c) => (
              <Column key={c.status} status={c.status} label={c.label} issues={shown.filter((i) => i.status === c.status)} onDrop={onDrop} onOpen={setOpen} />
            ))}
          </div>
          {data.issues.length >= 1000 ? <Notice tone="action">This project has more than 1000 issues; the board shows the first 1000 by priority. Agents can list all of them.</Notice> : null}
          <h3>Recent activity</h3>
          <ActivityList items={data.activity} />
        </>
      )}
      <IssueDialog id={open} data={data} onClose={() => setOpen(null)} onChanged={reload} />
      <MoveDialog
        move={move}
        onClose={() => setMove(null)}
        onDone={() => {
          setMove(null);
          reload();
        }}
      />
      {current ? (
        <NewIssue
          key={current}
          open={dialog === "issue"}
          project={current}
          data={data}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
      {current ? (
        <NewGoal
          open={dialog === "goal"}
          project={current}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
      <EditProject
        project={dialog === "settings" ? (data.projects.find((p) => p.id === current) ?? null) : null}
        agents={data.agents}
        sync={sync}
        onClose={() => setDialog(null)}
        onDone={(deleted, warning) => {
          setDialog(null);
          setMoveError(warning);
          if (deleted) setProject(null);
          else reload();
        }}
      />
      <NewProject
        open={dialog === "project"}
        sync={sync}
        onClose={() => setDialog(null)}
        onDone={(id, warning) => {
          setDialog(null);
          setMoveError(warning);
          setProject(id);
        }}
      />
    </div>
  );
}
