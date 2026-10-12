// App: the manifest validates and matches the kit; it boots on the SDK (app-alone mode) and serves the derived routes;
// handlers enforce project access (unreadable = not found, read-only = scope_denied), log work under the verified
// caller, answer work_next, and resolve Knowledge document titles through the declared companion.
// Agent calls through a real bridge path are covered by `pnpm conformance`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { manifestDigest, validateManifest } from "@opt2-tealbrick/manifest";
import { defineApp, type HandlerSpec, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { MANIFEST_DIGEST, OP } from "#kit";
import { definition, handlers, manifest } from "../src/app.ts";
import { insertProject, upsertAgent } from "../src/board.ts";
import { CRUD, ctxFor, type FakeCaller, migratedDb } from "./helpers.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

const H = handlers as Record<string, HandlerSpec<any, any>>;
const call = (op: string, input: unknown, ctx: ReturnType<typeof ctxFor>) => (H[op] as HandlerSpec<any, any>).run(input as never, ctx);

const A: FakeCaller = { type: "agent", id: "agt_01J00000000000000000000AAA", name: "Agent A" };
const B: FakeCaller = { type: "agent", id: "agt_01J00000000000000000000BBB", name: "Agent B" };
const OWNER: FakeCaller = { type: "person", id: "per_01J00000000000000000000OWN", name: "Owner" };

test("manifest validates; kit matches; every operation has exactly one handler", () => {
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, v.ok ? "" : JSON.stringify(v.errors));
  assert.equal(MANIFEST_DIGEST, manifestDigest(manifest), "kit is stale: run node --run kit");
  const ids = manifest.operations.map((o) => o.id).sort();
  assert.deepEqual(Object.values(OP).sort(), ids);
  assert.deepEqual(Object.keys(handlers).sort(), ids);
});

test("manifest shape: 6-column status vocabulary, deletes destructive, creates idempotent, project scope own + shared", () => {
  const byId = new Map(manifest.operations.map((o) => [o.id, o]));
  const status = (byId.get("issue_update")?.input as any)?.properties?.status?.enum;
  assert.deepEqual(status, ["backlog", "todo", "in_progress", "in_review", "blocked", "done"]);
  for (const o of manifest.operations) {
    if (o.crud.includes("delete")) assert.equal(o.effect, "destructive", o.id);
    if (o.crud.includes("create")) assert.equal(o.idempotency, "required", o.id);
    if (o.audience === "agent") assert.equal(o.scopeType, "project", o.id);
  }
  assert.deepEqual(
    manifest.scopes?.[0]?.defaultGrants.map((g) => g.kind),
    ["own", "shared"],
  );
  assert.equal(manifest.needsAgentDirectory, true);
  assert.deepEqual(manifest.companions?.[0]?.operations, ["document_get"]);
});

