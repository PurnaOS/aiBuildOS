# @aibuildos/knowledge-engine

The only code that parses `docs/` — the OKF bundle boundary
([DC-0009](../../docs/decisions/dc-0009.md), [AR-0002](../../docs/architecture/ar-0002.md)).

| File | Responsibility |
| --- | --- |
| `parse.ts` | frontmatter/body split; enforces LF; permissive `hasFrontmatter` check |
| `schema.ts` | Zod schemas for the common frontmatter, IDs and links |
| `graph.ts` | `ArtifactGraph` — outbound edges stored, inbound derived by reverse index |
| `validate.ts` | `id/format`, `id/duplicate`, `link/target-exists`, `index/listed` |

Driven by `tools/okf/cli.ts` (`bun run docs:check`).

**Deliberately not here yet**, each awaiting its own requirement: CST-based round-trip editing, the
rule registry, gate compositions, state-transition enforcement, and the Ajv `json_schema` escape
hatch. This package is the boundary, not the finished engine.
