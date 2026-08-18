# Decisions

`DC-NNNN` — architecture decision records. Files are named for their ID: `dc-0001.md`.

The prefix is `DC`, not `ADR`: "ADR" is the name of the genre, `Decision` is the type. A decision is
never edited into a different decision — when it stops being true, write a new one with
`supersedes: [DC-…]`.

Conventions: [OKF conventions](../guidelines/okf-conventions.md) ·
[the Decision profile](../profile/decision.md) · back to [docs/README.md](../README.md)

| ID | Title | State | Constrains / Related |
| ---- | ------- | ------- | ---------------------- |
| [DC-0001](dc-0001.md) | Bun workspaces as the monorepo and package manager | accepted | [AR-0002](../architecture/ar-0002.md) · [DC-0002](dc-0002.md) |
| [DC-0002](dc-0002.md) | Bun and Electron's Node are separate runtimes | accepted | [AR-0001](../architecture/ar-0001.md) · [DC-0001](dc-0001.md), [DC-0003](dc-0003.md), [DC-0013](dc-0013.md) |
| [DC-0003](dc-0003.md) | Electron with electron-vite as the desktop shell | accepted | [AR-0001](../architecture/ar-0001.md) · [DC-0004](dc-0004.md) |
| [DC-0004](dc-0004.md) | React 19, Vite 7, Tailwind 4 and Radix for the renderer | accepted | [AR-0002](../architecture/ar-0002.md) · [DC-0005](dc-0005.md), [DC-0008](dc-0008.md) |
| [DC-0005](dc-0005.md) | Zustand holds renderer UI state only | accepted | [AR-0002](../architecture/ar-0002.md) · [DC-0006](dc-0006.md) |
| [DC-0006](dc-0006.md) | In-house typed IPC router validated with Zod | accepted | [AR-0001](../architecture/ar-0001.md) · [DC-0003](dc-0003.md) |
| [DC-0007](dc-0007.md) | Agent integration through the official ACP TypeScript SDK | accepted | [AR-0001](../architecture/ar-0001.md) · [DC-0008](dc-0008.md), [DC-0013](dc-0013.md) |
| [DC-0008](dc-0008.md) | CopilotKit and AG-UI for conversational and generative UI | accepted | [DC-0004](dc-0004.md), [DC-0007](dc-0007.md) |
| [DC-0009](dc-0009.md) | Custom TypeScript knowledge engine over YAML CST | accepted | [AR-0002](../architecture/ar-0002.md) · [DC-0015](dc-0015.md) |
| [DC-0010](dc-0010.md) | System Git CLI driven by argv, with worktrees for isolation | accepted | [AR-0001](../architecture/ar-0001.md) · [DC-0015](dc-0015.md) |
| [DC-0011](dc-0011.md) | Secrets held in Electron safeStorage, never in the bundle | accepted | [AR-0001](../architecture/ar-0001.md) · [DC-0007](dc-0007.md) |
| [DC-0012](dc-0012.md) | Previews via WebContentsView with execa-managed dev servers | accepted | [AR-0001](../architecture/ar-0001.md) · [DC-0003](dc-0003.md) |
| [DC-0013](dc-0013.md) | Vitest, Playwright and a scripted stub ACP agent | accepted | [AR-0002](../architecture/ar-0002.md) · [DC-0002](dc-0002.md), [DC-0007](dc-0007.md) |
| [DC-0014](dc-0014.md) | Packaging with electron-builder, updates via GitHub Releases | accepted | [DC-0003](dc-0003.md) |
| [DC-0015](dc-0015.md) | The repository is the system of record, in OKF | accepted | [AR-0002](../architecture/ar-0002.md) · [DC-0009](dc-0009.md), [DC-0010](dc-0010.md) |

## Not yet decided

Recorded here so they are not mistaken for oversights:

- **Starter templates** (Next.js, Hono, Astro) — named in the technology baseline, but product
  surface rather than foundation. They get a requirement and a decision when template work starts.
- **Domain-state caching in the renderer** — see [DC-0005](dc-0005.md).
- **TypeScript 7** — the toolchain is pinned to TypeScript 5.9 for a known-good bootstrap.
- **Vite 8** — blocked by electron-vite's peer range, see [DC-0004](dc-0004.md).
- **Linting** — no linter is configured; `tsc` and `docs:check` are the gate.
