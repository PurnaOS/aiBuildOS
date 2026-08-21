import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0004. Launching with no harness must prompt the user to attach one, and must stop prompting
 * once one exists. The harness file is pointed at a temp directory so the run does not depend on —
 * or disturb — whatever is in the developer's real userData.
 */
test("prompts to attach a harness on an empty config, and not once one exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aibuildos-e2e-"));
  const env = {
    ...process.env,
    AIBUILDOS_HARNESSES_FILE: join(dir, "harnesses.json"),
    AIBUILDOS_SETTINGS_FILE: join(dir, "settings.json"),
  };

  try {
    const first = await electron.launch({ args: ["."], cwd: appRoot, env });
    const window = await first.firstWindow();

    await expect(window.getByTestId("attach-dialog")).toBeVisible();

    // A preset prefills the form and stays editable (RQ-0001#AC-3).
    await window.getByTestId("preset-claude-code").click();
    await expect(window.getByTestId("harness-command")).toHaveValue("npx");

    // Switching presets replaces the prefill rather than accumulating it: Gemini maps no
    // supervision option, so Claude's mapping must not survive the second click (RQ-0050#AC-3).
    await window.getByTestId("preset-gemini").click();

    await window.getByTestId("harness-name").fill("Stub");
    await window.getByTestId("harness-command").fill(process.execPath);
    // `--experimental-strip-types` is the default only from Node 22.18; `engines` admits 22.0.
    await window.getByTestId("harness-args").fill(`--experimental-strip-types\n${stub}`);
    await window.getByTestId("harness-save").click();

    await expect(window.getByTestId("attach-dialog")).toBeHidden();
    await expect(window.getByTestId("harness-row")).toHaveCount(1);
    expect(readFileSync(join(dir, "harnesses.json"), "utf8")).not.toContain("supervisionOptions");
    await first.close();

    // Same config file, second launch: the prompt is gone (RQ-0001#AC-4).
    const second = await electron.launch({ args: ["."], cwd: appRoot, env });
    const reopened = await second.firstWindow();

    await expect(reopened.getByTestId("title")).toHaveText("aiBuildOS");
    await expect(reopened.getByTestId("attach-dialog")).toHaveCount(0);

    // Removing the last harness puts the app back in its first-run state, without a restart.
    await reopened.getByTestId("nav-settings").click();
    await reopened.getByTestId("harness-remove").click();
    await expect(reopened.getByTestId("attach-dialog")).toBeVisible();
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * TC-0004 step 8 — RQ-0001#AC-10. The attach dialog has no dismiss, so a save that fails silently
 * is a dead end: the button returns to its idle label and the user has no way out and no reason why.
 */
test("shows the reason when a save cannot be written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aibuildos-e2e-"));
  // A directory where the app expects a file: every write to it fails with EISDIR.
  const env = {
    ...process.env,
    AIBUILDOS_HARNESSES_FILE: dir,
    AIBUILDOS_SETTINGS_FILE: join(dir, "settings.json"),
  };

  try {
    const app = await electron.launch({ args: ["."], cwd: appRoot, env });
    const window = await app.firstWindow();

    await expect(window.getByTestId("attach-dialog")).toBeVisible();
    await window.getByTestId("harness-name").fill("Stub");
    await window.getByTestId("harness-command").fill(process.execPath);
    await window.getByTestId("harness-save").click();

    await expect(window.getByTestId("harness-error")).toBeVisible();
    await expect(window.getByTestId("attach-dialog")).toBeVisible();
    await app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
