import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** The debounce the editors use, so a test can assert a write happened *before* it would have. */
const PAUSE = 800;

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0034. Editing saves itself — except while something else has a claim on the file.
 *
 * The suppressions are what this is really for. A timer that writes whatever is in the editor is
 * easy; one that keeps its hands off while the agent is mid-turn is the thing that can silently
 * destroy work if it is wrong.
 */
async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "autosave-config-"));
  const work = mkdtempSync(join(tmpdir(), "autosave-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  writeFileSync(join(work, "notes.md"), "one\n");

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=slower"],
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
  return { app, w, work };
}

async function type(w: Page, text: string): Promise<void> {
  await w.locator(".cm-content").click();
  await w.keyboard.press("ControlOrMeta+a");
  await w.keyboard.type(text);
}

test("writes what was typed once the typing stops, with nothing pressed", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();

  await type(w, "written by itself\n");
  await expect(w.getByTestId("file-saved")).toHaveText("saved");
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("written by itself\n");

  // No Save button anywhere, and no question on the way out (RQ-0008#AC-5, AC-8).
  await expect(w.getByTestId("file-save")).toHaveCount(0);
  await w.getByTestId("tab-close-notes.md").click();
  await expect(w.getByTestId("file-tab")).toHaveCount(0);

  await app.close();
});

test("writes at once on the Save command, rather than at the end of the pause", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();
  await type(w, "by the shortcut\n");

  // The menu item ⌘S is attached to. A synthetic key press cannot fire a native accelerator, so this
  // exercises everything except the platform's own key handling — the part that is not ours to test.
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("save")?.click();
  });

  // Far shorter than the pause, so only the command can account for it.
  await expect(w.getByTestId("file-saved")).toHaveText("saved", { timeout: PAUSE - 200 });
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("by the shortcut\n");

  // The standard roles the platform's own menu provided are still there (RQ-0008#AC-7).
  const roles = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).flatMap((item) =>
      (item.submenu?.items ?? []).map((entry) => entry.role ?? ""),
    ),
  );
  // Lower-cased by Electron; `selectAll` is reported as `selectall`.
  for (const role of ["copy", "paste", "undo", "selectall", "quit"]) expect(roles).toContain(role);

  await app.close();
});

test("a save that fails leaves the work in the editor and says what failed", async () => {
  // TC-0036 (RQ-0008#AC-6). The write is refused by the filesystem itself — a read-only file — so
  // the whole reporting path runs against a real failure, not a mocked one.
  const { app, w, work } = await open();

  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();

  chmodSync(join(work, "notes.md"), 0o444);
  await type(w, "typed into a wall\n");

  // The failure is named on screen, and the work is still marked as unwritten — not silently "saved".
  await expect(w.getByTestId("file-save-problem")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("file-save-problem")).not.toBeEmpty();
  await expect(w.getByTestId("file-saved")).toHaveText("unsaved");
  // Nothing on disk was touched, and nothing in the editor was thrown away.
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("one\n");
  await expect(w.locator(".cm-content")).toContainText("typed into a wall");

  // Writable again: the same work — kept, not retyped — is what lands.
  chmodSync(join(work, "notes.md"), 0o644);
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("save")?.click();
  });
  await expect(w.getByTestId("file-saved")).toHaveText("saved", { timeout: 15000 });
  await expect(w.getByTestId("file-save-problem")).toHaveCount(0);
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("typed into a wall\n");

  await app.close();
});

test("holds the write while a turn is streaming, then makes it", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  // Everything below has to happen *under* a live turn — the held write and the tab's mark both
  // key off streaming (RQ-0008#AC-3), so the turn ending early is the test losing its subject, not
  // the app misbehaving. `--mode=slower` streams ~6s and the assertion below proves it started.
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("please proceed");
  await w.keyboard.press("Enter");
  await expect(w.getByTestId("tab-working-chat")).toBeVisible({ timeout: 10000 });

  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();
  await type(w, "typed during the turn\n");

  // Nothing is written for as long as the agent has a claim on the file (RQ-0008#AC-3).
  await expect(w.getByTestId("file-saved")).toHaveText("unsaved");
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("one\n");
  // And the tab says a write is waiting on something, which is when closing still asks.
  await expect(w.getByTestId("tab-dirty-notes.md")).toBeVisible();

  // Once the turn ends, what was typed is written.
  await expect(w.getByTestId("file-saved")).toHaveText("saved", { timeout: 30000 });
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("typed during the turn\n");

  await app.close();
});

test("holds the write while the user is being asked which version to keep", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();

  await type(w, "mine\n");
  await expect(w.getByTestId("file-saved")).toHaveText("saved");

  // The agent writes, and a turn ends: the conflict bar goes up.
  writeFileSync(join(work, "notes.md"), "theirs\n");
  await type(w, "mine again\n");
  await w.getByTestId("tab-chat").click();
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("please proceed");
  await w.keyboard.press("Enter");
  await w.getByTestId("tab-notes.md").click();

  await expect(w.getByTestId("file-conflict")).toBeVisible({ timeout: 30000 });
  // A timer must not answer the question the user is being asked (RQ-0008#AC-4).
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("theirs\n");

  await w.getByTestId("conflict-keep-mine").click();
  await expect(w.getByTestId("file-saved")).toHaveText("saved", { timeout: 15000 });
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("mine again\n");

  await app.close();
});
