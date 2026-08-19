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
  const error = cause as { code?: unknown; stderr?: unknown; message?: unknown };
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

  const message = stderr || (typeof error.message === "string" ? error.message : "git failed");
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

/**
 * Branch, upstream divergence and working-tree counts in one invocation — which is what lets the
 * launch page afford a status read per row.
 *
 * `--porcelain=v2 -z`: NUL-terminated records, because a filename may contain a newline and the
 * line-based format quotes such paths instead of reporting them plainly.
 */
export async function status(dir: string): Promise<GitStatus> {
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
  let changed = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicted = 0;

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
      changed += 1;
      untracked += 1;
      continue;
    }
    if (kind === "u") {
      changed += 1;
      conflicted += 1;
      continue;
    }
    if (kind === "1" || kind === "2") {
      changed += 1;
      // `<kind> <XY> ...` — X is the staged status, Y the unstaged one, `.` meaning unchanged.
      const xy = record.slice(2, 4);
      if (xy[0] !== undefined && xy[0] !== ".") staged += 1;
      if (xy[1] !== undefined && xy[1] !== ".") unstaged += 1;
      // A rename (`2`) is followed by a *second* NUL-terminated field holding the original path.
      // Not consuming it makes the next record parse as a path and throws every later count off.
      if (kind === "2") index += 1;
    }
  }

  return { branch, changed, staged, unstaged, untracked, conflicted };
}
