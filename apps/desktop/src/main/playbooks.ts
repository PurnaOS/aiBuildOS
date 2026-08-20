import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadProfile } from "@aibuildos/knowledge-engine/load";
import { bundleFiles, OWNER_PLACEHOLDER } from "./scaffold.js";

/**
 * The standard instructions, written into a project that has none: the playbooks (RQ-0013#AC-4)
 * and the root `AGENTS.md`/`CLAUDE.md` an adopted project was scaffolded without (RQ-0028#AC-3).
 *
 * DC-0019: a playbook is a record artifact, so "seeding" is writing the same files the scaffold
 * template ships — with the same identity rule minting has (`project:create-artifact`), because
 * these artifacts need an `owner` and it cannot be baked into a static template. `AGENTS.md` and
 * `CLAUDE.md` carry no frontmatter and need no owner, so they follow a simpler rule of their own:
 * write whichever is missing, touch neither if it is already there.
 *
 * Two refusals and one heal, chosen to be the smallest thing that leaves a valid bundle behind:
 *   - any `PB-…` file already under `docs/playbooks/` refuses outright. Seeding is for a project
 *     that has none; deciding whether a partial set should be topped up is a question nobody has
 *     asked yet, and inventing an answer now would be a guess wearing the shape of a feature.
 *   - no configured `user.name` refuses for the same reason `project:create-artifact` does — an
 *     artifact needs a real owner, and this process has no way to invent one. (`AGENTS.md`/
 *     `CLAUDE.md` need no owner, but this refusal happens before either is written, so a project
 *     with no identity gets neither on this call — the next successful seed still catches them.)
 *   - a project adopted before DC-0019 has no `Playbook` in its `docs/profile/` at all, so writing
 *     only the three artifacts would leave `type: Playbook` resolving against nothing — a bundle
 *     `docs:check` would flag the moment it ran. That is not refused: seeding also writes
 *     `docs/profile/playbook.md`, the same file the scaffold template carries, so what a seed
 *     leaves behind always validates. The type is data (okf-conventions §6), so healing it here
 *     costs nothing a fresh scaffold was not already going to pay.
 *
 * Synchronous throughout, on purpose: `project:seed-playbooks` (`ipc.ts`) calls this from a handler
 * that is not `async` and does not await its result, so an asynchronous identity lookup here would
 * hand the IPC contract a `Promise` where it expects a string.
 */
export function seedPlaybooks(projectPath: string): string | null {
  const docsRoot = join(projectPath, "docs");
  const playbooksDir = join(docsRoot, "playbooks");

  if (existsSync(playbooksDir)) {
    const already = readdirSync(playbooksDir).some((entry) => /^pb-\d{4,}\.md$/i.test(entry));
    if (already) return "This project already has playbook artifacts.";
  }

  const owner = readOwner(projectPath);
  if (owner === "") {
    return "This repository has no `user.name` configured, so a playbook has no owner.";
  }

  const hasPlaybookType = loadProfile(docsRoot).profile.get("Playbook") !== undefined;

  for (const [relative, content] of bundleFiles()) {
    const isPlaybookArtifact = relative.startsWith("docs/playbooks/");
    const healsProfile = relative === "docs/profile/playbook.md" && !hasPlaybookType;
    const isInstructions = relative === "AGENTS.md" || relative === "CLAUDE.md";
    if (!isPlaybookArtifact && !healsProfile && !isInstructions) continue;

    const target = join(projectPath, relative);
    // RQ-0028#AC-3: never overwrite an instructions file that is already there.
    if (isInstructions && existsSync(target)) continue;

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content.replaceAll(OWNER_PLACEHOLDER, owner), "utf8");
  }

  return null;
}

/**
 * `git config user.name`, the same read `project:create-artifact` does — this is an *adopted*
 * project, not a fresh one, so its config (not `GIT_AUTHOR_NAME`) is the honest source (contrast
 * `scaffold.ts`'s `resolveOwner`, which asks Git what a commit would use because a brand-new
 * repository may have no config at all). A missing binary or an unset key are both "no owner",
 * not a crash.
 */
function readOwner(projectPath: string): string {
  try {
    return execFileSync("git", ["-C", projectPath, "config", "user.name"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}
