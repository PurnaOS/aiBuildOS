# aiBuildOS

An AI-native software development operating system: a desktop app that drives coding agents, with
**Git as the single source of truth for the entire SDLC**. This repository is not just the code — it
is the record of the requirements, decisions, work, tests and defects behind it.

## Canonical guidance

@docs/guidelines/okf-conventions.md
@docs/guidelines/requirement-first.md

Everything else lives in [`docs/`](docs/README.md) and is loaded on demand. Precedence when documents
disagree:

1. `docs/guidelines/okf-conventions.md` — how documents are written
2. `docs/guidelines/requirement-first.md` — how work enters the repo
3. `docs/README.md` — the bundle map and the traceability chains
4. `docs/decisions/` — why the stack is what it is
5. `docs/architecture/` — how the system is shaped

## Non-negotiables

1. **Requirement-first.** Never implement a feature that bypassed the requirements system. Search
   `docs/requirements/` first, reuse or create the requirement, then the story, then the test, then
   the code. Refactors, dependency bumps and typo fixes are exempt.
2. **The repo is the record.** Lifecycle artifacts are OKF documents in `docs/`, committed alongside
   the code they describe. No external tracker is the source of truth.
3. **`state:`, never `status:`.** OKF reserves `status`.
4. **IDs are append-only and never reused.** Filenames are the ID lowercased — `dc-0001.md`.
5. **Links are stored one direction only.** Outbound in frontmatter `links:`; inverses are derived.
   Never hand-write a backlink.
6. **ACP is the only door to AI.** No component holds a model client; agents are stdio child
   processes speaking ACP.
7. **No Bun-only APIs in `apps/` or `packages/`.** Bun is the tooling baseline; Electron's bundled
   Node runs the app. See [AR-0001](docs/architecture/ar-0001.md) — this is the constraint that breaks
   things silently.

## Commands

```bash
bun install          # workspaces: apps/*, packages/*, tools/*
bun run dev          # electron-vite dev — the desktop app
bun run build        # build the desktop app
bun run typecheck    # tsc --noEmit across every package
bun run lint         # biome (ts/tsx/css/json) + markdownlint (docs/); lint:fix to apply
bun run format       # biome format --write
bun run test         # vitest (runs on Node, not Bun — see AR-0001)
bun run test:e2e     # playwright against the built app; build first
bun run docs:check   # validate the OKF bundle in docs/
```

## Layout

```
docs/                  the OKF bundle — the system of record
apps/desktop/          the Electron app: main / preload / renderer + e2e
packages/shared/       vocabulary every process agrees on; zero dependencies
packages/ipc/          Zod channel contract + typed router (testable without Electron)
packages/knowledge-engine/  the only code that parses docs/: parse, validate, graph
packages/acp/          agent descriptors and the spawn boundary
tools/okf/             the docs:check validator CLI (runs on Bun)
tools/stub-acp-agent/  scripted stdio agent — no live model in CI
```

Libraries do not build: every package exports `./src/index.ts` directly. Only `apps/desktop` has a
build step. Tests are colocated as `*.test.ts`. Full rationale in
[AR-0002](docs/architecture/ar-0002.md).

## Navigating the docs

Start at [`docs/README.md`](docs/README.md), open the relevant index, load the **one** artifact you
need, then follow its links. The bundle is written for just-in-time retrieval — do not read it whole.
