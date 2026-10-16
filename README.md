# Task Board (Tealbrick mini app)

Task Board (product id `kanban`): the shared board of projects, goals and issues that agents and the owner both write to; the durable record of agent work. Built on the Miniapp SDK.

**Status:** stable 0.1.12; `main` is 0.1.13 (dev channel only; its qa1 soak is the gate for stable, C221). Visibility: public, Apache-2.0. Image: `ghcr.io/tealbrick/opt2-tealbrick-kanban` (publicly pullable; as of 2026-10-17 it holds the tags 0.1.13, its earlier dev pre-releases 0.1.13-dev.1 and 0.1.13-dev.2, and `sha-` tags; 0.1.12 and older were published under the former owner's GHCR namespace). The product id stays `kanban`; the display name is Task Board.

- Repository: `Tealbrick/opt2-tealbrick-kanban` (GitHub organisation `Tealbrick`)
- Licence: Apache-2.0 for the app code (`LICENSE`, `NOTICE`); upstream licences of what the app bundles are in `THIRD_PARTY_NOTICES.md`. The Tealbrick brand mark and app art are Tealbrick artwork and are not covered by the Apache-2.0 licence.

## No secrets policy

This repository is public. It must never contain secrets or personal data, and neither may its issues or pull requests:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every pull request, every push to `main` and every tag runs a secret scan (gitleaks, the `secret-scan` step in `.woodpecker/ci.yaml`). GitHub secret scanning and push protection are not enabled on this repository, so the CI scan is the guard. Optional local guard: `pre-commit install` (`.pre-commit-config.yaml` runs gitleaks).
- If a secret is committed anyway: rotate it first, then remove it from history.

## App

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by operation id (`src/app.ts`) and plain migrations (`migrations/`). The app has no keys and no app-specific environment variables.

## What it does

- **Projects, goals, issues.** A project is the scope instance (scope type `project`; access `read`, `contribute`, `manage`). Every agent gets its own project on first sight (manifest `needsAgentDirectory`; default grant for the own project: manage = read, work and delete). Owner projects are `shared` (default grant: contribute = read and work). Goals belong to one project; issues may point at one goal.
- **One status vocabulary:** `backlog`, `todo`, `in_progress`, `in_review`, `blocked`, `done`. An issue is **ready** when it is `todo` and every issue it depends on (`dependsOn`, same project, no cycles) is `done`. Readiness is computed, never stored. Completing, unlinking or deleting a dependency writes a `promoted` activity entry on each issue that becomes ready.
- **Apps by name.** Issues, comments and activity written by a companion app show "<name> (app)" from the SDK's verified caller name, or "App <instance id>" until the SDK knows the name.
- **Names on everything.** The author of every issue, comment and activity entry is the verified caller (agent, companion app or the owner), never a free-text label. Assignee = an agent id from the workspace directory, or the owner.
- **`template`** (optional, on `issue_create`, filter on `issues_list`): a stable lowercase key for repeated work (uppercase is refused with `template_invalid`, never changed), so Evolution can group done issues (contract: `issues_list {status: "done", limit: 200}` returns `id, title, status, assignee, template`).
- **`work_next`:** an agent's ready issues and its issues in progress. Agents are told to call `kanban__work_next` first (manifest `harnessHints`).
- **Shared projects reach every agent.** A project created or switched to shared gets the `shared` default grant ("Read and work") for every agent already seen and for later agents on first sight. Unsharing or deleting removes existing access from the owner board.
- **Deletes are destructive** (`issue_delete`, `goal_delete`, `project_delete`): held for the owner by default.
- **Knowledge documents** are referenced by id and title that the agent supplies after reading the document with its own Knowledge access. Kanban never reads Knowledge on an agent's behalf and has no companion grant to it. No document bodies are stored.

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | identity, runtime (data + backup volumes), operations, scopes, skills, backups, UI paths |
| `src/app.ts` | `defineApp`: one typed handler per operation (op ids and I/O types from `#kit`), agent first-sight event |
| `src/board.ts` | the board store: projects, goals, issues, dependencies (computed `ready`, promotion), comments, document references, activity |
| `src/main.ts` | `startApp(app, process.env)` |
| `src/ui/` | owner board (six columns, drag = `board_issue_update`), holds, receipts, agents and scopes, backups and export, inside `<AppShell>` from `@opt2-tealbrick/ui` (`standard.tsx` and `pages.css` are the template's shared copies, unchanged; `app.css` is the board layout only); built to `dist/ui` |
| `migrations/` | 4 forward-only migrations (`0001_init.sql` baseline, `0002_share_grants.sql`, `0003_drop_share_grants.sql`, `0004_apps.sql`). Never edit a released file. |
| `skills/use-kanban/SKILL.md` | the agent skill: when to use the board, how to log, block, complete and split work |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | `node:24-slim` pinned by digest, pnpm build to `dist/`, non-root, `CMD ["node", "dist/main.js"]` |
| `.woodpecker/ci.yaml`, `.github/workflows/opt2-release.yml` | the opt2 CI template ci-v9.9, generated from `Tealbrick/opt2-tealbrick-platform`; do not edit |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |
| `conformance.start.ts` | boots the app for `tb-conformance` |
| `test/` | store rules (`board.test.ts`), app and handler checks (`app.test.ts`), UI checks |

## Develop

```sh
corepack enable && pnpm install --frozen-lockfile --ignore-scripts   # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # kit, server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app (not release evidence; QA is)
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls (operations answer 503 no_bridge)
```

## Environment

The SDK reads only `TB_*` variables (SDK API section 13). The Dockerfile defaults `TB_DATA_DIR=/data` (the `data` volume mount) and `TB_BACKUP_DIR=/data/backup` (one volume per service). The deploy recipe sets the rest: `TB_INSTANCE_ID`, `TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`. Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`, `TB_STANDALONE`. The listen port is the manifest `runtime.port`.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.1.0`) on a green pipeline and push the tag. Tags are immutable.
3. The release Action (`.github/workflows/opt2-release.yml`) builds and pushes the GHCR image and attaches the kit tarball. The Woodpecker `release-record` step validates and prints the release; it holds no signing key. The platform `registry-sync` pipeline finds the tag, resolves the image digest in GHCR and signs the index entry.
4. Core deploys the newest stable version when the owner installs or updates the app. An update that fails keeps the previous version serving.

Check `publisher` and `source.repo` in the manifest. The repository name must match the image name in `tealbrick-ci.json` (`opt2-tealbrick-kanban`).

## Dependency pins and caching

- `@opt2-tealbrick/*` dependencies are pinned as tarball URLs on the dist host (`Tealbrick/opt2-tealbrick-dist` releases). `pnpm-lock.yaml` carries the sha512 integrity of every such tarball. After changing one, run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves `index.html` as `no-cache` and the hashed directory as immutable, so a deploy is visible at once.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design of this app (operations, scopes, data, background work).
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to change it.
- Runtime contract: `docs/SDK-API.md` in `Tealbrick/opt2-tealbrick-specs`. UI kit: `Tealbrick/opt2-tealbrick-packages`.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
