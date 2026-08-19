import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/** TC-0022. Editing a file, and the collision that happens when the agent edits it too. */
async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "edit-config-"));
  const work = mkdtempSync(join(tmpdir(), "edit-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  writeFileSync(join(work, "notes.md"), "one\n");

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub],
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
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w, work };
}

/** Type into the editor and wait for the tab to admit it is dirty. */
async function edit(w: Page, text: string): Promise<void> {
  await w.locator(".cm-content").click();
  await w.keyboard.press("ControlOrMeta+a");
  await w.keyboard.type(text);
  await expect(w.getByTestId("file-dirty")).toBeVisible();
}

test("edits and saves a file exactly as it was shown", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();

  await edit(w, "two\n");
  await expect(w.getByTestId("tab-dirty-notes.md")).toBeVisible();

  await w.getByTestId("file-save").click();
  await expect(w.getByTestId("file-dirty")).toHaveCount(0);

  // Byte for byte: nothing appended, trimmed or normalised on the way out.
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("two\n");

  await app.close();
});

test("takes the agent's version when the file is open and unmodified", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();

  // The agent changes it; the end of a turn is when this looks.
  writeFileSync(join(work, "notes.md"), "from the agent\n");
  await w.getByTestId("tab-chat").click();
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("go");
  await w.keyboard.press("Enter");
  await w.getByTestId("tab-notes.md").click();

  await expect(w.locator(".cm-content")).toContainText("from the agent", { timeout: 15000 });
  // Nothing to resolve: there was nothing of the user's to lose.
  await expect(w.getByTestId("file-conflict")).toHaveCount(0);

  await app.close();
});

test("keeps both versions when the agent changes a file being edited", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();
  await edit(w, "mine\n");

  writeFileSync(join(work, "notes.md"), "theirs\n");
  // Away to the conversation and back: unsaved work must survive that, which is why every open tab
  // stays mounted.
  await w.getByTestId("tab-chat").click();
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("go");
  await w.keyboard.press("Enter");
  await w.getByTestId("tab-notes.md").click();
  await expect(w.locator(".cm-content")).toContainText("mine");

  // Neither side is discarded, and the difference is on screen.
  await expect(w.getByTestId("file-conflict")).toBeVisible({ timeout: 15000 });
  await expect(w.locator(".cm-content")).toContainText("mine");
  await expect(w.getByTestId("file-conflict")).toContainText("theirs");

  await w.getByTestId("conflict-take-theirs").click();
  await expect(w.getByTestId("file-conflict")).toHaveCount(0);
  await expect(w.locator(".cm-content")).toContainText("theirs");

  await app.close();
});
