/**
 * The build/review walk's pure half (ST-0028, TC-0048): the state flips a build, a turn ending, an
 * accept and a send-back each perform, and the prompt text a build or a send-back sends onward.
 *
 * Nothing here touches `window.aibuildos`: every effect — a guarded save — is a function the caller
 * hands in as `Save`, so a test substitutes a record entirely in memory and the running components
 * (WorkBoard.tsx, ReviewTab.tsx, useTurnEnd.ts) hand in the real IPC call. Mirrors how playbooks.ts
 * keeps `compose` apart from what fetches a body and what sends one.
 */
import { compose } from "../workspace/playbooks.js";

export interface SaveResult {
  readonly problem: string | null;
}

/** One guarded save against `project:artifact-save`'s shape, minus the project and artifact ids the
 * caller already has bound. */
export type Save = (
  artifactId: string,
  frontmatter: Record<string, string | string[]>,
  body?: string,
) => Promise<SaveResult>;

export interface BuildContext {
  readonly storyId: string;
  readonly storyTitle: string;
  readonly requirementId: string;
  readonly requirementTitle: string;
  /** PB-0003's body, verbatim — nothing here invents playbook text. */
  readonly playbookBody: string;
}

export interface BuildResult {
  readonly problem: string | null;
  /** `null` when a flip refused; otherwise the exact text to send (RQ-0015#AC-1). */
  readonly prompt: string | null;
}

/**
 * `ready → queued → building`, as two ordered guarded saves — the profile declares no shortcut
 * (`ready → building` direct is refused) — followed by the build playbook composed with the story
 * and its requirement as context. Stops at the first refusal rather than attempting the second flip
 * from a state it never reached.
 */
export async function buildWalk(save: Save, context: BuildContext): Promise<BuildResult> {
  const queued = await save(context.storyId, { state: "queued" });
  if (queued.problem !== null) return { problem: queued.problem, prompt: null };

  const building = await save(context.storyId, { state: "building" });
  if (building.problem !== null) return { problem: building.problem, prompt: null };

  const prompt = compose(context.playbookBody, [
    { id: context.storyId, title: context.storyTitle },
    { id: context.requirementId, title: context.requirementTitle },
  ]);
  return { problem: null, prompt };
}

export interface RecordEntry {
  readonly id: string;
  readonly type: string;
  readonly state: string;
}

/**
 * Every Story sitting at `building` flips to `review` when a turn ends (RQ-0015#AC-3) — Bugs are out
 * of ST-0028's scope, and a story anywhere else already stopped moving before this turn began.
 *
 * Returns the ids that actually flipped, so a caller bumps the shared revision only when something
 * really changed rather than on every turn that happened to end.
 */
export async function turnEndWalk(
  save: Save,
  artifacts: readonly RecordEntry[],
): Promise<string[]> {
  const building = artifacts.filter((a) => a.type === "Story" && a.state === "building");
  const flipped: string[] = [];
  for (const story of building) {
    const result = await save(story.id, { state: "review" });
    if (result.problem === null) flipped.push(story.id);
  }
  return flipped;
}

/** `review → accepted`: the verdict, and nothing else (RQ-0015#AC-4). */
export function acceptStory(save: Save, storyId: string): Promise<SaveResult> {
  return save(storyId, { state: "accepted" });
}

/** The commit message RQ-0018#AC-4 derives from an accepted story: its ID and its title, both
 * ways this text is used — the offer's own label, and the message Git actually receives. */
export function commitMessage(storyId: string, title: string): string {
  return `${storyId}: ${title}`;
}

const REVIEW_NOTES_HEADING = "## Review notes";

/**
 * The reviewer's note, filed under `## Review notes` — a new section if the story has never been
 * sent back before, one more line in the existing one otherwise, so a second send-back reads as a
 * log rather than a pile of duplicate headings.
 */
export function appendReviewNote(body: string, note: string): string {
  const at = body.indexOf(REVIEW_NOTES_HEADING);
  if (at === -1) {
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}\n\n${REVIEW_NOTES_HEADING}\n\n${note}\n`;
  }

  const after = body.slice(at + REVIEW_NOTES_HEADING.length);
  const next = after.search(/\n## /);
  const insertAt = next === -1 ? body.length : at + REVIEW_NOTES_HEADING.length + next;
  const before = body.slice(0, insertAt).replace(/\s+$/, "");
  const tail = body.slice(insertAt);
  return `${before}\n\n${note}\n${tail}`;
}

export interface SendBackResult {
  readonly problem: string | null;
  /** `null` when the flip refused; otherwise the note, named to the story, to send onward. */
  readonly prompt: string | null;
}

/**
 * `review → building`, the note appended to the story's body, both in the one guarded save
 * (RQ-0015#AC-4) — so a refusal leaves neither the state nor the note changed.
 */
export async function sendBackStory(
  save: Save,
  storyId: string,
  currentBody: string,
  note: string,
): Promise<SendBackResult> {
  const result = await save(storyId, { state: "building" }, appendReviewNote(currentBody, note));
  if (result.problem !== null) return { problem: result.problem, prompt: null };
  return { problem: null, prompt: `Sent ${storyId} back for another pass.\n\n${note}` };
}
