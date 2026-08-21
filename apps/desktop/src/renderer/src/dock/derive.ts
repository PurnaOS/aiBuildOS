/**
 * The activity dock's pure derivation (RQ-0044, ST-0062, DC-0027): the session inventory — not
 * `build:list` alone — turned into three kinds of row, and what needs a person.
 *
 * Nothing here touches `window.aibuildos` — the same split `now.ts` (this module's predecessor) kept:
 * `ActivityDock.tsx` supplies the real IPC calls and the live session tracking, this module only
 * classifies and counts. `session:list` already carries every session this project has open — a build
 * (`storyId` set), a background run (`label` set), or the main chat (neither) — so classification never
 * has to guess, only sort what the inventory already says.
 */

export type SessionLifecycle = "starting" | "ready" | "busy" | "closed" | "failed" | null;

/** One session's static shape from `session:list`, joined with what its own event stream has said
 * since (`ActivityDock.tsx`'s live tracking — the same `state`/`activity`/`lastEventAt`/`waiting`
 * shape `now.ts`'s `LiveSession` used). */
export interface SessionInfo {
  readonly sessionId: string;
  readonly projectId: string;
  /** The story this session is building; `null` for the main chat and for a background run. */
  readonly storyId: string | null;
  /** A background run's label; `null` for the main chat and for a build. */
  readonly label: string | null;
  readonly startedAt: string;
  readonly state: SessionLifecycle;
  readonly activity: string | null;
  readonly lastEventAt: number | null;
  /** An unanswered permission request is open on this session right now. */
  readonly waiting: boolean;
}

/** `build:list`'s own row shape (RQ-0037): everything Now's rows already answered, plus what a
 * worktree row now names about itself. */
export interface BuildInfo {
  readonly storyId: string;
  /** `null` for a build that survived a restart and has no session yet (DC-0021). */
  readonly sessionId: string | null;
  readonly branch: string;
  readonly path: string;
  readonly sprintId: string | null;
  readonly ahead: number;
  readonly lastCheckpointAt: string | null;
}

interface ActivityFields {
  readonly state: string;
  readonly activity: string | null;
  readonly lastEventAt: number | null;
  readonly needsYou: boolean;
}

export interface BuildRow extends ActivityFields {
  readonly kind: "build";
  readonly storyId: string;
  readonly title: string;
  readonly sessionId: string | null;
  readonly branch: string;
  readonly path: string;
  readonly sprintId: string | null;
  readonly ahead: number;
  readonly lastCheckpointAt: string | null;
}

export interface MainRow extends ActivityFields {
  readonly kind: "main";
  /** `null` before the main chat's own session has opened. */
  readonly sessionId: string | null;
}

export interface BackgroundRow extends ActivityFields {
  readonly kind: "background";
  readonly sessionId: string;
  readonly label: string;
  readonly startedAt: string;
}

export interface DockData {
  readonly builds: readonly BuildRow[];
  readonly main: MainRow;
  readonly background: readonly BackgroundRow[];
}

function activityOf(session: SessionInfo | undefined): ActivityFields {
  if (session === undefined) {
    return { state: "no session yet", activity: null, lastEventAt: null, needsYou: false };
  }
  return {
    state: session.waiting ? "waiting on you" : (session.state ?? "starting"),
    activity: session.activity,
    lastEventAt: session.lastEventAt,
    needsYou: session.waiting,
  };
}

/**
 * The dock's whole picture (RQ-0044#AC-2): `builds` is joined to its own live session first — the
 * same join Now always did — and whatever is left in `sessions` (no `storyId`, since every build
 * session names one) is classified by `label`: a background run if it has one, the main chat if it
 * has neither. A chat-only session with no worktree build still shows up, because it is read straight
 * from the inventory rather than only from `build:list`.
 */
export function deriveDock(
  sessions: readonly SessionInfo[],
  builds: readonly BuildInfo[],
  titleOf: (storyId: string) => string,
): DockData {
  const bySession = new Map(sessions.map((session) => [session.sessionId, session]));

  const buildRows: BuildRow[] = builds.map((build) => {
    const session = build.sessionId === null ? undefined : bySession.get(build.sessionId);
    return {
      kind: "build",
      storyId: build.storyId,
      title: titleOf(build.storyId),
      sessionId: build.sessionId,
      branch: build.branch,
      path: build.path,
      sprintId: build.sprintId,
      ahead: build.ahead,
      lastCheckpointAt: build.lastCheckpointAt,
      ...activityOf(session),
    };
  });

  const other = sessions.filter((session) => session.storyId === null);
  const background: BackgroundRow[] = other
    .filter((session) => session.label !== null)
    .map((session) => ({
      kind: "background",
      sessionId: session.sessionId,
      label: session.label as string,
      startedAt: session.startedAt,
      ...activityOf(session),
    }));
  const mainSession = other.find((session) => session.label === null);
  const main: MainRow = {
    kind: "main",
    sessionId: mainSession?.sessionId ?? null,
    ...activityOf(mainSession),
  };

  return { builds: buildRows, main, background };
}

