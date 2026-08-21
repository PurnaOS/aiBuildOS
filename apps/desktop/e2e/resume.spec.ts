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

/**
 * TC-0095, TC-0096 — RQ-0036 / ST-0054, against the running application.
 *
 * Mirrors `worktree.spec.ts`'s fixture mechanics (seed, index rows, the `{{OWNER}}` loop, config
 * overrides), a story seeded straight at `building` rather than walked there through the board —
 * `build:resume`'s own board control (RQ-0037) lands in a later slot, so every acceptance
 * criterion here is driven straight through `window.aibuildos.invoke`, the real preload bridge.
 *
 * Lesson from ST-0044's own round: never poll for a transient state. "review" and "building" are
 * both momentary once a fast stub is running — this asserts the declared path's *outcome*
 * (`state: review` after a turn, `state: building` right after resume, before any prompt), never a
 * state in between.
 */
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

const RQ = `---
type: Requirement
id: RQ-0001
title: "Notes get written"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — Notes get written

## Acceptance criteria

- [AC-1] A note lands in notes.md.
`;

const TC = `---
type: TestCase
id: TC-0001
title: "Notes get written, verified"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: manual
links:
  verifies: [RQ-0001]
---

# TC-0001 — Notes get written, verified

## Steps

1. Check notes.md changed.
`;

function story(state: string): string {
  return `---
type: Story
id: ST-0001
title: "Write a note"
state: ${state}
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ST-0001 — Write a note

A scripted slice: whatever the agent writes to \`notes.md\`.

## Acceptance criteria

- [AC-1] notes.md contains a new line.
`;
}

function seed(state: string): { config: string; work: string; worktrees: string } {
  const config = mkdtempSync(join(tmpdir(), "resume-config-"));
  const work = mkdtempSync(join(tmpdir(), "resume-work-"));
  const worktrees = mkdtempSync(join(tmpdir(), "resume-worktrees-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);
  writeFileSync(join(work, "docs/user-stories/st-0001.md"), story(state));

  const rqIndex = join(work, "docs/requirements/README.md");
  writeFileSync(
    rqIndex,
    `${readFileSync(rqIndex, "utf8")}| [RQ-0001](rq-0001.md) | Notes get written | ready | — |\n`,
  );
  const tcIndex = join(work, "docs/testing/README.md");
  writeFileSync(
    tcIndex,
    `${readFileSync(tcIndex, "utf8")}| [TC-0001](tc-0001.md) | Notes get written, verified | draft | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );
  const stIndex = join(work, "docs/user-stories/README.md");
  writeFileSync(
    stIndex,
    `${readFileSync(stIndex, "utf8")}| [ST-0001](st-0001.md) | Write a note | ${state} | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );

  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }

  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "seed", "--quiet"]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=file-writer"],
      },
    ]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  return { config, work, worktrees };
}

async function open(
  config: string,
  worktrees: string,
): Promise<{ app: ElectronApplication; w: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
      AIBUILDOS_WORKTREES_ROOT: worktrees,
    },
  });
  const w = await app.firstWindow();
  await expect(w.getByTestId("title")).toBeVisible();
  return { app, w };
}

/** `window.aibuildos.invoke`, from the page — the real preload bridge. */
function invoke<C extends string>(w: Page, channel: C, request: unknown): Promise<unknown> {
  return w.evaluate(
    ([ch, req]) => {
      const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
      return api.invoke(ch as never, req as never);
    },
    [channel, request] as const,
  );
}

test("build:resume re-attaches after a relaunch: review walks back to building, and the same checkpoint→flip runs again", async () => {
  const { config, work, worktrees } = seed("building");
  const storyFile = join(work, "docs/user-stories/st-0001.md");

  const first = await open(config, worktrees);
  const started = await invoke(first.w, "build:start", {
    projectId: "p1",
    storyId: "ST-0001",
    harnessId: "h",
  });
  expect(started).toMatchObject({ ok: true });
  const sessionId = (started as { ok: true; sessionId: string }).sessionId;

  await invoke(first.w, "session:prompt", { sessionId, text: "build it" });
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toContain("state: review");

  // Closed without a merge or a discard — `before-quit` ends every session, but the worktree, its
  // branch and the record's `review` state all survive on disk (DC-0021, RQ-0036).
  await first.app.close();

  const second = await open(config, worktrees);
  const resumed = await invoke(second.w, "build:resume", {
    projectId: "p1",
    storyId: "ST-0001",
    harnessId: "h",
  });
  expect(resumed).toMatchObject({ ok: true });
  const resumedSessionId = (resumed as { ok: true; sessionId: string }).sessionId;

  // ST-0054#AC-3: review walks back to building before the fresh session ever prompts.
  expect(readFileSync(storyFile, "utf8")).toContain("state: building");

  // The same `attach()` a fresh build uses: a turn on the resumed session checkpoints and flips.
  await invoke(second.w, "session:prompt", { sessionId: resumedSessionId, text: "keep going" });
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toContain("state: review");

  const wtPath = join(worktrees, "p1", "ST-0001");
  expect(
    execFileSync("git", ["-C", wtPath, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  ).not.toBe("1"); // more than the single seed commit: both turns' checkpoints landed.

  await second.app.close();
});

test("build:resume refuses not_found with no surviving worktree, and already_attached with a session already there", async () => {
  const { config, worktrees } = seed("building");
  const { app, w } = await open(config, worktrees);

  const beforeStart = await invoke(w, "build:resume", {
    projectId: "p1",
    storyId: "ST-0001",
    harnessId: "h",
  });
  expect(beforeStart).toEqual({ ok: false, code: "not_found", message: expect.any(String) });

  const started = await invoke(w, "build:start", {
    projectId: "p1",
    storyId: "ST-0001",
    harnessId: "h",
  });
  expect(started).toMatchObject({ ok: true });

  const whileAttached = await invoke(w, "build:resume", {
    projectId: "p1",
    storyId: "ST-0001",
    harnessId: "h",
  });
  expect(whileAttached).toEqual({
    ok: false,
    code: "already_attached",
    message: expect.any(String),
  });

  await app.close();
});
