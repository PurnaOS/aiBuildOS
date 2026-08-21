import { defineConfig } from "@playwright/test";

/**
 * Playwright drives the *built* Electron app via `_electron.launch` (DC-0013) — no browser download
 * is needed, only a display server (hence `xvfb-run` on Linux CI).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  /**
   * A hosted runner is slower than any developer's machine, and unevenly so — the first green
   * matrix cost several rounds to failures that were all one shape: an assertion that would have
   * become true a second later. Waiting longer weakens nothing (the assertion still has to come
   * true, or the test still fails); it only stops the clock from deciding the verdict.
   */
  expect: { timeout: process.env.CI === undefined ? 5_000 : 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
});
