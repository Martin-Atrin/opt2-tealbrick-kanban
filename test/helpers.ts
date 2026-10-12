// Test helpers: a migrated node:sqlite database shaped like the SDK `Db`, and a handler context with a fake scope view.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CrudAction } from "@opt2-tealbrick/manifest";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";

export function migratedDb(): Db {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(new URL(f, dir), "utf8"));
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return db as unknown as Db;
}

export const CRUD = {
  read: ["read"],
  contribute: ["read", "create", "update"],
  manage: ["read", "create", "update", "delete"],
} as const satisfies Record<string, readonly CrudAction[]>;

export interface FakeCaller {
  type: "agent" | "app" | "person";
  id: string;
  name: string;
  mode?: "free" | "bound";
}

/** A handler context: `access` maps project id → CRUD set (ignored for person callers, who may act everywhere). */
export function ctxFor(
  db: Db,
  caller: FakeCaller,
  access: Record<string, readonly CrudAction[]> = {},
  callApp?: OpContext["callApp"],
): OpContext & { instances: { type: string; id: string; label: string; shared?: boolean }[] } {
  const person = caller.type === "person";
  const instances: { type: string; id: string; label: string; shared?: boolean }[] = [];
  return {
    db,
    caller: { ...caller, mode: caller.type === "agent" ? (caller.mode ?? "free") : null },
    scope: {
      access: null,
      readable: async () => (person ? [] : Object.keys(access).filter((p) => access[p]?.includes("read"))),
      writable: async () => (person ? [] : Object.keys(access).filter((p) => access[p]?.some((c) => c !== "read"))),
      can: async (_t: string, id: string, crud: CrudAction) => person || (access[id]?.includes(crud) ?? false),
    },
    scopes: {
      instances: {
        create: async (type: string, id: string, label: string, opts?: { shared?: boolean }) => {
          instances.push({ type, id, label, shared: opts?.shared });
          return { type, id, label, shared: opts?.shared ?? false };
        },
        list: async () => [],
      },
    },
    callApp: callApp ?? (async () => Promise.reject(new Error("no companion in this test"))),
    instances,
  } as unknown as OpContext & { instances: { type: string; id: string; label: string; shared?: boolean }[] };
}
