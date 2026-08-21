import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0081. The rail folds and counts from the top, and the chrome asks in its own voice.
 *
 * Verifies RQ-0029#AC-1 to AC-3 through the running application.
 */
function requirement(id: string, title: string): string {
  return `---
type: Requirement
id: ${id}
title: "${title}"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# ${id} — ${title}

## Acceptance criteria

- [AC-1] It does the thing.
`;
}

async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "rail-config-"));
  const work = mkdtempSync(join(tmpdir(), "rail-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  cpSync(template, join(work, "docs"), { recursive: true });
  // A raw template copy leaves `owner: {{OWNER}}` in the seed playbooks (transitions.spec.ts's
  // sibling harnesses do the same via `journey.spec.ts`'s pattern — see `watch.spec.ts`).
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "srini"));
  }

  writeFileSync(join(work, "docs/requirements/rq-0001.md"), requirement("RQ-0001", "Alpha thing"));
  writeFileSync(join(work, "docs/requirements/rq-0002.md"), requirement("RQ-0002", "Beta thing"));
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | Alpha thing | draft | — |\n` +
      `| [RQ-0002](rq-0002.md) | Beta thing | draft | — |\n`,
  );

  // `--mode=slow` is only exercised by the dirty-close test below, but one harness config is enough
  // for all three — none of the others start a session at all.
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=slow"],
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

test("folds a group from its header, keeps the count, and the fold survives a refresh", async () => {
  const { app, w, work } = await open();

  const group = w.getByTestId("record-group-Requirement");
  await expect(group).toContainText("Requirements · 2");
  await expect(w.getByTestId("record-open-RQ-0001")).toBeVisible();
  await expect(w.getByTestId("record-open-RQ-0002")).toBeVisible();

  await group.click();
  await expect(w.getByTestId("record-open-RQ-0001")).toHaveCount(0);
  await expect(w.getByTestId("record-open-RQ-0002")).toHaveCount(0);
  // The count is a structural fact about the group, not about what is on screen right now.
  await expect(group).toContainText("Requirements · 2");

  // An external write — nothing in this window did it — and the watcher's own refresh (RQ-0026).
  writeFileSync(join(work, "docs/requirements/rq-0003.md"), requirement("RQ-0003", "Gamma thing"));
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0003](rq-0003.md) | Gamma thing | draft | — |\n`,
  );

  await expect(group).toContainText("Requirements · 3", { timeout: 10000 });
  // Still folded: the count moved, the rows did not reappear on their own.
  await expect(w.getByTestId("record-open-RQ-0001")).toHaveCount(0);
  await expect(w.getByTestId("record-open-RQ-0003")).toHaveCount(0);

  // Unfolding proves the fold, not a stale read, was the reason the third row was never seen.
  await group.click();
  await expect(w.getByTestId("record-open-RQ-0003")).toBeVisible();

  await app.close();
});

test("filters from the top, counts matches, reaches into a folded group, and clears in one press", async () => {
  const { app, w } = await open();

  // Fold Playbook first — a match inside it must still be reachable (RQ-0029#AC-1's "still searches
  // folded groups").
  await w.getByTestId("record-group-Playbook").click();
  await expect(w.getByTestId("record-open-PB-0004")).toHaveCount(0);

  await w.getByTestId("record-filter").fill("checks");
  await expect(w.getByTestId("record-filter-count")).toHaveText("1 match");
  await expect(w.getByTestId("record-open-PB-0004")).toBeVisible();
  await expect(w.getByTestId("record-open-PB-0001")).toHaveCount(0);

  await w.getByTestId("record-filter-clear").click();
  await expect(w.getByTestId("record-filter")).toHaveValue("");
  await expect(w.getByTestId("record-filter-count")).toHaveCount(0);
  // The fold resumes once filtering stops — nothing was permanently unfolded by reaching into it.
  await expect(w.getByTestId("record-open-PB-0004")).toHaveCount(0);

  await app.close();
});

test("a dirty tab's close asks through the application's own dialog, in dark appearance too", async () => {
  const { app, w } = await open();
  await w.emulateMedia({ colorScheme: "dark" });

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  // `--mode=slow` streams for long enough to type underneath it (autosave.spec.ts's own scene) —
  // which is what keeps the tab dirty: autosave holds its write while the turn streams (RQ-0008#AC-3).
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("please proceed");
  await w.keyboard.press("Enter");

  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();
  await w.getByTestId("artifact-body").locator(".cm-content").click();
  await w.keyboard.type("edited while streaming\n");
  await expect(w.getByTestId("tab-dirty-RQ-0001")).toBeVisible();

  await w.getByTestId("tab-close-RQ-0001").click();
  const dialog = w.getByTestId("discard-dialog");
  await expect(dialog).toBeVisible();
  // In this application's own dark neutrals (theme.spec.ts's ground colour), not the platform's.
  await expect(dialog).toHaveCSS("background-color", /oklch\(0\.145 |rgb\(10, 10, 10\)/);

  await w.getByTestId("discard-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(w.getByTestId("tab-RQ-0001")).toBeVisible();

  // The turn may have ended by now, which would let autosave's 800ms debounce clear the dirty flag
  // out from under this second close — proven on CI's slower runners, where the polls between the
  // re-edit and the close-click alone outlast the debounce. Start another slow turn first: autosave
  // holds its write while a turn streams (RQ-0008#AC-3), the same protection the first close had.
  await w.getByTestId("tab-chat").click();
  await composer.click();
  await composer.fill("keep going");
  await w.keyboard.press("Enter");
  await w.getByTestId("tab-RQ-0001").click();
  await w.getByTestId("artifact-body").locator(".cm-content").click();
  await w.keyboard.type("still editing\n");
  await expect(w.getByTestId("tab-dirty-RQ-0001")).toBeVisible();

  await w.getByTestId("tab-close-RQ-0001").click();
  await expect(w.getByTestId("discard-dialog")).toBeVisible();
  await w.getByTestId("discard-confirm").click();
  await expect(w.getByTestId("tab-RQ-0001")).toHaveCount(0);

  await app.close();
});
