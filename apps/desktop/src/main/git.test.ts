import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  branches,
  commitAll,
  commitStaged,
  fetchRemote,
  GitError,
  git,
  initRepo,
  pull,
  push,
  recentCommits,
  repoRoot,
  stagePath,
  status,
  toGitError,
  unstagePath,
} from "./git.js";

/**
 * TC-0007. Reading a repository, and naming Git's own failures.
 *
 * Against the real `git` binary in a temp directory: the point of DC-0010 is that there is no second
 * implementation of Git semantics, so there is nothing to test against except Git.
 *
 * Identity is configured **locally** in each fixture repo rather than relied on from the developer's
 * global config, so the suite behaves the same on a fresh CI machine.
 */
describe("the git boundary", () => {
  let dir: string;

  const identify = async (): Promise<void> => {
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.com");
    // A repo-local identity is not enough if commit signing is on globally and no agent is present.
    await git(dir, "config", "commit.gpgsign", "false");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-git-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no repository before init, and the directory itself after", async () => {
    expect(await repoRoot(dir)).toBeNull();

    await initRepo(dir);

    // Compared with `realpath`: on macOS the temp directory is reached through a symlink.
    const root = await repoRoot(dir);
    expect(root).not.toBeNull();
    expect(await git(dir, "rev-parse", "--show-toplevel")).toContain(root ?? "");
  });

  it("returns an empty log for a repository with no commits (ST-0005#AC-4)", async () => {
    await initRepo(dir);
    expect(await recentCommits(dir)).toEqual([]);
  });

  it("counts an untracked file as untracked only", async () => {
    await initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "one", "utf8");

    const tree = await status(dir);

    expect(tree).toMatchObject({ untracked: 1, staged: 0, unstaged: 0, conflicted: 0 });
  });

  it("counts a staged file, then reports a clean tree and the commit", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "a.txt"), "one", "utf8");
    await git(dir, "add", "a.txt");

    expect(await status(dir)).toMatchObject({ staged: 1, untracked: 0, unstaged: 0 });

    await git(dir, "commit", "-m", "add a");

    const tree = await status(dir);
    expect(tree).toMatchObject({ staged: 0, unstaged: 0, untracked: 0 });
    expect(tree.branch).not.toBeNull();

    const [commit] = await recentCommits(dir);
    expect(commit?.subject).toBe("add a");
    expect(commit?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(Number.isNaN(Date.parse(commit?.date ?? ""))).toBe(false);
  });

  it("keeps hash and date intact when a commit subject contains the separator", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "a.txt"), "one", "utf8");
    // Git allows control characters in a message. A reader that splits naively loses the date.
    await git(dir, "add", "-A");
    await git(dir, "commit", "-m", "subject with \u001f a separator in it");

    const [commit] = await recentCommits(dir);

    expect(commit?.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(Number.isNaN(Date.parse(commit?.date ?? ""))).toBe(false);
    expect(commit?.subject).toContain("a separator in it");
  });

  it("counts a modified tracked file as unstaged", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "a.txt"), "one", "utf8");
    await commitAll(dir, "add a");

    writeFileSync(join(dir, "a.txt"), "two", "utf8");

    expect(await status(dir)).toMatchObject({ unstaged: 1, staged: 0, untracked: 0 });
  });

  /**
   * `changed` counts paths, `staged`/`unstaged` count statuses, and one path can carry both. Summing
   * the counters reports "2 uncommitted" for a single edited file, which is what the launch page row
   * used to print.
   */
  it("counts a staged-then-edited file as one changed path", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "a.txt"), "one", "utf8");
    await commitAll(dir, "add a");

    writeFileSync(join(dir, "a.txt"), "two", "utf8");
    await git(dir, "add", "a.txt");
    writeFileSync(join(dir, "a.txt"), "three", "utf8");

    const tree = await status(dir);

    expect(tree.staged).toBe(1);
    expect(tree.unstaged).toBe(1);
    expect(tree.changed).toBe(1);
  });

  it("counts an untracked directory once, not once per file inside it", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "a.txt"), "one", "utf8");
    await commitAll(dir, "add a");

    mkdirSync(join(dir, "build", "nested"), { recursive: true });
    for (const name of ["one", "two", "three"]) {
      writeFileSync(join(dir, "build", "nested", `${name}.txt`), name, "utf8");
    }

    const tree = await status(dir);

    expect(tree.untracked).toBe(1);
    expect(tree.changed).toBe(1);
  });

  /**
   * The reason porcelain v2 is parsed by hand at all: a renamed entry is followed by a *second*
   * NUL-terminated field holding the original path. A reader that does not consume it parses that
   * path as the next record — and `utils.ts` starts with `u`, which is the code for a conflicted
   * entry, so a real repository renaming a real file grows a phantom merge conflict.
   *
   * The original name here therefore matters: it has to begin with one of the record prefixes
   * (`1`, `2`, `u`, `?`) for the bug to be visible at all.
   */
  it("consumes a rename's original path instead of reading it as a record", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "utils.ts"), "one", "utf8");
    writeFileSync(join(dir, "b.txt"), "two", "utf8");
    await commitAll(dir, "add utils and b");

    await git(dir, "mv", "utils.ts", "helpers.ts");
    // Changes *after* the rename are what a bad parser miscounts.
    writeFileSync(join(dir, "b.txt"), "changed", "utf8");
    writeFileSync(join(dir, "c.txt"), "new", "utf8");

    const tree = await status(dir);

    expect(tree.staged).toBe(1); // the rename
    expect(tree.unstaged).toBe(1); // b.txt
    expect(tree.untracked).toBe(1); // c.txt
    expect(tree.conflicted).toBe(0); // `utils.ts` is not a conflict
  });

  it("reports the repository root from a subdirectory, not the subdirectory (RQ-0002#AC-5)", async () => {
    await initRepo(dir);
    const nested = join(dir, "packages", "inner");
    mkdirSync(nested, { recursive: true });

    expect(await repoRoot(nested)).toBe(await repoRoot(dir));
  });

  it("carries Git's own message when it is not a repository", async () => {
    await expect(git(dir, "rev-parse", "--show-toplevel")).rejects.toMatchObject({
      code: "git_failed",
    });

    const error = await git(dir, "rev-parse", "--show-toplevel").catch((cause) => cause);
    expect(error).toBeInstanceOf(GitError);
    expect(error.message).toMatch(/not a git repository/i);
  });

  /**
   * `.git/config` travels with a directory, and `core.fsmonitor` names a program `git status` runs.
   * Adopting one unpacked archive would otherwise execute it on every launch, for every launch —
   * silently, since Git reports exit 0 with empty stderr even when the program fails (DC-0010).
   */
  it("never executes a repository's own fsmonitor program while reading it", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "a.txt"), "one", "utf8");
    await commitAll(dir, "add a");

    const marker = join(dir, "EXECUTED");
    const program = join(dir, "fsmonitor.sh");
    writeFileSync(program, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, "utf8");
    chmodSync(program, 0o755);
    await git(dir, "config", "core.fsmonitor", program);

    // Every read the application performs against a project it did not create.
    await status(dir);
    await recentCommits(dir);
    await repoRoot(dir);

    expect(existsSync(marker)).toBe(false);
  });

  it("reports a missing identity as its own outcome (RQ-0002#AC-11)", async () => {
    await initRepo(dir);
    // Empty strings defeat the global config *and* Git's auto-detection from the hostname.
    await git(dir, "config", "user.name", "");
    await git(dir, "config", "user.email", "");
    writeFileSync(join(dir, "a.txt"), "one", "utf8");

    await expect(commitAll(dir, "add a")).rejects.toMatchObject({ code: "git_identity" });
  });
});

