// The board's popups. Each one is a single form, so each is a Dialog (StepFlow is for multi-step flows only).
// Delete is a two-step button in the footer: the first click asks, the second (filled) click deletes.
import { useScopes } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Dialog, Field, Notice, Select, Swatch, Switch, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type Agent, type BoardData, COLUMNS, explain, type Issue, type IssueDetail, needsNote, PRIORITIES, type Priority, type Project, run, STATUS_LABEL, type Status, when } from "./api.ts";
import { ActivityList, assigneeOptions } from "./common.tsx";

const COLUMN_OPTIONS = COLUMNS.map((c) => ({ value: c.status, label: c.label }));

function Failure({ message }: { message: string | null }) {
  return message ? (
    <Notice tone="needs-you" role="alert">
      {message}
    </Notice>
  ) : null;
}

/** Footer with a two-step delete on the left and the dialog's main action(s) on the right. */
function DeleteFoot({
  label,
  question,
  asking,
  setAsking,
  busy,
  onDelete,
  children,
}: {
  label: string;
  question: string;
  asking: boolean;
  setAsking: (v: boolean) => void;
  busy: boolean;
  onDelete: () => void;
  children: ReactNode;
}) {
  return asking ? (
    <>
      <span className="tb-hint">{question}</span>
      <Button onClick={() => setAsking(false)} disabled={busy}>
        Keep
      </Button>
      <Button variant="danger" confirm onClick={onDelete} disabled={busy}>
        Delete
      </Button>
    </>
  ) : (
    <>
      <Button variant="danger" className="kb-push" onClick={() => setAsking(true)} disabled={busy}>
        {label}
      </Button>
      {children}
    </>
  );
}

