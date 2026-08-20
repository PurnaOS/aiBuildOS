import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/** TC-0021. Controls come from the agent, and the agent confirms every change. */
async function open(mode: string) {
  const config = mkdtempSync(join(tmpdir(), "ctl-config-"));
  const work = mkdtempSync(join(tmpdir(), "ctl-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, `--mode=${mode}`],
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
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  return { app, w };
}

test("shows what the agent offers, and follows the agent when it changes", async () => {
  const { app, w } = await open("controls");

  await expect(w.getByTestId("controls")).toBeVisible();
  await expect(w.getByTestId("control-mode")).toContainText("Plan");
  await expect(w.getByTestId("control-model")).toContainText("Sonnet");
  await expect(w.getByTestId("control-thought_level")).toContainText("Think");

  // Changing asks the agent; the chip follows the agent's own confirmation.
  await w.getByTestId("control-model").click();
  await w.getByTestId("control-model-opus").click();
  await expect(w.getByTestId("control-model")).toContainText("Opus");

  await w.getByTestId("control-mode").click();
  await w.getByTestId("control-mode-code").click();
  await expect(w.getByTestId("control-mode")).toContainText("Code");

  // Commands the agent advertised, sent as ordinary text.
  await w.getByTestId("control-commands").click();
  await w.getByTestId("control-commands-review").click();
  await expect(w.getByTestId("chat")).toContainText("/review");

  await app.close();
});

test("shows nothing at all when the agent advertises nothing", async () => {
  const { app, w } = await open("rich");

  // Absent, not an empty menu — the difference the design turns on.
  await expect(w.getByTestId("controls")).toHaveCount(0);

  await app.close();
});
