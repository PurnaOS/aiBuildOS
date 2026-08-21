import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  criteriaRefusal,
  editArtifact,
  type Profile,
  parseOkfDocument,
  transitionRefusal,
  updateIndexRow,
  validate,
} from "@aibuildos/knowledge-engine";
import { loadBundle, loadProfile } from "@aibuildos/knowledge-engine/load";
import { noteSelfWrite } from "./watch.js";

/**
 * The record's guarded edit, and the path containment every write shares (ST-0041).
 *
 * Extracted from the `project:artifact-save` handler so main has exactly one place that knows how
 * a record artifact is legally changed — the IPC handler calls it for the renderer's saves, and
 * `builds.ts` calls it for the turn-end flip a build performs against its *own* project, window
 * or no window (BG-0007). Two copies of the transition check would be two doors with different
 * locks.
 */

/**
 * Resolve a path inside a project, refusing anything that lands outside it.
 *
 * The second half of the defence the contract's `RepoPathSchema` begins. A string check cannot
 * see a **symlink**: `docs/out` may be a perfectly ordinary relative path that points at `/`.
 * Resolving both sides through `realpath` and comparing is the only answer that survives one.
 *
 * The target may not exist yet — a file being saved for the first time — so the nearest existing
 * ancestor is what gets resolved, and the rest is appended to it.
 */
export function insideProject(root: string, path: string): string {
  const target = resolve(root, path);

  let existing = target;
  const trailing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    // Ran out of path without finding anything: nothing here is inside the project.
    if (parent === existing) throw new Error(`${path} is not inside this project`);
    trailing.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }

  const real = join(realpathSync(existing), ...trailing);
  const away = relative(realpathSync(root), real);
  if (away.startsWith("..") || isAbsolute(away)) {
    throw new Error(`${path} is not inside this project`);
  }
  return real;
}

/**
 * The findings for one artifact, each tied to the frontmatter key that caused it where possible.
 *
 * A finding carries a line; `keyLines` maps a key to its line. Inverting that is what turns "this
 * file is wrong" into "this field is wrong", which is the difference between a validator and an
 * editor (RQ-0005#AC-9).
 */
export function findingsFor(
  bundle: Parameters<typeof validate>[0],
  profile: Profile,
  file: string,
  keyLines: ReadonlyMap<string, number>,
): { rule: string; severity: string; message: string; key: string | null }[] {
  const byLine = new Map([...keyLines].map(([key, line]) => [line, key]));

  return validate(bundle, profile)
    .filter((finding) => finding.file === file)
    .map((finding) => ({
      rule: finding.rule,
      severity: finding.severity,
      message: finding.message,
      key: finding.line === undefined ? null : (byLine.get(finding.line) ?? null),
    }));
}

export interface ArtifactEditResult {
  problem: string | null;
  markdown: string | null;
  findings: { rule: string; severity: string; message: string; key: string | null }[];
}

/**
 * Change one artifact the only legal way: transitions checked against the state the file carries
 * right now (RQ-0010), criteria numbers append-only, only the named keys and the body rewritten,
 * the index row following in the same act. Throws nothing a caller can provoke — expected
 * failures come back as `problem`, exactly as the IPC handler always answered.
 */
export function applyArtifactEdit(
  projectPath: string,
  artifactId: string,
  frontmatter: Record<string, unknown>,
  body?: string,
): ArtifactEditResult {
  const root = join(projectPath, "docs");

  const { bundle } = loadBundle(root, projectPath);
  const found = bundle.artifacts.find(
    (artifact) => (artifact.frontmatter as { id?: unknown }).id === artifactId,
  );
  if (!found) {
    return { problem: `${artifactId} is not in this bundle.`, markdown: null, findings: [] };
  }

  // The path comes from the bundle walk rather than from the renderer, so nothing untrusted
  // reaches it — but this is a write, and every write in this process is contained the same
  // way rather than each one arguing for itself (TC-0023).
  const file = insideProject(projectPath, found.file);
  // The profile is what knows which relationships this type declares, so it is what vouches
  // for a link key the file does not carry yet. Anything else missing is still refused.
  const { profile: dialect } = loadProfile(root);
  const type = String((found.frontmatter as { type?: unknown }).type ?? "");
  const definition = dialect.get(type);
  // Declared fields are vouched the same way links are: a manual test case that has never
  // been walked carries no `last_result` until its first walk writes one (RQ-0023#AC-2).
  const create = [
    ...Object.keys(definition?.links ?? {}).map((rel) => `links.${rel}`),
    ...Object.keys(definition?.fields ?? {}),
  ];

  const before = readFileSync(file, "utf8");

  // This is the one place the previous state is known: read before the write, the same file
  // the write is about to change. That is what lets a transition be checked here at all
  // (RQ-0010).
  if (definition && typeof frontmatter.state === "string") {
    const currentState = String((found.frontmatter as { state?: unknown }).state ?? "");
    if (frontmatter.state !== currentState) {
      const refusal = transitionRefusal(definition, type, currentState, frontmatter.state);
      if (refusal !== null) return { problem: refusal, markdown: null, findings: [] };
    }
  }
  if (body !== undefined) {
    const refusal = criteriaRefusal(parseOkfDocument(before).body, body);
    if (refusal !== null) return { problem: refusal, markdown: null, findings: [] };
  }

  // Only the named keys and the body change; the rest of the file is byte-identical.
  const written = editArtifact(before, {
    frontmatter: frontmatter as Record<string, string | string[]>,
    ...(body === undefined ? {} : { body }),
    create,
  });
  writeFileSync(file, written, "utf8");

  // The record must not disagree with itself: the index says what the artifact says (AC-10).
  const indexFile = join(projectPath, found.dir, "README.md");
  if (existsSync(indexFile)) {
    const contained = insideProject(projectPath, join(found.dir, "README.md"));
    const title = frontmatter.title;
    const state = frontmatter.state;
    writeFileSync(
      contained,
      updateIndexRow(readFileSync(contained, "utf8"), artifactId, {
        ...(typeof title === "string" ? { title } : {}),
        ...(typeof state === "string" ? { state } : {}),
      }),
      "utf8",
    );
  }

  // Main's own write must not depend on the watcher noticing it (fsevents can drop the tail of a
  // rapid rewrite burst): the generation and the changed event move here, deterministically.
  noteSelfWrite(projectPath);

  // Re-read so what comes back is what the bundle now says, not what was hoped for.
  const after = loadBundle(root, projectPath);
  const parsed = parseOkfDocument(readFileSync(file, "utf8"));
  return {
    problem: null,
    markdown: written,
    findings: findingsFor(after.bundle, dialect, found.file, parsed.keyLines),
  };
}
