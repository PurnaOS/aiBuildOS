#!/usr/bin/env bun
/**
 * `bun run docs:check` — validate the OKF bundle.
 *
 * This runs on Bun (it is repo tooling, not application code — AR-0001), but sticks to `node:` APIs
 * so it stays readable next to the engine it drives.
 *
 * The walk itself lives in `@aibuildos/knowledge-engine/load`, shared with the desktop app: the
 * engine is the only code that parses `docs/` (AR-0002). What stays here is everything a library must
 * not do — printing, and deciding the exit code.
 */
import { validate } from "@aibuildos/knowledge-engine";
import { loadBundle } from "@aibuildos/knowledge-engine/load";

const root = process.argv[2] ?? "docs";

const { bundle, parseErrors } = loadBundle(root, process.cwd());

for (const { file, message } of parseErrors) {
  console.error(`${file}  parse  ${message}`);
  process.exitCode = 1;
}

const findings = validate(bundle);

for (const finding of findings) {
  const at = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  console.error(`${at}  ${finding.severity}  ${finding.rule}  ${finding.message}`);
}

// A validator that validated nothing must fail loudly. An empty walk means the bundle moved, the
// walker broke, or a checkout rewrote every artifact's line endings (see .gitattributes) — all of
// which would otherwise report a cheerful zero errors.
//
// This guard is the CLI's, not the engine's: a *newly created* project has a valid bundle with no
// artifacts in it yet (RQ-0002#AC-4), and `validate` is right to be silent about that.
if (bundle.artifacts.length === 0) {
  console.error(
    `${root}  error  bundle/empty  no artifacts found — the bundle is missing or unreadable`,
  );
  process.exit(1);
}

const errors = findings.filter((f) => f.severity === "error").length;
console.log(
  `\n${bundle.artifacts.length} artifacts, ${bundle.indexes.size} indexes — ${errors} error${errors === 1 ? "" : "s"}, ` +
    `${findings.length - errors} warning${findings.length - errors === 1 ? "" : "s"}`,
);
if (errors > 0) process.exitCode = 1;
