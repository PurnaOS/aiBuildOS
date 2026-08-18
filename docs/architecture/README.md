# Architecture

`AR-NNNN` — how the system is shaped, and why the shape holds. Files are named for their ID:
`ar-0001.md`.

Architecture documents describe structure; the reasons live in
[decisions](../decisions/README.md). Each document lists the decisions that produced it.

`AR` is currently **ID-reserved only** — Architecture is not yet one of the profiled types, so these
documents carry valid common frontmatter but no `TypeDefinition` stands behind them. See
[OKF conventions §3](../guidelines/okf-conventions.md#3-ids-and-file-layout).

Conventions: [OKF conventions](../guidelines/okf-conventions.md) ·
back to [docs/README.md](../README.md)

| ID | Title | State | Related |
| ---- | ------- | ------- | --------- |
| [AR-0001](ar-0001.md) | Runtime topology and the Bun / Electron-Node boundary | accepted | [AR-0002](ar-0002.md) · constrained by [DC-0002](../decisions/dc-0002.md), [DC-0003](../decisions/dc-0003.md), [DC-0006](../decisions/dc-0006.md), [DC-0007](../decisions/dc-0007.md), [DC-0010](../decisions/dc-0010.md), [DC-0011](../decisions/dc-0011.md), [DC-0012](../decisions/dc-0012.md) |
| [AR-0002](ar-0002.md) | Monorepo layout and package boundaries | accepted | [AR-0001](ar-0001.md) · constrained by [DC-0001](../decisions/dc-0001.md), [DC-0004](../decisions/dc-0004.md), [DC-0005](../decisions/dc-0005.md), [DC-0009](../decisions/dc-0009.md), [DC-0013](../decisions/dc-0013.md), [DC-0015](../decisions/dc-0015.md) |
