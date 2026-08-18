# @aibuildos/okf-cli

`bun run docs:check` — walks the OKF bundle in `docs/` and runs
[`@aibuildos/knowledge-engine`](../../packages/knowledge-engine/README.md)'s validators over it.

Repo tooling, so it runs on Bun ([AR-0001](../../docs/architecture/ar-0001.md)).

Skips, by design: `docs/profile/` (type definitions), `README.md` files (indexes, checked as indexes),
and any file without opening frontmatter. That is OKF's permissive consumption — a non-artifact is
skipped, never an error.
