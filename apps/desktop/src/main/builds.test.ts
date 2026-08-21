import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventPayload } from "@aibuildos/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeBuild, resumeBuild, startBuild, startSprint } from "./builds.js";
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

/** Registers a project and a harness the way `ipc.ts`'s stores would, for `resumeBuild` — which,
 * unlike `startBuild`, is handed raw ids and resolves both itself (ST-0054). */
function registerConfig(configDir: string, projectId: string, work: string): void {
  writeFileSync(
    join(configDir, "projects.json"),
    JSON.stringify([{ id: projectId, name: "demo", path: work, lastOpened: null }]),
  );
  writeFileSync(
    join(configDir, "harnesses.json"),
    JSON.stringify([
      {
        id: harness.id,
        displayName: harness.displayName,
        command: harness.command,
        args: harness.args,
      },
    ]),
  );
}

describe("the build's flip", () => {
  let worktrees: string;
  let configDir: string;
  let projects: string[];
  let sessions: SessionRegistry;
  let flips: { sessionId: string; value: unknown }[];

  beforeEach(() => {
    worktrees = mkdtempSync(join(tmpdir(), "aibuildos-builds-worktrees-"));
    configDir = mkdtempSync(join(tmpdir(), "aibuildos-builds-config-"));
    process.env.AIBUILDOS_WORKTREES_ROOT = worktrees;
    // Pointed at a directory with no files yet — `loadProjects`/`loadHarnesses` read a missing file
    // as empty, never a throw, so tests that never call `resumeBuild` are unaffected.
    process.env.AIBUILDOS_PROJECTS_FILE = join(configDir, "projects.json");
    process.env.AIBUILDOS_HARNESSES_FILE = join(configDir, "harnesses.json");
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
    delete process.env.AIBUILDOS_PROJECTS_FILE;
    delete process.env.AIBUILDOS_HARNESSES_FILE;
    rmSync(worktrees, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const work of projects)
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it(
    "a sprint story branches from the sprint branch, flips stay in main, and the sprint branch's " +
      "docs/ stays byte-identical to its base until merge (DC-0025, ST-0053)",
    async () => {
      const work = await seedProject("ST-0004", "building");
      projects.push(work);
      const storyFile = join(work, "docs/user-stories/st-0004.md");

      const sprint = await startSprint(work, "SP-0001");
      if (!sprint.ok) throw new Error(sprint.message);
      const sprintBase = (await git(work, "rev-parse", sprint.branch)).trim();

      const started = await startBuild(
        sessions,
        { id: "p1", path: work },
        "ST-0004",
        harness,
        "SP-0001",
      );
      if (!started.ok) throw new Error(`${started.code}: ${started.message}`);

      await sessions.prompt(started.sessionId, "build it");
      await waitFor(() => readFileSync(storyFile, "utf8").includes("state: review"));

      // The flip landed in main's own checkout (ST-0053#AC-3) — the sprint branch's own copy of
      // the story is untouched, still at `building`.
      expect(await git(work, "show", `${sprint.branch}:docs/user-stories/st-0004.md`)).toContain(
        "state: building",
      );

      const merged = await mergeBuild(work, "ST-0004");
      expect(merged).toEqual({ ok: true });

      // ST-0053#AC-2: the checkpoint landed on the sprint branch, not main.
      expect(
        (await git(work, "rev-list", "--count", `${sprintBase}..${sprint.branch}`)).trim(),
      ).not.toBe("0");
      // DC-0025's byte-identical invariant: even with that checkpoint landed, the sprint branch's
      // docs/ is still exactly what it was at its base — the flip never touched it.
      expect((await git(work, "diff", sprintBase, sprint.branch, "--", "docs/")).trim()).toBe("");
    },
  );

  it("startBuild refuses no_sprint when the named sprint has no worktree", async () => {
    const work = await seedProject("ST-0008", "building");
    projects.push(work);

    const result = await startBuild(
      sessions,
      { id: "p1", path: work },
      "ST-0008",
      harness,
      "SP-9999",
    );
    expect(result).toEqual({ ok: false, code: "no_sprint", message: expect.any(String) });
  });

  it("resumeBuild re-attaches to a surviving worktree: review walks back to building, and the same attach() runs its checkpoint→flip", async () => {
    const work = await seedProject("ST-0005", "building");
    projects.push(work);
    registerConfig(configDir, "p1", work);
    const storyFile = join(work, "docs/user-stories/st-0005.md");

    const started = await startBuild(sessions, { id: "p1", path: work }, "ST-0005", harness);
    if (!started.ok) throw new Error(`${started.code}: ${started.message}`);
    await sessions.prompt(started.sessionId, "build it");
    await waitFor(() => readFileSync(storyFile, "utf8").includes("state: review"));

    // The session ends (quit, crash) without a merge or a discard — the worktree, its branch, and
    // the record's `review` state all survive on disk, exactly as DC-0021 promises.
    await sessions.close(started.sessionId);

    const resumed = await resumeBuild(sessions, "p1", "ST-0005", harness.id);
    if (!resumed.ok) throw new Error(`${resumed.code}: ${resumed.message}`);

    // ST-0054#AC-3: review walks back to building before the fresh session ever prompts.
    expect(readFileSync(storyFile, "utf8")).toContain("state: building");

    // The same attach(): a turn on the resumed session checkpoints and flips exactly as a fresh
    // build's would.
    await sessions.prompt(resumed.sessionId, "keep going");
    await waitFor(() => readFileSync(storyFile, "utf8").includes("state: review"));
  });

  it("resumeBuild refuses not_found for an unknown project, harness, or worktree", async () => {
    const work = await seedProject("ST-0006", "building");
    projects.push(work);
    registerConfig(configDir, "p1", work);

    expect(await resumeBuild(sessions, "nope", "ST-0006", harness.id)).toEqual({
      ok: false,
      code: "not_found",
      message: expect.any(String),
    });
    expect(await resumeBuild(sessions, "p1", "ST-0006", "nope")).toEqual({
      ok: false,
      code: "not_found",
      message: expect.any(String),
    });
    // No worktree was ever started for ST-0006.
    expect(await resumeBuild(sessions, "p1", "ST-0006", harness.id)).toEqual({
      ok: false,
      code: "not_found",
      message: expect.any(String),
    });
  });

  it("resumeBuild refuses already_attached while a session is already running for the story", async () => {
    const work = await seedProject("ST-0007", "building");
    projects.push(work);
    registerConfig(configDir, "p1", work);

    const started = await startBuild(sessions, { id: "p1", path: work }, "ST-0007", harness);
    if (!started.ok) throw new Error(`${started.code}: ${started.message}`);

    expect(await resumeBuild(sessions, "p1", "ST-0007", harness.id)).toEqual({
      ok: false,
      code: "already_attached",
      message: expect.any(String),
    });
  });
});
