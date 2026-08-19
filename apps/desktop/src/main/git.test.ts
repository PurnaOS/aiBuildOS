import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, GitError, git, initRepo, recentCommits, repoRoot, status } from "./git.js";

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

  it("reports a missing identity as its own outcome (RQ-0002#AC-11)", async () => {
    await initRepo(dir);
    // Empty strings defeat the global config *and* Git's auto-detection from the hostname.
    await git(dir, "config", "user.name", "");
    await git(dir, "config", "user.email", "");
    writeFileSync(join(dir, "a.txt"), "one", "utf8");

    await expect(commitAll(dir, "add a")).rejects.toMatchObject({ code: "git_identity" });
  });
});
