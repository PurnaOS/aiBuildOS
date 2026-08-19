import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commitAll, initRepo } from "./git.js";

/**
 * Creating a project on disk (ST-0003, TC-0006).
 *
 * A new project is a real Git repository with a real first commit and an OKF bundle in it, because
 * the repository *is* the record (DC-0015) and a project whose record has nowhere to go is a project
 * the rest of the product cannot work on.
 *
 * The seeded bundle deliberately contains **no artifacts** — a new project's backlog is empty, and
 * requirement-first says its first artifact is the one its first feature needs (RQ-0002#AC-4).
 * One consequence worth knowing before anybody "fixes" it: running the bundle validator CLI over a
 * freshly created project exits non-zero with `bundle/empty`. That guard belongs to the CLI, which is
 * right to shout when it validated nothing; the engine's `validate` is clean on this seed, and that
 * is what TC-0006 asserts.
 */

/**
 * The bundle templates, inlined into the main bundle at build time.
 *
 * Real Markdown files rather than string literals so they stay diffable and lintable, and a raw glob
 * rather than copying a directory at runtime because that directory does not exist inside a packaged
 * app. Vite turns each into an exported string, so there is no `extraResources` config, no
 * dev-versus-production path difference, and Vitest resolves them the same way.
 *
 * ponytail: the templates are a snapshot of this repo's own `docs/profile/` and `docs/guidelines/`,
 * so the two can drift. Upgrade path is a `docs:check` rule that diffs them.
 */
const templates = import.meta.glob("./okf-template/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const TEMPLATE_ROOT = "./okf-template/";

/** Everything the seed writes, as repo-relative paths mapped to their content. */
export function bundleFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [key, content] of Object.entries(templates)) {
    files.set(key.slice(key.indexOf(TEMPLATE_ROOT) + TEMPLATE_ROOT.length), content);
  }
  return files;
}

/** Write the OKF bundle into an existing directory. Exported for its own test. */
export function seedBundle(dir: string): void {
  for (const [relative, content] of bundleFiles()) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

function readme(name: string): string {
  return `# ${name}\n\nThe lifecycle record for this project lives in [\`docs/\`](docs/README.md).\n`;
}

/**
 * Claim `parentDir/name`, creating the directory.
 *
 * `mkdir` **without** `recursive` is the existence check: an existing directory raises `EEXIST` and
 * this refuses rather than writing into someone's folder (RQ-0002#AC-3). Doing it in one syscall is
 * also the only way to avoid the gap between checking and writing.
 *
 * Separate from `fillProject` so the caller can register the project the moment the directory is
 * real. A failure after that point leaves a directory on disk, and a directory the app made but then
 * refuses to list is one the user can neither open nor create again.
 */
export function claimProjectDirectory(parentDir: string, name: string): string {
  const dir = join(parentDir, name);
  mkdirSync(dir);
  return dir;
}

/**
 * Make the claimed directory a project: a repository, a README, the bundle, and one commit.
 *
 * Not rolled back on failure. The directory and whatever landed in it are real, and recursively
 * deleting a tree this function may not have created cleanly is worse than leaving it to be looked
 * at — the commit is the step most likely to fail (an unconfigured Git identity, a signing key with
 * no agent, a failing hook), and every one of those leaves a perfectly good working tree behind.
 */
export async function fillProject(dir: string, name: string): Promise<void> {
  await initRepo(dir);
  writeFileSync(join(dir, "README.md"), readme(name), "utf8");
  seedBundle(dir);
  await commitAll(dir, "chore: initial commit");
}

/** The whole of creating a project, for callers that do not need to register it in between. */
export async function scaffoldProject(parentDir: string, name: string): Promise<string> {
  const dir = claimProjectDirectory(parentDir, name);
  await fillProject(dir, name);
  return dir;
}
