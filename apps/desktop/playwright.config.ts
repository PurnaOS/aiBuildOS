import { defineConfig } from "@playwright/test";

/**
 * Playwright drives the *built* Electron app via `_electron.launch` (DC-0013) — no browser download
 * is needed, only a display server (hence `xvfb-run` on Linux CI).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
