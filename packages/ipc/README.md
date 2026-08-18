# @aibuildos/ipc

The renderer↔main boundary: a Zod-validated channel contract plus a typed router and client
([DC-0006](../../docs/decisions/dc-0006.md)).

`createRouter` and `createClient` take **structural interfaces** (`IpcMainLike`, `IpcRendererLike`),
not Electron's concrete types — which is why `router.test.ts` exercises the whole boundary with an
in-memory fake and no Electron runtime.

Add a channel in `src/contract.ts`; the handler type and the client's types follow from it.
