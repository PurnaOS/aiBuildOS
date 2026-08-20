import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointWorktree, discardBuild, listBuilds, mergeBuild } from "./builds.js";
import { git, status, worktreeAdd, worktreeList } from "./git.js";
import { SessionRegistry } from "./sessions.js";

/**
 * TC-0066. Worktree verbs at the Git boundary, against real repositories — the same discipline
 * `git.test.ts` uses, because DC-0010's whole point is that there is no second implementation of
 * Git semantics to test against instead.
 *
 * `startBuild` is deliberately not exercised here: it needs a live agent session, which is
 * `sessions.test.ts`'s discipline (TC-0060), not this one's. Everything TC-0066 actually asks —
 * create, checkpoint, merge, conflict, prune — sits below that, reachable through `worktreeAdd` and
 * `builds.ts`'s own exported verbs with no session anywhere in the picture. `listBuilds` still wants
 * a `SessionRegistry` to ask what is live; an idle one answers truthfully that nothing is.
 */
describe("worktree builds", () => {
  let main: string;
  let root: string;
  let sessions: SessionRegistry;

  const identify = async (dir: string): Promise<void> => {
    await git(dir, "config", "user.name", "Test Person");
    await git(dir, "config", "user.email", "test@example.com");
    await git(dir, "config", "commit.gpgsign", "false");
  };

  beforeEach(async () => {
    main = mkdtempSync(join(tmpdir(), "aibuildos-worktrees-main-"));
    root = mkdtempSync(join(tmpdir(), "aibuildos-worktrees-root-"));
    await git(main, "init", "--quiet");
    await identify(main);
    writeFileSync(join(main, "README.md"), "seed\n");
    await git(main, "add", "-A");
    await git(main, "commit", "-q", "-m", "seed");
    sessions = new SessionRegistry(
      () => undefined,
      () => "closest",
    );
  });

  afterEach(() => {
    rmSync(main, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a worktree on its own branch, branched from HEAD, listed by the enumeration", async () => {
    const wtPath = join(root, "st-0042");
    await worktreeAdd(main, wtPath, "aibuildos/st-0042");

    // Matched by branch, not by path: macOS reaches a temp directory through a symlink
    // (`/var` → `/private/var`), and Git reports the resolved path (git.test.ts hits the same thing).
    const list = await worktreeList(main);
    expect(list.some((w) => w.branch === "aibuildos/st-0042")).toBe(true);

    const mainHead = (await git(main, "rev-parse", "HEAD")).trim();
    const wtHead = (await git(wtPath, "rev-parse", "HEAD")).trim();
    expect(wtHead).toBe(mainHead);
  });

  it("checkpoints a dirty worktree on its branch, and does nothing to a clean one", async () => {
    const wtPath = join(root, "st-0043");
    await worktreeAdd(main, wtPath, "aibuildos/st-0043");
    writeFileSync(join(wtPath, "notes.md"), "hello\n");

    const result = await checkpointWorktree(wtPath, "checkpoint: ST-0043 turn 1");
    expect(result).toEqual({ ok: true, committed: true });
    expect((await status(wtPath)).changed).toBe(0);
    expect((await git(wtPath, "log", "-1", "--format=%s")).trim()).toBe(
      "checkpoint: ST-0043 turn 1",
    );

    // Clean now: a second checkpoint commits nothing.
    const again = await checkpointWorktree(wtPath, "checkpoint: ST-0043 turn 2");
    expect(again).toEqual({ ok: true, committed: false });
    expect((await git(wtPath, "log", "-1", "--format=%s")).trim()).toBe(
      "checkpoint: ST-0043 turn 1",
    );
  });

  it("a rejecting hook surfaces its words, and checkpoints nothing", async () => {
    const wtPath = join(root, "st-0044");
    await worktreeAdd(main, wtPath, "aibuildos/st-0044");
    writeFileSync(join(wtPath, "notes.md"), "hello\n");

    // Worktrees share one `.git` directory, hooks included.
    const hooksDir = join(main, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'no thanks' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = await checkpointWorktree(wtPath, "checkpoint: ST-0044 turn 1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("no thanks");

    // Nothing checkpointed: the worktree is still dirty.
    expect((await status(wtPath)).changed).toBeGreaterThan(0);
  });

  it("merges a clean branch --no-ff, and removes the worktree and the branch", async () => {
    const wtPath = join(root, "st-0045");
    await worktreeAdd(main, wtPath, "aibuildos/st-0045");
    writeFileSync(join(wtPath, "feature.md"), "feature\n");
    await checkpointWorktree(wtPath, "checkpoint: ST-0045 turn 1");

    const result = await mergeBuild(main, "ST-0045");
    expect(result).toEqual({ ok: true });

    expect(existsSync(join(main, "feature.md"))).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
    expect((await git(main, "branch", "--list", "aibuildos/st-0045")).trim()).toBe("");
    expect((await git(main, "log", "-1", "--format=%s")).trim()).toBe("ST-0045: accept the build");
  });

  it("a conflicting merge is Git's words, main untouched, the worktree still there — discard removes it", async () => {
    const wtPath = join(root, "st-0046");
    await worktreeAdd(main, wtPath, "aibuildos/st-0046");
    writeFileSync(join(wtPath, "README.md"), "changed on the branch\n");
    await checkpointWorktree(wtPath, "checkpoint: ST-0046 turn 1");

    writeFileSync(join(main, "README.md"), "changed on main\n");
    await git(main, "add", "-A");
    await git(main, "commit", "-q", "-m", "change on main");
    const beforeLog = (await git(main, "log", "--oneline")).trim();

    const result = await mergeBuild(main, "ST-0046");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);

    // Left exactly as Git left it: no merge commit, no lingering conflict in the index.
    expect((await git(main, "log", "--oneline")).trim()).toBe(beforeLog);
    expect((await status(main)).changed).toBe(0);
    expect(existsSync(wtPath)).toBe(true);

    const discarded = await discardBuild(main, "ST-0046");
    expect(discarded.problem).toBeNull();
    expect(existsSync(wtPath)).toBe(false);
    expect((await git(main, "branch", "--list", "aibuildos/st-0046")).trim()).toBe("");
  });

  it("prunes a worktree deleted by hand, so the enumeration is honest again", async () => {
    const wtPath = join(root, "st-0047");
    await worktreeAdd(main, wtPath, "aibuildos/st-0047");
    rmSync(wtPath, { recursive: true, force: true });

    const { builds, problem } = await listBuilds(sessions, main);
    expect(problem).toBeNull();
    expect(builds.some((build) => build.storyId === "ST-0047")).toBe(false);
  });
});
