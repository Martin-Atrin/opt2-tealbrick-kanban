// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. This file registers exactly one handler
// per manifest operation id, plus the agent directory events. Op ids and I/O types come from the generated kit (#kit).
//
// Access: a project is the scope instance (type `project`). Ops that name a project let the SDK check it (`scope`
// returns the id). Ops that name an issue or goal return null ("across projects"), and the handler checks the
// project that owns the row with ctx.scope.can (unreadable = not found, so nothing leaks). Person calls (the owner's
// board UI) may act on every project.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type CrudAction, ulid } from "@opt2-tealbrick/manifest";
import { type AppDefinition, defineApp, type HandlerSpec, type OpContext, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type ActivityListInput,
  type BoardCommentAddInput,
  type BoardGoalCreateInput,
  type BoardGoalUpdateInput,
  type BoardIssueCreateInput,
  type BoardIssueDeleteInput,
  type BoardIssueInput,
  type BoardIssueLinkInput,
  type BoardIssueUpdateInput,
  type BoardProjectCreateInput,
  type BoardProjectDeleteInput,
  type BoardProjectUpdateInput,
  type BoardViewInput,
  type GoalCreateInput,
  type GoalDeleteInput,
  type GoalsListInput,
  type GoalUpdateInput,
  type IssueBlockInput,
  type IssueCommentAddInput,
  type IssueCompleteInput,
  type IssueCreateInput,
  type IssueDeleteInput,
  type IssueDocumentLinkInput,
  type IssueDocumentUnlinkInput,
  type IssueGetInput,
  type IssueLinkInput,
  type IssuesListInput,
  type IssueUnlinkInput,
  type IssueUpdateInput,
  OP,
  type OpId,
  type ProjectDeleteInput,
  type ProjectGetInput,
  type ProjectUpdateInput,
  type WorkNextInput,
} from "#kit";
import {
  type Actor,
  addComment,
  createGoal,
  createIssue,
  deactivateAgent,
  deleteGoal,
  deleteIssue,
  deleteProject,
  dependents,
  ensureOwnProject,
  getGoal,
  getProject,
  goalRow,
  insertProject,
  issueRow,
  linkDocument,
  linkIssue,
  listActivity,
  listAgents,
  listComments,
  listGoals,
  listIssues,
  listProjects,
  notFound,
  OWNER_NAME,
  PROJECT_SCOPE,
  projectRow,
  resolveAssignee,
  toIssue,
  unlinkDocument,
  unlinkIssue,
  updateGoal,
  updateIssue,
  updateProject,
  upsertAgent,
} from "./board.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

/** The verified caller as a board actor (never a caller-chosen label). */
export function actorOf(ctx: Pick<OpContext, "caller">): Actor {
  const c = ctx.caller;
  if (c.type === "person") return { kind: "owner", id: c.id, name: OWNER_NAME };
  return { kind: c.type, id: c.id, name: c.name };
}

/** Per agent/app call: keep the directory name current and make sure the caller's own project row exists (also
 *  after the caller deleted it: the scope instance label is restored). */
async function prepare(ctx: OpContext): Promise<Actor> {
  const a = actorOf(ctx);
  if (a.kind === "agent") upsertAgent(ctx.db, { id: a.id, name: a.name, mode: ctx.caller.mode ?? "free" });
  if (a.kind !== "owner" && ensureOwnProject(ctx.db, a)) await ctx.scopes.instances.create(PROJECT_SCOPE, a.id, `${a.name} work`.slice(0, 80), { ownerAgent: a.id as never });
  return a;
}
/** Free text after trim must not be empty (the schema checks only the raw length). */
function text(v: string, field: string): string {
  const t = v.trim();
  if (!t) throw new TbError(`${field}_empty`, `${field} is empty`, 400);
  return t;
}

const tx = <T>(ctx: OpContext, fn: () => T): T => ctx.db.transaction(fn);