export function MoveDialog({ move, onClose, onDone }: { move: { issue: Issue; status: Status } | null; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (move) {
      setText("");
      setError(null);
    }
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
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Move “${move.issue.title}” to ${STATUS_LABEL[move.status]}`}
      onClose={onClose}
      busy={busy}
      footer={
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            Move
          </Button>
      }
    >
      <Failure message={error} />
      <Field label={blocked ? "What decision or input is needed?" : "Result (what shipped, where it is)"} hint="Optional">
        <TextInput value={text} maxLength={blocked ? 1000 : 4000} onChange={(e) => setText(e.target.value)} />
      </Field>
    </Dialog>
  );
}

export function NewIssue({ open, project, data, onClose, onDone }: { open: boolean; project: string; data: BoardData; onClose: () => void; onDone: () => void }) {
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
      setError(explain(e));
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
      <Failure message={error} />
      <Field label="Title">
        <TextInput value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Summary">
        <Textarea value={summary} maxLength={4000} rows={3} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <div className="kb-pair">
        <Field label="Column">
          <Select value={status} options={COLUMN_OPTIONS} onValueChange={(v) => setStatus(v as Status)} />
        </Field>
        <Field label="Priority">
          <Select value={priority} options={PRIORITIES} onValueChange={(v) => setPriority(v as Priority)} />
        </Field>
      </div>
      <Field label="Assignee">
        <Select value={assignee} options={assigneeOptions(data.agents)} onValueChange={setAssignee} />
      </Field>
      {data.goals.length ? (
        <Field label="Goal">
          <Select value={goal} options={[{ value: "", label: "None" }, ...data.goals.map((g) => ({ value: g.id, label: g.title }))]} onValueChange={setGoal} />
        </Field>
      ) : null}
    </Dialog>
  );
}

export function IssueDialog({
  id,
  data,
  onClose,
  onChanged,
  onMove,
}: {
  id: string | null;
  data: BoardData;
  onClose: () => void;
  onChanged: () => void;
  onMove: (issue: Issue, status: Status) => void;
}) {
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [comment, setComment] = useState("");
  const [dep, setDep] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const load = useCallback(() => {
    if (!id) return;
    run("board_issue", { issue: id })
      .then(setDetail)
      .catch((e: unknown) => setError(explain(e)));
  }, [id]);
  useEffect(() => {
    setDetail(null);
    setError(null);
    setAsking(false);
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
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };
  const issue = detail?.issue;
  const titleOf = (x: string) => data.issues.find((i) => i.id === x)?.title ?? x;
  const candidates = data.issues.filter((i) => issue && i.id !== issue.id && !issue.dependsOn.includes(i.id));
  return (
    <Dialog
      open
      title={issue?.title ?? "Issue"}
      kicker={issue ? STATUS_LABEL[issue.status] : undefined}
      onClose={onClose}
      busy={busy}
      size="lg"
      footer={
        issue ? (
          <DeleteFoot
            label="Delete issue"
            question="Delete this issue with its comments and activity?"
            asking={asking}
            setAsking={setAsking}
            busy={busy}
            onDelete={() => void act(() => run("board_issue_delete", { issue: issue.id }), true)}
          >
            <Button variant="primary" onClick={onClose} disabled={busy}>
              Done
            </Button>
          </DeleteFoot>
        ) : undefined
      }
    >
      <Failure message={error} />
      {!issue || !detail ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading the issue.
          </p>
        )
      ) : (
        <>
          {issue.summary ? <p className="tb-soft kb-pre">{issue.summary}</p> : null}
          <div className="kb-three">
            <Field label="Column">
              <Select
                value={issue.status}
                disabled={busy}
                options={COLUMN_OPTIONS}
                onValueChange={(v) => {
                  // the one move rule (QA S3): Blocked / Done ask for the reason / result, like a drag
                  if (needsNote(v as Status)) {
                    onClose();
                    onMove(issue as Issue, v as Status);
                  } else void act(() => run("board_issue_update", { issue: issue.id, status: v as Status }));
                }}
              />
            </Field>
            <Field label="Priority">
              <Select value={issue.priority} disabled={busy} options={PRIORITIES} onValueChange={(v) => void act(() => run("board_issue_update", { issue: issue.id, priority: v as Priority }))} />
            </Field>
            <Field label="Assignee">
              <Select
                value={issue.assignee ? (issue.assignee.kind === "owner" ? "owner" : issue.assignee.id) : ""}
                disabled={busy}
                options={assigneeOptions(data.agents, issue.assignee?.kind === "agent" ? issue.assignee.id : undefined)}
                onValueChange={(v) => void act(() => run("board_issue_update", { issue: issue.id, assignee: v || null }))}
              />
            </Field>
          </div>
          <p className="tb-hint">
            Created by {issue.createdBy.name} · {when(issue.createdAt)}
            {issue.ready ? " · ready to start" : ""}
          </p>
          {issue.blockedReason ? <Notice tone="needs-you">Blocked: {issue.blockedReason}</Notice> : null}
          {issue.result ? <Notice tone="live">Result: {issue.result}</Notice> : null}

          <section className="tb-stack kb-tight">
            <h3>Depends on</h3>
            {issue.dependsOn.length === 0 ? (
              <p className="tb-soft">Nothing.</p>
            ) : (
              <div className="ruled">
                {issue.dependsOn.map((d) => (
                  <div className="item" key={d}>
                    <Swatch />
                    <h3>{titleOf(d)}</h3>
                    <div className="side">
                      <Button size="sm" variant="quiet" disabled={busy} aria-label={`Remove dependency ${titleOf(d)}`} onClick={() => void act(() => run("board_issue_link", { issue: issue.id, dependsOn: d, remove: true }))}>
                        Remove
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {candidates.length ? (
              <div className="tb-input-row kb-add">
                <Field label="Add a dependency">
                  <Select value={dep} placeholder="Choose an issue" options={candidates.map((c) => ({ value: c.id, label: c.title }))} onValueChange={setDep} />
                </Field>
                <Button
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
            {detail.dependents.length ? <p className="tb-hint">Waiting for this: {detail.dependents.map(titleOf).join(", ")}</p> : null}
          </section>

          {issue.documents.length ? (
            <section className="tb-stack kb-tight">
              <h3>Documents</h3>
              <div className="ruled">
                {issue.documents.map((d) => (
                  <div className="item" key={d.id}>
                    <Swatch />
                    <h3>{d.title}</h3>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="tb-stack kb-tight">
            <h3>Comments</h3>
            {detail.comments.length ? (
              <div className="ruled">
                {detail.comments.map((c) => (
                  <div className="item" key={c.id}>
                    <Swatch className={c.author.kind === "owner" ? "is-needs-you" : undefined} />
                    <h3>{c.author.name}</h3>
                    <p className="kb-pre">{c.body}</p>
                    <span className="meta">{when(c.createdAt)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="tb-input-row">
              <TextInput aria-label="Add a comment" value={comment} maxLength={8000} placeholder="Add a comment" onChange={(e) => setComment(e.target.value)} />
              <Button
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
          </section>

          <section className="tb-stack kb-tight">
            <h3>Activity</h3>
            <ActivityList items={detail.activity} />
          </section>
        </>
      )}
    </Dialog>
  );
}

export function NewProject({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
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
      // SDK 0.1.13: a project created shared reaches every agent already seen (and later ones on first sight).
      onDone(r.project.id);
    } catch (e) {
      setError(explain(e));
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
      <Failure message={error} />
      <Field label="Name">
        <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Summary">
        <Textarea value={summary} maxLength={4000} rows={3} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <div className="tb-stack kb-tight">
        <Switch label="Shared with every agent" checked={shared} onCheckedChange={setShared} />
        <p className="tb-hint">Every agent can read a shared project and work in it. Change it per agent under Agents &amp; scopes.</p>
      </div>
    </Dialog>
  );
}

type SetAccess = ReturnType<typeof useScopes>["set"];
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

/** Rename, share / unshare, delete. Defaults apply once per agent, so this dialog changes the existing grants too:
 *  share = every active agent may read and work; unshare and delete = every agent loses access (the agent that owns
 *  an own project keeps it). */
export function EditProject({ project, agents, onClose, onDone }: { project: Project | null; agents: Agent[]; onClose: () => void; onDone: (deleted: boolean, warning: string | null) => void }) {
  // keyed by the project id: the board reloads every 15 s, and a reload must not reset what the owner is typing
  return project ? <ProjectForm key={project.id} project={project} agents={agents} onClose={onClose} onDone={onDone} /> : null;
}

function ProjectForm({ project, agents, onClose, onDone }: { project: Project; agents: Agent[]; onClose: () => void; onDone: (deleted: boolean, warning: string | null) => void }) {
  const { set } = useScopes();
  const [name, setName] = useState(project.name);
  const [summary, setSummary] = useState(project.summary);
  const [shared, setShared] = useState(project.shared);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = agents.filter((a) => a.id !== project.ownerAgent);
  const warn = (failed: string[]) => (failed.length ? `Access could not be changed for: ${failed.join(", ")}. Check Agents & scopes.` : null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await run("board_project_update", { project: project.id, name: name.trim(), summary, shared });
      let failed: string[] = [];
      if (shared !== project.shared && !shared) failed = await grantAll(set, others, project.id, null);
      // Sharing: the SDK grants every seen agent (0.1.13). Unsharing: the SDK keeps existing rows, so they are removed here.
      onDone(false, warn(failed));
    } catch (e) {
      setError(explain(e));
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
      setError(explain(e));
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
        <DeleteFoot
          label="Delete project"
          question="Delete this project with all its goals, issues, comments and activity?"
          asking={asking}
          setAsking={setAsking}
          busy={busy}
          onDelete={() => void remove()}
        >
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            Save
          </Button>
        </DeleteFoot>
      }
    >
      <Failure message={error} />
      <Field label="Name">
        <TextInput value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Summary">
        <Textarea value={summary} maxLength={4000} rows={3} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <div className="tb-stack kb-tight">
        <Switch label="Shared with every agent" checked={shared} onCheckedChange={setShared} />
        <p className="tb-hint">Every agent can read a shared project and work in it. Turning this off removes their access.</p>
      </div>
    </Dialog>
  );
}

export function NewGoal({ open, project, onClose, onDone }: { open: boolean; project: string; onClose: () => void; onDone: () => void }) {
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
      setError(explain(e));
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
      <Failure message={error} />
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
          onValueChange={(v) => setHorizon(v as "short" | "medium" | "long")}
        />
      </Field>
    </Dialog>
  );
}
