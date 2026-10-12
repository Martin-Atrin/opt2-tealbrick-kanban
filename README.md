# opt2-tealbrick-kanban

Teal Brick opt2: **Work Ethic Kanban** (product id `kanban`), the shared board of projects, goals and issues that agents and the owner both write to.

**Status: opt2 build (clean-room v2 of Teal Brick), work in progress.** This repository is part of the opt2 build and lives under `Martin-Atrin` during the build; it moves to the Teal Brick organisation as one clean commit when opt2 is released. It is not the current production system.

Owner lane: Lead · Work Ethic Kanban.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every push runs a secret scan (Woodpecker `secret-scan` step, gitleaks). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## App

A Teal Brick opt2 miniapp (product id `kanban`), built on `@opt2-tealbrick/miniapp-sdk`.

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output
validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by
operation id (`src/app.ts`) and plain migrations (`migrations/`).

## What it does

- **Projects, goals, issues.** A project is the scope instance (scope type `project`). Every agent gets its own
  project on first sight (manifest `needsAgentDirectory`; default grant `own` = read, work and delete); owner
  projects are `shared` (default grant = read and work). Goals belong to one project; issues may point at one goal.
- **One status vocabulary**: `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`. An issue is **ready**
  when it is `todo` and every issue it depends on (`dependsOn`, same project, no cycles) is `done`. Completing,
  unlinking or deleting a dependency writes a `promoted` activity entry on each issue that becomes ready.
- **Names on everything.** The author of every issue, comment and activity entry is the verified caller (agent,
  companion app or the owner), never a free-text label. Assignee = an agent id from the workspace directory, or the
  owner.
- **`template`** (optional, on `issue_create`, filter on `issues_list`): a stable key for repeated work, so Evolution
  can group done issues (contract: `issues_list {status: "done", limit: 200}` → `id, title, status, assignee, template`).
- **`work_next`**: an agent's ready issues and its issues in progress (the target for the coming poll mode).
- **Shared projects reach every agent**: the owner board gives every current agent "Read and work" on each shared
  project once (recorded per project and agent, so the owner's later edits win); agents seen later get it from the
  SDK `shared` default grant.
- **Deletes are destructive** (`issue_delete`, `goal_delete`, `project_delete`): held for the owner by default.
- **Knowledge documents** are referenced by id + title that the agent supplies after reading the document with its
  own Knowledge access (C88: Kanban never reads Knowledge on an agent's behalf, no companion grant). No bodies.

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | identity, runtime (data + backup volumes), operations, scopes, skills, backups, UI paths |
| `src/app.ts` | `defineApp`: one typed handler per operation (op ids and I/O types from `#kit`), agent first-sight event |
| `src/board.ts` | the board store: projects, goals, issues, dependencies (computed `ready`, promotion), comments, document references, activity |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | owner board (six columns, drag = `board_issue_update`), holds, receipts, agents & scopes, backups & export, inside `<AppShell>`; built to `dist/ui` |
| `migrations/0001_init.sql` | baseline; forward-only, never edit a released file |
| `skills/use-kanban/SKILL.md` | the agent skill: when to use the board, how to log, block, complete and split work |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | `node:24-slim` pinned by digest, pnpm build to `dist/`, non-root, `CMD ["node", "dist/main.js"]` |
| `.woodpecker/ci.yaml` | the opt2 CI template, byte-identical copy (do not edit) |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |
| `test/` | store rules (`board.test.ts`) and app/handler checks incl. the J2 flow (`app.test.ts`) |

## Develop

```sh
pnpm install          # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls
```

## Environment

The SDK reads only `TB_*` variables (SDK-API §13). The deploy recipe sets them: `TB_INSTANCE_ID`,
`TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`, `TB_DATA_DIR` (the `data` volume mount, `/data`)
and `TB_BACKUP_DIR` (`/data/backup`: one volume per service). Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`,
`TB_STANDALONE`. The listen port is the manifest `runtime.port`.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.1.0`) and push the tag.
3. CI builds and publishes the image, then writes the signed release record from the manifest.

Before the first push, check `publisher` and `source.repo` in the manifest. The repository name must match the
image name in `tealbrick-ci.json` (`opt2-tealbrick-kanban`).

## Dependency pins and caching
- `pnpm-lock.yaml` carries the sha512 integrity of every GitHub-release tarball (CI rule ci-v8). After changing an `@opt2-tealbrick/*` dependency run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves index.html `no-cache` and the hashed directory immutable, so a deploy is visible at once (C61).
