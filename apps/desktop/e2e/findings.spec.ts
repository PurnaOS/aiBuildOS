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

/**
 * TC-0043. What the validator would say, said where the artifact is listed and beside the content it
 * concerns — through the running application.
 *
 * Verifies RQ-0012#AC-1, AC-2 and AC-4.
 */
const RQ_OK = `---
type: Requirement
id: RQ-0001
title: "The clean one"
state: draft
owner: srini
provenance: human
created: 2026-08-20
kind: functional
---

# RQ-0001 — The clean one

## Acceptance criteria

- [AC-1] Nothing wrong with it.
`;

/** Invalid on purpose: the profile requires `kind` on a Requirement. */
const RQ_MISSING_KIND = `---
type: Requirement
id: RQ-0001
title: "The erroneous one"
state: draft
owner: srini
provenance: human
created: 2026-08-20
---

# RQ-0001 — The erroneous one

## Acceptance criteria

- [AC-1] Missing its \`kind\`.
`;

async function open(requirement: string): Promise<{ app: ElectronApplication; w: Page }> {
  const config = mkdtempSync(join(tmpdir(), "findings-config-"));
  const work = mkdtempSync(join(tmpdir(), "findings-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  // The template ships `owner: {{OWNER}}` in its seed playbooks — only `seedBundle` resolves that,
  // which a raw `cpSync` does not run. Left unresolved it parses as a YAML mapping, not a string, and
  // every playbook fails `doc/field-required` — the "clean project" case would not be clean.
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, `docs/playbooks/${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "srini"));
  }
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), requirement);

  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | placeholder | draft | — |\n`,
  );

  // A harness on file, or the first-run attach dialog sits over the launch page (TC-0004).
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([{ id: "h", displayName: "Stub", command: "true", args: [] }]),
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

test("a finding is marked where the artifact is listed, in words, and beside the content on open", async () => {
  const { app, w } = await open(RQ_MISSING_KIND);

  const mark = w.getByTestId("record-problems-RQ-0001");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveText("1 error");

  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();
  await expect(w.getByTestId("artifact-finding")).toContainText("kind");
  await expect(w.getByTestId("artifact-finding")).toContainText("field/required");

  await app.close();
});

test("a clean record shows no mark anywhere", async () => {
  const { app, w } = await open(RQ_OK);

  await expect(w.getByTestId("record-open-RQ-0001")).toBeVisible();
  // Not just this row: no artifact in the record — including the seeded playbooks — carries a mark.
  await expect(w.locator('[data-testid^="record-problems-"]')).toHaveCount(0);
  await expect(w.getByTestId("record-rail")).not.toContainText("error");
  await expect(w.getByTestId("record-rail")).not.toContainText("warning");

  await app.close();
});
