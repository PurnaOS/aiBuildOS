# Guidelines

The rules that govern how this repository is written. These two documents are canonical — everything
else in `docs/` is an artifact that follows them.

| Document | What it settles |
| --- | --- |
| [okf-conventions.md](okf-conventions.md) | Frontmatter, IDs, relationships, states, the type profile, index format |
| [requirement-first.md](requirement-first.md) | How a feature enters the repository: requirement → story → test → code |

Both are imported into the root [`CLAUDE.md`](../../CLAUDE.md) via `@docs/...` so agents load them
without a search. Back to [docs/README.md](../README.md).