async function needProject(ctx: OpContext, id: string, crud: CrudAction): Promise<void> {
  if (!projectRow(ctx.db, id) || !(await ctx.scope.can(PROJECT_SCOPE, id, "read"))) throw notFound("project");
  if (crud !== "read" && !(await ctx.scope.can(PROJECT_SCOPE, id, crud))) throw new TbError("scope_denied", `no ${crud} access to this project`, 403);
}
async function needIssue(ctx: OpContext, id: string, crud: CrudAction): Promise<Record<string, unknown>> {
  const r = issueRow(ctx.db, id);
  if (!r || !(await ctx.scope.can(PROJECT_SCOPE, String(r.project), "read"))) throw notFound("issue");
  await needProject(ctx, String(r.project), crud);
  return r;
}
async function needGoal(ctx: OpContext, id: string, crud: CrudAction): Promise<Record<string, unknown>> {
  const r = goalRow(ctx.db, id);
  if (!r || !(await ctx.scope.can(PROJECT_SCOPE, String(r.project), "read"))) throw notFound("goal");
  await needProject(ctx, String(r.project), crud);
  return r;
}
async function readable(ctx: OpContext, project?: string): Promise<string[]> {
  if (project) {
    await needProject(ctx, project, "read");
    return [project];
  }
  return ctx.scope.readable(PROJECT_SCOPE);
}
/** Default project for agent-side creates: the caller's own (id = caller id). */
const ownOr = (project: string | undefined, caller: { id: string }) => project ?? caller.id;
const assignee = (ctx: OpContext, a: string | null | undefined, who: Actor) =>
  a === undefined ? undefined : a === null ? null : resolveAssignee(ctx.db, a, who);

const sayIssue = (i: { issue: string }) => `issue ${i.issue}`;

