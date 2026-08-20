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
 * TC-0026. An artifact is authored as its own shape, and the file it writes is still reviewable.
 *
 * Verifies RQ-0005#AC-5, AC-6, AC-8, AC-9 and AC-10 through the interface rather than the engine:
 * the engine's own byte-preservation is TC-0024's subject, and what this proves is that the shape a
 * person edits is the profile's shape and that the record does not end up disagreeing with itself.
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
# A comment nobody edited, and an inline map, both of which a careless writer would destroy.
tags: [alpha, beta]
links:
  related_to: [RQ-0002]
---

# RQ-0001 — The first thing

## Acceptance criteria

- [AC-1] It does the thing.
- [AC-2] It also does the other thing, at such length that whoever wrote it down
  wrapped the sentence across two lines.
`;

const RQ2 = `---
type: Requirement
id: RQ-0002
title: "The second thing"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0002 — The second thing

## Acceptance criteria

- [AC-1] It does something else.
`;

const TC = `---
type: TestCase
id: TC-0001
title: "The first check"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: automated
binding: "somewhere.test.ts"
---

# TC-0001 — The first check

## Steps

1. Do the thing.
`;

/** Invalid on purpose: `nonsense` is not in the Requirement state vocabulary. */
const RQ3 = `---
type: Requirement
id: RQ-0003
title: "The third thing"
state: nonsense
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0003 — The third thing

## Acceptance criteria

- [AC-1] It does a third thing.
`;

async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "author-config-"));
  const work = mkdtempSync(join(tmpdir(), "author-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/requirements/rq-0002.md"), RQ2);
  writeFileSync(join(work, "docs/requirements/rq-0003.md"), RQ3);
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);

  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | The first thing | draft | — |\n`,
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
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();
  return { app, w, work };
}

test("offers the current state, its legal next states, and only legal link targets", async () => {
  const { app, w } = await open();

  // The current state plus exactly what Requirement's transitions declare from `draft` — not the
  // whole vocabulary (RQ-0010#AC-1).
  const states = await w.getByTestId("artifact-state").locator("option").allTextContents();
  expect(states).toEqual(["draft", "ready", "retired"]);

  // `verified_by` targets TestCase, so the requirement next door is not on offer for it.
  const verifiers = await w.getByTestId("link-add-verified_by").locator("option").allTextContents();
  expect(verifiers.join(" ")).toContain("TC-0001");
  expect(verifiers.join(" ")).not.toContain("RQ-0002");

  // `depends_on` targets Requirement, so the test case is not on offer for that one.
  const depends = await w.getByTestId("link-add-depends_on").locator("option").allTextContents();
  expect(depends.join(" ")).toContain("RQ-0002");
  expect(depends.join(" ")).not.toContain("TC-0001");

  await app.close();
});

test("writes the fields, the criteria and the index, and disturbs nothing else", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("artifact-state").selectOption("ready");
  // A link this artifact has never carried: the file has no `verified_by` key at all.
  await w.getByTestId("link-add-verified_by").selectOption("TC-0001");
  // AC-1 goes; AC-2 must keep its number, because `RQ-0001#AC-2` is how it is referred to elsewhere.
  await w.getByTestId("criterion-remove-1").click();
  await w.getByTestId("criterion-add").click();

  await expect(w.getByTestId("artifact-saved")).toHaveText("saved");

  const after = readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8");

  expect(after).toContain("state: ready");
  expect(after).toContain("verified_by: [TC-0001]");
  // Untouched, and a careless writer would have reformatted every one of these (AC-8).
  expect(after).toContain('title: "The first thing"');
  expect(after).toContain("# A comment nobody edited");
  expect(after).toContain("tags: [alpha, beta]");
  expect(after).toContain("  related_to: [RQ-0002]");
  // Append-only: AC-2 stays AC-2, and the new one is AC-3 rather than reusing the retired number.
  // Untouched, so written back as the two lines it was read from rather than unwrapped.
  expect(after).toContain(
    "- [AC-2] It also does the other thing, at such length that whoever wrote it down\n  wrapped the sentence across two lines.",
  );
  expect(after).toContain("- [AC-3]");
  expect(after).not.toContain("[AC-1]");

  // The record does not disagree with itself (AC-10).
  expect(readFileSync(join(work, "docs/requirements/README.md"), "utf8")).toContain(
    "| [RQ-0001](rq-0001.md) | The first thing | ready |",
  );

  await app.close();
});

test("changing a field alone leaves the whole body byte-identical", async () => {
  const { app, w, work } = await open();
  const path = join(work, "docs/requirements/rq-0001.md");
  const before = readFileSync(path, "utf8");

  await w.getByTestId("artifact-state").selectOption("ready");
  await expect(w.getByTestId("artifact-saved")).toHaveText("saved");

  // One field moved and nothing else did — prose, wrapping, comment and all (AC-8).
  expect(readFileSync(path, "utf8")).toBe(before.replace("state: draft", "state: ready"));

  await app.close();
});

