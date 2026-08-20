/**
 * "Work on this" (ST-0044, RQ-0027#AC-1, AC-2): the record rail's version of the board's Build.
 *
 * A Story sitting at `ready` or `queued` is walked to `building` through `buildWalk` — reused, not
 * reimplemented, so the rail and the board run the exact same walk (ST-0044#AC-2). Anything else —
 * any other type, any other state — keeps the behaviour "Work on this" always had: the artifact
 * named, its own text quoted beneath it.
 *
 * Nothing here touches `window.aibuildos`. What either path needs beyond the artifact's own
 * type/state is fetched lazily, through the two callbacks a caller hands in — mirrors how `walk.ts`
 * injects `Save` — so a test substitutes both in memory, and only the one the decision actually
 * takes ever runs.
 */
import { type BuildContext, buildWalk, type Save } from "../review/walk.js";

export interface WorkOnArtifact {
  readonly id: string;
  readonly type: string;
  readonly state: string;
}

export interface WorkOnResult {
  readonly problem: string | null;
  /** `null` when a flip refused; otherwise the exact text to send. */
  readonly prompt: string | null;
}

/** RQ-0027#AC-1, AC-2: only a Story at `ready` or `queued` is walked. Everything else — every other
 * type, every other state — is unchanged text injection. */
export function shouldWalk(artifact: Pick<WorkOnArtifact, "type" | "state">): boolean {
  return artifact.type === "Story" && (artifact.state === "ready" || artifact.state === "queued");
}

/** The pre-RQ-0027 behaviour, byte for byte: the artifact named, its file's text quoted beneath it
 * when there is one. */
export function injectionPrompt(artifactId: string, text: string | null): string {
  return text === null
    ? `Work on ${artifactId}.`
    : `Work on ${artifactId}. This is what it says:\n\n${text}`;
}

/**
 * `fetchWalkContext` answers `null` when the story implements no requirement — the one refusal
 * `buildWalk` cannot express itself, since it never sees the story's links (WorkBoard's own check,
 * reused verbatim as the message so the rail and the board refuse the same way).
 */
export async function workOn(
  save: Save,
  artifact: WorkOnArtifact,
  fetchWalkContext: () => Promise<BuildContext | null>,
  fetchText: () => Promise<string | null>,
): Promise<WorkOnResult> {
  if (!shouldWalk(artifact)) {
    return { problem: null, prompt: injectionPrompt(artifact.id, await fetchText()) };
  }

  const context = await fetchWalkContext();
  if (context === null) {
    return { problem: "This story implements no requirement.", prompt: null };
  }
  return buildWalk(save, context);
}
