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
 * TC-0063. A manual test case walked from a story's review, and the walk written down.
 *
 * Verifies RQ-0023#AC-1, AC-2 and AC-3 through the running application. The fixture mirrors
 * checks.spec.ts's own shape — one requirement, one test case, one story seeded straight at
 * `review` — with the test case's `kind: manual` in place of an automated `binding`.
 */
const RQ = `---
type: Requirement
id: RQ-0001
title: "The lamp turns on"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — The lamp turns on

## Acceptance criteria

- [AC-1] Flipping the switch lights the lamp.
`;

const TC = `---
type: TestCase
id: TC-0001
title: "The lamp, checked by hand"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: manual
links:
  verifies: [RQ-0001]
---

# TC-0001 — The lamp, checked by hand

## Steps

1. Flip the switch.
2. Confirm the lamp is lit.
`;

/** Seeded straight at `review` — this is about the review surface, not the build walk. */
const ST = `---
type: Story
id: ST-0001
title: "Wire the lamp"
state: review
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ST-0001 — Wire the lamp

A scripted slice.

## Acceptance criteria

- [AC-1] The lamp lights on flip.
`;

async function open(): Promise<{ app: ElectronApplication; w: Page; tcFile: string }> {
  const config = mkdtempSync(join(tmpdir(), "manual-config-"));
  const work = mkdtempSync(join(tmpdir(), "manual-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);
  writeFileSync(join(work, "docs/user-stories/st-0001.md"), ST);

  const rqIndex = join(work, "docs/requirements/README.md");
  writeFileSync(
    rqIndex,
    `${readFileSync(rqIndex, "utf8")}| [RQ-0001](rq-0001.md) | The lamp turns on | ready | — |\n`,
  );
  const tcIndex = join(work, "docs/testing/README.md");
  writeFileSync(
    tcIndex,
    `${readFileSync(tcIndex, "utf8")}| [TC-0001](tc-0001.md) | The lamp, checked by hand | draft | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );
  const stIndex = join(work, "docs/user-stories/README.md");
  writeFileSync(
    stIndex,
    `${readFileSync(stIndex, "utf8")}| [ST-0001](st-0001.md) | Wire the lamp | review | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );

  // The template ships every playbook with an unresolved `{{OWNER}}` token — `fillProject` fills it
  // in normally, and a raw `cpSync` here does not run that, so it is filled in by hand, the same way
  // findings.spec.ts and checks.spec.ts do. Left unresolved it is not valid YAML.
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }

  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "seed", "--quiet"]);

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

  // RQ-0045#AC-1, AC-3: Work is its own pinned surface now, not a nested strip view.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();

  return { app, w, tcFile: join(work, "docs/testing/tc-0001.md") };
}

test("a manual check is walked from the review, finished, and the outcome lands", async () => {
  const { app, w, tcFile } = await open();

  // AC-1: the manual check is listed, and opening it shows its Steps as an ordered checklist.
  const outcome = w.getByTestId("manual-check-outcome-TC-0001");
  await expect(outcome).toHaveText("never walked");

  await w.getByTestId("manual-check-open-TC-0001").click();
  const steps = w.getByTestId("manual-check-steps");
  await expect(steps).toBeVisible();
  await expect(steps).toContainText("Flip the switch.");
  await expect(steps).toContainText("Confirm the lamp is lit.");

  // Tick through in order.
  await w.getByTestId("manual-check-step-0").check();
  await w.getByTestId("manual-check-step-1").check();

  // AC-2: finishing records pass, when and by whom, through the guarded save. The panel only closes
  // once that save resolves (ManualChecks.tsx's `finish`), and the save's own `writeFileSync` is
  // synchronous inside the main-process handler — so waiting for the panel to close is what makes
  // reading the file afterwards race-free, rather than racing the save with a fixed guess at when it
  // has landed.
  await w.getByTestId("manual-check-passed").click();
  await expect(w.getByTestId("manual-check-steps")).toHaveCount(0);

  const after = readFileSync(tcFile, "utf8");
  expect(after).toContain("last_result: passed");
  expect(after).toMatch(/last_run: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  expect(after).toContain("last_run_by: srini");

  // AC-3: the latest outcome beside the automated checks (the same review-story column Checks
  // renders in — this project seeds no checks playbook fences, so Checks itself offers nothing).
  await expect(outcome).toContainText("passed");
  await expect(outcome).toContainText("srini");

  // Start another walk and abandon it: the file must not move.
  await w.getByTestId("manual-check-open-TC-0001").click();
  await expect(w.getByTestId("manual-check-steps")).toBeVisible();
  await w.getByTestId("manual-check-step-0").check();
  await w.getByTestId("manual-check-close").click();
  await expect(w.getByTestId("manual-check-steps")).toHaveCount(0);

  expect(readFileSync(tcFile, "utf8")).toBe(after);

  await app.close();
});
