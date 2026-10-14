// Agents & scopes: the access grid, one Select per agent and project. It is the `render` of the shared AgentsPage, so
// the heading, loading, load error and empty state come from ./standard.tsx.
import { useScopes } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, EmptyState, Field, Notice, Select, Swatch, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { explain, type Project, run } from "./api.ts";
import type { Agent } from "./standard.tsx";

const ACCESS = [
  { value: "", label: "No access" },
  { value: "read", label: "Read" },
  { value: "contribute", label: "Read and work" },
  { value: "manage", label: "Read, work and delete" },
];

export function ScopeGrid({ agents }: { agents: readonly Agent[] }) {
  const { access, set } = useScopes();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    run("board_view", {})
      .then((d) => setProjects(d.projects))
      .catch((e: unknown) => setLoadError(explain(e)));
  }, []);
  useEffect(load, [load]);
  if (loadError) {
    return (
      <Notice tone="needs-you" role="alert">
        <span className="tb-row">
          <span>{loadError}</span>
          <Button size="sm" onClick={load}>
            Try again
          </Button>
        </span>
      </Notice>
    );
  }
  if (!projects) {
    return (
      <p className="tb-soft" role="status">
        Loading projects.
      </p>
    );
  }
  if (!projects.length) return <EmptyState title="No projects yet">Create a project on the Board, then choose here which agents can use it.</EmptyState>;
  const level = (agent: string, project: string) => access.find((r) => r.agent === agent && r.type === "project" && r.instanceId === project)?.access ?? "";
  const change = async (agent: string, project: string, value: string) => {
    setBusy(`${agent}|${project}`);
    setError(null);
    try {
      await set(agent as never, "project", project, value || null);
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      <div className="ruled">
        {agents.map((a) => (
          <section className="kb-agent" key={a.id} aria-label={a.name}>
            <div className="tb-row kb-who-row">
              <Swatch />
              <h3>{a.name}</h3>
              <Tag>{a.mode}</Tag>
              {a.status === "paused" ? <Tag status="needs-you">paused</Tag> : null}
            </div>
            <div className="kb-grants">
              {projects.map((p) => (
                <Field key={p.id} label={p.name}>
                  <Select
                    aria-label={`${a.name} access to ${p.name}`}
                    options={ACCESS}
                    value={level(a.id, p.id)}
                    disabled={busy === `${a.id}|${p.id}`}
                    onValueChange={(v) => void change(a.id, p.id, v)}
                  />
                </Field>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
