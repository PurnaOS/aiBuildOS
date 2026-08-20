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
  /** `build:list` never returns anything else (`builds.ts`'s `listBuilds` filters worktree
   * branches only) — every row here already answers "where are my files" with this (RQ-0030#AC-4). */
  readonly branch: string;
}

export interface LiveSession {
  /** From `session:state`; `null` before the first one has arrived for this session. */
  readonly state: "starting" | "ready" | "busy" | "closed" | "failed" | null;
  /** The last event's own label — a `CUSTOM` event's `name`, otherwise its `type`. Kept honest
   * rather than decoded: the last event type is enough to say something is moving. `describeActivity`
   * is what turns this into words a person reads (RQ-0030#AC-2) — kept raw here since other readers
   * of this store (none today) might want the wire's own vocabulary. */
  readonly activity: string | null;
  /** `Date.now()` when the last `session:event` or `session:state` for this session arrived — `null`
   * before either has (RQ-0030#AC-2's "how long since its build last said anything"). */
  readonly lastEventAt: number | null;
  /** An unanswered permission request is open on this session right now (RQ-0021#AC-3). */
  readonly waiting: boolean;
}

export interface NowRow {
  readonly storyId: string;
  readonly title: string;
  readonly sessionId: string | null;
  readonly branch: string;
  readonly state: string;
  readonly activity: string | null;
  readonly lastEventAt: number | null;
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
      branch: build.branch,
      state:
        session === null
          ? "no session yet"
          : needsYou
            ? "waiting on you"
            : (session.state ?? "starting"),
      activity: session?.activity ?? null,
      lastEventAt: session?.lastEventAt ?? null,
      needsYou,
    };
  });
}

/**
 * A Now row's activity in plain words (RQ-0030#AC-2): nobody outside this codebase should have to
 * read `TEXT_MESSAGE_CONTENT` or `acp.tool_call_update` to know a build is doing something.
 *
 * Honest, not exhaustive: `TEXT_MESSAGE_START`/`TEXT_MESSAGE_CONTENT` are mid-message — the agent is
 * still "writing" it — and `TEXT_MESSAGE_END` is the word that closes it, "said something". Anything
 * this has never learned to name — `RUN_STARTED`, a checkpoint note, an unrecognised `CUSTOM` — falls
 * back to "working" rather than guessing.
 */
export function describeActivity(name: string | null): string {
  if (name === null) return "working";
  if (name === "TEXT_MESSAGE_START" || name === "TEXT_MESSAGE_CONTENT") return "writing";
  if (name === "TEXT_MESSAGE_END") return "said something";
  if (name.startsWith("REASONING_MESSAGE")) return "thinking";
  if (name.startsWith("TOOL_CALL") || name === "acp.tool_call_update") return "running a tool";
  return "working";
}

/** "42s ago" (RQ-0030#AC-2): coarse on purpose, the same spirit as `ui.ts`'s `relativeTime` but in
 * seconds rather than `Intl.RelativeTimeFormat`'s coarsest "a minute ago" — a build's last word a
 * few seconds back should not read the same as one from a minute ago. `nowMs` is a parameter, not a
 * `Date.now()` call inside, so this stays a pure function a fixture can drive deterministically. */
export function elapsedLabel(sinceMs: number | null, nowMs: number): string | null {
  if (sinceMs === null) return null;
  const seconds = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
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
