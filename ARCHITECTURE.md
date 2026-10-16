# Task Board (Tealbrick mini app): architecture

State: verified against the repo on 2026-10-16. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see the system `ARCHITECTURE.md` and `SYSTEM-OVERVIEW.md`.

## Common app pattern (verified for all seven apps)

- **Runtime**: Node 24, TypeScript run through `tsc` to `dist/`, UI built by `scripts/build-ui.ts` (no bundler; content-hashed `assets-<hash>/`). The app is started by `startApp` from `@opt2-tealbrick/miniapp-sdk` (`src/main.ts`).
- **Dockerfile**: two stages on `node:24-slim` pinned by digest, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build && pnpm prune --prod`, the manifest also copied to `/opt/tb/tealbrick.manifest.json` (the `tb-exec` default), `USER node`, no `VOLUME`. The SDK drops root to uid 1000 itself when the platform starts the container as root (Railway volumes are root-owned).
- **Data**: one SQLite file `TB_DATA_DIR/app.db` owned by the SDK. App tables use their own prefix; SDK tables use `tb_*`. On Railway there is ONE volume per service: the backup directory is `<data mount>/backup`, so the volume size is data plus backup (C28).
- **Migrations**: `migrations/NNNN_name.sql` (or `.ts` exporting `up(db)`). The SDK enforces forward-only: gap-free from 0001, one transaction each, sha256 recorded in `tb_migrations`. A changed, missing, misnamed or `down` migration stops the app with `migration_invalid`.
- **Backups and restore**: SDK cron runner writes `tb-backup-<UTC>.tar.gz`; export `tealbrick.export/1` never carries the instance key, KEK, keys, secrets or sessions. Restore at next boot with `TB_RESTORE_FROM`.
- **Authorization**: the bridge gates (`gate()`); the SDK decides (`authorize()`): run, hold or refuse. Holds and receipts live in the app's own `tb_receipts` table. Raw call input is never stored, only a digest.
- **Manifest** `tealbrick.manifest.json` is the only source for operations, scopes, settings, hooks, companions, skills, runtime hints, backups and UI paths. Schema `tealbrick.miniapp/2`, `sdkMajor 1`, `source.license Apache-2.0`. Agent ops become MCP tools `<product>__<op>`. Person ops are owner UI only.
- **Generated**: `gen/` (openapi, kit, docs, railway) is produced by `tb-gen` and is not committed. The typed client kit is built into `dist/kit` and imported as `#kit` in apps that have one.
- **Standard UI pages** (from the kit `AppShell`): Holds, Receipts, Agents and scopes, Keys (where the app has keys), Backups and export.
- **Licence files**: `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`. The brand mark and app art are Tealbrick artwork and are not Apache-licensed.
- **Private by design**: no public address. Only the bridge is public.

## Task Board: what it does

An issue is "ready" when it is `todo` and every `dependsOn` is done. Readiness is computed, never stored (a `promoted` activity entry is written). The author of every issue, comment and activity is the verified caller (agent, companion app shown as "<name> (app)", or owner), never free text. Kanban stores document references only (id and title the agent supplies). It never reads Knowledge (no confused deputy, C88).

## Operations (from `tealbrick.manifest.json`)

34 operations.
- Read (agent, per project): `projects_list`, `project_get`, `goals_list`, `issues_list` (filter `template`, a lowercase key for repeated work; Evolution's detector relies on it), `issue_get`, `activity_list`, `work_next`.
- Write (agent): `project_update`, `goal_create`, `goal_update`, `issue_create`, `issue_update`, `issue_comment_add`, `issue_link`, `issue_unlink`, `issue_block`, `issue_complete`, `issue_document_link`, `issue_document_unlink`.
- Destructive, hold `destructive`: `project_delete`, `goal_delete`, `issue_delete`.
- Person: `board_view`, `board_issue`, 8 writes, 2 destructive (held).

## Scopes, hooks and companions

- **Scopes:** `project` (access `read`, `contribute`, `manage`). Default grants: own project manage, shared project contribute. `needsAgentDirectory: true`: each agent gets its own project on first sight; owner projects can be shared with every agent, current and later.
- **Hooks:** None.
- **Companion grants it asks for:** None. Consumers: Evolution calls `issues_list`, `issue_create`, `issue_complete`, `issue_block`.

## Settings, keys and environment

None. No keys and no app-specific environment variables.

## Data

- **Stored:** Migrations 0001 to 0004: `agents`, `projects`, `goals`, `issues` (author kind, id, name; template; blocked reason; result), `issue_links`, `comments`, `issue_documents` (document id and title only), `activity`, `apps` (verified names of companion-app callers).
- **Never stored:** Knowledge document bodies.

## External calls and background work

- **External:** None.
- **Background:** None (no timers).

## Person UI

Board (six columns; drag changes status), Holds, Receipts, Agents and scopes (`/configure`), Backups and export (`src/ui/App.tsx`). No Keys page.

## Requirements and runtime hints

A bridge for agent access. Standalone mode gives a person-only UI. Agents are told to call `kanban__work_next` first (manifest `harnessHints`).

Port 8080. 0.25 cpu, 256 MB. Data 1 GB plus backup 2 GB (3 GB merged). Backup cron `41 2 * * *`, retain 14.

## Pinned packages

miniapp-sdk 0.1.22, manifest 0.1.18, conformance 0.1.18, ui 0.2.4 (no direct spec dependency).

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25: pre-update snapshot, migration lock, failed mode) is in this app only where the pin above says 0.1.25 (dev channel, RS-3 candidates). The other apps re-pin in RS-3 (dev channel first, stable after the qa1 soak). Until then Core can roll back an update of such an app only as an image (no data restore).

## Known gaps

- README lists one migration (there are four) and says ui 0.2.0 (pinned 0.2.4).