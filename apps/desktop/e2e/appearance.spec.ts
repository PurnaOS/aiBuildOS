import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * TC-0032. The chosen appearance is in force, and survives a restart.
 *
 * Asserted through the media query rather than through the stored value: the media query is what
 * every stylesheet in this application actually reads, and a setting on disk the window does not
 * reflect is exactly the failure worth catching.
 */
const config = mkdtempSync(join(tmpdir(), "appearance-config-"));

/** `neutral-800` and `neutral-200`, as Tailwind 4 emits them. */
const DARK_BORDER = "oklch(0.269 0 none)";
const LIGHT_BORDER = "oklch(0.922 0 none)";

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

test("chooses an appearance, and keeps it across a restart", async () => {
  const work = mkdtempSync(join(tmpdir(), "appearance-work-"));
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
  // Playwright pins a new page to a colour scheme of its own; cleared, the page follows the platform,
  // which is the thing under test.
  await w.emulateMedia({ colorScheme: null });

  await w.getByTestId("nav-settings").click();
  await expect(w.getByTestId("appearance-system")).toHaveAttribute("data-active", "true");

  // Asserted on a border a `dark:` utility paints, which is downstream of the media query: proving
  // the query flipped proves nothing if the stylesheets did not follow it.
  const sidebar = w.getByTestId("sidebar");

  await w.getByTestId("appearance-dark").click();
  await expect(w.getByTestId("appearance-dark")).toHaveAttribute("data-active", "true");
  await expect(sidebar).toHaveCSS("border-right-color", DARK_BORDER);

  await w.getByTestId("appearance-light").click();
  await expect(sidebar).toHaveCSS("border-right-color", LIGHT_BORDER);

  // The renderer holds no second answer to which appearance is in force (RQ-0007#AC-6).
  const root = w.locator("html");
  expect(await root.getAttribute("class")).toBe(null);
  expect(await root.getAttribute("data-theme")).toBe(null);

  // Following the system means deferring to it, which is a statement about the platform rather than
  // about any one colour: with `system` chosen there is no override in place for the desktop to lose
  // to (RQ-0007#AC-5).
  await w.getByTestId("appearance-system").click();
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");

  await w.getByTestId("appearance-dark").click();
  await expect(sidebar).toHaveCSS("border-right-color", DARK_BORDER);
  await app.close();

  // In force on the first frame of the next run, not applied after it. Asserted on the platform's own
  // value: a border assertion alone proves nothing on a machine whose desktop is already dark, which
  // is exactly the machine this is most likely to be run on.
  const again = await launch();
  const w2 = await again.firstWindow();
  await w2.emulateMedia({ colorScheme: null });
  expect(await again.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  await expect(w2.getByTestId("sidebar")).toHaveCSS("border-right-color", DARK_BORDER);
  await again.close();
});