test("boots on the SDK, serves derived routes, refuses agent ops without a bridge", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${manifest.id}-test-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const local = { ...manifest, runtime: { ...manifest.runtime, port } };
  const running = await startApp(defineApp({ ...definition, manifest: local }), { TB_DATA_DIR: dir, TB_STANDALONE: "1", TB_LOG_LEVEL: "error" });
  try {
    const base = `http://127.0.0.1:${port}`;
    const health = (await (await fetch(`${base}/tb/v1/health`)).json()) as { status: string; manifestDigest: string };
    assert.equal(health.status, "ok");
    assert.equal(health.manifestDigest, manifestDigest(local));
    const openapi = (await (await fetch(`${base}/tb/v1/openapi.json`)).json()) as { paths: Record<string, unknown> };
    for (const op of manifest.operations.filter((o) => o.audience === "agent"))
      assert.ok(
        Object.keys(openapi.paths).some((p) => p.endsWith(`/${op.id}`)),
        `openapi lists ${op.id}`,
      );
    const refused = await fetch(`${base}/tb/v1/ops/work_next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
    assert.equal(refused.status, 503);
  } finally {
    await running.stop();
  }
});

function workspace() {
  const db = migratedDb();
  return db;
}

test("agent directory: first sight creates the agent's own project (scope instance id = agent id)", async () => {
  const db = workspace();
  const ctx = ctxFor(db, A);
  const instances: unknown[] = [];
  await definition.events?.agentAdded?.({ id: A.id as never, name: A.name, mode: "free", status: "active" }, {
    db,
    log: ctx.log,
    scopes: { instances: { create: async (...a: unknown[]) => instances.push(a) } },
  } as never);
  assert.deepEqual(instances, [["project", A.id, "Agent A work", { ownerAgent: A.id }]]);
  const r = db.prepare("SELECT name, owner_agent FROM projects WHERE id = ?").get(A.id);
  assert.equal(r?.owner_agent, A.id);
  await definition.events?.agentRemoved?.({ id: A.id as never, name: A.name, mode: "free", status: "active" }, { db, log: ctx.log } as never);
  assert.equal(Number(db.prepare("SELECT active FROM agents WHERE id = ?").get(A.id)?.active), 0);
});

test("J2: two agents log work in a shared project; the owner sees names and status; dependencies promote", async () => {
  const db = workspace();
  upsertAgent(db, { id: A.id, name: A.name, mode: "free" });
  upsertAgent(db, { id: B.id, name: B.name, mode: "free" });
  insertProject(db, { id: "prj_shared", name: "Launch", shared: true, ownerAgent: null }, { kind: "owner", id: OWNER.id, name: "Owner" });
  const access = { prj_shared: CRUD.contribute };
  const a = ctxFor(db, A, { ...access, [A.id]: CRUD.manage });
  const b = ctxFor(db, B, { ...access, [B.id]: CRUD.manage });

  const spec = (await call("issue_create", { project: "prj_shared", title: "Write the spec", assignee: "me" }, a)) as any;
  const build = (await call("issue_create", { project: "prj_shared", title: "Build", assignee: B.id, dependsOn: [spec.issue.id] }, a)) as any;
  assert.equal(build.issue.ready, false);
  assert.equal(((await call("work_next", {}, b)) as any).ready.length, 0, "B has nothing ready yet");
  await call("issue_update", { issue: spec.issue.id, status: "in_progress" }, a);
  await call("issue_comment_add", { issue: spec.issue.id, body: "Draft in docs/spec.md" }, a);
  const done = (await call("issue_complete", { issue: spec.issue.id, result: "Spec merged" }, a)) as any;
  assert.deepEqual(done.promoted, [build.issue.id]);
  const next = (await call("work_next", {}, b)) as any;
  assert.deepEqual(
    next.ready.map((i: any) => i.id),
    [build.issue.id],
  );
  await call("issue_update", { issue: build.issue.id, status: "in_progress" }, b);
  assert.equal(((await call("work_next", {}, b)) as any).inProgress[0].id, build.issue.id);

  // owner board: every project, names and status
  const owner = ctxFor(db, OWNER);
  const view = (await call("board_view", { project: "prj_shared" }, owner)) as any;
  const cards = new Map(view.issues.map((i: any) => [i.title, i]));
  assert.equal((cards.get("Write the spec") as any).status, "done");
  assert.equal((cards.get("Write the spec") as any).createdBy.name, "Agent A");
  assert.equal((cards.get("Build") as any).assignee.name, "Agent B");
  assert.equal((cards.get("Build") as any).status, "in_progress");
  assert.ok(view.projects.some((p: any) => p.id === A.id), "the agents' own projects show on the owner board");
  const detail = (await call("board_issue", { issue: spec.issue.id }, owner)) as any;
  assert.equal(detail.comments[0].author.name, "Agent A");
  assert.ok(detail.activity.some((e: any) => e.kind === "completed" && e.actor.name === "Agent A"));

  // owner drags a card: board_issue_update through the person session
  const moved = (await call("board_issue_update", { issue: build.issue.id, status: "in_review" }, owner)) as any;
  assert.equal(moved.issue.status, "in_review");
  const log = (await call("activity_list", { issue: build.issue.id }, b)) as any;
  assert.equal(log.activity[0].actor.kind, "owner");
});

test("access: unreadable project = not found; read-only = scope_denied; delete needs delete access", async () => {
  const db = workspace();
  upsertAgent(db, { id: A.id, name: A.name, mode: "free" });
  insertProject(db, { id: "prj_secret", name: "Secret", shared: false, ownerAgent: null }, { kind: "owner", id: OWNER.id, name: "Owner" });
  insertProject(db, { id: "prj_ro", name: "Read only", shared: true, ownerAgent: null }, { kind: "owner", id: OWNER.id, name: "Owner" });
  const owner = ctxFor(db, OWNER);
  const secret = (await call("board_issue_create", { project: "prj_secret", title: "hidden" }, owner)) as any;
  const ro = (await call("board_issue_create", { project: "prj_ro", title: "visible" }, owner)) as any;
  const a = ctxFor(db, A, { prj_ro: CRUD.read, [A.id]: CRUD.manage });

  await assert.rejects(call("issue_get", { issue: secret.issue.id }, a), { code: "not_found" });
  await assert.rejects(call("issue_update", { issue: secret.issue.id, status: "done" }, a), { code: "not_found" });
  assert.equal(((await call("issue_get", { issue: ro.issue.id }, a)) as any).issue.title, "visible");
  await assert.rejects(call("issue_update", { issue: ro.issue.id, status: "done" }, a), { code: "scope_denied" });
  await assert.rejects(call("issue_delete", { issue: ro.issue.id }, a), { code: "scope_denied" });
  const projects = ((await call("projects_list", {}, a)) as any).projects.map((p: any) => p.id);
  assert.deepEqual(projects, [A.id, "prj_ro"], "own project first; the secret project is not listed");
  const list = ((await call("issues_list", {}, a)) as any).issues.map((i: any) => i.title);
  assert.deepEqual(list, ["visible"]);

  // own project: full access, default target for creates, deletable
  const mine = (await call("issue_create", { title: "my task" }, a)) as any;
  assert.equal(mine.issue.project, A.id);
  assert.equal(H.issue_create?.scope?.({ title: "x" }, a.caller as never), A.id);
  assert.deepEqual(await call("issue_delete", { issue: mine.issue.id }, a), { ok: true });
  assert.ok(H.issue_delete?.holdView?.({ issue: "iss_1" }), "deletes show the owner a hold text");
});

test("owner projects: shared flag goes to the scope instance; deleting keeps no data", async () => {
  const db = workspace();
  const owner = ctxFor(db, OWNER);
  const p = (await call("board_project_create", { name: "Website", summary: "public site" }, owner)) as any;
  assert.match(p.project.id, /^prj_/);
  assert.equal(p.project.shared, true, "owner projects are shared by default");
  assert.deepEqual(owner.instances.at(-1), { type: "project", id: p.project.id, label: "Website", shared: true });
  await call("board_project_update", { project: p.project.id, shared: false }, owner);
  assert.equal(owner.instances.at(-1)?.shared, false);
  await call("board_issue_create", { project: p.project.id, title: "x" }, owner);
  await call("board_goal_create", { project: p.project.id, title: "g" }, owner);
  await call("board_project_delete", { project: p.project.id }, owner);
  for (const t of ["projects", "issues", "goals", "activity"])
    assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "projects" ? "id" : "project"} = ?`).get(p.project.id)?.n), 0, t);
  assert.match(owner.instances.at(-1)?.label ?? "", /\(deleted\)$/);
});

