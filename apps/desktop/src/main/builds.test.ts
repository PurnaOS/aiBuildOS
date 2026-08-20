import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventPayload } from "@aibuildos/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBuild } from "./builds.js";
import { git } from "./git.js";
import type { Harness } from "./harnesses.js";
import { SessionRegistry } from "./sessions.js";

// `startBuild` reads `app.getVersion()` only to label the ACP handshake (`ipc.ts` does the same for
// the main session) — the stub does not care what the string is, and the real Electron `app` does
// not exist outside the running application. Same accommodation `worktreesRoot()` already makes for
// `app.getPath`, one layer further in.
vi.mock("electron", () => ({ app: { getVersion: () => "0.0.0-test" } }));

/**
 * TC-0073. The `building → review` flip belongs to main, against the build's own project (BG-0007,
 * ST-0041) — driven through `startBuild` itself with the scripted stub agent, spawned exactly as
 * `sessions.test.ts` spawns it (TC-0060's discipline), against a real git repository seeded from the
 * same OKF template `worktree.spec.ts` copies for its own fixture, so the transition check runs
 * against the genuine Story profile rather than a stand-in. No renderer, no window, anywhere here.
 */
const template = fileURLToPath(new URL("./okf-template/docs", import.meta.url));
const stub = fileURLToPath(
  new URL("../../../../tools/stub-acp-agent/src/agent.ts", import.meta.url),
);

const harness: Harness = {
  id: "stub",
  displayName: "Stub",
  command: process.execPath,
  args: ["--experimental-strip-types", stub, "--mode=file-writer"],
};

function story(id: string, state: string): string {
  return `---
type: Story
id: ${id}
title: "A scripted story"
state: ${state}
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ${id} — A scripted story

## Acceptance criteria

- [AC-1] It does the thing.
`;
}

/** A real project — the OKF template plus one Story at `state` — so the flip runs against the
 * genuine Story profile's transition table (`docs/profile/story.md`), not a stand-in. */
async function seedProject(storyId: string, state: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "aibuildos-builds-work-"));
  await git(work, "init", "--quiet");
  await git(work, "config", "user.name", "Test Person");
  await git(work, "config", "user.email", "test@example.com");
  await git(work, "config", "commit.gpgsign", "false");
  cpSync(template, join(work, "docs"), { recursive: true });
  // The template ships every playbook with an unresolved `{{OWNER}}` token (worktree.spec.ts hits
  // the same thing) — filled in so the bundle walk this test's own flip triggers parses cleanly.
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }
  writeFileSync(join(work, `docs/user-stories/${storyId.toLowerCase()}.md`), story(storyId, state));
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "seed");
  return work;
}

/** Poll until true, rather than a fixed sleep — the checkpoint and the flip both run off the turn's
 * own `RUN_FINISHED`, on a chain the caller's `prompt()` await does not itself wait for. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the build's flip", () => {
  let worktrees: string;
  let projects: string[];
  let sessions: SessionRegistry;
  let flips: { sessionId: string; value: unknown }[];

  beforeEach(() => {
    worktrees = mkdtempSync(join(tmpdir(), "aibuildos-builds-worktrees-"));
    process.env.AIBUILDOS_WORKTREES_ROOT = worktrees;
    projects = [];
    flips = [];
    sessions = new SessionRegistry(
      (event, payload) => {
        if (event !== "session:event") return;
        const { name, value } = (payload as EventPayload<"session:event">).event as unknown as {
          name?: string;
          value?: unknown;
        };
        if (name === "aibuildos.flip") {
          flips.push({ sessionId: (payload as EventPayload<"session:event">).sessionId, value });
        }
      },
      () => "closest",
    );
  });

  afterEach(async () => {
    await sessions.closeAll();
    delete process.env.AIBUILDOS_WORKTREES_ROOT;
    rmSync(worktrees, { recursive: true, force: true });
    for (const work of projects) rmSync(work, { recursive: true, force: true });
  });

  it("flips the story to review in the build's own project when its turn ends, no renderer anywhere", async () => {
    const work = await seedProject("ST-0001", "building");
    projects.push(work);
    const storyFile = join(work, "docs/user-stories/st-0001.md");

    const started = await startBuild(sessions, { id: "p1", path: work }, "ST-0001", harness);
    if (!started.ok) throw new Error(`${started.code}: ${started.message}`);

    await sessions.prompt(started.sessionId, "build it");

    await waitFor(() => readFileSync(storyFile, "utf8").includes("state: review"));
    expect(flips).toEqual([]);
  });

  it("two projects, same story id: only the build's own project flips", async () => {
    const workA = await seedProject("ST-0002", "building");
    const workB = await seedProject("ST-0002", "building");
    projects.push(workA, workB);
    const storyA = join(workA, "docs/user-stories/st-0002.md");
    const storyB = join(workB, "docs/user-stories/st-0002.md");

    const started = await startBuild(sessions, { id: "a", path: workA }, "ST-0002", harness);
    if (!started.ok) throw new Error(`${started.code}: ${started.message}`);

    await sessions.prompt(started.sessionId, "build it");

    await waitFor(() => readFileSync(storyA, "utf8").includes("state: review"));
    expect(readFileSync(storyB, "utf8")).toContain("state: building");
  });

  it("refuses an illegal flip exactly as the save handler does: a story at draft is left alone, no crash", async () => {
    const work = await seedProject("ST-0003", "draft");
    projects.push(work);
    const storyFile = join(work, "docs/user-stories/st-0003.md");
    const wtPath = join(worktrees, "p1", "ST-0003");

    const started = await startBuild(sessions, { id: "p1", path: work }, "ST-0003", harness);
    if (!started.ok) throw new Error(`${started.code}: ${started.message}`);

    await sessions.prompt(started.sessionId, "build it");

    // Nothing to poll toward on the Story itself — it never moves. The checkpoint's own commit
    // landing on the worktree's branch is proof the turn-end handler ran as far as the flip
    // attempt chained right after it; a short grace period covers that last, synchronous step.
    await waitFor(async () => {
      const subject = await git(wtPath, "log", "-1", "--format=%s").catch(() => "");
      return subject.trim() === "checkpoint: ST-0003 turn 1";
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readFileSync(storyFile, "utf8")).toContain("state: draft");
    expect(flips).toEqual([]);
  });
});
