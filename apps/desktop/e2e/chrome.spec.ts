import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * TC-0035. The sidebar collapses, comes back, and is remembered.
 *
 * The restart is the part worth writing down: a toggle that forgets is one that has to be pressed
 * every morning, which is a slower version of the problem it was added to solve.
 */
const config = mkdtempSync(join(tmpdir(), "chrome-config-"));

async function launch(): Promise<ElectronApplication> {
  return await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
}

test("collapses, comes back, and is where it was left after a restart", async () => {
  const work = mkdtempSync(join(tmpdir(), "chrome-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([{ id: "h", displayName: "Stub", command: "true", args: [] }]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  const app = await launch();
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();

  await expect(w.getByTestId("sidebar")).toBeVisible();

  await w.getByTestId("sidebar-collapse").click();
  await expect(w.getByTestId("sidebar")).toBeHidden();
  // Not a keystroke nobody would find: something on screen brings it back.
  await expect(w.getByTestId("sidebar-expand")).toBeVisible();

  await w.getByTestId("sidebar-expand").click();
  await expect(w.getByTestId("sidebar")).toBeVisible();

  // The menu item ⌘B is attached to; a synthetic key press cannot fire a native accelerator.
  const toggle = async (): Promise<void> => {
    await app.evaluate(({ Menu }) => {
      Menu.getApplicationMenu()?.getMenuItemById("toggle-sidebar")?.click();
    });
  };

  await toggle();
  await expect(w.getByTestId("sidebar")).toBeHidden();
  await toggle();
  await expect(w.getByTestId("sidebar")).toBeVisible();

  // Left collapsed, and still collapsed next time.
  await toggle();
  await expect(w.getByTestId("sidebar")).toBeHidden();

  // And the panes, which BG-0004 showed were never kept either. Dragged, not typed: the separator is
  // what a person moves.
  const width = async (page: typeof w): Promise<number> =>
    (await page.getByTestId("record-rail").boundingBox())?.width ?? 0;
  const before = await width(w);

  const separator = w.locator('[role="separator"]').first();
  const box = await separator.boundingBox();
  if (box === null) throw new Error("no separator to drag");
  await w.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await w.mouse.down();
  await w.mouse.move(box.x + 160, box.y + box.height / 2, { steps: 8 });
  await w.mouse.up();

  const widened = await width(w);
  // Otherwise the comparison after the restart would hold for a drag that did nothing.
  expect(widened).toBeGreaterThan(before + 50);

  // TC-0037 (RQ-0009#AC-4): collapsing the chrome does not disturb the panes the user just sized.
  // The layout is fractional, so the sizes the user chose *are* fractions: bringing the sidebar back
  // shares the reclaimed width pro-rata across the panes, and collapsing it again returns every pane
  // to exactly the width it had. What must never happen is a toggle resetting the drag to defaults.
  const workspaceWidth = async (): Promise<number> =>
    (await w.getByTestId("workspace").boundingBox())?.width ?? 0;
  const chosenFraction = widened / (await workspaceWidth());

  await toggle();
  await expect(w.getByTestId("sidebar")).toBeVisible();
  await expect
    .poll(async () => Math.abs((await width(w)) / (await workspaceWidth()) - chosenFraction))
    .toBeLessThan(0.01);

  await toggle();
  await expect(w.getByTestId("sidebar")).toBeHidden();
  await expect.poll(async () => Math.abs((await width(w)) - widened)).toBeLessThan(4);

  await app.close();

  const again = await launch();
  const w2 = await again.firstWindow();
  await w2.setViewportSize({ width: 1440, height: 900 });
  await w2.getByTestId("project-open").first().click();
  await w2.getByTestId("workspace").waitFor();

  await expect(w2.getByTestId("sidebar-expand")).toBeVisible();
  await expect(w2.getByTestId("sidebar")).toBeHidden();
  // Within a pixel or two: the layout is stored as fractions of a window of the same size.
  expect(Math.abs((await width(w2)) - widened)).toBeLessThan(4);
  await again.close();
});
