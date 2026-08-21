import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative as nodeRelative } from "node:path";
import { hasFrontmatter, parseOkfDocument } from "./parse.js";
import {
  type Profile,
  type ProfileIssue,
  type RawTypeDefinition,
  resolveProfile,
} from "./profile.js";
import type { Bundle, LoadedArtifact } from "./validate.js";

/**
 * Bundle paths are the graph's keys and the findings' addresses, and they are compared against
 * forward-slash strings everywhere (index links, `findingsFor`, the CLI's output). Windows's
 * `relative()` answers with backslashes, which silently fails every one of those comparisons —
 * the first Windows CI run proved it — so separators are normalised the moment a path enters
 * the bundle.
 */
const relative = (from: string, to: string): string => nodeRelative(from, to).replaceAll("\\", "/");

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

  return { bundle: { root: relative(base, root), artifacts, indexes }, parseErrors };
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
      artifacts.push({
        ...at,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        keyLines: parsed.keyLines,
      });
    } catch (error) {
      // A file that will not parse still has to be reported, not dropped — so it goes into the
      // artifact list *and* into `parseErrors`. Deciding what to do about it is the caller's job:
      // a library must not print, and must not set `process.exitCode`.
      artifacts.push({ ...at, frontmatter: {}, body: "", keyLines: new Map() });
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

export interface LoadedProfile {
  readonly profile: Profile;
  /** Profile documents that would not parse, plus unresolvable `extends`. Reported, never thrown. */
  readonly issues: readonly ProfileIssue[];
}

/**
 * Read a bundle's type profile (ST-0006, TC-0010).
 *
 * `profile/` is the one directory `loadBundle` skips — it holds the type dialect, not artifacts
 * (conventions §6). This is the other half of that: the same directory, read as the schema.
 *
 * Only documents declaring `type: TypeDefinition` are collected, which is what skips the directory
 * index and the `profile.md` manifest without either having to be named here. A bundle with no
 * `profile/` at all resolves to an empty profile rather than an error — a newly created project is a
 * valid bundle before it is a described one (RQ-0003#AC-14).
 */
export function loadProfile(root: string, base: string = root): LoadedProfile {
  const dir = join(root, "profile");
  const raw: RawTypeDefinition[] = [];
  const issues: ProfileIssue[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { profile: resolveProfile([]).profile, issues: [] };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) continue;

    const file = relative(base, path);
    const text = readFileSync(path, "utf8");
    if (!hasFrontmatter(text)) continue;

    try {
      const parsed = parseOkfDocument(text);
      if (parsed.frontmatter.type !== "TypeDefinition") continue;
      raw.push({ file, frontmatter: parsed.frontmatter });
    } catch (error) {
      issues.push({ file, message: (error as Error).message });
    }
  }

  const resolved = resolveProfile(raw);
  return { profile: resolved.profile, issues: [...issues, ...resolved.issues] };
}
