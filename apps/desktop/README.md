# @aibuildos/desktop

The Electron application ([DC-0003](../../docs/decisions/dc-0003.md)) — the only app in this repo.

| Path | Runtime | Contents |
| --- | --- | --- |
| `src/main/` | Electron's bundled Node | window lifecycle, IPC binding |
| `src/preload/` | Electron's Node, isolated | the contextBridge surface, nothing else |
| `src/renderer/` | Chromium | React 19, Tailwind, one Zustand store |
| `e2e/` | Playwright → built app | the launch smoke test |

**No Bun-only APIs here.** This code runs on Electron's Node, not on Bun — see
[AR-0001](../../docs/architecture/ar-0001.md).

```
bun run dev        # electron-vite dev
bun run build      # electron-vite build
bun run test:e2e   # playwright, against the build output
```
