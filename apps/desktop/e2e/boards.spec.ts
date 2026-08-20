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
 * TC-0041. Moving a card is the state change, and an illegal drop is a refusal.
 *
 * Verifies RQ-0011#AC-2 to AC-4, AC-6 and AC-7 through the running application, asserting against the
 * files on disk — the board claims to be a view of them.
 *
 * Drag itself is not simulated here: the design's own words call the per-card "Move to…" menu "the
 * keyboard/screen-reader path and the stable e2e path" — every move a drag can make, the menu can
 * make too, so the menu is what this file drives.
 */
async function open(seed: (work: string) => void): Promise<{
  app: ElectronApplication;
  w: Page;
  work: string;
}> {
  const config = mkdtempSync(join(tmpdir(), "boards-config-"));
  const work = mkdtempSync(join(tmpdir(), "boards-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  cpSync(template, join(work, "docs"), { recursive: true });
  seed(work);

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
  await w.getByTestId("tab-board").click();
  await w.getByTestId("board-tab").waitFor();
  return { app, w, work };
}

const RQ_1 = `---
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

const RQ_3 = `---
type: Requirement
id: RQ-0003
title: "The third thing"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0003 — The third thing

## Acceptance criteria

- [AC-1] It does a third thing.
`;

test("moves a card via its menu, refuses an illegal move, picks up an outside edit, and opens on click", async () => {
  const { app, w, work } = await open((dir) => {
    writeFileSync(join(dir, "docs/requirements/rq-0001.md"), RQ_1);
    writeFileSync(join(dir, "docs/requirements/rq-0003.md"), RQ_3);
    const index = join(dir, "docs/requirements/README.md");
    writeFileSync(
      index,
      `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | The first thing | draft | — |\n` +
        `| [RQ-0003](rq-0003.md) | The third thing | ready | — |\n`,
    );
  });

  // AC-1: one column per vocabulary state, Backlog active by default — including a state no seeded
  // requirement occupies, which can only come from the profile: no artifact could put it there.
  await expect(w.getByTestId("board-view-backlog")).toHaveAttribute("data-active", "true");
  await expect(w.getByTestId("board-column-draft").getByTestId("board-card-RQ-0001")).toBeVisible();
  await expect(w.getByTestId("board-column-verified")).toBeVisible();

  // AC-3/AC-4: the drag twin — only what the profile declares from `draft` is offered, never the
  // whole vocabulary (`building`, `built`, `verified` are all unreachable from here).
  await w.getByTestId("board-card-menu-RQ-0001").click();
  const moves = w.getByTestId("board-card-moves-RQ-0001");
  await expect(moves.getByTestId("board-card-move-RQ-0001-ready")).toBeVisible();
  await expect(moves.getByTestId("board-card-move-RQ-0001-retired")).toBeVisible();
  await expect(moves.getByTestId("board-card-move-RQ-0001-building")).toHaveCount(0);
  await expect(moves.getByTestId("board-card-move-RQ-0001-built")).toHaveCount(0);
  await expect(moves.getByTestId("board-card-move-RQ-0001-verified")).toHaveCount(0);

  // AC-2: the move performed is the guarded save — the file and its index row flip together.
  await moves.getByTestId("board-card-move-RQ-0001-ready").click();
  await expect(w.getByTestId("board-column-ready").getByTestId("board-card-RQ-0001")).toBeVisible();
  await expect(readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8")).toContain(
    "state: ready",
  );
  await expect(readFileSync(join(work, "docs/requirements/README.md"), "utf8")).toContain(
    "| [RQ-0001](rq-0001.md) | The first thing | ready |",
  );

  // AC-2: clicking a card opens it the same way a record row does.
  await w.getByTestId("board-card-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();
  await expect(w.getByTestId("artifact-state")).toHaveValue("ready");

  // AC-7: a change made outside the board — here, outside the application entirely — shows up once
  // something bumps the shared revision. RQ-0003 moves on disk directly; a save elsewhere is what
  // makes the board look again.
  const path3 = join(work, "docs/requirements/rq-0003.md");
  writeFileSync(path3, readFileSync(path3, "utf8").replace("state: ready", "state: building"));

  const title = w.getByTestId("artifact-title");
  await title.fill("The first thing, retitled");
  await expect(w.getByTestId("artifact-saved")).toHaveText("saved");

  await w.getByTestId("tab-board").click();
  await expect(
    w.getByTestId("board-column-building").getByTestId("board-card-RQ-0003"),
  ).toBeVisible();
  await expect(w.getByTestId("board-column-ready").getByTestId("board-card-RQ-0003")).toHaveCount(
    0,
  );

  // AC-3: the same refusal the editor would produce, reached the way an agent's edit would arrive —
  // the file is untouched by the attempt.
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
  expect(result.problem).toContain("ready");
  expect(result.problem).toContain("built");
  expect(readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8")).toContain(
    "state: ready",
  );
  // The refused attempt never went through the board, so the card is exactly where it was.
  await expect(w.getByTestId("board-column-ready").getByTestId("board-card-RQ-0001")).toBeVisible();

  await app.close();
});

const RQ_TARGET = `---
type: Requirement
id: RQ-0001
title: "What the story serves"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — What the story serves

## Acceptance criteria

- [AC-1] It does the thing.
`;

const TC_TARGET = `---
type: TestCase
id: TC-0001
title: "What verifies the story"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: manual
links:
  verifies: [RQ-0001]
---

# TC-0001 — What verifies the story

## Steps

1. Do the thing and check it happened.
`;

const STORY_IN_REVIEW = `---
type: Story
id: ST-0001
title: "The story under review"
state: review
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ST-0001 — The story under review

## Acceptance criteria

- [AC-1] It does the thing.
`;

/** `queued → building` is profile-legal — the discriminating case: a builder-owned edge stays off the
 * menu even though the type declares it, which a review-only card could never show. */
const BUG_IN_QUEUE = `---
type: Bug
id: BG-0001
title: "Something the builder is on"
state: queued
owner: srini
provenance: human
created: 2026-08-19
severity: minor
links:
  affects: [RQ-0001]
---

# BG-0001 — Something the builder is on

## Reproduction

1. Do the thing.
2. See the defect.
`;

test("the Work board restricts moves to the edges a person owns", async () => {
  const { app, w, work } = await open((dir) => {
    writeFileSync(join(dir, "docs/requirements/rq-0001.md"), RQ_TARGET);
    writeFileSync(join(dir, "docs/testing/tc-0001.md"), TC_TARGET);
    writeFileSync(join(dir, "docs/user-stories/st-0001.md"), STORY_IN_REVIEW);
    writeFileSync(join(dir, "docs/bugs/bg-0001.md"), BUG_IN_QUEUE);
  });

  await w.getByTestId("board-view-work").click();
  await expect(w.getByTestId("board-view-work")).toHaveAttribute("data-active", "true");

  // AC-6: the columns the builders write take no moves, and say why — whether or not anything is in
  // them right now, which is what makes the caption a property of the column, not of a card.
  await expect(w.getByTestId("board-column-ready")).toContainText("moved by the builder");
  await expect(w.getByTestId("board-column-queued")).toContainText("moved by the builder");
  await expect(w.getByTestId("board-column-building")).toContainText("moved by the builder");
  await expect(w.getByTestId("board-column-accepted")).not.toContainText("moved by the builder");

  // Stories and Bugs on one board, told apart by their mono ID prefix.
  await expect(
    w.getByTestId("board-column-review").getByTestId("board-card-ST-0001"),
  ).toBeVisible();
  await expect(
    w.getByTestId("board-column-queued").getByTestId("board-card-BG-0001"),
  ).toBeVisible();

  // AC-6, the discriminating case: `queued → building` is a transition the profile itself declares
  // legal, but it is the builder's own edge, not a verdict a person renders — so it stays off the
  // menu even though `project:artifact` reports it as legal. Only retirement is offered from here.
  await w.getByTestId("board-card-menu-BG-0001").click();
  const builderMoves = w.getByTestId("board-card-moves-BG-0001");
  await expect(builderMoves.getByTestId("board-card-move-BG-0001-retired")).toBeVisible();
  await expect(builderMoves.getByTestId("board-card-move-BG-0001-building")).toHaveCount(0);
  await expect(builderMoves.getByTestId("board-card-move-BG-0001-review")).toHaveCount(0);

  // AC-6: from `review`, exactly the verdicts a person owns — accept, send back, reject, retire —
  // never the builders' own `ready`/`queued` edges.
  await w.getByTestId("board-card-menu-ST-0001").click();
  const moves = w.getByTestId("board-card-moves-ST-0001");
  await expect(moves.getByTestId("board-card-move-ST-0001-accepted")).toBeVisible();
  await expect(moves.getByTestId("board-card-move-ST-0001-building")).toBeVisible();
  await expect(moves.getByTestId("board-card-move-ST-0001-rejected")).toBeVisible();
  await expect(moves.getByTestId("board-card-move-ST-0001-retired")).toBeVisible();

  await moves.getByTestId("board-card-move-ST-0001-accepted").click();
  await expect(
    w.getByTestId("board-column-accepted").getByTestId("board-card-ST-0001"),
  ).toBeVisible();
  expect(readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8")).toContain(
    "state: accepted",
  );

  await app.close();
});

/** A priority the record carries, present tense: p1 above p3 whatever the IDs say. */
const prioritised = (id: string, priority: string): string => `---
type: Requirement
id: ${id}
title: "${id} at ${priority}"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: functional
priority: ${priority}
---

# ${id} — at ${priority}

## Acceptance criteria

- [AC-1] It does the thing.
`;

test("orders a column by priority before ID (TC-0050, BG-0005)", async () => {
  // The IDs argue one order and the priorities the other; only the priorities may win.
  const { app, w } = await open((dir) => {
    writeFileSync(join(dir, "docs/requirements/rq-0001.md"), prioritised("RQ-0001", "p3"));
    writeFileSync(join(dir, "docs/requirements/rq-0002.md"), prioritised("RQ-0002", "p1"));
    const index = join(dir, "docs/requirements/README.md");
    writeFileSync(
      index,
      `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | RQ-0001 at p3 | draft | — |\n| [RQ-0002](rq-0002.md) | RQ-0002 at p1 | draft | — |\n`,
    );
  });

  await w.getByTestId("tab-board").click();
  const cards = w.getByTestId("board-column-draft").locator('[data-testid^="board-card-RQ-"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAttribute("data-testid", "board-card-RQ-0002");

  await app.close();
});
