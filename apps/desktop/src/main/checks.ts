/**
 * The project's checks (RQ-0019, ST-0033): the fenced ` ```check ` commands of a checks playbook,
 * run as child processes, exit codes the whole verdict.
 *
 * A stub until ST-0033 lands — the channel and handler exist so the lane building this never edits
 * the shared files.
 */

export interface CheckResult {
  readonly command: string;
  readonly outcome: "passed" | "failed" | "could_not_run";
  readonly exitCode: number | null;
}

export async function runChecks(
  _projectPath: string,
  _onOutput: (command: string, chunk: string) => void,
): Promise<{ results: CheckResult[]; problem: string | null }> {
  return { results: [], problem: "Running checks is not built yet." };
}
