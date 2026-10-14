// The owner board: one project at a time, six fixed columns, cards with the agent's name and status. Dragging a card
// to another column is `board_issue_update {status}` through the person session (keyboard: open the card, pick the
// column). Goals and recent activity sit with the board. Dialogs live in ./dialogs.tsx.
import { Button, Count, EmptyState, Notice, Select, Tag } from "@opt2-tealbrick/ui";
import { type DragEvent, useCallback, useEffect, useMemo, useState } from "react";
import { type BoardData, COLUMNS, explain, type Issue, needsNote, PRIORITIES, type Priority, run, STATUS_LABEL, type Status } from "./api.ts";
import { ActivityList, assigneeOptions } from "./common.tsx";
import { EditProject, IssueDialog, MoveDialog, NewGoal, NewIssue, NewProject } from "./dialogs.tsx";

const REFRESH_MS = 15_000;
const DRAG_TYPE = "text/x-kanban-issue";

export function useBoard(project: string | null) {
  const [data, setData] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    run("board_view", project ? { project } : {})
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(explain(e)));
  }, [project]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);
  return { data, error, reload };
}

const priorityLabel = (p: Priority) => PRIORITIES.find((x) => x.value === p)?.label ?? p;

function Card({ issue, onOpen }: { issue: Issue; onOpen: () => void }) {
  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, issue.id);
    e.dataTransfer.effectAllowed = "move";
  };
  const docs = issue.documents.length;
  return (
    <li className="kb-card" draggable onDragStart={onDragStart}>
      <button type="button" className="kb-card-open" onClick={onOpen} aria-label={`${issue.title}, ${STATUS_LABEL[issue.status]}, open`}>
        <b>{issue.title}</b>
        {issue.priority !== "medium" || issue.ready || (issue.status === "todo" && !issue.ready) || docs ? (
          <span className="tb-row kb-tags">
            {issue.priority !== "medium" ? <Tag status={issue.priority === "high" ? "needs-you" : "default"}>{priorityLabel(issue.priority)}</Tag> : null}
            {issue.ready ? <Tag status="live">ready</Tag> : null}
            {issue.status === "todo" && !issue.ready ? <Tag status="idle">waiting</Tag> : null}
            {docs ? <Tag>{`${docs} ${docs === 1 ? "doc" : "docs"}`}</Tag> : null}
          </span>
        ) : null}
        {issue.blockedReason ? <span className="kb-reason">{issue.blockedReason}</span> : null}
        <span className="kb-who">{issue.assignee ? issue.assignee.name : "Unassigned"}</span>
      </button>
    </li>
  );
}