/** The rollup every surface reads (RQ-0044#AC-3): the main chat counts exactly like any other row. */
export function needsYouCount(dock: DockData): number {
  return (
    (dock.main.needsYou ? 1 : 0) +
    dock.builds.filter((row) => row.needsYou).length +
    dock.background.filter((row) => row.needsYou).length
  );
}

export interface RecordArtifact {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state: string;
}

export interface NextActionButton {
  readonly label: string;
  /** `kind` is a plain string here rather than `TabKind`, so this stays free of a dependency on
   * `workspace/TabStrip.ts` — `ActivityDock.tsx` is the one place that has to agree the two line up. */
  readonly open: { readonly id: string; readonly kind: string; readonly title: string };
}

export interface NextAction {
  readonly text: string;
  readonly action: NextActionButton;
}

/**
 * The dock's stage indicator (RQ-0044#AC-4, DC-0027): deliberately no stepper — one line that says
 * where the flow stands and is the button that advances it. Priority, most urgent first: an open
 * permission (main chat, then a build, then a background run — whichever a person would notice first
 * on a single glance), a story already built and waiting on a verdict, a story picked and ready to
 * build, drafts waiting on approval, and — the empty-record case — nowhere to go but the conversation.
 */
export function nextAction(dock: DockData, artifacts: readonly RecordArtifact[]): NextAction {
  if (dock.main.needsYou) {
    return {
      text: "The conversation needs an answer.",
      action: { label: "Open", open: { id: "chat", kind: "chat", title: "Chat" } },
    };
  }
  const waitingBuild = dock.builds.find((row) => row.needsYou);
  if (waitingBuild !== undefined) {
    return {
      text: `${waitingBuild.storyId} needs an answer.`,
      action: {
        label: "Open",
        open: {
          id: `session:${waitingBuild.sessionId}`,
          kind: "session",
          title: waitingBuild.storyId,
        },
      },
    };
  }
  const waitingBackground = dock.background.find((row) => row.needsYou);
  if (waitingBackground !== undefined) {
    return {
      text: `${waitingBackground.label} needs an answer.`,
      action: {
        label: "Open",
        open: {
          id: `session:${waitingBackground.sessionId}`,
          kind: "session",
          title: waitingBackground.label,
        },
      },
    };
  }

  const reviewReady = artifacts
    .filter((artifact) => artifact.type === "Story" && artifact.state === "review")
    .sort((a, b) => b.id.localeCompare(a.id))[0];
  if (reviewReady !== undefined) {
    return {
      text: `${reviewReady.id} waits in review.`,
      action: {
        label: "Review",
        open: { id: `review:${reviewReady.id}`, kind: "review", title: reviewReady.id },
      },
    };
  }

  const ready = artifacts
    .filter((artifact) => artifact.type === "Story" && artifact.state === "ready")
    .sort((a, b) => b.id.localeCompare(a.id))[0];
  if (ready !== undefined) {
    return {
      text: `${ready.id} is ready to build.`,
      action: { label: "Work", open: { id: "work", kind: "work", title: "Work" } },
    };
  }

  const drafted = artifacts.filter(
    (artifact) =>
      (artifact.type === "Story" || artifact.type === "TestCase") && artifact.state === "draft",
  ).length;
  if (drafted > 0) {
    return {
      text: `${drafted} draft ${drafted === 1 ? "piece" : "pieces"} waiting for review.`,
      action: { label: "Plan", open: { id: "plan", kind: "plan", title: "Plan" } },
    };
  }

  return {
    text: "Nothing is building right now.",
    action: { label: "Chat", open: { id: "chat", kind: "chat", title: "Chat" } },
  };
}

/** A dock row's activity in plain words (RQ-0030#AC-2) — unchanged from `now.ts`. */
export function describeActivity(name: string | null): string {
  if (name === null) return "working";
  if (name === "TEXT_MESSAGE_START" || name === "TEXT_MESSAGE_CONTENT") return "writing";
  if (name === "TEXT_MESSAGE_END") return "said something";
  if (name.startsWith("REASONING_MESSAGE")) return "thinking";
  if (name.startsWith("TOOL_CALL") || name === "acp.tool_call_update") return "running a tool";
  return "working";
}

/** "42s ago" — unchanged from `now.ts`. `nowMs` is a parameter, not a `Date.now()` call inside, so
 * this stays a pure function a fixture can drive deterministically. */
export function elapsedLabel(sinceMs: number | null, nowMs: number): string | null {
  if (sinceMs === null) return null;
  const seconds = Math.max(0, Math.round((nowMs - sinceMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
