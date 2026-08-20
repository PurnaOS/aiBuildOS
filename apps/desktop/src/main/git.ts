import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * The system Git boundary (ST-0003, ST-0005, TC-0007).
 *
 * Every Git call in the application goes through `git()`, which invokes the system binary with an
 * **argv array and never a shell string** (DC-0010). Branch names, paths and messages are arguments,
 * so shell injection is not a class of bug that exists here.
 *
 * Driving the user's own Git means their config, hooks, credential helpers and signing all apply —
 * that is the point, and it is also why creating a project can fail for reasons that belong to their
 * machine. Those reasons get their own codes rather than one opaque failure.
 *
 * Node APIs only: this runs on Electron's bundled Node (AR-0001).
 */
const run = promisify(execFile);

export type GitErrorCode =
  /** No `git` on PATH at all. A real first-run state on a clean machine, not an exception. */
  | "git_missing"
  /** `user.name` / `user.email` are not configured, so nothing can be committed. */
  | "git_identity"
  /** Git ran and said no. `stderr` carries its own words. */
  | "git_failed";

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly stderr = "",
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Run one Git command in `cwd` and return its stdout.
 *
 * `-C <cwd>` rather than `{ cwd }` so that when the directory has been deleted the failure comes from
 * Git, with Git's wording, instead of from the spawn.
 */
export async function git(cwd: string, ...argv: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...argv], {
      // The 1 MB default overflows on `status` in a tree with tens of thousands of untracked files,
      // and reports it as a failure of the repository rather than of the buffer.
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        // Reading status must not fight a concurrent Git for the index lock.
        GIT_OPTIONAL_LOCKS: "0",
        // Never let a credential prompt block a child process nobody can see.
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return stdout;
  } catch (cause) {
    throw toGitError(cause);
  }
}

function toGitError(cause: unknown): GitError {
  const error = cause as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown };
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";

  if (error.code === "ENOENT") {
    return new GitError(
      "git_missing",
      "Git is not installed, or is not on this application's PATH. " +
        "Install the Xcode Command Line Tools or Git, then try again.",
      stderr,
    );
  }

  if (/Please tell me who you are|unable to auto-detect email|empty ident name/i.test(stderr)) {
    return new GitError(
      "git_identity",
      "Git has no identity configured, so it cannot commit. Set one with " +
        '`git config --global user.name "..."` and `git config --global user.email "..."`.',
      stderr,
    );
  }

  // Git explains some refusals on stdout, not stderr — `commit` with nothing staged among them.
  // Falling straight through to `error.message` there reports execFile's own wrapper text
  // ("Command failed: git -C ... commit -m ...") instead of the words Git actually said.
  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  const message =
    stderr || stdout || (typeof error.message === "string" ? error.message : "git failed");
  return new GitError("git_failed", message, stderr);
}

/**
 * Configuration this application refuses to honour when **reading** a repository it did not create.
 *
 * `core.fsmonitor` names a program Git executes during `status`, and `.git/config` travels with a
 * directory — cloning does not carry it, but an unpacked archive or a folder on a shared drive does.
 * The launch page reads every registered project on every launch, so adopting one hostile directory
 * once would re-arm it indefinitely, and Git runs it silently: measured on 2.54.0, a program that
 * exits non-zero still leaves `git status` at exit 0 with empty stderr.
 *
 * Deliberately scoped to reads, and deliberately narrow — see DC-0010. `fsmonitor` is a performance
 * cache, not Git semantics, so forcing it off costs only the speed-up on a very large repository.
 * Hooks, credential helpers, signing and merge behaviour are untouched.
 */
const UNTRUSTED_READ = ["-c", "core.fsmonitor="];

/**
 * `git`, for commands that read a repository the user pointed this application at.
 *
 * Writes — `init`, `add`, `commit` — deliberately do *not* go through here: they only ever run in a
 * directory the application just created, and they are exactly the operations DC-0010 wants running
 * under the user's own hooks and signing.
 */
async function readGit(cwd: string, ...argv: string[]): Promise<string> {
  return await git(cwd, ...UNTRUSTED_READ, ...argv);
}

/**
 * The root of the repository containing `dir`, or `null` when `dir` is not in one.
 *
 * Deliberately not `existsSync(dir + "/.git")`: adopting a *subdirectory* of an existing repository
 * must not initialise a second repository inside it (RQ-0002#AC-5), and only asking Git can tell the
 * difference.
 */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return (await readGit(dir, "rev-parse", "--show-toplevel")).trim();
  } catch (cause) {
    // Only Git's own "not a repository" means there is no repository. Every other failure —
    // `detected dubious ownership`, a permission error, a corrupt `.git` — is a repository this
    // process cannot read, and answering `null` there would let the caller `git init` on top of one.
    if (cause instanceof GitError && /not a git repository/i.test(cause.stderr)) return null;
    throw cause;
  }
}