test("document references: title via the Knowledge companion (product/op from the manifest); never the body", async () => {
  const db = workspace();
  upsertAgent(db, { id: A.id, name: A.name, mode: "free" });
  const calls: unknown[] = [];
  const companion = manifest.companions?.[0];
  const a = ctxFor(db, A, { [A.id]: CRUD.manage }, (async (product: string, op: string, input: unknown) => {
    calls.push([product, op, input]);
    return { status: "ok", output: { id: "doc_1", title: "Launch plan", body: "SECRET BODY" } };
  }) as never);
  const i = (await call("issue_create", { title: "t" }, a)) as any;
  const linked = (await call("issue_document_link", { issue: i.issue.id, document: "doc_1" }, a)) as any;
  assert.deepEqual(calls, [[companion?.product, "document_get", { id: "doc_1" }]]);
  assert.deepEqual(linked.issue.documents, [{ id: "doc_1", title: "Launch plan" }]);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM issue_documents").all()), /SECRET BODY/);
  const un = (await call("issue_document_unlink", { issue: i.issue.id, document: "doc_1" }, a)) as any;
  assert.deepEqual(un.issue.documents, []);

  const held = ctxFor(db, A, { [A.id]: CRUD.manage }, (async () => ({ status: "held", holdId: "hld_1", expiresAt: "x" })) as never);
  await assert.rejects(call("issue_document_link", { issue: i.issue.id, document: "doc_2" }, held), { code: "document_lookup_held" });
});

