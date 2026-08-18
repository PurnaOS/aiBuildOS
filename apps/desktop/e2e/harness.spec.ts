import { mkdtempSync, rmSync } from "node:fs";
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
  const env = { ...process.env, AIBUILDOS_HARNESSES_FILE: join(dir, "harnesses.json") };

  try {
    const first = await electron.launch({ args: ["."], cwd: appRoot, env });
    const window = await first.firstWindow();

    await expect(window.getByTestId("attach-dialog")).toBeVisible();

    // A preset prefills the form and stays editable (RQ-0001#AC-3).
    await window.getByTestId("preset-claude-code").click();
    await expect(window.getByTestId("harness-command")).toHaveValue("npx");

    await window.getByTestId("harness-name").fill("Stub");
    await window.getByTestId("harness-command").fill(process.execPath);
    await window.getByTestId("harness-args").fill(stub);
    await window.getByTestId("harness-save").click();

    await expect(window.getByTestId("attach-dialog")).toBeHidden();
    await expect(window.getByTestId("harness-row")).toHaveCount(1);
    await first.close();

    // Same config file, second launch: the prompt is gone (RQ-0001#AC-4).
    const second = await electron.launch({ args: ["."], cwd: appRoot, env });
    const reopened = await second.firstWindow();

    await expect(reopened.getByTestId("title")).toHaveText("aiBuildOS");
    await expect(reopened.getByTestId("attach-dialog")).toHaveCount(0);
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
