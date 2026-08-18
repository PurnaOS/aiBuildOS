import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/**
 * Three builds from one config (DC-0003). Main and preload target Electron's bundled Node; the
 * renderer is a normal Vite/React build for Chromium. See AR-0001 for why that split matters.
 *
 * Vite is pinned to 7.x: electron-vite 5 peers `^5 || ^6 || ^7` (DC-0004).
 */
// Workspace packages ship TypeScript source with no build step (AR-0002), so they must be bundled
// into the main/preload output rather than externalized — Electron cannot import `.ts` at runtime.
const workspacePackages = [
  "@aibuildos/acp",
  "@aibuildos/ipc",
  "@aibuildos/knowledge-engine",
  "@aibuildos/shared",
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: { rollupOptions: { input: resolve(__dirname, "src/main/index.ts") } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages })],
    build: { rollupOptions: { input: resolve(__dirname, "src/preload/index.ts") } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
  },
});