test("an app caller (companion grant) gets its own project and can log issues; it cannot be 'me'", async () => {
  const db = workspace();
  const app = ctxFor(db, { type: "app", id: "ins_01J0000000000000000000OBS", name: "Observer" }, { ins_01J0000000000000000000OBS: CRUD.manage });
  const i = (await call("issue_create", { title: "Proposed: follow up" }, app)) as any;
  assert.equal(i.issue.createdBy.kind, "app");
  assert.equal(i.issue.project, "ins_01J0000000000000000000OBS");
  await assert.rejects(call("issue_update", { issue: i.issue.id, assignee: "me" }, app), { code: "assignee_invalid" });
  assert.deepEqual(await call("work_next", {}, app), { ready: [], inProgress: [] });
});

test("Evolution contract: issues_list {status: done, limit: 200} from an app caller sees shared projects only, with template", async () => {
  const db = workspace();
  upsertAgent(db, { id: A.id, name: A.name, mode: "free" });
  insertProject(db, { id: "prj_shared", name: "Ops", shared: true, ownerAgent: null }, { kind: "owner", id: OWNER.id, name: "Owner" });
  insertProject(db, { id: "prj_private", name: "Private", shared: false, ownerAgent: null }, { kind: "owner", id: OWNER.id, name: "Owner" });
  const a = ctxFor(db, A, { prj_shared: CRUD.contribute, prj_private: CRUD.contribute, [A.id]: CRUD.manage });
  for (const p of ["prj_shared", "prj_private"]) {
    const i = (await call("issue_create", { project: p, title: "Weekly report", template: "weekly-report", assignee: "me" }, a)) as any;
    assert.equal(i.issue.template, "weekly-report");
    await call("issue_complete", { issue: i.issue.id, result: "sent" }, a);
  }
  await call("issue_create", { project: "prj_shared", title: "One-off" }, a);
  // C87: an app caller has only Kanban's defaultGrants: its own project (manage) + shared projects (contribute)
  const evo = ctxFor(db, { type: "app", id: "ins_01J0000000000000000000EVO", name: "Evolution" }, { prj_shared: CRUD.contribute, ins_01J0000000000000000000EVO: CRUD.manage });
  const out = (await call("issues_list", { status: "done", limit: 200 }, evo)) as any;
  assert.equal(out.issues.length, 1, "the private project is not visible");
  const [row] = out.issues;
  assert.deepEqual(
    { id: typeof row.id, title: row.title, status: row.status, assignee: row.assignee, template: row.template },
    { id: "string", title: "Weekly report", status: "done", assignee: { kind: "agent", id: A.id, name: "Agent A" }, template: "weekly-report" },
  );
  const byTemplate = (await call("issues_list", { template: "weekly-report" }, a)) as any;
  assert.equal(byTemplate.issues.length, 2);
});
