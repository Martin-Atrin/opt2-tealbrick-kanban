// Small pieces the board and its dialogs share.
import { Swatch } from "@opt2-tealbrick/ui";
import { type Activity, type Agent, when } from "./api.ts";

/** Active agents, plus `keep` (an issue's current assignee that has left the workspace) so it still shows. */
export function assigneeOptions(agents: Agent[], keep?: string) {
  return [
    { value: "", label: "Nobody" },
    { value: "owner", label: "Me (owner)" },
    ...agents.filter((a) => a.active || a.id === keep).map((a) => ({ value: a.id, label: a.active ? a.name : `${a.name} (left)` })),
  ];
}

export function ActivityList({ items }: { items: Activity[] }) {
  if (!items.length) return <p className="tb-soft">No activity yet.</p>;
  return (
    <div className="ruled">
      {items.map((a) => (
        <div className="item" key={a.id}>
          <Swatch className={a.actor.kind === "owner" ? "is-open" : undefined} />
          <h3>{a.actor.name}</h3>
          <p>{a.summary}</p>
          <span className="meta">{when(a.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}
