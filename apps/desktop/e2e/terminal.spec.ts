import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * TC-0084. The `exec-streamer` stub runs one execute call whose output arrives in four chunks
 * ~120ms apart before it completes — the smallest fixture that proves a command shows from the
 * start, output arrives live rather than only at the end, and the outcome lands in words beside a
 * duration (RQ-0031#AC-1, AC-2, AC-3). Its own output never runs past a screenful, so AC-4's fold —
 * the count, and "show all" unfolding it — is TC-0083's `visibleLines` coverage instead; what this
 * file proves is the command and its live output actually reaching the running card.
 */
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

async function open(): Promise<{ app: ElectronApplication; w: Page }> {
  const config = mkdtempSync(join(tmpdir(), "terminal-config-"));
  const work = mkdtempSync(join(tmpdir(), "terminal-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "stub",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=exec-streamer"],
      },
    ]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w };
}

test("a command streams into the transcript, then ends in words with a duration", async () => {
  const { app, w } = await open();

  await w.getByTestId("start-stub").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("run the tests");
  await w.keyboard.press("Enter");

  const card = w.getByTestId("tool-call");
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("tool-call-command")).toContainText("bun run test");

  // Still streaming: the first line is visible well before the whole run — four chunks land
  // ~120ms apart, the result only after all of them — and the outcome has not been said yet.
  await expect(w.getByTestId("tool-call-output")).toContainText("line one", { timeout: 2000 });
  await expect(card).not.toContainText("succeeded");

  await expect(w.getByTestId("tool-call-outcome")).toContainText("succeeded", { timeout: 5000 });
  await expect(w.getByTestId("tool-call-outcome")).toContainText(/\d/);
  await expect(w.getByTestId("tool-call-output")).toContainText("line four");

  await app.close();
});
