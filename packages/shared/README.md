# @aibuildos/shared

The vocabulary every process agrees on: artifact IDs, provenance, relationship names, the error shape.

**Zero dependencies.** This package is imported by the Electron main process, the preload script and
the renderer, so it must be safe in all three — and Node-compatible, never Bun-only
([AR-0001](../../docs/architecture/ar-0001.md)).

Boundary defined in [AR-0002](../../docs/architecture/ar-0002.md).