test("edits the prose of the body as markdown", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("artifact-body").locator(".cm-content").click();
  await w.keyboard.press("ControlOrMeta+End");
  await w.keyboard.type("A sentence someone added.\n\n");

  await expect(w.getByTestId("artifact-saved")).toHaveText("saved");

  // Byte-exact: an edit inside the prose moves the prose and nothing else — the blank line under
  // the frontmatter above all, which a one-newline disagreement about where the body starts eats.
  expect(readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8")).toBe(
    RQ.replace(
      "# RQ-0001 — The first thing\n\n## Acceptance criteria",
      "# RQ-0001 — The first thing\n\nA sentence someone added.\n\n## Acceptance criteria",
    ),
  );

  await app.close();
});

test("shows a state its own type does not declare, rather than the first one it does", async () => {
  const { app, w } = await open();

  await w.getByTestId("record-open-RQ-0003").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();

  // The control must report what the file says. Leaving the value out of the options makes the
  // select fall back to the first one, so the editor claims a state the artifact does not carry —
  // and that first option becomes the one thing the user cannot pick to correct it.
  await expect(w.getByTestId("artifact-state")).toHaveValue("nonsense");

  await app.close();
});

test("does not hand out a criterion number it has already retired", async () => {
  const { app, w, work } = await open();

  // Delete both, then add: the next number appends above the high-water mark rather than reusing
  // AC-1, because `RQ-0001#AC-1` elsewhere refers to the criterion that was deleted.
  await w.getByTestId("criterion-remove-1").click();
  await w.getByTestId("criterion-remove-2").click();
  await w.getByTestId("criterion-add").click();
  await expect(w.getByTestId("artifact-saved")).toHaveText("saved");

  const after = readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8");
  expect(after).toContain("- [AC-3]");
  expect(after).not.toContain("[AC-1]");
  expect(after).not.toContain("[AC-2]");

  await app.close();
});

test("keeps both versions when the agent changes an artifact being edited", async () => {
  const { app, w, work } = await open();
  const path = join(work, "docs/requirements/rq-0001.md");

  // `open()` leaves the artifact focused, so the conversation is where the harness is attached from.
  await w.getByTestId("tab-chat").click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  await w.getByTestId("tab-RQ-0001").click();
  await w.getByTestId("artifact-title").fill("Mine");

  // `docs/` is the agent's work too, so this is a real collision rather than a hypothetical one.
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace('title: "The first thing"', 'title: "Theirs"'),
  );

  await w.getByTestId("tab-chat").click();
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("go");
  await w.keyboard.press("Enter");
  await w.getByTestId("tab-RQ-0001").click();

  // Neither side is discarded, and the difference is on screen.
  await expect(w.getByTestId("artifact-conflict")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("artifact-title")).toHaveValue("Mine");
  await expect(w.getByTestId("artifact-conflict")).toContainText("Theirs");

  await w.getByTestId("artifact-conflict-take-theirs").click();
  await expect(w.getByTestId("artifact-conflict")).toHaveCount(0);
  await expect(w.getByTestId("artifact-title")).toHaveValue("Theirs");

  await app.close();
});

test("takes the agent's version of an artifact nobody was editing", async () => {
  const { app, w, work } = await open();
  const path = join(work, "docs/requirements/rq-0001.md");

  await w.getByTestId("tab-chat").click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  await w.getByTestId("tab-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();

  writeFileSync(
    path,
    readFileSync(path, "utf8").replace('title: "The first thing"', 'title: "Theirs"'),
  );

  await w.getByTestId("tab-chat").click();
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("go");
  await w.keyboard.press("Enter");
  await w.getByTestId("tab-RQ-0001").click();

  await expect(w.getByTestId("artifact-title")).toHaveValue("Theirs", { timeout: 15000 });
  // Nothing to resolve: there was nothing of the user's to lose.
  await expect(w.getByTestId("artifact-conflict")).toHaveCount(0);

  await app.close();
});

test("does not mistake its own save for the agent having changed the artifact", async () => {
  const { app, w } = await open();

  await w.getByTestId("tab-chat").click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  await w.getByTestId("tab-RQ-0001").click();

  await w.getByTestId("artifact-title").fill("Mine");
  await expect(w.getByTestId("artifact-saved")).toHaveText("saved");
  // Still editing when the turn ends: what is on disk is this save, not what was first read.
  await w.getByTestId("artifact-title").fill("Mine again");

  await w.getByTestId("tab-chat").click();
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  // A prompt the reply cannot be mistaken for: the stub answers `ok`, and waiting for the turn to
  // actually end is the whole point — a check made before it ends would prove nothing.
  await composer.fill("please proceed");
  await w.keyboard.press("Enter");
  await expect(w.getByTestId("chat")).toContainText("ok", { timeout: 15000 });
  await w.getByTestId("tab-RQ-0001").click();

  await expect(w.getByTestId("artifact-conflict")).toHaveCount(0);
  await expect(w.getByTestId("artifact-title")).toHaveValue("Mine again");

  await app.close();
});

test("reports invalidity against the field that caused it", async () => {
  const { app, w } = await open();

  // RQ-0003 carries a state its own type does not declare.
  await w.getByTestId("record-open-RQ-0003").click();

  // Beside the field that caused it, not in a list of problems somewhere else (AC-9).
  const finding = w.getByTestId("field-state").getByTestId("artifact-finding").first();
  await expect(finding).toBeVisible();
  await expect(finding).toContainText("nonsense");

  await app.close();
});
