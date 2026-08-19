import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { hasFrontmatter, parseOkfDocument } from "./parse.js";
import type { Bundle, LoadedArtifact } from "./validate.js";

/**
 * Reading a bundle off disk (ST-0005, TC-0009).
 *
 * This is the **only** module in the package that touches the filesystem, and it is behind the
 * `@aibuildos/knowledge-engine/load` subpath rather than the root export so that importing the
 * engine's pure parts stays free of `node:fs`.
 *
 * The walk used to live inside `tools/okf/cli.ts`. It moved here when the Electron main process
 * became a second consumer: the engine is the only code allowed to parse `docs/` (AR-0002), and two
 * walkers would be two answers to "what is in this bundle".
 */

/** A file that looks like an artifact but would not parse. Reported, never thrown or dropped. */
export interface BundleParseError {
  readonly file: string;
  readonly message: string;
}

export interface LoadedBundle {
  readonly bundle: Bundle;
  readonly parseErrors: readonly BundleParseError[];
}

/**
 * Walk a bundle root.
 *
 * `base` is what reported paths are relative to — the repository root for the `docs:check` CLI, the
 * project root for the app. It is a parameter and not `process.cwd()` because a library that reads
 * the working directory produces different findings depending on where it was called from.
 *
 * Permissive consumption (okf-conventions §1): anything that is not an artifact is skipped rather
 * than thrown on.
 *
 *   - `profile/` holds type definitions, not artifacts
 *   - `README.md` files are indexes — collected separately, validated as indexes
 *   - a file without opening frontmatter is prose, and prose is allowed here
 */
export function loadBundle(root: string, base: string = root): LoadedBundle {
  const artifacts: LoadedArtifact[] = [];
  const indexes = new Map<string, string>();
  const parseErrors: BundleParseError[] = [];

  walk(root, base, artifacts, indexes, parseErrors);

  return { bundle: { artifacts, indexes }, parseErrors };
}

function walk(
  dir: string,
  base: string,
  artifacts: LoadedArtifact[],
  indexes: Map<string, string>,
  parseErrors: BundleParseError[],
): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "profile") walk(path, base, artifacts, indexes, parseErrors);
      continue;
    }
    if (!entry.endsWith(".md")) continue;

    const raw = readFileSync(path, "utf8");
    if (entry === "README.md") {
      indexes.set(relative(base, dir), raw);
      continue;
    }
    if (!hasFrontmatter(raw)) continue;

    const file = relative(base, path);
    const at = { file, dir: relative(base, dir), basename: entry };
    try {
      const parsed = parseOkfDocument(raw);
      artifacts.push({ ...at, frontmatter: parsed.frontmatter, keyLines: parsed.keyLines });
    } catch (error) {
      // A file that will not parse still has to be reported, not dropped — so it goes into the
      // artifact list *and* into `parseErrors`. Deciding what to do about it is the caller's job:
      // a library must not print, and must not set `process.exitCode`.
      artifacts.push({ ...at, frontmatter: {}, keyLines: new Map() });
      parseErrors.push({ file, message: (error as Error).message });
    }
  }
}

/** Artifact counts by `type` and by `state` — the whole of what a project view needs (ST-0005). */
export interface BundleSummary {
  readonly artifacts: number;
  readonly indexes: number;
  readonly byType: Record<string, number>;
  readonly byState: Record<string, number>;
}

export function summarize(bundle: Bundle): BundleSummary {
  const byType: Record<string, number> = {};
  const byState: Record<string, number> = {};

  for (const artifact of bundle.artifacts) {
    tally(byType, artifact.frontmatter.type);
    tally(byState, artifact.frontmatter.state);
  }

  return { artifacts: bundle.artifacts.length, indexes: bundle.indexes.size, byType, byState };
}

/** Frontmatter is unvalidated at this point: a non-string `type` is a finding, not a crash here. */
function tally(into: Record<string, number>, value: unknown): void {
  if (typeof value !== "string" || value === "") return;
  into[value] = (into[value] ?? 0) + 1;
}
