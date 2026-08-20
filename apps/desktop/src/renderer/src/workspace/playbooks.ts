/**
 * The playbook strip's pure half (ST-0026, TC-0044): a record to buttons, and a body plus a
 * selection to the prompt text a press actually sends.
 *
 * Nothing here talks to `window.aibuildos` or React — that is `Playbooks.tsx`'s job, which fetches
 * what these functions need and renders what they return. Kept apart because what has to be *exactly
 * right* is string work — the transcript must show precisely what a button said it would send — and
 * that is easiest to get right, and to keep right, as something a test can call directly.
 */

/**
 * The slice of a record row this module reads. Structural, not `ChannelResponse<"project:record">`
 * itself: what decides a button is `type` and `state`, nothing the record's derived-links machinery
 * adds, and a narrower type is what lets a test build one without inventing an `inbound` it does not
 * care about.
 */
export interface RecordEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state: string;
  readonly file: string;
}

/** What a button needs to render itself and to ask for its own body (RQ-0013#AC-1). */
export interface PlaybookButton {
  readonly id: string;
  readonly title: string;
  readonly file: string;
}

/**
 * The buttons a record offers — one per `Playbook` at `state: active`, none for anything retired.
 *
 * A filtered view of the record and nothing else (DC-0019): there is no separate playbook registry
 * to fall out of sync with what the artifacts actually say.
 */
export function derivePlaybooks(artifacts: readonly RecordEntry[]): PlaybookButton[] {
  return artifacts
    .filter((artifact) => artifact.type === "Playbook" && artifact.state === "active")
    .map((artifact) => ({ id: artifact.id, title: artifact.title, file: artifact.file }));
}

/** An artifact named as context — just enough to say which one it was (RQ-0013#AC-2). */
export interface ContextArtifact {
  readonly id: string;
  readonly title: string;
}

/**
 * The prompt a press sends: the playbook's body, verbatim, plus one line per selected artifact
 * naming its ID and title. Nothing invented, nothing hidden (RQ-0013#AC-2) — no selection is a bare
 * body, which is what the workspace strip sends today; ST-0027 is what starts passing a non-empty
 * one.
 */
export function compose(body: string, context: readonly ContextArtifact[]): string {
  if (context.length === 0) return body;
  const lines = context.map((artifact) => `- ${artifact.id}: ${artifact.title}`);
  return `${body}\n\n${lines.join("\n")}`;
}

/** The one field a harness needs to be matched by name (RQ-0013#AC-6). */
export interface NamedHarness {
  readonly displayName: string;
}

/**
 * The harness display name a button's ⓘ shows, and runs with.
 *
 * `harness` names a preference by *display name* because a playbook travels with the repository and
 * a harness id does not (DC-0019's Consequences). No configured harness matching, or no preference
 * declared at all, both answer the same way: whatever the workspace already has attached.
 */
export function resolveHarness(
  preferred: string | undefined,
  harnesses: readonly NamedHarness[],
  fallback: string,
): string {
  if (preferred === undefined) return fallback;
  return harnesses.find((harness) => harness.displayName === preferred)?.displayName ?? fallback;
}
