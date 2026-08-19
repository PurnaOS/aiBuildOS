import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0028 and TC-0031. The conversation and the editors are drawn in the application's palette.
 *
 * Against the rendered surface, not the stylesheet: the defect this covers is a cascade one, where
 * the declarations are present and lose to the library's own.
 */
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));

const RQ = `---
type: Requirement
id: RQ-0001
title: "A thing"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — A thing

## Acceptance criteria

- [AC-1] It does the thing.
`;

const DARK_GROUND = "rgb(10, 10, 10)";
const LIGHT_GROUND = "rgb(255, 255, 255)";

test("follows the system appearance, in this application's neutrals", async () => {
  const config = mkdtempSync(join(tmpdir(), "theme-config-"));
  const work = mkdtempSync(join(tmpdir(), "theme-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

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
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  const surface = w.locator(".copilotKitMessages");
  await surface.waitFor();

  await w.emulateMedia({ colorScheme: "dark" });
  await expect(surface).toHaveCSS("background-color", DARK_GROUND);
  await expect(surface).toHaveCSS("color", "rgb(245, 245, 245)");

  // A fix that merely forced dark would be the same defect pointing the other way.
  await w.emulateMedia({ colorScheme: "light" });
  await expect(surface).toHaveCSS("background-color", LIGHT_GROUND);
  await expect(surface).toHaveCSS("color", "rgb(23, 23, 23)");

  // Nothing on the document says which appearance is in force; the media query is the only authority.
  const root = w.locator("html");
  expect(await root.getAttribute("class")).toBe(null);
  expect(await root.getAttribute("data-theme")).toBe(null);

  await app.close();
});

/** TC-0031. The editors, which are themed in JavaScript and so reach no media query on their own. */
test("themes every editor surface with the window", async () => {
  const config = mkdtempSync(join(tmpdir(), "theme-config-"));
  const work = mkdtempSync(join(tmpdir(), "theme-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "notes.md"), "one\n");
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | A thing | draft | — |\n`,
  );

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
  await w.emulateMedia({ colorScheme: "dark" });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();

  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  const file = w.getByTestId("file-tab").locator(".cm-editor");
  await expect(file).toHaveCSS("background-color", DARK_GROUND);
  await expect(file.locator(".cm-content")).toHaveCSS("color", "rgb(245, 245, 245)");

  // A separate call site: one of the two being passed a theme is exactly what ships unnoticed.
  await w.getByTestId("record-open-RQ-0001").click();
  const body = w.getByTestId("artifact-body").locator(".cm-editor");
  await expect(body).toHaveCSS("background-color", DARK_GROUND);

  await w.emulateMedia({ colorScheme: "light" });
  await expect(body).toHaveCSS("background-color", LIGHT_GROUND);
  // Re-opened rather than switched to: a single click previews, and the artifact replaced it.
  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(file).toHaveCSS("background-color", LIGHT_GROUND);

  await app.close();
});