export async function initRepo(dir: string): Promise<void> {
  // No `-b <name>`: honour the user's `init.defaultBranch` rather than imposing one, and stay
  // compatible with Git older than 2.28 where the flag does not exist.
  await git(dir, "init", "--quiet");
}

/** `add -A` then `commit`. Runs the user's hooks and signing, because that is what DC-0010 chose. */
export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-m", message);
}

export interface GitCommit {
  readonly hash: string;
  readonly subject: string;
  /** ISO-8601, straight from `%aI`. Formatting is the renderer's problem. */
  readonly date: string;
}

export interface GitStatus {
  /** Git's own branch name, or `null` when HEAD is detached. */
  readonly branch: string | null;
  /**
   * Distinct **paths** touched in the working tree.
   *
   * Not the sum of the counters below: porcelain v2 emits one record per path with both a staged and
   * an unstaged status, so one file edited, staged, then edited again appears in `staged` *and* in
   * `unstaged`, and adding them reports two changes for one file.
   */
  readonly changed: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicted: number;
}

/** ASCII unit separator. A commit subject can contain anything printable, but not this. */
const UNIT = "\u001f";

/**
 * Recent commits, newest first. An empty list for a repository with no commits — a directory that was
 * just adopted is the normal case, not an error (ST-0005#AC-4).
 */
export async function recentCommits(dir: string, limit = 10): Promise<GitCommit[]> {
  let stdout: string;
  try {
    // Subject **last**: it is the only field a commit author writes, and Git allows a unit separator
    // inside a commit message. With it last, everything after the second separator is the subject, so
    // a crafted message cannot shift the hash or the date. `%s` is the first line only, so the
    // line-based split above stays safe too.
    stdout = await readGit(dir, "log", "-n", String(limit), `--format=%h${UNIT}%aI${UNIT}%s`);
  } catch (cause) {
    if (cause instanceof GitError && /does not have any commits yet/i.test(cause.stderr)) return [];
    throw cause;
  }

  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [hash = "", date = "", ...subject] = line.split(UNIT);
      return { hash, date, subject: subject.join(UNIT) };
    });
}

/** One path the working tree reports as changed. */
export interface GitChange {
  readonly path: string;
  /** Git's own two letters: the staged status and the unstaged one, `.` meaning unchanged. */
  readonly staged: string;
  readonly unstaged: string;
  readonly untracked: boolean;
  readonly conflicted: boolean;
}

/**
 * Branch and every changed path, from one invocation.
 *
 * `--porcelain=v2 -z`: NUL-terminated records, because a filename may contain a newline and the
 * line-based format quotes such paths instead of reporting them plainly.
 */
export async function changes(
  dir: string,
): Promise<{ branch: string | null; entries: GitChange[] }> {
  const stdout = await readGit(
    dir,
    "status",
    "--porcelain=v2",
    "--branch",
    // `normal`, not `all`: this runs for every row of the launch page, and `all` walks every file
    // inside an untracked directory — one un-ignored `node_modules` turns the ledger into a
    // multi-second, multi-megabyte read. Collapsing to the directory is also the truer count.
    "--untracked-files=normal",
    "-z",
  );

  const records = stdout.split("\0");
  let branch: string | null = null;
  const entries: GitChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record === "") continue;

    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      // `(detached)` is not a branch name. A null branch *is* the detached signal.
      branch = head === "(detached)" ? null : head;
      continue;
    }
    if (record.startsWith("#")) continue;

    const kind = record[0];
    if (kind === "?") {
      entries.push({
        path: record.slice(2),
        staged: ".",
        unstaged: ".",
        untracked: true,
        conflicted: false,
      });
      continue;
    }

    const fields = record.split(" ");
    const xy = fields[1] ?? "..";
    // The path is everything after the fixed fields, rejoined — a path may contain spaces.
    const from = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    const path = fields.slice(from).join(" ");

    if (kind === "1" || kind === "2" || kind === "u") {
      entries.push({
        path,
        staged: xy[0] ?? ".",
        unstaged: xy[1] ?? ".",
        untracked: false,
        conflicted: kind === "u",
      });
      // A rename (`2`) is followed by a *second* NUL-terminated field holding the original path.
      // Not consuming it makes the next record parse as a path and throws every later count off.
      if (kind === "2") index += 1;
    }
  }

  return { branch, entries };
}

/**
 * Branch and working-tree counts, derived from the same read.
 *
 * Counts come from the entries rather than being tallied separately, so the number the launch page
 * shows and the list the Git rail shows can never disagree.
 */
export async function status(dir: string): Promise<GitStatus> {
  const { branch, entries } = await changes(dir);

  return {
    branch,
    changed: entries.length,
    staged: entries.filter((entry) => !entry.untracked && entry.staged !== ".").length,
    unstaged: entries.filter((entry) => !entry.untracked && entry.unstaged !== ".").length,
    untracked: entries.filter((entry) => entry.untracked).length,
    conflicted: entries.filter((entry) => entry.conflicted).length,
  };
}

