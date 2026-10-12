// Store rules: one status vocabulary, computed "ready", promotion on completion/unlink/delete, dependency checks,
// assignee resolution, activity records and list order.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Actor,
  addComment,
  createGoal,
  createIssue,
  deleteIssue,
  ensureOwnProject,
  insertProject,
  isReady,
  linkIssue,
  listActivity,
  listIssues,
  resolveAssignee,
  unlinkIssue,
  updateIssue,
  upsertAgent,
} from "../src/board.ts";
import { migratedDb } from "./helpers.ts";

const A: Actor = { kind: "agent", id: "agt_01J00000000000000000000AAA", name: "Agent A" };
const B: Actor = { kind: "agent", id: "agt_01J00000000000000000000BBB", name: "Agent B" };
const OWNER: Actor = { kind: "owner", id: "per_01J00000000000000000000OWN", name: "Owner" };

function board() {
  const db = migratedDb();
  upsertAgent(db, { id: A.id, name: A.name, mode: "free" });
  upsertAgent(db, { id: B.id, name: B.name, mode: "free" });
  insertProject(db, { id: "prj_1", name: "Launch", shared: true, ownerAgent: null }, OWNER);
  insertProject(db, { id: "prj_2", name: "Other", shared: true, ownerAgent: null }, OWNER);
  return db;
}

test("ready = todo with every dependency done; completing the dependency promotes; reopening demotes", () => {
  const db = board();
  const parent = createIssue(db, { project: "prj_1", title: "Write spec" }, A);
  const child = createIssue(db, { project: "prj_1", title: "Build it", dependsOn: [parent.id] }, A);
  const backlog = createIssue(db, { project: "prj_1", title: "Later", status: "backlog", dependsOn: [parent.id] }, A);
  assert.equal(parent.ready, true, "no dependencies = ready");
  assert.equal(child.ready, false);
  assert.deepEqual(child.dependsOn, [parent.id]);

  const done = updateIssue(db, parent.id, { status: "done", result: "spec in docs/spec.md" }, B);
  assert.equal(done.issue.status, "done");
  assert.ok(done.issue.completedAt);
  assert.deepEqual(done.promoted, [child.id], "only the todo dependent is promoted, not the backlog one");
  assert.equal(isReady(db, child.id), true);
  assert.equal(isReady(db, backlog.id), false);
  const promoted = listActivity(db, { projects: ["prj_1"], issue: child.id, limit: 10 }).activity;
  assert.equal(promoted[0]?.kind, "promoted");
  assert.equal(promoted[0]?.actor.name, "Agent B");

  const reopened = updateIssue(db, parent.id, { status: "in_progress" }, B);
  assert.equal(reopened.issue.completedAt, null);
  assert.equal(isReady(db, child.id), false, "reopened dependency = not ready again");
});

test("a child with two dependencies is ready only when both are done", () => {
  const db = board();
  const p1 = createIssue(db, { project: "prj_1", title: "p1" }, A);
  const p2 = createIssue(db, { project: "prj_1", title: "p2" }, A);
  const c = createIssue(db, { project: "prj_1", title: "c", dependsOn: [p1.id, p2.id] }, A);
  assert.deepEqual(updateIssue(db, p1.id, { status: "done" }, A).promoted, []);
  assert.equal(isReady(db, c.id), false);
  assert.deepEqual(updateIssue(db, p2.id, { status: "done" }, A).promoted, [c.id]);
});

test("links: no self link, no cross-project link, no cycle; unlink and delete promote", () => {
  const db = board();
  const a = createIssue(db, { project: "prj_1", title: "a" }, A);
  const b = createIssue(db, { project: "prj_1", title: "b", dependsOn: [a.id] }, A);
  const c = createIssue(db, { project: "prj_1", title: "c", dependsOn: [b.id] }, A);
  const far = createIssue(db, { project: "prj_2", title: "far" }, A);
  assert.throws(() => linkIssue(db, a.id, a.id, A), { code: "link_invalid" });
  assert.throws(() => linkIssue(db, a.id, far.id, A), { code: "link_invalid" });
  assert.throws(() => linkIssue(db, a.id, c.id, A), { code: "link_cycle" });
  assert.throws(() => createIssue(db, { project: "prj_1", title: "x", dependsOn: ["iss_missing"] }, A), { code: "link_invalid" });

  // unlink: c loses its only open dependency -> ready + promoted
  const u = unlinkIssue(db, c.id, b.id, B);
  assert.equal(u.ready, true);
  assert.equal(listActivity(db, { projects: ["prj_1"], issue: c.id, limit: 1 }).activity[0]?.kind, "promoted");

  // delete: b's dependency a is deleted -> b ready + promoted; links to a are gone
  deleteIssue(db, a.id, OWNER);
  assert.equal(isReady(db, b.id), true);
  assert.equal(listIssues(db, { projects: ["prj_1"], limit: 10 }).issues.find((i) => i.id === b.id)?.dependsOn.length, 0);
});

