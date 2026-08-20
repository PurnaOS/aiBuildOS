/**
 * Now's pure derivation (RQ-0021, TC-0068): `build:list` plus what is known about each build's live
 * session, turned into rows, and a count of what needs a person.
 *
 * Nothing here touches `window.aibuildos` — the same split `walk.ts` and `derive.ts` already keep,
 * so this is testable with plain data and `NowTab.tsx` supplies the real IPC calls.
 */

export interface BuildInfo {
  readonly storyId: string;
  /** `null` for a build that survived a restart and has no session yet (DC-0021). */
  readonly sessionId: string | null;
}

export interface LiveSession {
  /** From `session:state`; `null` before the first one has arrived for this session. */
  readonly state: "starting" | "ready" | "busy" | "closed" | "failed" | null;
  /** The last event's own label — a `CUSTOM` event's `name`, otherwise its `type`. Kept honest
   * rather than decoded: the last event type is enough to say something is moving. */
  readonly activity: string | null;
  /** An unanswered permission request is open on this session right now (RQ-0021#AC-3). */
  readonly waiting: boolean;
}

export interface NowRow {
  readonly storyId: string;
  readonly title: string;
  readonly sessionId: string | null;
  readonly state: string;
  readonly activity: string | null;
  readonly needsYou: boolean;
}

export function deriveNow(
  builds: readonly BuildInfo[],
  sessions: ReadonlyMap<string, LiveSession>,
  titleOf: (storyId: string) => string,
): NowRow[] {
  return builds.map((build) => {
    const session = build.sessionId === null ? null : (sessions.get(build.sessionId) ?? null);
    const needsYou = session?.waiting ?? false;
    return {
      storyId: build.storyId,
      title: titleOf(build.storyId),
      sessionId: build.sessionId,
      state:
        session === null
          ? "no session yet"
          : needsYou
            ? "waiting on you"
            : (session.state ?? "starting"),
      activity: session?.activity ?? null,
      needsYou,
    };
  });
}

export function needsYouCount(rows: readonly NowRow[]): number {
  return rows.filter((row) => row.needsYou).length;
}

export interface RecordArtifact {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state: string;
}

/**
 * What Now says when nothing is building: the most recently drafted Story sitting in `review`, or
 * plain quiet when there is none (TC-0068 step 2).
 *
 * "Most recent" reads as the highest id: IDs are append-only (okf-conventions §3), so a later story
 * always carries a higher one — no `created` comparison needed.
 */
export function emptyMessage(artifacts: readonly RecordArtifact[]): string {
  const reviewReady = artifacts
    .filter((artifact) => artifact.type === "Story" && artifact.state === "review")
    .sort((a, b) => b.id.localeCompare(a.id))[0];

  return reviewReady
    ? `Nothing is building right now. ${reviewReady.id} is waiting in review.`
    : "Nothing is building right now.";
}