export const handlers = {
  // ------------------------------------------------------------ projects
  [OP.projectsList]: op<Record<string, never>, unknown>({
    scope: () => null,
    async run(_input, ctx) {
      await prepare(ctx);
      return { projects: listProjects(ctx.db, await ctx.scope.readable(PROJECT_SCOPE), ctx.caller.id) };
    },
  }),
  [OP.projectGet]: op<ProjectGetInput, unknown>({
    scope: (i) => i.project,
    async run(i, ctx) {
      await prepare(ctx);
      await needProject(ctx, i.project, "read");
      return { project: getProject(ctx.db, i.project), goals: listGoals(ctx.db, [i.project]) };
    },
  }),
  [OP.projectUpdate]: op<ProjectUpdateInput, unknown>({
    scope: (i) => i.project,
    redact: (i) => `project ${i.project}`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needProject(ctx, i.project, "update");
      const p = tx(ctx, () => updateProject(ctx.db, i.project, { name: i.name, summary: i.summary }, a));
      await ctx.scopes.instances.create(PROJECT_SCOPE, p.id, p.name, { shared: p.shared });
      return { project: p };
    },
  }),
  [OP.projectDelete]: op<ProjectDeleteInput, unknown>({
    scope: (i) => i.project,
    redact: (i) => `project ${i.project}`,
    holdView: (i) => `Delete project ${i.project} with all its goals, issues, comments and activity.`,
    async run(i, ctx) {
      await prepare(ctx);
      await needProject(ctx, i.project, "delete");
      const p = getProject(ctx.db, i.project);
      tx(ctx, () => deleteProject(ctx.db, i.project));
      if (p) await ctx.scopes.instances.create(PROJECT_SCOPE, p.id, `${p.name} (deleted)`.slice(0, 80), { shared: false });
      return { ok: true };
    },
  }),

  // ------------------------------------------------------------ goals
  [OP.goalsList]: op<GoalsListInput, unknown>({
    scope: (i) => i.project ?? null,
    async run(i, ctx) {
      await prepare(ctx);
      return { goals: listGoals(ctx.db, await readable(ctx, i.project), i.status) };
    },
  }),
  [OP.goalCreate]: op<GoalCreateInput, unknown>({
    scope: (i, c) => ownOr(i.project, c),
    redact: (i) => `goal "${i.title.slice(0, 80)}"`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      const project = ownOr(i.project, ctx.caller);
      await needProject(ctx, project, "create");
      return { goal: tx(ctx, () => createGoal(ctx.db, { project, title: i.title, summary: i.summary, horizon: i.horizon }, a)) };
    },
  }),
  [OP.goalUpdate]: op<GoalUpdateInput, unknown>({
    scope: () => null,
    redact: (i) => `goal ${i.goal}`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needGoal(ctx, i.goal, "update");
      return { goal: tx(ctx, () => updateGoal(ctx.db, i.goal, i, a)) };
    },
  }),
  [OP.goalDelete]: op<GoalDeleteInput, unknown>({
    scope: () => null,
    redact: (i) => `goal ${i.goal}`,
    holdView: (i) => `Delete goal ${i.goal}. Its issues stay and lose the goal link.`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needGoal(ctx, i.goal, "delete");
      tx(ctx, () => deleteGoal(ctx.db, i.goal, a));
      return { ok: true };
    },
  }),

  // ------------------------------------------------------------ issues
  [OP.issuesList]: op<IssuesListInput, unknown>({
    scope: (i) => i.project ?? null,
    async run(i, ctx) {
      const a = await prepare(ctx);
      return listIssues(ctx.db, {
        projects: await readable(ctx, i.project),
        status: i.status,
        assignee: i.assignee === undefined ? undefined : resolveAssignee(ctx.db, i.assignee, a, true),
        goal: i.goal,
        template: i.template,
        ready: i.ready,
        limit: i.limit ?? 50,
        cursor: i.cursor,
      });
    },
  }),
  [OP.issueGet]: op<IssueGetInput, unknown>({
    scope: () => null,
    async run(i, ctx) {
      await prepare(ctx);
      const r = await needIssue(ctx, i.issue, "read");
      return { issue: toIssue(ctx.db, r), dependents: dependents(ctx.db, i.issue), comments: listComments(ctx.db, i.issue) };
    },
  }),
  [OP.issueCreate]: op<IssueCreateInput, unknown>({
    scope: (i, c) => ownOr(i.project, c),
    redact: (i) => `issue "${i.title.slice(0, 80)}"`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      const project = ownOr(i.project, ctx.caller);
      await needProject(ctx, project, "create");
      const who = assignee(ctx, i.assignee, a);
      return { issue: tx(ctx, () => createIssue(ctx.db, { ...i, project, assignee: who }, a)) };
    },
  }),
  [OP.issueUpdate]: op<IssueUpdateInput, unknown>({
    scope: () => null,
    redact: sayIssue,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "update");
      const { issue: _id, assignee: as, ...rest } = i;
      return { issue: tx(ctx, () => updateIssue(ctx.db, i.issue, { ...rest, assignee: assignee(ctx, as, a) }, a)).issue };
    },
  }),
  [OP.issueCommentAdd]: op<IssueCommentAddInput, unknown>({
    scope: () => null,
    redact: sayIssue,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "create");
      return { comment: tx(ctx, () => addComment(ctx.db, i.issue, i.body, a)) };
    },
  }),
  [OP.issueLink]: op<IssueLinkInput, unknown>({
    scope: () => null,
    redact: (i) => `issue ${i.issue} depends on ${i.dependsOn}`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "update");
      return { issue: tx(ctx, () => linkIssue(ctx.db, i.issue, i.dependsOn, a)) };
    },
  }),
  [OP.issueUnlink]: op<IssueUnlinkInput, unknown>({
    scope: () => null,
    redact: (i) => `issue ${i.issue} no longer depends on ${i.dependsOn}`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "update");
      return { issue: tx(ctx, () => unlinkIssue(ctx.db, i.issue, i.dependsOn, a)) };
    },
  }),
  [OP.issueBlock]: op<IssueBlockInput, unknown>({
    scope: () => null,
    redact: sayIssue,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "update");
      return { issue: tx(ctx, () => updateIssue(ctx.db, i.issue, { status: "blocked", blockedReason: text(i.reason, "reason") }, a)).issue };
    },
  }),
  [OP.issueComplete]: op<IssueCompleteInput, unknown>({
    scope: () => null,
    redact: sayIssue,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "update");
      return tx(ctx, () => updateIssue(ctx.db, i.issue, { status: "done", result: text(i.result, "result") }, a));
    },
  }),
  [OP.issueDelete]: op<IssueDeleteInput, unknown>({
    scope: () => null,
    redact: sayIssue,
    holdView: (i) => `Delete issue ${i.issue} with its comments and activity.`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "delete");
      tx(ctx, () => deleteIssue(ctx.db, i.issue, a));
      return { ok: true };
    },
  }),
  [OP.activityList]: op<ActivityListInput, unknown>({
    scope: (i) => i.project ?? null,
    async run(i, ctx) {
      await prepare(ctx);
      if (i.issue) {
        const r = await needIssue(ctx, i.issue, "read");
        if (i.project && i.project !== r.project) throw notFound("issue");
        return listActivity(ctx.db, { projects: [String(r.project)], issue: i.issue, limit: i.limit ?? 50, cursor: i.cursor });
      }
      return listActivity(ctx.db, { projects: await readable(ctx, i.project), limit: i.limit ?? 50, cursor: i.cursor });
    },
  }),
  [OP.workNext]: op<WorkNextInput, unknown>({
    scope: () => null,
    async run(i, ctx) {
      const a = await prepare(ctx);
      if (a.kind !== "agent") return { ready: [], inProgress: [] };
      const projects = await ctx.scope.readable(PROJECT_SCOPE);
      const me = { kind: "agent" as const, id: a.id };
      const limit = i.limit ?? 20;
      return {
        ready: listIssues(ctx.db, { projects, assignee: me, ready: true, limit }).issues,
        inProgress: listIssues(ctx.db, { projects, assignee: me, status: "in_progress", limit }).issues,
      };
    },
  }),
  [OP.issueDocumentLink]: op<IssueDocumentLinkInput, unknown>({
    scope: () => null,
    redact: (i) => `issue ${i.issue}: document ${i.document}`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "update");
      // C88: the agent supplies the title (it read the document with its own grant); Kanban never reads Knowledge for it.
      return { issue: tx(ctx, () => linkDocument(ctx.db, i.issue, { id: i.document, title: text(i.title, "title") }, a)) };
    },
  }),
  [OP.issueDocumentUnlink]: op<IssueDocumentUnlinkInput, unknown>({
    scope: () => null,
    redact: (i) => `issue ${i.issue}: document ${i.document}`,
    async run(i, ctx) {
      const a = await prepare(ctx);
      await needIssue(ctx, i.issue, "update");
      return { issue: tx(ctx, () => unlinkDocument(ctx.db, i.issue, i.document, a)) };
    },
  }),

  // ------------------------------------------------------------ owner board (person ops)
  [OP.boardView]: op<BoardViewInput, unknown>({
    async run(i, ctx) {
      const projects = listProjects(ctx.db, null);
      const project = i.project && projectRow(ctx.db, i.project) ? i.project : (projects[0]?.id ?? null);
      return {
        projects,
        agents: listAgents(ctx.db),
        project,
        issues: project ? listIssues(ctx.db, { projects: [project], limit: 1000 }).issues : [],
        goals: project ? listGoals(ctx.db, [project]) : [],
        activity: project ? listActivity(ctx.db, { projects: [project], limit: 50 }).activity : [],
      };
    },
  }),
  [OP.boardIssue]: op<BoardIssueInput, unknown>({
    async run(i, ctx) {
      const r = issueRow(ctx.db, i.issue);
      if (!r) throw notFound("issue");
      return {
        issue: toIssue(ctx.db, r),
        dependents: dependents(ctx.db, i.issue),
        comments: listComments(ctx.db, i.issue),
        activity: listActivity(ctx.db, { projects: [String(r.project)], issue: i.issue, limit: 100 }).activity,
      };
    },
  }),
  [OP.boardProjectCreate]: op<BoardProjectCreateInput, unknown>({
    async run(i, ctx) {
      const shared = i.shared ?? true;
      const p = tx(ctx, () => insertProject(ctx.db, { id: newProjectId(), name: i.name, summary: i.summary, shared, ownerAgent: null }, actorOf(ctx)));
      await ctx.scopes.instances.create(PROJECT_SCOPE, p.id, p.name, { shared });
      return { project: p };
    },
  }),
  [OP.boardProjectUpdate]: op<BoardProjectUpdateInput, unknown>({
    async run(i, ctx) {
      const p = tx(ctx, () => updateProject(ctx.db, i.project, i, actorOf(ctx)));
      await ctx.scopes.instances.create(PROJECT_SCOPE, p.id, p.name, { shared: p.shared });
      return { project: p };
    },
  }),
  [OP.boardProjectDelete]: op<BoardProjectDeleteInput, unknown>({
    async run(i, ctx) {
      const p = getProject(ctx.db, i.project);
      if (!p) throw notFound("project");
      tx(ctx, () => deleteProject(ctx.db, i.project));
      await ctx.scopes.instances.create(PROJECT_SCOPE, p.id, `${p.name} (deleted)`.slice(0, 80), { shared: false });
      return { ok: true };
    },
  }),
  [OP.boardGoalCreate]: op<BoardGoalCreateInput, unknown>({
    async run(i, ctx) {
      return { goal: tx(ctx, () => createGoal(ctx.db, i, actorOf(ctx))) };
    },
  }),
  [OP.boardGoalUpdate]: op<BoardGoalUpdateInput, unknown>({
    async run(i, ctx) {
      if (!getGoal(ctx.db, i.goal)) throw notFound("goal");
      return { goal: tx(ctx, () => updateGoal(ctx.db, i.goal, i, actorOf(ctx))) };
    },
  }),
  [OP.boardIssueCreate]: op<BoardIssueCreateInput, unknown>({
    async run(i, ctx) {
      const a = actorOf(ctx);
      return { issue: tx(ctx, () => createIssue(ctx.db, { ...i, assignee: assignee(ctx, i.assignee, a) }, a)) };
    },
  }),
  [OP.boardIssueUpdate]: op<BoardIssueUpdateInput, unknown>({
    async run(i, ctx) {
      const a = actorOf(ctx);
      const { issue: _id, assignee: as, ...rest } = i;
      return { issue: tx(ctx, () => updateIssue(ctx.db, i.issue, { ...rest, assignee: assignee(ctx, as, a) }, a)).issue };
    },
  }),
  [OP.boardIssueLink]: op<BoardIssueLinkInput, unknown>({
    async run(i, ctx) {
      const a = actorOf(ctx);
      return { issue: tx(ctx, () => (i.remove ? unlinkIssue(ctx.db, i.issue, i.dependsOn, a) : linkIssue(ctx.db, i.issue, i.dependsOn, a))) };
    },
  }),
  [OP.boardCommentAdd]: op<BoardCommentAddInput, unknown>({
    async run(i, ctx) {
      return { comment: tx(ctx, () => addComment(ctx.db, i.issue, i.body, actorOf(ctx))) };
    },
  }),
  [OP.boardIssueDelete]: op<BoardIssueDeleteInput, unknown>({
    async run(i, ctx) {
      tx(ctx, () => deleteIssue(ctx.db, i.issue, actorOf(ctx)));
      return { ok: true };
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

const newProjectId = () => `prj_${ulid()}`;

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
  events: {
    // needsAgentDirectory: every workspace agent appears here once (first sight). Keep the assignee directory and
    // create the agent's own project (scope instance id = agent id); the SDK then applies the `own` + `shared` grants.
    async agentAdded(agent, ctx) {
      ctx.db.transaction(() => {
        upsertAgent(ctx.db, agent);
        ensureOwnProject(ctx.db, agent);
      });
      await ctx.scopes.instances.create(PROJECT_SCOPE, agent.id, `${agent.name} work`.slice(0, 80), { ownerAgent: agent.id });
    },
    async agentRemoved(agent, ctx) {
      deactivateAgent(ctx.db, agent.id);
    },
  },
};

export const app = defineApp(definition);