test("assignee: me, owner or a known active agent; names come from the directory", () => {
  const db = board();
  assert.deepEqual(resolveAssignee(db, "me", A), { kind: "agent", id: A.id });
  assert.deepEqual(resolveAssignee(db, "me", OWNER), { kind: "owner", id: "owner" });
  assert.deepEqual(resolveAssignee(db, "owner", A), { kind: "owner", id: "owner" });
  assert.deepEqual(resolveAssignee(db, B.id, A), { kind: "agent", id: B.id });
  assert.throws(() => resolveAssignee(db, "agt_unknown", A), { code: "assignee_unknown" });
  assert.throws(() => resolveAssignee(db, "me", { kind: "app", id: "ins_x", name: "Observer" }), { code: "assignee_invalid" });

  const i = createIssue(db, { project: "prj_1", title: "t", assignee: { kind: "agent", id: B.id } }, A);
  assert.deepEqual(i.assignee, { kind: "agent", id: B.id, name: "Agent B" });
  upsertAgent(db, { id: B.id, name: "Agent B (renamed)", mode: "bound" });
  assert.equal(listIssues(db, { projects: ["prj_1"], limit: 5 }).issues[0]?.assignee?.name, "Agent B (renamed)");
});

test("activity: one record per real update listing the changes; no-op writes nothing; comments carry the verified author", () => {
  const db = board();
  const i = createIssue(db, { project: "prj_1", title: "t" }, A);
  const count = () => listActivity(db, { projects: ["prj_1"], issue: i.id, limit: 100 }).activity.length;
  const n0 = count();
  updateIssue(db, i.id, { title: "t", priority: "medium" }, A);
  assert.equal(count(), n0, "no-op update");
  updateIssue(db, i.id, { status: "blocked", blockedReason: "Need the API key decision", priority: "high" }, A);
  const last = listActivity(db, { projects: ["prj_1"], issue: i.id, limit: 1 }).activity[0];
  assert.equal(last?.kind, "blocked");
  assert.match(last?.summary ?? "", /status todo → blocked; priority high; blocked: Need the API key decision/);
  const moved = updateIssue(db, i.id, { status: "todo" }, A).issue;
  assert.equal(moved.blockedReason, null, "leaving blocked clears the reason");
  const c = addComment(db, i.id, "  found the root cause  ", B);
  assert.equal(c.body, "found the root cause");
  assert.deepEqual(c.author, B);
  assert.throws(() => addComment(db, i.id, "   ", B), { code: "comment_empty" });
});

test("list order: priority high first, then oldest; ready filter; cursor pages", () => {
  const db = board();
  const t0 = Date.now();
  const low = createIssue(db, { project: "prj_1", title: "low", priority: "low" }, A, t0);
  const high = createIssue(db, { project: "prj_1", title: "high", priority: "high" }, A, t0 + 1);
  const med1 = createIssue(db, { project: "prj_1", title: "med1" }, A, t0 + 2);
  const med2 = createIssue(db, { project: "prj_1", title: "med2", dependsOn: [low.id] }, A, t0 + 3);
  const all = listIssues(db, { projects: ["prj_1"], limit: 10 }).issues.map((i) => i.title);
  assert.deepEqual(all, ["high", "med1", "med2", "low"]);
  const ready = listIssues(db, { projects: ["prj_1"], ready: true, limit: 10 }).issues.map((i) => i.id);
  assert.deepEqual(ready, [high.id, med1.id, low.id]);
  assert.deepEqual(
    listIssues(db, { projects: ["prj_1"], ready: false, limit: 10 }).issues.map((i) => i.id),
    [med2.id],
  );
  const p1 = listIssues(db, { projects: ["prj_1"], limit: 2 });
  assert.equal(p1.cursor, "2");
  const p2 = listIssues(db, { projects: ["prj_1"], limit: 2, cursor: p1.cursor ?? undefined });
  assert.deepEqual(
    p2.issues.map((i) => i.title),
    ["med2", "low"],
  );
  assert.equal(p2.cursor, null);
  assert.throws(() => listIssues(db, { projects: ["prj_1"], limit: 2, cursor: "x" }), { code: "cursor_invalid" });
});

test("goals belong to one project; an issue's goal must be in its project", () => {
  const db = board();
  const g = createGoal(db, { project: "prj_1", title: "Ship v1", horizon: "short" }, OWNER);
  const i = createIssue(db, { project: "prj_1", title: "t", goal: g.id }, A);
  assert.equal(i.goal, g.id);
  assert.throws(() => createIssue(db, { project: "prj_2", title: "t", goal: g.id }, A), { code: "goal_invalid" });
  updateIssue(db, i.id, { status: "done" }, A);
});

test("own project: created once per agent or app caller", () => {
  const db = board();
  ensureOwnProject(db, A);
  ensureOwnProject(db, A);
  const n = db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(A.id);
  assert.equal(Number(n?.n), 1);
});
