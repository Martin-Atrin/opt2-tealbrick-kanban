// Board drag and drop (src/ui/board.tsx): dropping a card on another column is `board_issue_update {status}`; Blocked and
// Done ask for the reason / result first (the one move rule); the same column does nothing; a failed move shows a plain
// message. The rendered-contrast harness cannot drag, so this covers the drag path. The UI is compiled with the build
// tsconfig into dist/ui-test-board and rendered in happy-dom against a stub server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-board");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/kanban/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

// ── stub server ────────────────────────────────────────────────────────────
const PROJECT = "prj_01HZX3K8Q2V4N6P8R0S2T4V6W8";
const issue = (n: number, title: string, status: string) => ({
  id: `iss_01HZX3K8Q2V4N6P8R0S2T4V6W${n}`,
  project: PROJECT,
  title,
  summary: "",
  status,
  priority: "medium",
  ready: false,
  assignee: null,
  goal: null,
  dependsOn: [],
  blockedReason: null,
  result: null,
  documents: [],
  createdBy: { kind: "owner", id: "per_1", name: "Owner" },
  createdAt: "2026-10-14T08:00:00.000Z",
  updatedAt: "2026-10-14T08:00:00.000Z",
  completedAt: null,
  template: null,
});
const TODO = issue(1, "Draft the recall letters", "todo");
const BOARD = {
  projects: [{ id: PROJECT, name: "Launch", summary: "", shared: true, ownerAgent: null, counts: {}, createdAt: "2026-10-14T08:00:00.000Z", updatedAt: "2026-10-14T08:00:00.000Z" }],
  agents: [],
  project: PROJECT,
  issues: [TODO],
  goals: [],
  activity: [],
};

const stub = { calls: [] as { op: string; input: Record<string, unknown> }[], failUpdate: false };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/kanban/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  stub.calls.push({ op, input: body.input ?? {} });
  if (op === "board_view") return json(200, { status: "ok", output: BOARD });
  if (op === "board_issue_update") {
    if (stub.failUpdate) return json(500, { error: { code: "internal", message: "raw upstream text", requestId: "req_1" } });
    return json(200, { status: "ok", output: { issue: TODO } });
  }
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "kanban" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}

/** A drag from the card to a column, as the browser sends it: dragstart on the card, then dragover and drop on the column. */
async function drag(card: Element, column: Element) {
  const store = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "uninitialized",
    get types() {
      return [...store.keys()];
    },
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
  };
  const fire = (el: Element, type: string) => {
    const ev = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
    return act(async () => void el.dispatchEvent(ev as unknown as Event));
  };
  await fire(card, "dragstart");
  await fire(column, "dragover");
  await fire(column, "drop");
  await flush();
}
const column = (host: Element, label: string) => {
  const found = [...host.querySelectorAll("section.kb-col")].find((s) => s.getAttribute("aria-label")?.startsWith(`${label}:`));
  assert.ok(found, `column ${label}`);
  return found;
};
const updates = () => stub.calls.filter((c) => c.op === "board_issue_update");

let Board: typeof import("../src/ui/board.tsx").Board;
before(async () => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
  ({ Board } = (await import(pathToFileURL(join(outDir, "ui", "board.js")).href)) as typeof import("../src/ui/board.tsx"));
});
after(() => rmSync(outDir, { recursive: true, force: true }));

describe("Board drag and drop", () => {
  const board = () => h(Board, { project: null, setProject: () => {} });

  it("moving to another column sends board_issue_update with the new status", async () => {
    stub.calls = [];
    stub.failUpdate = false;
    const m = await mount(board());
    const card = column(m.host, "Todo").querySelector("li.kb-card");
    assert.ok(card?.hasAttribute("draggable"));
    await drag(card as Element, column(m.host, "In progress"));
    assert.deepEqual(updates().map((c) => c.input), [{ issue: TODO.id, status: "in_progress" }]);
    await m.unmount();
  });

  it("the same column does nothing", async () => {
    stub.calls = [];
    const m = await mount(board());
    await drag(column(m.host, "Todo").querySelector("li.kb-card") as Element, column(m.host, "Todo"));
    assert.equal(updates().length, 0);
    await m.unmount();
  });

  it("Blocked asks for the reason first and sends it with the move", async () => {
    stub.calls = [];
    const m = await mount(board());
    await drag(column(m.host, "Todo").querySelector("li.kb-card") as Element, column(m.host, "Blocked"));
    assert.equal(updates().length, 0, "nothing is sent before the reason is asked for");
    assert.match(document.body.textContent ?? "", /to Blocked/);
    assert.match(document.body.textContent ?? "", /What decision or input is needed/);
    const input = document.querySelector("dialog input.tb-input") as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      set?.call(input, "Need the API key");
      input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    });
    const move = [...document.querySelectorAll("dialog button")].find((b) => b.textContent?.trim() === "Move") as HTMLButtonElement;
    await act(async () => move.click());
    await flush();
    assert.deepEqual(updates().map((c) => c.input), [{ issue: TODO.id, status: "blocked", blockedReason: "Need the API key" }]);
    await m.unmount();
  });

  it("a failed move shows a plain message, never the upstream text", async () => {
    stub.calls = [];
    stub.failUpdate = true;
    const m = await mount(board());
    await drag(column(m.host, "Todo").querySelector("li.kb-card") as Element, column(m.host, "In review"));
    const alert = m.host.querySelector('[role="alert"]')?.textContent ?? "";
    assert.match(alert, /Something went wrong/);
    assert.doesNotMatch(alert, /raw upstream/);
    await m.unmount();
  });
});
