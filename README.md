# aiBuildOS

aiBuildOS is an AI-native Software Development Operating System that turns Git into the single source
of truth for the entire SDLC.

A desktop application that drives coding agents over [ACP](docs/decisions/dc-0007.md), while
requirements, decisions, work items, tests and defects live in this repository as structured
documents — not in a separate tracker.

> **Status: bootstrap.** The documentation system, the requirements/traceability model and the
> technical skeleton exist. No product features yet.

## Getting started

```bash
bun install
bun run dev
```

Requires [Bun](https://bun.sh) and Node 22+. Both — see
[AR-0001](docs/architecture/ar-0001.md) for why.

## Where things are

| | |
| --- | --- |
| [`docs/`](docs/README.md) | the knowledge base and system of record |
| [`docs/requirements/`](docs/requirements/README.md) | the canonical source of truth for product requirements |
| [`docs/decisions/`](docs/decisions/README.md) | why the stack is what it is |
| [`CLAUDE.md`](CLAUDE.md) | orientation for agents working in this repo |

New behaviour enters through
[requirement-first development](docs/guidelines/requirement-first.md) — requirement, then story, then
test, then code.

## Licence

[MIT](LICENSE)
