import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOkfDocument } from "@aibuildos/knowledge-engine";

/**
 * The project's checks (RQ-0019, ST-0033): the fenced ` ```check ` commands of every active checks
 * playbook, run as child processes in main, exit codes the whole verdict.
 *
 * Fence source: **every** active `Playbook` artifact under `docs/playbooks/` that carries at least
 * one ` ```check ` fence contributes its commands, concatenated in artifact-ID order — not only a
 * playbook titled "Run the checks". A project may split its gate across more than one playbook, and
 * asking main to recognise one by title would be a second place a name has to agree with the record;
 * the record is asked what it declares, nothing is matched by convention.
 *
 * `parseOkfDocument` (knowledge-engine) is the one parser of frontmatter/body; this module only
 * extracts fences from the body string it is handed, which keeps the engine the only
 * frontmatter/docs-semantics parser in the application.
 *
 * Each command runs via `spawn(command, { shell: true, ... })`. That is not user input crossing a
 * trust boundary the way a Git argument is (DC-0010's argv-only rule is about *that* boundary) — a
 * fenced command line is exactly a `package.json` script: written by whoever owns the project,
 * naming pipes and flags a shell is needed to word-split.
 */

export interface CheckResult {
  readonly command: string;
  readonly outcome: "passed" | "failed" | "could_not_run";
  readonly exitCode: number | null;
}

const PLAYBOOK_FILE = /^pb-\d{4,}\.md$/i;
/** A fence's opening and closing markers are their own lines; `m` anchors each `^`/`$` to one. */
const CHECK_FENCE = /^```check\n([\s\S]*?)\n```$/gm;

/** The fenced `check` commands of one artifact body, in the order they appear. Exported for its own test. */
export function extractCheckCommands(body: string): string[] {
  return [...body.matchAll(CHECK_FENCE)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((command) => command !== "");
}

/**
 * Every check command this project declares, from every active `Playbook` under `docs/playbooks/`,
 * in artifact-ID order. Empty when there is no playbooks directory, no active playbook, or no
 * playbook with a `check` fence — all three are "this project declares no checks", not an error.
 */
function projectCheckCommands(projectPath: string): string[] {
  const dir = join(projectPath, "docs", "playbooks");
  if (!existsSync(dir)) return [];

  const commands: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!PLAYBOOK_FILE.test(entry)) continue;

    let parsed: ReturnType<typeof parseOkfDocument>;
    try {
      parsed = parseOkfDocument(readFileSync(join(dir, entry), "utf8"));
    } catch {
      // An artifact that will not parse is `docs:check`'s complaint, not this runner's — it
      // contributes no commands rather than failing the whole gate.
      continue;
    }

    if (parsed.frontmatter.type !== "Playbook" || parsed.frontmatter.state !== "active") continue;
    commands.push(...extractCheckCommands(parsed.body));
  }
  return commands;
}

/** Every child this process has spawned and not yet seen exit, so `killChecks` has something to kill. */
const live = new Set<ChildProcess>();

/**
 * Run one command to completion, streaming its combined stdout/stderr to `onOutput` as it arrives.
 *
 * Exit code is the whole verdict (RQ-0019): `0` passes, anything else fails — except `127`, POSIX
 * `sh`'s own convention for "the shell ran, the command named inside it did not exist". That is still
 * reading the exit code, not the words a shell printed, so it answers `could_not_run` rather than
 * `failed`. A genuine spawn failure (the shell itself could not start) answers the same way, with no
 * exit code at all.
 */
function runOne(
  command: string,
  projectPath: string,
  onOutput: (command: string, chunk: string) => void,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, cwd: projectPath, windowsHide: true });
    live.add(child);
    const forget = (): void => void live.delete(child);

    child.stdout?.on("data", (chunk: Buffer) => onOutput(command, chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => onOutput(command, chunk.toString("utf8")));

    child.on("error", () => {
      forget();
      resolve({ command, outcome: "could_not_run", exitCode: null });
    });

    child.on("close", (code) => {
      forget();
      const outcome = code === 0 ? "passed" : code === 127 ? "could_not_run" : "failed";
      resolve({ command, outcome, exitCode: code });
    });
  });
}

/**
 * Run every check this project declares, sequentially, in the order they were declared. Resolves
 * once every command has exited; live output arrives through `onOutput` as each one runs.
 */
export async function runChecks(
  projectPath: string,
  onOutput: (command: string, chunk: string) => void,
): Promise<{ results: CheckResult[]; problem: string | null }> {
  const commands = projectCheckCommands(projectPath);
  if (commands.length === 0) {
    return {
      results: [],
      problem: "This project declares no checks — no active playbook carries a `check` fence.",
    };
  }

  const results: CheckResult[] = [];
  for (const command of commands) {
    results.push(await runOne(command, projectPath, onOutput));
  }
  return { results, problem: null };
}

/**
 * Kill every check still running. Called from the application's `before-quit` (RQ-0019#AC-5) —
 * closing the window must not leave an orphaned check process behind.
 *
 * ponytail: kills the direct child only. For one simple command `sh -c` execs into it (proven
 * empirically: same pid, no orphan), but a compound fence (`a && b`) or a command that itself forks
 * (`bun run typecheck` spawning `tsc`) can leave a grandchild behind. Upgrade path if that turns out
 * to matter: `spawn(command, { ..., detached: true })` and `process.kill(-child.pid)` to signal the
 * whole process group instead of one pid.
 */
export function killChecks(): void {
  for (const child of live) child.kill();
  live.clear();
}
