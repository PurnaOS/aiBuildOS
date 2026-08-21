import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpointWorktree,
  discardBuild,
  discardSprint,
  listBuilds,
  mergeBuild,
  mergeSprint,
  startSprint,
} from "./builds.js";
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
/**
 * The same directory, however each side spells it.
 *
 * Git reports a worktree's path in its own dialect: forward slashes on Windows, and the *long*
 * name where Node's `mkdtemp` handed back an 8.3 short one (`RUNNER~1` vs `runneradmin`) — CI
 * proved both. macOS differs a third way, reaching temp through the `/var` → `/private/var`
 * symlink. Comparing spellings tests the platform; comparing the directory tests the code.
 */
function sameDirectory(reported: string | undefined, expected: string): boolean {
  if (reported === undefined) return false;
  const key = (path: string): string =>
    realpathSync.native(path).replaceAll("\\", "/").toLowerCase();
  return key(reported) === key(expected);
}

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

  it("a plain build's row carries a null sprintId and reports commits ahead of its base", async () => {
    const wtPath = join(root, "st-0052");
    await worktreeAdd(main, wtPath, "aibuildos/st-0052");

    const before = (await listBuilds(sessions, main)).builds.find((b) => b.storyId === "ST-0052");
    expect(before?.sprintId).toBeNull();
    expect(before?.ahead).toBe(0);
    expect(sameDirectory(before?.path, wtPath)).toBe(true);

    writeFileSync(join(wtPath, "notes.md"), "hello\n");
    await checkpointWorktree(wtPath, "checkpoint: ST-0052 turn 1");

    const after = (await listBuilds(sessions, main)).builds.find((b) => b.storyId === "ST-0052");
    expect(after?.ahead).toBe(1);
    expect(after?.lastCheckpointAt).not.toBeNull();
  });
});

/**
 * TC-0091, TC-0092, TC-0093, TC-0094. A sprint's git side (RQ-0035, DC-0025): the branch and its
 * worktree are the whole record, story worktrees bind to it with `--`, and the `stories_live` guard
 * keeps finish and discard from running out from under a build. No OKF bundle, no session, no
 * renderer — the same discipline as the story-worktree tests above, `startSprint`/`mergeSprint`/
 * `discardSprint` exercised directly against a real repository.
 */