function Column({ status, label, issues, onDrop, onOpen }: { status: Status; label: string; issues: Issue[]; onDrop: (id: string, status: Status) => void; onOpen: (id: string) => void }) {
  const [over, setOver] = useState(false);
  return (
    <section
      className={over ? "kb-col is-over" : "kb-col"}
      aria-label={`${label}: ${issues.length}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) onDrop(id, status);
      }}
    >
      <h3>
        {label} <Count tone="ink">{issues.length}</Count>
      </h3>
      <ul className="kb-cards">
        {issues.map((i) => (
          <Card key={i.id} issue={i} onOpen={() => onOpen(i.id)} />
        ))}
      </ul>
    </section>
  );
}


export function Board({ project, setProject }: { project: string | null; setProject: (id: string | null) => void }) {
  const { data, error, reload } = useBoard(project);
  const [open, setOpen] = useState<string | null>(null);
  const [move, setMove] = useState<{ issue: Issue; status: Status } | null>(null);
  const [dialog, setDialog] = useState<"issue" | "project" | "goal" | "settings" | null>(null);
  const [who, setWho] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const shown = useMemo(
    () => (data?.issues ?? []).filter((i) => !who || (who === "none" ? !i.assignee : who === "owner" ? i.assignee?.kind === "owner" : i.assignee?.id === who)),
    [data, who],
  );
  if (!data) {
    return (
      <section className="app-page" aria-label="Board">
        {error ? (
          <Notice tone="needs-you" role="alert">
            <span className="tb-row">
              <span>{error}</span>
              <Button size="sm" onClick={reload}>
                Try again
              </Button>
            </span>
          </Notice>
        ) : (
          <p className="tb-soft" role="status">
            Loading the board.
          </p>
        )}
      </section>
    );
  }
  const current = data.project;
  const onDrop = (id: string, status: Status) => {
    const issue = data.issues.find((i) => i.id === id);
    if (!issue || issue.status === status) return;
    if (needsNote(status)) return setMove({ issue, status });
    setNotice(null);
    run("board_issue_update", { issue: id, status })
      .then(reload)
      .catch((e: unknown) => setNotice(explain(e)));
  };
  const finish = () => {
    setDialog(null);
    reload();
  };
  return (
    <section className="app-page" aria-label="Board">
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="needs-you" role="alert">
          {notice}
        </Notice>
      ) : null}
      <div className="toolbar">
        {data.projects.length ? (
          <div className="kb-pick">
            <Select
              aria-label="Project"
              value={current ?? ""}
              options={data.projects.map((p) => ({ value: p.id, label: p.name, meta: p.shared ? undefined : p.ownerAgent ? "own project" : "private" }))}
              onValueChange={setProject}
            />
          </div>
        ) : null}
        <div className="kb-pick">
          <Select
            aria-label="Assignee filter"
            value={who}
            options={[{ value: "", label: "Everyone" }, { value: "none", label: "Unassigned" }, ...assigneeOptions(data.agents).slice(1)]}
            onValueChange={setWho}
          />
        </div>
        <span className="kb-grow" />
        <Button variant={current ? "primary" : undefined} disabled={!current} onClick={() => setDialog("issue")}>
          New issue
        </Button>
        <Button disabled={!current} onClick={() => setDialog("goal")}>
          New goal
        </Button>
        <Button variant={current ? undefined : "primary"} onClick={() => setDialog("project")}>
          New project
        </Button>
        <Button variant="quiet" disabled={!current} onClick={() => setDialog("settings")}>
          Project settings
        </Button>
        <Button variant="quiet" onClick={reload}>
          Refresh
        </Button>
      </div>
      {!current ? (
        <EmptyState title="No project yet">Each agent gets its own project when it’s connected. Create a shared project for work several agents do together.</EmptyState>
      ) : (
        <>
          {data.goals.length ? (
            <ul className="kb-goals" aria-label="Goals">
              {data.goals.map((g) => (
                <li key={g.id}>
                  <b>{g.title}</b>
                  <Tag status={g.status === "done" ? "live" : "busy"}>{`${g.issues.done}/${g.issues.total} done`}</Tag>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="kb-board">
            {COLUMNS.map((c) => (
              <Column key={c.status} status={c.status} label={c.label} issues={shown.filter((i) => i.status === c.status)} onDrop={onDrop} onOpen={setOpen} />
            ))}
          </div>
          {data.issues.length >= 1000 ? <Notice>This project has more than 1000 issues. The board shows the first 1000 by priority. Agents can list all of them.</Notice> : null}
          <section className="tb-stack kb-activity">
            <h2>Recent activity</h2>
            <ActivityList items={data.activity} />
          </section>
        </>
      )}
      <IssueDialog id={open} data={data} onClose={() => setOpen(null)} onChanged={reload} onMove={(issue, status) => setMove({ issue, status })} />
      <MoveDialog
        move={move}
        onClose={() => setMove(null)}
        onDone={() => {
          setMove(null);
          reload();
        }}
      />
      {current ? <NewIssue key={current} open={dialog === "issue"} project={current} data={data} onClose={() => setDialog(null)} onDone={finish} /> : null}
      {current ? <NewGoal open={dialog === "goal"} project={current} onClose={() => setDialog(null)} onDone={finish} /> : null}
      <EditProject
        project={dialog === "settings" ? (data.projects.find((p) => p.id === current) ?? null) : null}
        agents={data.agents}
        onClose={() => setDialog(null)}
        onDone={(deleted, warning) => {
          setDialog(null);
          setNotice(warning);
          if (deleted) setProject(null);
          else reload();
        }}
      />
      <NewProject
        open={dialog === "project"}
        onClose={() => setDialog(null)}
        onDone={(id) => {
          setDialog(null);
          setNotice(null);
          setProject(id);
        }}
      />
    </section>
  );
}
