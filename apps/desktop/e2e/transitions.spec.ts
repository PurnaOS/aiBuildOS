import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcBridge } from "@aibuildos/ipc";
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
 * TC-0039. The editor's state control offers only what the profile's transitions declare, and a
 * legal flip lands in the file and the index row in the same save.
 *
 * Verifies RQ-0010#AC-1, AC-5 and AC-6 through the running application.
 */
const RQ = `---
type: Requirement
id: RQ-0001
title: "The first thing"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — The first thing

## Acceptance criteria

- [AC-1] It does the thing.
`;

/** Invalid on purpose: `nonsense` is not in the Requirement state vocabulary. */
const RQ2 = `---
type: Requirement
id: RQ-0002
title: "The second thing"
state: nonsense
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0002 — The second thing

## Acceptance criteria

- [AC-1] It does another thing.
`;

async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "transitions-config-"));
  const work = mkdtempSync(join(tmpdir(), "transitions-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/requirements/rq-0002.md"), RQ2);

  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | The first thing | draft | — |\n`,
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
  return { app, w, work };
}

test("offers the current state and exactly its legal next states", async () => {
  const { app, w } = await open();

  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();

  // `draft` plus what Requirement's transitions declare from there — not the whole vocabulary
  // (`building`, `built` and `verified` are all reachable only later, not from here).
  const states = await w.getByTestId("artifact-state").locator("option").allTextContents();
  expect(states).toEqual(["draft", "ready", "retired"]);

  await app.close();
});

test("a legal flip changes the frontmatter and the index row in the same save", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();

  await w.getByTestId("artifact-state").selectOption("ready");
  await expect(w.getByTestId("artifact-saved")).toHaveText("saved");

  expect(readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8")).toContain(
    "state: ready",
  );
  expect(readFileSync(join(work, "docs/requirements/README.md"), "utf8")).toContain(
    "| [RQ-0001](rq-0001.md) | The first thing | ready |",
  );

  await app.close();
});

test("refuses a state change along a pair the type does not declare, naming it", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();

  // Nothing on the control can select an undeclared pair — the same door reached directly, the way
  // an agent's edit would arrive.
  const result = await w.evaluate(
    async ({ id, artifactId }) => {
      const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
      return await api.invoke("project:artifact-save", {
        id,
        artifactId,
        frontmatter: { state: "built" },
      });
    },
    { id: "p1", artifactId: "RQ-0001" },
  );

  expect(result.problem).toContain("draft");
  expect(result.problem).toContain("built");
  expect(readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8")).toContain(
    "state: draft",
  );

  await app.close();
});

test("refuses a body edit that reuses an `[AC-n]` number, naming it", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();

  const result = await w.evaluate(
    async ({ id, artifactId }) => {
      const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
      return await api.invoke("project:artifact-save", {
        id,
        artifactId,
        frontmatter: {},
        body: "\n## Acceptance criteria\n\n- [AC-1] First.\n- [AC-1] Duplicate.\n",
      });
    },
    { id: "p1", artifactId: "RQ-0001" },
  );

  expect(result.problem).toContain("AC-1");
  expect(readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8")).toContain(
    "- [AC-1] It does the thing.",
  );

  await app.close();
});

test("a state written outside the application is shown as found, with only retirement offered", async () => {
  const { app, w } = await open();

  await w.getByTestId("record-open-RQ-0002").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();

  // The control must report what the file says, not correct it to the first state it does declare.
  await expect(w.getByTestId("artifact-state")).toHaveValue("nonsense");
  const states = await w.getByTestId("artifact-state").locator("option").allTextContents();
  expect(states).toEqual(["nonsense", "retired"]);

  await app.close();
});
