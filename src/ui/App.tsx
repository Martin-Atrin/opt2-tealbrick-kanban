// The app inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): header in the app's colour with its
// art, then the pages. The Board is the launch page (manifest `ui.launchPath`); Holds, Receipts, Agents & scopes
// (`ui.configurePath`) and Backups & export come from ./standard.tsx with this app's words.
import { useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { Board } from "./board.tsx";
import { ScopeGrid } from "./scopes.tsx";
import { AgentsPage, BackupsPage, HoldsPage, portalHref, ReceiptsPage, standardRoutes, useHoldList, useNav } from "./standard.tsx";

const NAME = "Task Board";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Shell page id → path under the base `/a/kanban/`. The Board is the launch page; Agents & scopes is `/configure`. */
const ROUTES = standardRoutes("board");
const PAGES = [{ id: "board", label: "Board" }, ...STANDARD_PAGES.filter((p) => p.id in ROUTES)];

export function App() {
  const { principal, status, signOut } = useSession();
  const nav = useNav(ROUTES, "board");
  const holds = useHoldList();
  const [project, setProject] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p));
  const signedIn = status === "signed_in" && principal;
  return (
    <AppShell
      title={NAME}
      colour={appColour("kanban")}
      art={appArt("kanban", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page}
      onNavigate={nav.go}
      pageHref={nav.href}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="needs-you" role="alert">
            Your session ended. Open Task Board again from Portal.
          </Notice>
        ) : notice ? (
          <Notice tone="needs-you" role="alert">
            {notice}
          </Notice>
        ) : null
      }
    >
      {!signedIn ? null : nav.page === "board" ? (
        <Board project={project} setProject={setProject} />
      ) : nav.page === "agents" ? (
        <AgentsPage
          lede="Each agent has its own project. Shared projects are open to every agent for reading and work; deleting is held for your approval."
          render={(agents) => <ScopeGrid agents={agents} />}
        />
      ) : nav.page === "receipts" ? (
        <ReceiptsPage />
      ) : nav.page === "backups" ? (
        <BackupsPage text="A backup of the whole board runs every night inside your deployment. The export is a readable copy: projects, goals, issues, comments, activity and agent receipts." />
      ) : (
        <HoldsPage list={holds} only={nav.hold} empty="Nothing waits for your approval. Deletions by agents wait here." />
      )}
    </AppShell>
  );
}
