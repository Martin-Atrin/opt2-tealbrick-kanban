// Owner UI inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): the board first, then the SDK
// standard pages (holds, receipts, agents & scopes, backups & export). Holds are decided one call at a time (C8).
import { callOp, tbFetch, useAgents, useHolds, useScopes, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, BrandMark, Button, Notice, Select, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { errorText, type Project, run } from "./api.ts";
import { Board } from "./board.tsx";

const NAME = "Work Ethic Kanban";
/** Own pages first, then the standard pages this app needs (it has no keys). `configurePath` opens "agents". */
const PAGES = [{ id: "board", label: "Board" }, ...STANDARD_PAGES.filter((p) => p.id !== "keys")];
const BASE = "/a/kanban/";

function pageOf(pathname: string): string {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length).replace(/\/+$/, "") : "";
  if (rest === "configure") return "agents";
  return PAGES.some((p) => p.id === rest) ? rest : "board";
}
const pathOf = (page: string) => (page === "board" ? "./" : page === "agents" ? "./configure" : `./${page}`);

function Holds() {
  const { holds, loading, decide } = useHolds({ status: "held" });
  const [error, setError] = useState<string | null>(null);
  if (loading) return <p className="kb-muted">Loading holds…</p>;
  if (!holds.length) return <p className="kb-muted">Nothing waits for your approval. Deletions by agents wait here.</p>;
  const act = (id: string, d: "approve" | "deny") => decide(id as never, d).catch((e: unknown) => setError(errorText(e)));
  return (
    <div>
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <table className="kb-table">
        <tbody>
          {holds.map((h) => (
            <tr key={h.id}>
              <td>
                <strong>{h.caller.name}</strong>: {h.view ?? h.summary} <Tag tone="action">{h.op}</Tag>
              </td>
              <td className="kb-row">
                <Button size="sm" variant="primary" onClick={() => void act(h.id, "approve")}>
                  Approve
                </Button>
                <Button size="sm" onClick={() => void act(h.id, "deny")}>
                  Deny
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ReceiptRow {
  id: string;
  caller: { name: string };
  op: string;
  status: string;
  summary: string;
  createdAt: number;
}
function Receipts() {
  const [items, setItems] = useState<ReceiptRow[] | null>(null);
  useEffect(() => {
    callOp<{ items: ReceiptRow[] }>("tb.receipts_list", {})
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  if (!items) return <p className="kb-muted">Loading…</p>;
  if (!items.length) return <p className="kb-muted">No agent changes recorded yet.</p>;
  return (
    <table className="kb-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Agent</th>
          <th>Change</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => (
          <tr key={r.id}>
            <td>{new Date(r.createdAt).toLocaleString()}</td>
            <td>{r.caller.name}</td>
            <td>
              {r.op}: {r.summary}
            </td>
            <td>
              <Tag tone={r.status === "run" || r.status === "approved" ? "ok" : r.status === "held" ? "action" : "neutral"}>{r.status}</Tag>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const ACCESS = [
  { value: "", label: "No access" },
  { value: "read", label: "Read" },
  { value: "contribute", label: "Read and work" },
  { value: "manage", label: "Read, work and delete" },
];
function AgentsAndScopes() {
  const { agents, loading } = useAgents();
  const { access, set } = useScopes();
  const [projects, setProjects] = useState<Project[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    run("board_view", {})
      .then((d) => setProjects(d.projects))
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  if (loading) return <p className="kb-muted">Loading agents…</p>;
  if (!agents.length) return <Notice tone="action">No agent is in this workspace yet.</Notice>;
  const level = (agent: string, project: string) => access.find((r) => r.agent === agent && r.type === "project" && r.instanceId === project)?.access ?? "";
  const change = async (agent: string, project: string, value: string) => {
    setBusy(`${agent}|${project}`);
    setError(null);
    try {
      await set(agent as never, "project", project, value || null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <p className="kb-muted">Each agent has its own project. Shared projects are open to every agent for reading and work; deleting is held for your approval.</p>
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <div className="kb-scroll">
        <table className="kb-table">
          <thead>
            <tr>
              <th>Agent</th>
              {projects.map((p) => (
                <th key={p.id}>{p.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name} <Tag>{a.mode}</Tag> {a.status === "paused" ? <Tag tone="blocked">paused</Tag> : null}
                </td>
                {projects.map((p) => (
                  <td key={p.id}>
                    <Select
                      aria-label={`${a.name} access to ${p.name}`}
                      options={ACCESS}
                      value={level(a.id, p.id)}
                      disabled={busy === `${a.id}|${p.id}`}
                      onChange={(e) => void change(a.id, p.id, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Backups() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await tbFetch("tb/v1/ops/tb.export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
      const name = /filename="([^"]+)"/u.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "kanban-export.tar.gz";
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="kb-muted">A backup of the whole board runs every night inside your deployment. The export is a readable copy: projects, goals, issues, comments, activity and agent receipts.</p>
      {error ? <Notice tone="action" role="alert">{error}</Notice> : null}
      <Button onClick={() => void download()} disabled={busy}>
        {busy ? "Preparing…" : "Download a copy"}
      </Button>
    </div>
  );
}

export function App() {
  const { status } = useSession();
  const [page, setPage] = useState(() => pageOf(globalThis.location.pathname));
  const [project, setProject] = useState<string | null>(null);
  const { holds } = useHolds({ status: "held" });
  useEffect(() => {
    const onPop = () => setPage(pageOf(globalThis.location.pathname));
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (id: string) => {
    globalThis.history.pushState(null, "", pathOf(id));
    setPage(id);
  };
  if (status === "loading") return <p className="kb-muted">Loading…</p>;
  if (status === "signed_out") return <Notice tone="action">Your session ended. Open Work Ethic Kanban again from the Portal canvas.</Notice>;
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.length || null } : p));
  return (
    <AppShell title={NAME} icon={<BrandMark size={22} />} pages={pages} current={page} onNavigate={navigate}>
      {page === "board" ? <Board project={project} setProject={setProject} /> : null}
      {page === "holds" ? <Holds /> : null}
      {page === "receipts" ? <Receipts /> : null}
      {page === "agents" ? <AgentsAndScopes /> : null}
      {page === "backups" ? <Backups /> : null}
    </AppShell>
  );
}
