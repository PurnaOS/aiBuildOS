import { join } from "node:path";
import { probeHarness } from "@aibuildos/acp/probe";
import { createRouter, type Handlers, type IpcMainLike } from "@aibuildos/ipc";
import { app } from "electron";
import { loadHarnesses, removeHarness, saveHarness } from "./harnesses.js";

/**
 * Bind the IPC contract to Electron's ipcMain.
 *
 * `createRouter` takes a structural `IpcMainLike`, so this file is the only place that knows about
 * Electron at all — which is what lets the router itself be tested without it (DC-0006).
 *
 * This is also where the harness store gets its path and where agents are spawned: the renderer
 * never holds a child process, and ACP is the only door to AI (DC-0007).
 */
function harnessFile(): string {
  return process.env.AIBUILDOS_HARNESSES_FILE ?? join(app.getPath("userData"), "harnesses.json");
}

const handlers: Handlers = {
  "app:info": () => ({
    name: "aiBuildOS",
    version: app.getVersion(),
    runtime: {
      node: process.versions.node,
      ...(process.versions.electron === undefined ? {} : { electron: process.versions.electron }),
      ...(process.versions.chrome === undefined ? {} : { chrome: process.versions.chrome }),
    },
  }),

  "harness:list": () => loadHarnesses(harnessFile()),

  "harness:save": (harness) => saveHarness(harnessFile(), harness),

  "harness:remove": ({ id }) => removeHarness(harnessFile(), id),

  "harness:test": async ({ id }) => {
    const harness = loadHarnesses(harnessFile()).find((candidate) => candidate.id === id);
    if (!harness) {
      return {
        ok: false,
        stage: "spawn",
        code: "unknown_harness",
        message: `no harness with id ${id}`,
        stderr: "",
        authMethods: [],
      };
    }

    return await probeHarness(harness, {
      cwd: harness.cwd ?? app.getPath("home"),
      clientVersion: app.getVersion(),
    });
  },
};

export function registerIpc(ipcMain: IpcMainLike): void {
  createRouter(ipcMain, handlers);
}
