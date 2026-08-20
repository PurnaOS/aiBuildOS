/**
 * @aibuildos/shared — the vocabulary every process agrees on.
 *
 * Zero dependencies, by design (AR-0002): this package is imported by the Electron main process,
 * the preload script, and the renderer, so it must be safe in all three. That also means it must
 * stay Node-compatible — no Bun-only APIs anywhere in `packages/` (AR-0001, DC-0002).
 */

/** Artifact ID prefixes this project has minted. See docs/guidelines/okf-conventions.md §3. */
export const ID_PREFIXES = ["RQ", "EP", "ST", "TC", "BG", "DC", "AR", "PB"] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];

/** `<PREFIX>-<NNNN>` — 4+ digits, zero-padded, per-prefix, append-only, never reused. */
export type ArtifactId = `${IdPrefix}-${string}`;

/** Coarse origin classification carried by every artifact. */
export type Provenance = "human" | "agent" | "imported" | "backfilled";

/**
 * Relationships that are *stored* in an artifact's frontmatter `links:` map.
 * Inverses (`implemented_by`, `affected_by`, …) are derived by reverse index and never written.
 */
export const STORED_RELATIONSHIPS = [
  "implements",
  "depends_on",
  "related_to",
  "derived_from",
  "verified_by",
  "verifies",
  "supersedes",
  "affects",
  "fixed_by",
  "constrains",
  "parent",
] as const;

export type Relationship = (typeof STORED_RELATIONSHIPS)[number];

/** The application-wide error shape crossing the IPC boundary. */
export interface AppError {
  readonly code: string;
  readonly message: string;
}