/**
 * Which of these paths the repository ignores.
 *
 * Asked of Git rather than guessed at: `.gitignore` composes global, repo and nested rules, and a
 * hand-rolled matcher would disagree with the repository the user actually has.
 *
 * Paths go in on **stdin**, because `check-ignore` refuses `-z` any other way — and `-z` is what
 * keeps a path containing a newline from being read as two paths, the same reason `status` uses it.
 *
 * Deliberately lenient. `check-ignore` exits 1 when nothing matches, which is not a failure, and if
 * Git cannot answer at all the honest result is "nothing is known to be ignored" — listing too much
 * beats hiding a project.
 */
export async function ignored(dir: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();

  const stdout = await new Promise<string>((resolve) => {
    const child = execFile(
      "git",
      ["-C", dir, ...UNTRUSTED_READ, "check-ignore", "-z", "--stdin"],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (_error, out) => resolve(out),
    );
    child.stdin?.end(paths.join("\0"));
  });

  return new Set(stdout.split("\0").filter((path) => path !== ""));
}

/**
 * The first writes (RQ-0018). Same posture as every read above: the user's own Git, argv only,
 * failures in Git's — or a hook's — own words via `GitError`.
 */
export async function stagePath(cwd: string, path: string): Promise<void> {
  await git(cwd, "add", "--", path);
}

export async function unstagePath(cwd: string, path: string): Promise<void> {
  // `reset -- <path>` rather than `restore --staged`: it also unstages a file the repository has
  // no commit for yet, which `restore` refuses on an unborn branch.
  await git(cwd, "reset", "--", path);
}

/** Commit what is staged; the new commit's hash on success. Hooks run — that is the point. */
export async function commitStaged(cwd: string, message: string): Promise<string> {
  await git(cwd, "commit", "-m", message);
  return (await git(cwd, "rev-parse", "HEAD")).trim();
}

/**
 * Worktree verbs (RQ-0020, DC-0021): the branch is the binding, `git worktree list` is the
 * enumeration, and every operation here is exactly what a person would type — no second
 * implementation of what a worktree is.
 *
 * `list`/`prune` are reads, run with the same `core.fsmonitor` carve-out as `status`/`log`: they run
 * on every `build:list`, the same read-heavy path those already sit on. `add`/`remove` and the merge
 * verbs are writes, for the same reason `commitAll` is: they run under the user's own hooks and
 * signing, and forcing `fsmonitor` off for them would be forcing it off for a write DC-0010 never
 * asked to touch.
 */
export interface Worktree {
  readonly path: string;
  /** `null` for a detached worktree — not one this application ever creates, but Git's own state
   * can hold one, and pretending otherwise would misreport it as `aibuildos/undefined`. */
  readonly branch: string | null;
}

/** Every worktree `git worktree list --porcelain` reports, branch names stripped of `refs/heads/`. */
export async function worktreeList(projectPath: string): Promise<Worktree[]> {
  const stdout = await readGit(projectPath, "worktree", "list", "--porcelain");

  const worktrees: Worktree[] = [];
  let current: { path?: string; branch?: string } = {};
  const flush = (): void => {
    if (current.path !== undefined)
      worktrees.push({ path: current.path, branch: current.branch ?? null });
    current = {};
  };

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
    // `HEAD <sha>`, `detached`, `locked`, `prunable` — nothing downstream needs them.
  }
  flush();

  return worktrees;
}

/** A worktree for a fresh branch `-b <branch>`, from `projectPath`'s current `HEAD` (DC-0021). */
export async function worktreeAdd(
  projectPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await git(projectPath, "worktree", "add", "-b", branch, worktreePath, "HEAD");
}

/** Removes the worktree's administrative entry and, unless `force`, refuses if it is dirty. */
export async function worktreeRemove(
  projectPath: string,
  worktreePath: string,
  force = false,
): Promise<void> {
  await git(projectPath, "worktree", "remove", ...(force ? ["--force"] : []), worktreePath);
}

/** Clears the administrative entry for a worktree directory deleted by hand (TC-0066 step 5). */
export async function worktreePrune(projectPath: string): Promise<void> {
  await git(projectPath, "worktree", "prune");
}

/** `--no-ff`: the accept press is the person's commit, and history should say a merge happened
 * rather than fast-forwarding it away (DC-0021). Throws `GitError` on conflict; main is left as
 * Git left it — the caller is what runs `merge --abort`. */
export async function mergeBranch(
  projectPath: string,
  branch: string,
  message: string,
): Promise<void> {
  await git(projectPath, "merge", "--no-ff", branch, "-m", message);
}

/** Leaves main clean after a conflicting merge. Failing here (nothing to abort) is not this
 * caller's problem — main was never touched by a merge that never landed. */
export async function mergeAbort(projectPath: string): Promise<void> {
  await git(projectPath, "merge", "--abort");
}

export async function deleteBranch(
  projectPath: string,
  branch: string,
  force = false,
): Promise<void> {
  await git(projectPath, "branch", force ? "-D" : "-d", branch);
}
