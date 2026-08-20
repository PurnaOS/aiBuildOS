import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commitAll, git, initRepo } from "./git.js";

/**
 * Creating a project on disk (ST-0003, TC-0006).
 *
 * A new project is a real Git repository with a real first commit and an OKF bundle in it, because
 * the repository *is* the record (DC-0015) and a project whose record has nowhere to go is a project
 * the rest of the product cannot work on.
 *
 * The seeded backlog is deliberately empty — no Requirement, Story or Bug — because requirement-first
 * says the first one is whatever the project's first feature needs (RQ-0002#AC-4). It is not seeded
 * empty of *artifacts* any more: the standard playbooks (RQ-0013#AC-1, DC-0019) ship from the first
 * commit, because they are the buttons that help write the backlog rather than backlog themselves.
 * One consequence worth knowing before anybody "fixes" it: the bundle validator CLI's `bundle/empty`
 * guard no longer fires on a freshly created project — the standard playbooks are real artifacts. The
 * engine's `validate` is clean on this seed either way, and that is what TC-0006 asserts.
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

/**
 * What a template file writes in place of `owner` (RQ-0013#AC-1).
 *
 * The playbook artifacts are the first *artifacts* the template ships, and an artifact's `owner` is a
 * git handle (okf-conventions §7) — nothing this module has until the project it is writing into has a
 * Git identity. Exported so `playbooks.ts` can replace the same token when it seeds into a project that
 * already exists.
 */
export const OWNER_PLACEHOLDER = "{{OWNER}}";

/** Everything the seed writes, as repo-relative paths mapped to their content. */
export function bundleFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [key, content] of Object.entries(templates)) {
    files.set(key.slice(key.indexOf(TEMPLATE_ROOT) + TEMPLATE_ROOT.length), content);
  }
  return files;
}

/**
 * Write the OKF bundle into an existing directory, with `owner` filled in wherever the template left
 * it blank. Exported for its own test.
 *
 * A blind `replaceAll` on every file rather than only the playbook ones: the token cannot appear by
 * accident in the other templates, and singling out paths here would be a second place that has to
 * know which files are artifacts.
 */
export function seedBundle(dir: string, owner = ""): void {
  for (const [relative, content] of bundleFiles()) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content.replaceAll(OWNER_PLACEHOLDER, owner), "utf8");
  }
}

/**
 * The identity a commit made **right now** in `dir` would carry, name only.
 *
 * `git var GIT_AUTHOR_IDENT` rather than `git config user.name`: the latter answers only from config
 * and is blind to `GIT_AUTHOR_NAME`, which is how this project's own tests supply an identity without
 * a global `.gitconfig` (see `scaffold.test.ts`). Asking Git what it would actually use is the one
 * answer that agrees with whether `commitAll` below is about to succeed.
 */
async function resolveOwner(dir: string): Promise<string> {
  const ident = await git(dir, "var", "GIT_AUTHOR_IDENT").catch(() => "");
  return ident.match(/^(.*) <[^>]*> \d+ [+-]\d{4}\s*$/)?.[1]?.trim() ?? "";
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
 *
 * `resolveOwner` runs after `initRepo` (a repository is what it asks Git about) and before
 * `seedBundle` (the playbooks need an answer to write). No separate refusal for a missing identity:
 * an empty owner writes an invalid `owner:` line, and the commit that follows fails for exactly the
 * same reason and with the same `git_identity` error this already had before there were playbooks to
 * seed — one refusal, not two that could disagree.
 */
export async function fillProject(dir: string, name: string): Promise<void> {
  await initRepo(dir);
  writeFileSync(join(dir, "README.md"), readme(name), "utf8");
  seedBundle(dir, await resolveOwner(dir));
  await commitAll(dir, "chore: initial commit");
}

/** The whole of creating a project, for callers that do not need to register it in between. */
export async function scaffoldProject(parentDir: string, name: string): Promise<string> {
  const dir = claimProjectDirectory(parentDir, name);
  await fillProject(dir, name);
  return dir;
}
