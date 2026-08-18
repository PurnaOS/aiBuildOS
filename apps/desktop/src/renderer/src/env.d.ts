/// <reference types="vite/client" />
import type { IpcClient } from "@aibuildos/ipc";

declare global {
  interface Window {
    /** Exposed by the preload script — the only surface that crosses the boundary (DC-0006). */
    readonly aibuildos: IpcClient;
  }
}