describe("sprint worktrees", () => {
  let main: string;
  let root: string;
  let sessions: SessionRegistry;

  beforeEach(async () => {
    main = mkdtempSync(join(tmpdir(), "aibuildos-sprints-main-"));
    root = mkdtempSync(join(tmpdir(), "aibuildos-sprints-root-"));
    // `startSprint` invents its own worktree path via `worktreesRoot()` — pointed here so it never
    // reaches for a real Electron `userData` directory (the same override `builds.test.ts` sets).
    process.env.AIBUILDOS_WORKTREES_ROOT = root;
    await git(main, "init", "--quiet");
    await git(main, "config", "user.name", "Test Person");
    await git(main, "config", "user.email", "test@example.com");
    await git(main, "config", "commit.gpgsign", "false");
    writeFileSync(join(main, "README.md"), "seed\n");
    await git(main, "add", "-A");
    await git(main, "commit", "-q", "-m", "seed");
    sessions = new SessionRegistry(
      () => undefined,
      () => "closest",
    );
  });

  afterEach(() => {
    delete process.env.AIBUILDOS_WORKTREES_ROOT;
    rmSync(main, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("starts a sprint: branch and worktree, checked out on it, and refuses a second start", async () => {
    const started = await startSprint(main, "SP-0001");
    expect(started).toEqual({ ok: true, branch: "aibuildos/sp-0001" });
    if (!started.ok) return;

    const list = await worktreeList(main);
    const sprintWorktree = list.find((w) => w.branch === started.branch);
    if (!sprintWorktree) throw new Error("no sprint worktree");
    expect((await git(sprintWorktree.path, "rev-parse", "HEAD")).trim()).toBe(
      (await git(main, "rev-parse", "HEAD")).trim(),
    );

    const again = await startSprint(main, "SP-0001");
    expect(again).toEqual({
      ok: false,
      code: "sprint_exists",
      message: expect.any(String),
    });
  });

  it("a story branches from the sprint branch, and its accepted merge lands there, not on main", async () => {
    const sprint = await startSprint(main, "SP-0002");
    if (!sprint.ok) throw new Error(sprint.message);
    const sprintWorktree = (await worktreeList(main)).find((w) => w.branch === sprint.branch);
    if (!sprintWorktree) throw new Error("no sprint worktree");

    const storyWtPath = join(root, "st-0049");
    await worktreeAdd(main, storyWtPath, "aibuildos/sp-0002--st-0049", sprint.branch);
    // Branched from the sprint branch, not from main's HEAD directly.
    expect((await git(storyWtPath, "rev-parse", "HEAD")).trim()).toBe(
      (await git(sprintWorktree.path, "rev-parse", "HEAD")).trim(),
    );

    writeFileSync(join(storyWtPath, "feature.md"), "feature\n");
    await checkpointWorktree(storyWtPath, "checkpoint: ST-0049 turn 1");
    const mainHeadBefore = (await git(main, "rev-parse", "HEAD")).trim();

    const result = await mergeBuild(main, "ST-0049");
    expect(result).toEqual({ ok: true });

    // Landed on the sprint branch's worktree — main never moved.
    expect((await git(main, "rev-parse", "HEAD")).trim()).toBe(mainHeadBefore);
    expect(existsSync(join(sprintWorktree.path, "feature.md"))).toBe(true);
    expect((await git(sprintWorktree.path, "log", "-1", "--format=%s")).trim()).toBe(
      "ST-0049: accept the build",
    );
    expect(existsSync(storyWtPath)).toBe(false);
    expect((await git(main, "branch", "--list", "aibuildos/sp-0002--st-0049")).trim()).toBe("");
  });

  it("mergeSprint and discardSprint refuse stories_live while a story worktree survives", async () => {
    const sprint = await startSprint(main, "SP-0003");
    if (!sprint.ok) throw new Error(sprint.message);
    const storyWtPath = join(root, "st-0050");
    await worktreeAdd(main, storyWtPath, "aibuildos/sp-0003--st-0050", sprint.branch);

    expect(await mergeSprint(main, "SP-0003")).toEqual({
      ok: false,
      code: "stories_live",
      message: expect.any(String),
    });
    expect(await discardSprint(main, "SP-0003")).toEqual({
      ok: false,
      code: "stories_live",
      message: expect.any(String),
    });

    // The story finishes; the guard lifts.
    const discardedStory = await discardBuild(main, "ST-0050");
    expect(discardedStory.problem).toBeNull();

    const merged = await mergeSprint(main, "SP-0003");
    expect(merged).toEqual({ ok: true });
    expect((await git(main, "branch", "--list", sprint.branch)).trim()).toBe("");
  });

  it("finishing a sprint is --no-ff into main; a conflict aborts clean and leaves the worktree", async () => {
    const sprint = await startSprint(main, "SP-0004");
    if (!sprint.ok) throw new Error(sprint.message);
    const sprintWorktree = (await worktreeList(main)).find((w) => w.branch === sprint.branch);
    if (!sprintWorktree) throw new Error("no sprint worktree");

    writeFileSync(join(sprintWorktree.path, "sprint-work.md"), "done\n");
    await checkpointWorktree(sprintWorktree.path, "sprint work");

    const result = await mergeSprint(main, "SP-0004");
    expect(result).toEqual({ ok: true });
    expect(existsSync(join(main, "sprint-work.md"))).toBe(true);
    expect((await git(main, "log", "-1", "--format=%s")).trim()).toBe("SP-0004: finish the sprint");
    expect((await git(main, "log", "-1", "--format=%P")).trim().split(" ").length).toBe(2);
  });

  it("a conflicting sprint merge is Git's words, main untouched", async () => {
    const sprint = await startSprint(main, "SP-0005");
    if (!sprint.ok) throw new Error(sprint.message);
    const sprintWorktree = (await worktreeList(main)).find((w) => w.branch === sprint.branch);
    if (!sprintWorktree) throw new Error("no sprint worktree");

    writeFileSync(join(sprintWorktree.path, "README.md"), "changed on the sprint\n");
    await checkpointWorktree(sprintWorktree.path, "sprint edit");

    writeFileSync(join(main, "README.md"), "changed on main\n");
    await git(main, "add", "-A");
    await git(main, "commit", "-q", "-m", "change on main");
    const beforeLog = (await git(main, "log", "--oneline")).trim();

    const result = await mergeSprint(main, "SP-0005");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("conflict");

    expect((await git(main, "log", "--oneline")).trim()).toBe(beforeLog);
    expect((await status(main)).changed).toBe(0);
    expect(existsSync(sprintWorktree.path)).toBe(true);
  });

  it("listBuilds classifies a sprint worktree separately, with its live story count", async () => {
    const sprint = await startSprint(main, "SP-0006");
    if (!sprint.ok) throw new Error(sprint.message);
    const storyWtPath = join(root, "st-0051");
    await worktreeAdd(main, storyWtPath, "aibuildos/sp-0006--st-0051", sprint.branch);
    writeFileSync(join(storyWtPath, "notes.md"), "hi\n");
    await checkpointWorktree(storyWtPath, "checkpoint: ST-0051 turn 1");

    const { builds, sprints, problem } = await listBuilds(sessions, main);
    expect(problem).toBeNull();

    const row = builds.find((b) => b.storyId === "ST-0051");
    expect(row?.sprintId).toBe("SP-0006");
    expect(sameDirectory(row?.path, storyWtPath)).toBe(true);
    expect(row?.ahead).toBe(1);

    const sprintRow = sprints.find((s) => s.sprintId === "SP-0006");
    expect(sprintRow).toEqual({
      sprintId: "SP-0006",
      branch: sprint.branch,
      path: expect.any(String),
      dirty: false,
      stories: 1,
    });
  });
});
