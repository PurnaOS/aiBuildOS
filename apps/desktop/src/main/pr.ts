/**
 * PR status for the current branch via the `gh` CLI (RQ-0034, DC-0024).
 *
 * `gh` is an *optional* external binary: its absence — or a machine where it is not logged in — is
 * a normal state the response carries as data (`gh_missing` / `gh_failed`), never an exception.
 * Same argv-only posture as `git.ts`; the binary is overridable through `AIBUILDOS_GH_BIN`, the
 * established test seam pattern, so CI covers the present-path with a stub script and the
 * absent-path honestly.
 */

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

/** RQ-0034 — lands with ST-0051. */
export async function prStatus(_projectPath: string): Promise<PrResult> {
  return { ok: false, code: "gh_failed", message: "PR status is not implemented yet." };
}
