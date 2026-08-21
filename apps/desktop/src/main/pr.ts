import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * PR status for the current branch via the `gh` CLI (RQ-0034, DC-0024).
 *
 * `gh` is an *optional* external binary: its absence — or a machine where it is not logged in — is
 * a normal state the response carries as data (`gh_missing` / `gh_failed`), never an exception.
 * Same argv-only posture as `git.ts`; the binary is overridable through `AIBUILDOS_GH_BIN`, the
 * established test seam pattern, so CI covers the present-path with a stub script and the
 * absent-path honestly.
 */
const run = promisify(execFile);

export interface PrStatus {
  readonly url: string;
  readonly state: string;
  readonly mergeable: string;
  readonly reviewDecision: string | null;
  readonly checks: { name: string; status: string }[];
}

export type PrResult =
  | ({ ok: true } & PrStatus)
  | { ok: false; code: "gh_missing" | "gh_failed"; message: string };

/**
 * `statusCheckRollup` entries come in two shapes depending on whether the check is a GitHub
 * Actions run (`name`/`conclusion`/`status`) or a legacy commit status (`context`/`state`) — `gh`
 * itself does not normalise them, so this does. Anything else unrecognisable becomes "unknown"
 * rather than throwing: a chip that can't name one check is not a reason to hide the rest.
 */
function toChecks(rollup: unknown): { name: string; status: string }[] {
  if (!Array.isArray(rollup)) return [];
  return rollup.map((entry) => {
    const e = entry as Record<string, unknown>;
    const name =
      typeof e.name === "string" ? e.name : typeof e.context === "string" ? e.context : "check";
    const status =
      typeof e.conclusion === "string"
        ? e.conclusion
        : typeof e.status === "string"
          ? e.status
          : typeof e.state === "string"
            ? e.state
            : "unknown";
    return { name, status };
  });
}

export async function prStatus(projectPath: string): Promise<PrResult> {
  const bin = process.env.AIBUILDOS_GH_BIN ?? "gh";

  try {
    const { stdout } = await run(
      bin,
      ["pr", "view", "--json", "url,state,mergeable,reviewDecision,statusCheckRollup"],
      { cwd: projectPath, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout) as Record<string, unknown>;
    return {
      ok: true,
      url: typeof data.url === "string" ? data.url : "",
      state: typeof data.state === "string" ? data.state : "UNKNOWN",
      mergeable: typeof data.mergeable === "string" ? data.mergeable : "UNKNOWN",
      reviewDecision: typeof data.reviewDecision === "string" ? data.reviewDecision : null,
      checks: toChecks(data.statusCheckRollup),
    };
  } catch (cause) {
    const error = cause as { code?: unknown; stderr?: unknown; message?: unknown };

    if (error.code === "ENOENT") {
      return {
        ok: false,
        code: "gh_missing",
        message:
          "The gh CLI is not installed. Install it from https://cli.github.com, then run " +
          "`gh auth login`.",
      };
    }

    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    return {
      ok: false,
      code: "gh_failed",
      message: stderr || (typeof error.message === "string" ? error.message : "gh failed"),
    };
  }
}
