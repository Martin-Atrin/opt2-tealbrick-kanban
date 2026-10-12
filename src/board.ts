// The board store: projects, goals, issues, dependencies, comments, document references and the activity log, as
// plain functions over the SDK `Db` (app tables from migrations/0001_init.sql). Access checks live in the handlers;
// everything here assumes the caller may act on the rows it names.
//
// One status vocabulary (C83): backlog, todo, in_progress, in_review, blocked, done. "ready" is computed, never stored:
// an issue is ready when it is in todo and every issue it depends on is done. When an issue becomes ready because a
// dependency was completed, unlinked or deleted, the activity log records a `promoted` entry on it.
import { ulid } from "@opt2-tealbrick/manifest";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";

export const PROJECT_SCOPE = "project";
export const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = "low" | "medium" | "high";
export type Horizon = "short" | "medium" | "long";
export type GoalStatus = "active" | "done";
export const OWNER_ID = "owner";
export const OWNER_NAME = "Owner";

export interface Actor {
  kind: "agent" | "owner" | "app";
  id: string;
  name: string;
}
export interface DocRef {
  id: string;
  title: string;
}
export interface IssueView {
  id: string;
  project: string;
  title: string;
  summary: string;
  status: Status;
  priority: Priority;
  ready: boolean;
  assignee: Actor | null;
  goal: string | null;
  /** optional key for repeated work (a template or a routine); Evolution groups done issues by it */
  template: string | null;
  dependsOn: string[];
  blockedReason: string | null;
  result: string | null;
  documents: DocRef[];
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface ProjectView {
  id: string;
  name: string;
  summary: string;
  shared: boolean;
  ownerAgent: string | null;
  counts: Record<Status, number>;
  createdAt: string;
  updatedAt: string;
}
export interface GoalView {
  id: string;
  project: string;
  title: string;
  summary: string;
  horizon: Horizon;
  status: GoalStatus;
  issues: { total: number; done: number };
  createdAt: string;
  updatedAt: string;
}
export interface CommentView {
  id: string;
  issue: string;
  author: Actor;
  body: string;
  createdAt: string;
}
export interface ActivityView {
  id: string;
  project: string;
  issue: string | null;
  actor: Actor;
  kind: string;
  summary: string;
  createdAt: string;
}
export interface AgentView {
  id: string;
  name: string;
  mode: string;
  active: boolean;
}

type Row = Record<string, unknown>;
const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const isoOrNull = (ms: unknown): string | null => (ms === null || ms === undefined ? null : iso(ms));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export function notFound(what: string): TbError {
  return new TbError("not_found", `${what} not found`, 404);
}
export function invalid(code: string, message: string): TbError {
  return new TbError(code, message, 400);
}

// ---------------------------------------------------------------- agents (directory)

export function upsertAgent(db: Db, agent: { id: string; name: string; mode: string }, now = Date.now()): void {
  db.prepare(
    "INSERT INTO agents (id, name, mode, active, first_seen) VALUES (?, ?, ?, 1, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, mode = excluded.mode, active = 1",
  ).run(agent.id, agent.name, agent.mode, now);
}
export function deactivateAgent(db: Db, id: string): void {
  db.prepare("UPDATE agents SET active = 0 WHERE id = ?").run(id);
}
export function listAgents(db: Db): AgentView[] {
  return db
    .prepare("SELECT id, name, mode, active FROM agents ORDER BY active DESC, name, id")
    .all()
    .map((r) => ({ id: String(r.id), name: String(r.name), mode: String(r.mode), active: Number(r.active) === 1 }));
}
function agentName(db: Db, id: string): string | null {
  const r = db.prepare("SELECT name FROM agents WHERE id = ?").get(id);
  return r ? String(r.name) : null;
}

/** Resolves an assignee input ("me", "owner" or an agent id from the directory) to a stored (kind, id). */
/** `forFilter`: also accept agents that left the workspace (to find their remaining work). */
export function resolveAssignee(db: Db, input: string, caller: Actor, forFilter = false): { kind: "agent" | "owner"; id: string } {
  if (input === "me") {
    if (caller.kind === "agent") return { kind: "agent", id: caller.id };
    if (caller.kind === "owner") return { kind: "owner", id: OWNER_ID };
    throw invalid("assignee_invalid", 'an app caller cannot use "me" as assignee');
  }
  if (input === OWNER_ID) return { kind: "owner", id: OWNER_ID };
  const r = db.prepare("SELECT active FROM agents WHERE id = ?").get(input);
  if (!r || (!forFilter && Number(r.active) !== 1)) throw invalid("assignee_unknown", "assignee must be an agent of this workspace, \"me\" or \"owner\"");
  return { kind: "agent", id: input };
}

// ---------------------------------------------------------------- activity

export function logActivity(db: Db, e: { project: string; issue: string | null; actor: Actor; kind: string; summary: string }, now = Date.now()): void {
  db.prepare("INSERT INTO activity (id, project, issue, actor_kind, actor_id, actor_name, kind, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    `act_${ulid(now)}`,
    e.project,
    e.issue,
    e.actor.kind,
    e.actor.id,
    e.actor.name,
    e.kind,
    e.summary.slice(0, 400),
    now,
  );
}

function toActivity(r: Row): ActivityView {
  return {
    id: String(r.id),
    project: String(r.project),
    issue: strOrNull(r.issue),
    actor: { kind: String(r.actor_kind) as Actor["kind"], id: String(r.actor_id), name: String(r.actor_name) },
    kind: String(r.kind),
    summary: String(r.summary),
    createdAt: iso(r.created_at),
  };
}

/** Newest first; `projects` is the caller's readable set; `issue` narrows to one issue. Offset cursor. */
export function listActivity(db: Db, f: { projects: readonly string[]; issue?: string; limit: number; cursor?: string }): { activity: ActivityView[]; cursor: string | null } {
  if (f.projects.length === 0) return { activity: [], cursor: null };
  const offset = parseCursor(f.cursor);
  const where = [`project IN (${marks(f.projects.length)})`];
  const args: unknown[] = [...f.projects];
  if (f.issue) {
    where.push("issue = ?");
    args.push(f.issue);
  }
  const rows = db
    .prepare(`SELECT * FROM activity WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, f.limit + 1, offset);
  return { activity: rows.slice(0, f.limit).map(toActivity), cursor: rows.length > f.limit ? String(offset + f.limit) : null };
}

function parseCursor(c: string | undefined): number {
  if (c === undefined) return 0;
  if (!/^\d{1,9}$/.test(c)) throw invalid("cursor_invalid", "cursor is not valid");
  return Number(c);
}

// ---------------------------------------------------------------- projects

function counts(db: Db, project: string): Record<Status, number> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM issues WHERE project = ? GROUP BY status").all(project)) out[String(r.status) as Status] = Number(r.n);
  return out;
}
function toProject(db: Db, r: Row): ProjectView {
  return {
    id: String(r.id),
    name: String(r.name),
    summary: String(r.summary),
    shared: Number(r.shared) === 1,
    ownerAgent: strOrNull(r.owner_agent),
    counts: counts(db, String(r.id)),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
export function projectRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
}
export function getProject(db: Db, id: string): ProjectView | null {
  const r = projectRow(db, id);
  return r ? toProject(db, r) : null;
}
/** The given ids that exist, as views: own project of the caller first, then shared, then by name. */
export function listProjects(db: Db, ids: readonly string[] | null, firstOwner?: string): ProjectView[] {
  const rows =
    ids === null
      ? db.prepare("SELECT * FROM projects").all()
      : ids.length === 0
        ? []
        : db.prepare(`SELECT * FROM projects WHERE id IN (${marks(ids.length)})`).all(...ids);
  const rank = (r: Row) => (firstOwner && r.owner_agent === firstOwner ? 0 : Number(r.shared) === 1 ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))).map((r) => toProject(db, r));
}

export function insertProject(db: Db, p: { id: string; name: string; summary?: string; shared: boolean; ownerAgent: string | null }, actor: Actor, now = Date.now()): ProjectView {
  db.prepare("INSERT INTO projects (id, name, summary, shared, owner_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    p.id,
    p.name,
    p.summary ?? "",
    p.shared ? 1 : 0,
    p.ownerAgent,
    now,
    now,
  );
  logActivity(db, { project: p.id, issue: null, actor, kind: "project_created", summary: `Project "${p.name}" created` }, now);
  return getProject(db, p.id) as ProjectView;
}

/** The own project of an agent or app caller (id = caller id). Created when missing: the SDK may create the scope
 *  instance on its own (`own` default grant for an app caller on its first call) before this app has a row. */
export function ensureOwnProject(db: Db, owner: { id: string; name: string }, now = Date.now()): boolean {
  if (projectRow(db, owner.id)) return false;
  insertProject(db, { id: owner.id, name: `${owner.name} work`.slice(0, 80), shared: false, ownerAgent: owner.id }, { kind: "app", id: "kanban", name: "Kanban" }, now);
  return true;
}

export function updateProject(db: Db, id: string, patch: { name?: string; summary?: string; shared?: boolean }, actor: Actor, now = Date.now()): ProjectView {
  const r = projectRow(db, id);
  if (!r) throw notFound("project");
  const changes: string[] = [];
  if (patch.name !== undefined && patch.name !== r.name) changes.push("name");
  if (patch.summary !== undefined && patch.summary !== r.summary) changes.push("summary");
  if (patch.shared !== undefined && (patch.shared ? 1 : 0) !== Number(r.shared)) changes.push(patch.shared ? "shared" : "not shared");
  if (changes.length) {
    db.prepare("UPDATE projects SET name = ?, summary = ?, shared = ?, updated_at = ? WHERE id = ?").run(
      patch.name ?? r.name,
      patch.summary ?? r.summary,
      patch.shared === undefined ? r.shared : patch.shared ? 1 : 0,
      now,
      id,
    );
    logActivity(db, { project: id, issue: null, actor, kind: "project_updated", summary: `Project updated: ${changes.join(", ")}` }, now);
  }
  return getProject(db, id) as ProjectView;
}

/** Deletes the project's app data. The scope instance stays (the SDK has no instance delete); its row is gone, so it
 *  no longer lists or resolves. */
export function deleteProject(db: Db, id: string): void {
  if (!projectRow(db, id)) throw notFound("project");
  const issues = db.prepare("SELECT id FROM issues WHERE project = ?").all(id).map((r) => String(r.id));
  for (const issue of issues) purgeIssue(db, issue);
  db.prepare("DELETE FROM goals WHERE project = ?").run(id);
  db.prepare("DELETE FROM activity WHERE project = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

// ---------------------------------------------------------------- goals

function toGoal(db: Db, r: Row): GoalView {
  const c = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM issues WHERE goal = ?").get(r.id) ?? {};
  return {
    id: String(r.id),
    project: String(r.project),
    title: String(r.title),
    summary: String(r.summary),
    horizon: String(r.horizon) as Horizon,
    status: String(r.status) as GoalStatus,
    issues: { total: Number(c.total ?? 0), done: Number(c.done ?? 0) },
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
export function goalRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM goals WHERE id = ?").get(id);
}
export function getGoal(db: Db, id: string): GoalView | null {
  const r = goalRow(db, id);
  return r ? toGoal(db, r) : null;
}
export function listGoals(db: Db, projects: readonly string[], status?: GoalStatus): GoalView[] {
  if (projects.length === 0) return [];
  const args: unknown[] = [...projects];
  let sql = `SELECT * FROM goals WHERE project IN (${marks(projects.length)})`;
  if (status) {
    sql += " AND status = ?";
    args.push(status);
  }
  return db
    .prepare(`${sql} ORDER BY created_at, id`)
    .all(...args)
    .map((r) => toGoal(db, r));
}
export function createGoal(db: Db, g: { project: string; title: string; summary?: string; horizon?: Horizon }, actor: Actor, now = Date.now()): GoalView {
  if (!projectRow(db, g.project)) throw notFound("project");
  const id = `gol_${ulid(now)}`;
  db.prepare("INSERT INTO goals (id, project, title, summary, horizon, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)").run(
    id,
    g.project,
    g.title,
    g.summary ?? "",
    g.horizon ?? "medium",
    now,
    now,
  );
  logActivity(db, { project: g.project, issue: null, actor, kind: "goal_created", summary: `Goal "${g.title}" created` }, now);
  return getGoal(db, id) as GoalView;
}
export function updateGoal(
  db: Db,
  id: string,
  patch: { title?: string; summary?: string; horizon?: Horizon; status?: GoalStatus },
  actor: Actor,
  now = Date.now(),
): GoalView {
  const r = goalRow(db, id);
  if (!r) throw notFound("goal");
  const changes = (["title", "summary", "horizon", "status"] as const).filter((k) => patch[k] !== undefined && patch[k] !== r[k]);
  if (changes.length) {
    db.prepare("UPDATE goals SET title = ?, summary = ?, horizon = ?, status = ?, updated_at = ? WHERE id = ?").run(
      patch.title ?? r.title,
      patch.summary ?? r.summary,
      patch.horizon ?? r.horizon,
      patch.status ?? r.status,
      now,
      id,
    );
    logActivity(db, { project: String(r.project), issue: null, actor, kind: "goal_updated", summary: `Goal "${patch.title ?? r.title}" updated: ${changes.join(", ")}` }, now);
  }
  return getGoal(db, id) as GoalView;
}
export function deleteGoal(db: Db, id: string, actor: Actor, now = Date.now()): void {
  const r = goalRow(db, id);
  if (!r) throw notFound("goal");
  db.prepare("UPDATE issues SET goal = NULL WHERE goal = ?").run(id);
  db.prepare("DELETE FROM goals WHERE id = ?").run(id);
  logActivity(db, { project: String(r.project), issue: null, actor, kind: "goal_deleted", summary: `Goal "${String(r.title)}" deleted` }, now);
}

// ---------------------------------------------------------------- issues

export function issueRow(db: Db, id: string): Row | undefined {
  return db.prepare("SELECT * FROM issues WHERE id = ?").get(id);
}
function dependsOn(db: Db, id: string): string[] {
  return db
    .prepare("SELECT depends_on FROM issue_links WHERE issue = ? ORDER BY created_at, depends_on")
    .all(id)
    .map((r) => String(r.depends_on));
}
export function dependents(db: Db, id: string): string[] {
  return db
    .prepare("SELECT issue FROM issue_links WHERE depends_on = ? ORDER BY created_at, issue")
    .all(id)
    .map((r) => String(r.issue));
}
/** todo + every dependency done (none = ready). Links to deleted issues are removed with the issue. */
export function isReady(db: Db, id: string, status?: string): boolean {
  const s = status ?? String(issueRow(db, id)?.status ?? "");
  if (s !== "todo") return false;
  const open = db
    .prepare("SELECT COUNT(*) AS n FROM issue_links l JOIN issues d ON d.id = l.depends_on WHERE l.issue = ? AND d.status <> 'done'")
    .get(id);
  return Number(open?.n ?? 0) === 0;
}
function actorOf(db: Db, kind: unknown, id: unknown, storedName?: unknown): Actor {
  const k = String(kind) as Actor["kind"];
  if (k === "owner") return { kind: "owner", id: String(id), name: OWNER_NAME };
  const name = (k === "agent" ? agentName(db, String(id)) : null) ?? (storedName === undefined ? null : String(storedName)) ?? String(id);
  return { kind: k, id: String(id), name };
}
export function toIssue(db: Db, r: Row): IssueView {
  const id = String(r.id);
  return {
    id,
    project: String(r.project),
    title: String(r.title),
    summary: String(r.summary),
    status: String(r.status) as Status,
    priority: String(r.priority) as Priority,
    ready: isReady(db, id, String(r.status)),
    assignee: r.assignee_kind ? actorOf(db, r.assignee_kind, r.assignee_id) : null,
    goal: strOrNull(r.goal),
    template: strOrNull(r.template),
    dependsOn: dependsOn(db, id),
    blockedReason: strOrNull(r.blocked_reason),
    result: strOrNull(r.result),
    documents: db
      .prepare("SELECT document, title FROM issue_documents WHERE issue = ? ORDER BY linked_at, document")
      .all(id)
      .map((d) => ({ id: String(d.document), title: String(d.title) })),
    createdBy: actorOf(db, r.created_by_kind, r.created_by_id, r.created_by_name),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    completedAt: isoOrNull(r.completed_at),
  };
}
export function getIssue(db: Db, id: string): IssueView | null {
  const r = issueRow(db, id);
  return r ? toIssue(db, r) : null;
}

const PRIORITY_RANK = "CASE priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END";

export interface IssueFilter {
  projects: readonly string[];
  status?: Status;
  assignee?: { kind: "agent" | "owner"; id: string };
  goal?: string;
  template?: string;
  ready?: boolean;
  limit: number;
  cursor?: string;
}
/** Highest priority first, then oldest first. `ready` filters after the computation (todo + deps done). */
export function listIssues(db: Db, f: IssueFilter): { issues: IssueView[]; cursor: string | null } {
  if (f.projects.length === 0) return { issues: [], cursor: null };
  const where = [`project IN (${marks(f.projects.length)})`];
  const args: unknown[] = [...f.projects];
  if (f.status) {
    where.push("status = ?");
    args.push(f.status);
  }
  if (f.assignee) {
    where.push("assignee_kind = ? AND assignee_id = ?");
    args.push(f.assignee.kind, f.assignee.id);
  }
  if (f.goal) {
    where.push("goal = ?");
    args.push(f.goal);
  }
  if (f.template) {
    where.push("template = ?");
    args.push(f.template);
  }
  if (f.ready !== undefined) {
    const openDeps = "EXISTS (SELECT 1 FROM issue_links l JOIN issues d ON d.id = l.depends_on WHERE l.issue = issues.id AND d.status <> 'done')";
    where.push(f.ready ? `status = 'todo' AND NOT ${openDeps}` : `NOT (status = 'todo' AND NOT ${openDeps})`);
  }
  const offset = parseCursor(f.cursor);
  const rows = db
    .prepare(`SELECT * FROM issues WHERE ${where.join(" AND ")} ORDER BY ${PRIORITY_RANK} DESC, created_at, id LIMIT ? OFFSET ?`)
    .all(...args, f.limit + 1, offset);
  return { issues: rows.slice(0, f.limit).map((r) => toIssue(db, r)), cursor: rows.length > f.limit ? String(offset + f.limit) : null };
}

function checkGoal(db: Db, goal: string | null | undefined, project: string): void {
  if (goal === null || goal === undefined) return;
  const g = goalRow(db, goal);
  if (!g || g.project !== project) throw invalid("goal_invalid", "goal must be a goal of the same project");
}

/** Would `issue` depending on `dependsOn` close a cycle? (DFS from dependsOn along its own dependencies.) */
function wouldCycle(db: Db, issue: string, dependsOnId: string): boolean {
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length) {
    const cur = stack.pop() as string;
    if (cur === issue) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...dependsOn(db, cur));
  }
  return false;
}

function checkLink(db: Db, issue: Row, target: string): void {
  if (target === issue.id) throw invalid("link_invalid", "an issue cannot depend on itself");
  const t = issueRow(db, target);
  if (!t || t.project !== issue.project) throw invalid("link_invalid", "a dependency must be an issue of the same project");
  if (wouldCycle(db, String(issue.id), target)) throw invalid("link_cycle", "this dependency would create a cycle");
}

/** Logs `promoted` on each listed issue that is ready now and was not before. */
function promote(db: Db, before: Map<string, boolean>, actor: Actor, cause: string, now: number): string[] {
  const out: string[] = [];
  for (const [id, was] of before) {
    const r = issueRow(db, id);
    if (!r || was || !isReady(db, id, String(r.status))) continue;
    logActivity(db, { project: String(r.project), issue: id, actor, kind: "promoted", summary: `Ready: ${cause}` }, now);
    out.push(id);
  }
  return out;
}
const readiness = (db: Db, ids: readonly string[]) => new Map(ids.map((d) => [d, isReady(db, d)]));

export interface IssueInput {
  project: string;
  title: string;
  summary?: string;
  status?: Status;
  priority?: Priority;
  assignee?: { kind: "agent" | "owner"; id: string } | null;
  goal?: string | null;
  template?: string;
  dependsOn?: readonly string[];
}
export function createIssue(db: Db, i: IssueInput, actor: Actor, now = Date.now()): IssueView {
  if (!projectRow(db, i.project)) throw notFound("project");
  checkGoal(db, i.goal, i.project);
  const id = `iss_${ulid(now)}`;
  const status = i.status ?? "todo";
  db.prepare(
    `INSERT INTO issues (id, project, title, summary, status, priority, assignee_kind, assignee_id, goal, template, blocked_reason, result,
       created_by_kind, created_by_id, created_by_name, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    i.project,
    i.title,
    i.summary ?? "",
    status,
    i.priority ?? "medium",
    i.assignee?.kind ?? null,
    i.assignee?.id ?? null,
    i.goal ?? null,
    i.template ?? null,
    actor.kind,
    actor.id,
    actor.name,
    now,
    now,
    status === "done" ? now : null,
  );
  const row = issueRow(db, id) as Row;
  for (const d of new Set(i.dependsOn ?? [])) {
    checkLink(db, row, d);
    db.prepare("INSERT INTO issue_links (issue, depends_on, created_at) VALUES (?, ?, ?)").run(id, d, now);
  }
  const who = i.assignee ? ` for ${actorOf(db, i.assignee.kind, i.assignee.id).name}` : "";
  logActivity(db, { project: i.project, issue: id, actor, kind: "issue_created", summary: `Created "${i.title}" in ${status}${who}` }, now);
  return toIssue(db, issueRow(db, id) as Row);
}

export interface IssuePatch {
  title?: string;
  summary?: string;
  status?: Status;
  priority?: Priority;
  assignee?: { kind: "agent" | "owner"; id: string } | null;
  goal?: string | null;
  blockedReason?: string;
  result?: string;
}
/** One update = one activity record listing the changed fields; no-op changes write nothing. Leaving `blocked` clears
 *  the reason; leaving `done` clears completedAt (reopen) — dependents stop being ready, computed. */
export function updateIssue(db: Db, id: string, p: IssuePatch, actor: Actor, now = Date.now()): { issue: IssueView; promoted: string[] } {
  const r = issueRow(db, id);
  if (!r) throw notFound("issue");
  const project = String(r.project);
  if (p.goal !== undefined) checkGoal(db, p.goal, project);
  const next = {
    title: p.title ?? String(r.title),
    summary: p.summary ?? String(r.summary),
    status: p.status ?? (String(r.status) as Status),
    priority: p.priority ?? String(r.priority),
    assigneeKind: p.assignee === undefined ? strOrNull(r.assignee_kind) : (p.assignee?.kind ?? null),
    assigneeId: p.assignee === undefined ? strOrNull(r.assignee_id) : (p.assignee?.id ?? null),
    goal: p.goal === undefined ? strOrNull(r.goal) : p.goal,
    blockedReason: strOrNull(r.blocked_reason),
    result: strOrNull(r.result),
    completedAt: r.completed_at === null || r.completed_at === undefined ? null : Number(r.completed_at),
  };
  if (next.status === "blocked") next.blockedReason = p.blockedReason ?? next.blockedReason;
  else next.blockedReason = null;
  if (next.status === "done") {
    if (p.result !== undefined) next.result = p.result;
    if (r.status !== "done") next.completedAt = now;
  } else {
    next.completedAt = null;
    next.result = null;
  }

  const changes: string[] = [];
  if (next.title !== r.title) changes.push("title");
  if (next.summary !== r.summary) changes.push("summary");
  if (next.status !== r.status) changes.push(`status ${String(r.status)} → ${next.status}`);
  if (next.priority !== r.priority) changes.push(`priority ${next.priority}`);
  if (next.assigneeKind !== strOrNull(r.assignee_kind) || next.assigneeId !== strOrNull(r.assignee_id))
    changes.push(next.assigneeKind ? `assigned to ${actorOf(db, next.assigneeKind, next.assigneeId).name}` : "unassigned");
  if (next.goal !== strOrNull(r.goal)) changes.push(next.goal ? "goal set" : "goal cleared");
  if (next.blockedReason !== strOrNull(r.blocked_reason) && next.blockedReason) changes.push(`blocked: ${next.blockedReason}`);
  if (next.result !== strOrNull(r.result)) changes.push(next.result ? `result: ${next.result.split("\n")[0]}` : "result cleared");
  if (changes.length === 0) return { issue: toIssue(db, r), promoted: [] };

  const deps = dependents(db, id);
  const before = readiness(db, deps);
  db.prepare(
    `UPDATE issues SET title = ?, summary = ?, status = ?, priority = ?, assignee_kind = ?, assignee_id = ?, goal = ?, blocked_reason = ?,
       result = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(next.title, next.summary, next.status, next.priority, next.assigneeKind, next.assigneeId, next.goal, next.blockedReason, next.result, next.completedAt, now, id);
  const kind = next.status !== r.status ? (next.status === "done" ? "completed" : next.status === "blocked" ? "blocked" : "moved") : "updated";
  logActivity(db, { project, issue: id, actor, kind, summary: changes.join("; ") }, now);
  const promoted = promote(db, before, actor, `"${next.title}" is done`, now);
  return { issue: toIssue(db, issueRow(db, id) as Row), promoted };
}

export function linkIssue(db: Db, id: string, target: string, actor: Actor, now = Date.now()): IssueView {
  const r = issueRow(db, id);
  if (!r) throw notFound("issue");
  checkLink(db, r, target);
  const added = db.prepare("INSERT OR IGNORE INTO issue_links (issue, depends_on, created_at) VALUES (?, ?, ?)").run(id, target, now).changes > 0;
  if (added) {
    const t = issueRow(db, target) as Row;
    db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, id);
    logActivity(db, { project: String(r.project), issue: id, actor, kind: "linked", summary: `Depends on "${String(t.title)}"` }, now);
  }
  return toIssue(db, issueRow(db, id) as Row);
}
export function unlinkIssue(db: Db, id: string, target: string, actor: Actor, now = Date.now()): IssueView {
  const r = issueRow(db, id);
  if (!r) throw notFound("issue");
  const before = readiness(db, [id]);
  const removed = db.prepare("DELETE FROM issue_links WHERE issue = ? AND depends_on = ?").run(id, target).changes > 0;
  if (removed) {
    const t = issueRow(db, target);
    db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, id);
    logActivity(db, { project: String(r.project), issue: id, actor, kind: "unlinked", summary: `No longer depends on "${t ? String(t.title) : target}"` }, now);
    promote(db, before, actor, "a dependency was removed", now);
  }
  return toIssue(db, issueRow(db, id) as Row);
}

export function addComment(db: Db, id: string, body: string, actor: Actor, now = Date.now()): CommentView {
  const r = issueRow(db, id);
  if (!r) throw notFound("issue");
  const text = body.trim();
  if (!text) throw invalid("comment_empty", "comment body is empty");
  const cid = `cmt_${ulid(now)}`;
  db.prepare("INSERT INTO comments (id, issue, author_kind, author_id, author_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    cid,
    id,
    actor.kind,
    actor.id,
    actor.name,
    text,
    now,
  );
  db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, id);
  logActivity(db, { project: String(r.project), issue: id, actor, kind: "commented", summary: `Comment: ${text.split("\n")[0]}` }, now);
  return { id: cid, issue: id, author: actor, body: text, createdAt: iso(now) };
}
export function listComments(db: Db, id: string): CommentView[] {
  return db
    .prepare("SELECT * FROM comments WHERE issue = ? ORDER BY created_at, id")
    .all(id)
    .map((c) => ({ id: String(c.id), issue: id, author: actorOf(db, c.author_kind, c.author_id, c.author_name), body: String(c.body), createdAt: iso(c.created_at) }));
}

export function linkDocument(db: Db, id: string, doc: DocRef, actor: Actor, now = Date.now()): IssueView {
  const r = issueRow(db, id);
  if (!r) throw notFound("issue");
  db.prepare("INSERT INTO issue_documents (issue, document, title, linked_at) VALUES (?, ?, ?, ?) ON CONFLICT (issue, document) DO UPDATE SET title = excluded.title").run(
    id,
    doc.id,
    doc.title,
    now,
  );
  logActivity(db, { project: String(r.project), issue: id, actor, kind: "document_linked", summary: `Document "${doc.title}" linked` }, now);
  return toIssue(db, issueRow(db, id) as Row);
}
export function unlinkDocument(db: Db, id: string, document: string, actor: Actor, now = Date.now()): IssueView {
  const r = issueRow(db, id);
  if (!r) throw notFound("issue");
  if (db.prepare("DELETE FROM issue_documents WHERE issue = ? AND document = ?").run(id, document).changes > 0)
    logActivity(db, { project: String(r.project), issue: id, actor, kind: "document_unlinked", summary: "Document unlinked" }, now);
  return toIssue(db, issueRow(db, id) as Row);
}

function purgeIssue(db: Db, id: string): void {
  db.prepare("DELETE FROM issue_links WHERE issue = ? OR depends_on = ?").run(id, id);
  db.prepare("DELETE FROM comments WHERE issue = ?").run(id);
  db.prepare("DELETE FROM issue_documents WHERE issue = ?").run(id);
  db.prepare("DELETE FROM activity WHERE issue = ?").run(id);
  db.prepare("DELETE FROM issues WHERE id = ?").run(id);
}
/** Deletes the issue, its comments, references and activity; dependents lose the link (and may become ready). */
export function deleteIssue(db: Db, id: string, actor: Actor, now = Date.now()): void {
  const r = issueRow(db, id);
  if (!r) throw notFound("issue");
  const before = readiness(db, dependents(db, id));
  purgeIssue(db, id);
  logActivity(db, { project: String(r.project), issue: null, actor, kind: "issue_deleted", summary: `Deleted "${String(r.title)}"` }, now);
  promote(db, before, actor, `dependency "${String(r.title)}" was deleted`, now);
}