/**
 * TC-0055. The first writes: stage, unstage and commit, against the real binary.
 *
 * Same posture as the reads above — nothing here reimplements Git, everything is asked of a real
 * repository in a temp directory.
 */
describe("the first writes (RQ-0018)", () => {
  let dir: string;

  const identify = async (): Promise<void> => {
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "user.email", "test@example.com");
    await git(dir, "config", "commit.gpgsign", "false");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-git-write-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stages, unstages and restages a path, then commits it — counts follow, and the commit lands in the log", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "a.txt"), "one", "utf8");

    await stagePath(dir, "a.txt");
    expect(await status(dir)).toMatchObject({ staged: 1, unstaged: 0, untracked: 0 });

    await unstagePath(dir, "a.txt");
    expect(await status(dir)).toMatchObject({ staged: 0, unstaged: 0, untracked: 1 });

    await stagePath(dir, "a.txt");
    expect(await status(dir)).toMatchObject({ staged: 1, unstaged: 0, untracked: 0 });

    const hash = await commitStaged(dir, "add a");

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(await status(dir)).toMatchObject({ staged: 0, unstaged: 0, untracked: 0 });

    const [commit] = await recentCommits(dir);
    expect(commit?.subject).toBe("add a");
    expect(hash.startsWith(commit?.hash ?? "\0")).toBe(true);
  });

  it("unstages a path before the first commit exists — an unborn branch", async () => {
    await initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "one", "utf8");
    await stagePath(dir, "a.txt");
    expect(await status(dir)).toMatchObject({ staged: 1, untracked: 0 });

    await unstagePath(dir, "a.txt");

    expect(await status(dir)).toMatchObject({ staged: 0, untracked: 1 });
  });

  it("reports Git's own words, not execFile's wrapper text, when nothing is staged to commit", async () => {
    await initRepo(dir);
    await identify();
    writeFileSync(join(dir, "a.txt"), "one", "utf8");
    await commitAll(dir, "add a"); // a clean tree — nothing staged for the next commit

    const error = await commitStaged(dir, "empty").catch((cause) => cause);

    expect(error).toBeInstanceOf(GitError);
    // Git prints this refusal to stdout, not stderr — the gap this hardens.
    expect(error.message).toMatch(/nothing to commit/i);
    expect(error.message).not.toMatch(/^Command failed/);
  });

  /**
   * `#!/bin/sh` needs a POSIX shell to run the hook at all — not present as `sh` on a stock Windows
   * runner — so this is the one test in the suite that cannot run there. Everything it verifies
   * (RQ-0018#AC-3) is otherwise unexercised on win32 CI, which is a known gap, not a silent one.
   */
  it.skipIf(process.platform === "win32")(
    "a rejecting pre-commit hook reports its own words, and leaves the work staged",
    async () => {
      await initRepo(dir);
      await identify();
      const hook = join(dir, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\necho 'no, said the hook' 1>&2\nexit 1\n", "utf8");
      chmodSync(hook, 0o755);
      writeFileSync(join(dir, "a.txt"), "one", "utf8");
      await stagePath(dir, "a.txt");

      const error = await commitStaged(dir, "blocked").catch((cause) => cause);

      expect(error).toBeInstanceOf(GitError);
      expect(error.code).toBe("git_failed");
      expect(error.message).toContain("no, said the hook");
      // The hook ran *instead of* the commit — the work is exactly where staging left it.
      expect(await status(dir)).toMatchObject({ staged: 1, unstaged: 0 });
      expect(await recentCommits(dir)).toEqual([]);
    },
  );

  it("treats a path and a message full of shell metacharacters as plain argv, never shell text", async () => {
    await initRepo(dir);
    await identify();
    // If this ever reached a shell, `$(touch PWNED)` would run and `;` would end the command early.
    const marker = join(dir, "PWNED");
    const trickyName = "$(touch PWNED); a.txt";
    const trickyMessage = "message with `backticks`, $(a command) and ; a semicolon";
    writeFileSync(join(dir, trickyName), "one", "utf8");

    await stagePath(dir, trickyName);
    const hash = await commitStaged(dir, trickyMessage);

    expect(existsSync(marker)).toBe(false);
    const [commit] = await recentCommits(dir);
    expect(commit?.subject).toBe(trickyMessage);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });
});

