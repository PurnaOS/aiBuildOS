# @aibuildos/knowledge-engine

The only code that parses `docs/` — the OKF bundle boundary
([DC-0009](../../docs/decisions/dc-0009.md), [AR-0002](../../docs/architecture/ar-0002.md)).

| File | Responsibility |
| --- | --- |
| `parse.ts` | frontmatter/body split; enforces LF; permissive `hasFrontmatter` check |
| `schema.ts` | Zod schemas for the common frontmatter, IDs and links |
| `graph.ts` | `ArtifactGraph` — outbound edges stored, inbound derived by reverse index |
| `profile.ts` | the type profile as data: `extends` resolved by merging child over parent |
| `validate.ts` | the rules needing no profile: `id/*`, `index/listed`, `link/target-exists`, `doc/*` |
| `rules.ts` | the profile-driven rules — `type/*`, `field/*`, `state/*`, `link/*`, `body/*` |
| `load.ts` | the only module touching `node:fs`: `loadBundle`, `loadProfile`, `summarize` |

Driven by `tools/okf/cli.ts` (`bun run docs:check`).

`validate(bundle, profile?)` takes the profile as data, so **editing `docs/profile/` changes what is
enforced with no code change** ([conventions §6](../../docs/guidelines/okf-conventions.md#6-the-profile--types-are-data),
[RQ-0003](../../docs/requirements/rq-0003.md)). Passing no profile runs the common rules alone — a
newly created project has a valid bundle before it has a described one.

A type the profile does not define is a **warning**, never an error: `AR` is ID-reserved and
deliberately unprofiled, and OKF requires a reader to tolerate unknown types.

**Deliberately not here yet**, each awaiting its own requirement: CST-based round-trip editing, gate
compositions, state-*transition* enforcement and `[AC-n]` append-only checking (both need Git history,
which a single commit cannot show), and the Ajv `json_schema` escape hatch.
