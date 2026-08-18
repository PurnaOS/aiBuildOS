#!/usr/bin/env bun
/**
 * `bun run docs:check` — validate the OKF bundle.
 *
 * This runs on Bun (it is repo tooling, not application code — AR-0001), but sticks to `node:` APIs
 * so it stays readable next to the engine it drives.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  type Bundle,
  hasFrontmatter,
  type LoadedArtifact,
  parseOkfDocument,
  validate,
} from "@aibuildos/knowledge-engine";

const root = process.argv[2] ?? "docs";

/**
 * Walk the bundle. Permissive consumption (okf-conventions §1): anything that is not an artifact is
 * skipped, never thrown on.
 *
 *   - `profile/` holds type definitions, not artifacts
 *   - `README.md` files are indexes — collected separately, validated as indexes
 *   - a file without opening frontmatter is prose, and prose is allowed here
 */
function walk(dir: string, artifacts: LoadedArtifact[], indexes: Map<string, string>): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "profile") walk(path, artifacts, indexes);
      continue;
    }
    if (!entry.endsWith(".md")) continue;

    const raw = readFileSync(path, "utf8");
    if (entry === "README.md") {
      indexes.set(relative(process.cwd(), dir), raw);
      continue;
    }
    if (!hasFrontmatter(raw)) continue;

    const file = relative(process.cwd(), path);
    try {
      const parsed = parseOkfDocument(raw);
      artifacts.push({
        file,
        dir: relative(process.cwd(), dir),
        basename: entry,
        frontmatter: parsed.frontmatter,
        keyLines: parsed.keyLines,
      });
    } catch (error) {
      // A file that will not parse still has to be reported, not dropped.
      artifacts.push({
        file,
        dir: relative(process.cwd(), dir),
        basename: entry,
        frontmatter: {},
        keyLines: new Map(),
      });
      console.error(`${file}  parse  ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

const artifacts: LoadedArtifact[] = [];
const indexes = new Map<string, string>();
walk(root, artifacts, indexes);

const bundle: Bundle = { artifacts, indexes };
const findings = validate(bundle);

for (const finding of findings) {
  const at = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  console.error(`${at}  ${finding.severity}  ${finding.rule}  ${finding.message}`);
}

// A validator that validated nothing must fail loudly. An empty walk means the bundle moved, the
// walker broke, or a checkout rewrote every artifact's line endings (see .gitattributes) — all of
// which would otherwise report a cheerful zero errors.
if (artifacts.length === 0) {
  console.error(
    `${root}  error  bundle/empty  no artifacts found — the bundle is missing or unreadable`,
  );
  process.exit(1);
}

const errors = findings.filter((f) => f.severity === "error").length;
console.log(
  `\n${artifacts.length} artifacts, ${indexes.size} indexes — ${errors} error${errors === 1 ? "" : "s"}, ` +
    `${findings.length - errors} warning${findings.length - errors === 1 ? "" : "s"}`,
);
if (errors > 0) process.exitCode = 1;