/**
 * RQ-0032. `toGitError`'s regex mappings, fed canned stderr directly — no real Git run, because
 * the point is the string matching, not the plumbing `git.test.ts`'s other suites already cover.
 */
describe("toGitError's mapped codes (RQ-0032)", () => {
  it.each([
    "remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.com/repo.git/'",
    "fatal: could not read Username for 'https://example.com': No such device or address",
    "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "error: terminal prompts disabled because GIT_TERMINAL_PROMPT=0",
  ])("maps %j to git_auth", (stderr) => {
    const error = toGitError({ stderr });
    expect(error.code).toBe("git_auth");
    expect(error.stderr).toBe(stderr);
  });

  it.each([
    "fatal: No configured push destination.\nEither specify the URL from the command-line or configure a remote repository using\n\n    git remote add <name> <url>",
    "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.",
    "fatal: no remote repository specified. Please, specify either a URL or a\nremote name from which new revisions should be fetched.",
  ])("maps %j to no_remote", (stderr) => {
    const error = toGitError({ stderr });
    expect(error.code).toBe("no_remote");
    expect(error.stderr).toBe(stderr);
  });

  it("falls back to git_failed for a wording neither maps", () => {
    const error = toGitError({ stderr: "fatal: something else entirely went wrong" });
    expect(error.code).toBe("git_failed");
  });
});

/**
 * RQ-0032, RQ-0033. Fetch, pull and push against a real bare origin — the same discipline as the
 * suites above, because there is no second implementation of Git's remote protocol to test
 * against either.
 */
