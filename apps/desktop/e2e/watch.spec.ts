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
 * TC-0076. What anything writes, the workspace shows, with no turn ending — the test process plays
 * the terminal (RQ-0026, DC-0022).
 *
 * The renderer does not yet call `project:open` on the click that opens a project (a gap this story
 * did not create and is not the one to close — see the coordinator note in the session report), so
 * the harness starts the watch itself the way TC-0039's own third case reaches a channel directly:
 * through `project:open`, evaluated in the page rather than clicked.
 */
const RQ_1 = `---
type: Requirement
id: RQ-0001
title: "Already on the board"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — Already on the board

## Acceptance criteria

- [AC-1] It starts in draft.
`;

const RQ_2 = `---
type: Requirement
id: RQ-0002
title: "Written by the terminal"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0002 — Written by the terminal

## Acceptance criteria

- [AC-1] Nobody in the app wrote this file.
`;

async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "watch-config-"));
  const work = mkdtempSync(join(tmpdir(), "watch-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  // A raw template copy leaves `owner: {{OWNER}}` in the seed playbooks (journey.spec.ts's pattern).
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, `docs/playbooks/${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "srini"));
  }
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ_1);
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | Already on the board | draft | — |\n`,
  );

  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "-m",
    "seed",
  ]);

  // A harness on file, or the first-run attach dialog sits over the launch page (TC-0004) — never
  // started, since the point of this test is that nothing here ever runs a turn.
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

  // The door the coordinator note points at closing: `project:open` is what starts the watch
  // (RQ-0026#AC-7), and nothing in the running renderer calls it yet.
  await w.evaluate(
    async ({ id }) => {
      const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
      await api.invoke("project:open", { id });
    },
    { id: "p1" },
  );

  return { app, w, work };
}

test("a file written by the terminal, a state flipped on disk, and a terminal commit all reach the workspace with no turn", async () => {
  const { app, w, work } = await open();

  // Something already expanded, so there is a directory that could go stale rather than be read
  // fresh (refresh.spec.ts's precedent) — the new file below lands inside it.
  await w.getByTestId("file-row").filter({ hasText: "docs" }).first().click();
  await w.getByTestId("file-row").filter({ hasText: "requirements" }).first().click();
  await expect(w.getByTestId("file-row").filter({ hasText: "README.md" }).first()).toBeVisible();
  await expect(w.getByTestId("file-row").filter({ hasText: "rq-0002.md" })).toHaveCount(0);

  // AC-1: the test process is the terminal. Nothing in the app's window did this write.
  writeFileSync(join(work, "docs/requirements/rq-0002.md"), RQ_2);
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0002](rq-0002.md) | Written by the terminal | draft | — |\n`,
  );

  await expect(w.getByTestId("file-row").filter({ hasText: "rq-0002.md" })).toBeVisible({
    timeout: 10000,
  });

  // AC-2: a state changed on disk, not through `project:artifact-save`, moves the card.
  await w.getByTestId("tab-plan").click();
  await expect(w.getByTestId("board-card-RQ-0001")).toBeVisible();

  writeFileSync(
    join(work, "docs/requirements/rq-0001.md"),
    RQ_1.replace("state: draft", "state: ready"),
  );
  writeFileSync(
    index,
    readFileSync(index, "utf8").replace(
      "| [RQ-0001](rq-0001.md) | Already on the board | draft | — |",
      "| [RQ-0001](rq-0001.md) | Already on the board | ready | — |",
    ),
  );

  await expect(w.getByTestId("board-column-ready").getByTestId("board-card-RQ-0001")).toBeVisible({
    timeout: 10000,
  });

  // AC-3: a commit made outside the application reaches the Git tab's history.
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "-m",
    "a terminal commit",
  ]);

  await w.getByTestId("rail-tab-git").click();
  await expect(w.getByText("a terminal commit")).toBeVisible({ timeout: 10000 });

  // No turn ran anywhere above: `start-h` was never clicked, so nothing but this test process wrote
  // to `work` at all. AC-5's "one refresh, not three" is the burst-collapsing TC-0075 already proves
  // at the watcher itself — there is no cross-process way to count a renderer's own re-fetches from
  // here.

  await app.close();
});