describe("remote sync (RQ-0032, RQ-0033)", () => {
  let origin: string;
  let work: string;
  let branch: string;
  const extra: string[] = [];

  const identify = async (repo: string): Promise<void> => {
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "commit.gpgsign", "false");
    // A machine with this on globally makes a plain `push` on an unpublished branch succeed
    // without `-u`, which would let the retry path pass without ever exercising it.
    await git(repo, "config", "push.autoSetupRemote", "false");
  };

  /** A second clone of `origin`, configured and ready to commit — for the pull/fetch tests. */
  const cloneFrom = async (): Promise<string> => {
    const scratch = mkdtempSync(join(tmpdir(), "aibuildos-git-clone-"));
    extra.push(scratch);
    await git(scratch, "clone", "--quiet", origin, "clone");
    const clone = join(scratch, "clone");
    await identify(clone);
    return clone;
  };

  beforeEach(async () => {
    origin = mkdtempSync(join(tmpdir(), "aibuildos-git-origin-"));
    work = mkdtempSync(join(tmpdir(), "aibuildos-git-work-"));
    extra.push(origin, work);

    await git(origin, "init", "--quiet", "--bare");
    await git(work, "init", "--quiet");
    await identify(work);
    writeFileSync(join(work, "a.txt"), "one", "utf8");
    await commitAll(work, "seed");
    await git(work, "remote", "add", "origin", origin);
    // Never hardcoded: `init.defaultBranch` varies by machine.
    branch = (await git(work, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  });

  afterEach(() => {
    for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("publishes a new branch via the retry path, landing the commit in the bare repo", async () => {
    const result = await push(work);

    expect(result).toEqual({ branch });
    expect((await git(origin, "rev-parse", branch)).trim()).toBe(
      (await git(work, "rev-parse", "HEAD")).trim(),
    );
  });

  it("pushes plainly once the upstream is set", async () => {
    await push(work);
    writeFileSync(join(work, "b.txt"), "two", "utf8");
    await commitAll(work, "add b");

    const result = await push(work);

    expect(result).toEqual({ branch });
    expect((await git(origin, "rev-parse", branch)).trim()).toBe(
      (await git(work, "rev-parse", "HEAD")).trim(),
    );
  });

  it("fast-forwards on pull", async () => {
    await push(work);
    const clone = await cloneFrom();
    writeFileSync(join(clone, "c.txt"), "three", "utf8");
    await commitAll(clone, "add c");
    await push(clone);

    await pull(work);

    expect((await git(work, "rev-parse", "HEAD")).trim()).toBe(
      (await git(clone, "rev-parse", "HEAD")).trim(),
    );
  });

  it("refuses to pull a diverged branch, in git's own words", async () => {
    await push(work);
    const clone = await cloneFrom();
    writeFileSync(join(clone, "c.txt"), "three", "utf8");
    await commitAll(clone, "add c");
    await push(clone);

    // work diverges from what the clone published — neither is an ancestor of the other.
    writeFileSync(join(work, "d.txt"), "four", "utf8");
    await commitAll(work, "add d");

    const error = await pull(work).catch((cause) => cause);

    expect(error).toBeInstanceOf(GitError);
    expect(error.code).toBe("git_failed");
    expect(error.message.length).toBeGreaterThan(0);
  });

  it("updates refs/remotes on fetch without touching the working tree", async () => {
    await push(work);
    const clone = await cloneFrom();
    writeFileSync(join(clone, "c.txt"), "three", "utf8");
    await commitAll(clone, "add c");
    await push(clone);
    const before = (await git(work, "rev-parse", "HEAD")).trim();

    await fetchRemote(work);

    expect((await git(work, "rev-parse", "HEAD")).trim()).toBe(before);
    expect((await git(work, "rev-parse", `origin/${branch}`)).trim()).toBe(
      (await git(clone, "rev-parse", "HEAD")).trim(),
    );
  });

  it("reports ahead 1 behind 0 after pushing and committing locally (RQ-0033#AC-1)", async () => {
    await push(work);
    writeFileSync(join(work, "b.txt"), "two", "utf8");
    await commitAll(work, "add b");

    expect(await status(work)).toMatchObject({ ahead: 1, behind: 0 });
  });

  it("lists every branch with its upstream and counts, and nulls for one with none (RQ-0033#AC-2,3)", async () => {
    await push(work);
    await git(work, "branch", "topic");

    const result = await branches(work);

    expect(result.current).toBe(branch);
    expect(result.branches.find((b) => b.name === branch)).toMatchObject({
      upstream: `origin/${branch}`,
      ahead: 0,
      behind: 0,
    });
    expect(result.branches.find((b) => b.name === "topic")).toMatchObject({
      upstream: null,
      ahead: null,
      behind: null,
    });
  });
});
