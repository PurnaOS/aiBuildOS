import { describe, expect, it } from "vitest";
import {
  type BuildInfo,
  checkpointLabel,
  type DockData,
  deriveDock,
  describeActivity,
  elapsedLabel,
  needsYouCount,
  nextAction,
  type SessionInfo,
  terminalLabel,
  terminalStatus,
  worktreeBadges,
} from "./derive.js";

const session = (over: Partial<SessionInfo> & { sessionId: string }): SessionInfo => ({
  projectId: "p1",
  storyId: null,
  label: null,
  startedAt: "2026-08-21T00:00:00Z",
  state: null,
  activity: null,
  lastEventAt: null,
  waiting: false,
  ...over,
});

const build = (over: Partial<BuildInfo> & { storyId: string }): BuildInfo => ({
  sessionId: null,
  branch: `aibuildos/${over.storyId.toLowerCase()}`,
  path: "/tmp/wt",
  sprintId: null,
  ahead: 0,
  lastCheckpointAt: null,
  dirty: false,
  ...over,
});

/** ST-0062. `deriveDock` classifies main/build/background rows from the session inventory. */
describe("deriveDock", () => {
  it("joins a build to its own session, and classifies the rest by storyId/label", () => {
    const sessions: SessionInfo[] = [
      session({ sessionId: "s-build", storyId: "ST-0001", state: "busy", waiting: false }),
      session({ sessionId: "s-bg", label: "Nightly checks", state: "ready" }),
      session({ sessionId: "s-main", state: "busy" }),
    ];
    const dock = deriveDock(
      sessions,
      [build({ storyId: "ST-0001", sessionId: "s-build" })],
      (id) => (id === "ST-0001" ? "Write a note" : id),
    );

    expect(dock.builds).toHaveLength(1);
    expect(dock.builds[0]).toMatchObject({
      kind: "build",
      storyId: "ST-0001",
      title: "Write a note",
      state: "busy",
    });
    expect(dock.background).toHaveLength(1);
    expect(dock.background[0]).toMatchObject({
      kind: "background",
      sessionId: "s-bg",
      label: "Nightly checks",
      state: "ready",
    });
    expect(dock.main).toMatchObject({ kind: "main", sessionId: "s-main", state: "busy" });
  });

  it("says nothing has a session yet for a build that survived a restart", () => {
    const dock = deriveDock([], [build({ storyId: "ST-0003", sessionId: null })], (id) => id);
    expect(dock.builds[0]).toMatchObject({ state: "no session yet", needsYou: false });
  });

  it("carries a build's sprint id and dirty state through unchanged (RQ-0037)", () => {
    const dock = deriveDock(
      [],
      [build({ storyId: "ST-0004", sprintId: "SP-0001", dirty: true, ahead: 3 })],
      (id) => id,
    );
    expect(dock.builds[0]).toMatchObject({ sprintId: "SP-0001", dirty: true, ahead: 3 });
  });

  it("reads a chat-only session with no worktree build — Now's structural failure", () => {
    const dock = deriveDock([session({ sessionId: "s-main", state: "busy" })], [], (id) => id);
    expect(dock.builds).toHaveLength(0);
    expect(dock.main.sessionId).toBe("s-main");
    expect(dock.main.state).toBe("busy");
  });

  it("counts the main chat waiting on the user alongside a build and a background run", () => {
    const dock: DockData = {
      builds: [
        {
          kind: "build",
          storyId: "ST-0001",
          title: "t",
          sessionId: "s1",
          branch: "b",
          path: "/p",
          sprintId: null,
          ahead: 0,
          lastCheckpointAt: null,
          dirty: false,
          state: "waiting on you",
          activity: null,
          lastEventAt: null,
          needsYou: true,
        },
      ],
      main: {
        kind: "main",
        sessionId: "s-main",
        state: "waiting on you",
        activity: null,
        lastEventAt: null,
        needsYou: true,
      },
      background: [
        {
          kind: "background",
          sessionId: "s-bg",
          label: "task",
          startedAt: "2026-08-21T00:00:00Z",
          state: "ready",
          activity: null,
          lastEventAt: null,
          needsYou: false,
        },
      ],
    };
    expect(needsYouCount(dock)).toBe(2);
  });
});

const EMPTY_DOCK: DockData = {
  builds: [],
  main: {
    kind: "main",
    sessionId: null,
    state: "no session yet",
    activity: null,
    lastEventAt: null,
    needsYou: false,
  },
  background: [],
};

/** RQ-0044#AC-4. `nextAction`'s priority order. */
describe("nextAction", () => {
  it("puts an open permission first, main chat before a build", () => {
    const dock: DockData = {
      ...EMPTY_DOCK,
      main: { ...EMPTY_DOCK.main, needsYou: true },
    };
    expect(nextAction(dock, []).action.label).toBe("Open");
    expect(nextAction(dock, []).action.open).toMatchObject({ id: "chat", kind: "chat" });
  });

  it("reaches a waiting build before a review-ready story", () => {
    const dock: DockData = {
      ...EMPTY_DOCK,
      builds: [
        {
          kind: "build",
          storyId: "ST-0009",
          title: "t",
          sessionId: "s9",
          branch: "b",
          path: "/p",
          sprintId: null,
          ahead: 0,
          lastCheckpointAt: null,
          dirty: false,
          state: "waiting on you",
          activity: null,
          lastEventAt: null,
          needsYou: true,
        },
      ],
    };
    const result = nextAction(dock, [
      { id: "ST-0002", type: "Story", title: "Second", state: "review" },
    ]);
    expect(result.text).toContain("ST-0009");
    expect(result.action.open).toMatchObject({ id: "session:s9", kind: "session" });
  });

  it("names the most recent review-ready story ahead of a ready one", () => {
    const result = nextAction(EMPTY_DOCK, [
      { id: "ST-0001", type: "Story", title: "First", state: "review" },
      { id: "ST-0002", type: "Story", title: "Second", state: "review" },
      { id: "ST-0003", type: "Story", title: "Third", state: "ready" },
    ]);
    expect(result.text).toContain("ST-0002");
    expect(result.action).toMatchObject({ label: "Review", open: { id: "review:ST-0002" } });
  });

  it("offers a ready story ahead of drafts still waiting on the plan", () => {
    const result = nextAction(EMPTY_DOCK, [
      { id: "ST-0004", type: "Story", title: "Fourth", state: "ready" },
      { id: "ST-0005", type: "Story", title: "Fifth", state: "draft" },
    ]);
    expect(result.action).toMatchObject({ label: "Work", open: { id: "work" } });
  });

  it("offers the plan when only drafts are waiting", () => {
    const result = nextAction(EMPTY_DOCK, [
      { id: "ST-0006", type: "Story", title: "Sixth", state: "draft" },
      { id: "TC-0001", type: "TestCase", title: "A test", state: "draft" },
    ]);
    expect(result.text).toBe("2 draft pieces waiting for review.");
    expect(result.action).toMatchObject({ label: "Plan", open: { id: "plan" } });
  });

  it("falls back to the conversation for the empty-record case", () => {
    const result = nextAction(EMPTY_DOCK, []);
    expect(result).toMatchObject({
      text: "Nothing is building right now.",
      action: { label: "Chat", open: { id: "chat", kind: "chat" } },
    });
  });
});

describe("describeActivity", () => {
  it("reads a mid-message as writing, and a tool call as running a tool", () => {
    expect(describeActivity("TEXT_MESSAGE_CONTENT")).toBe("writing");
    expect(describeActivity("TOOL_CALL_ARGS")).toBe("running a tool");
    expect(describeActivity(null)).toBe("working");
  });
});

describe("elapsedLabel", () => {
  it("reads seconds, then minutes, then hours, coarsely", () => {
    expect(elapsedLabel(null, 5000)).toBe(null);
    expect(elapsedLabel(0, 42_000)).toBe("42s ago");
    expect(elapsedLabel(0, 3 * 60 * 60 * 1000)).toBe("3h ago");
  });
});

/** RQ-0037#AC-2. `ahead === 0` reads as "no checkpoints yet" in words — never a blank — even though
 * `lastCheckpointAt` is non-null at that point (the base's own commit date, not a checkpoint). */
describe("checkpointLabel", () => {
  it("says no checkpoints yet at ahead: 0, regardless of lastCheckpointAt", () => {
    expect(checkpointLabel(0, "2026-08-20T00:00:00Z", 0)).toBe("no checkpoints yet");
    expect(checkpointLabel(0, null, 0)).toBe("no checkpoints yet");
  });

  it("names the count and elapsed time once a checkpoint exists", () => {
    const now = Date.parse("2026-08-21T00:01:00Z");
    expect(checkpointLabel(1, "2026-08-21T00:00:00Z", now)).toBe(
      "1 commit ahead · last checkpoint 1m ago",
    );
    expect(checkpointLabel(3, "2026-08-21T00:00:00Z", now)).toBe(
      "3 commits ahead · last checkpoint 1m ago",
    );
  });
});

/** RQ-0037#AC-3. Dirty and resumable are independent, both readable as words. */
describe("worktreeBadges", () => {
  it("names dirty and resumable independently, and together", () => {
    expect(worktreeBadges({ sessionId: "s1", dirty: false })).toEqual([]);
    expect(worktreeBadges({ sessionId: "s1", dirty: true })).toEqual(["dirty"]);
    expect(worktreeBadges({ sessionId: null, dirty: false })).toEqual(["resumable"]);
    expect(worktreeBadges({ sessionId: null, dirty: true })).toEqual(["dirty", "resumable"]);
  });
});

/** RQ-0038. Terminal rows label by the index baked into `main/terminals.ts`'s own `t1, t2…` ids. */
describe("terminalLabel", () => {
  it("reads the index out of the terminal id", () => {
    expect(terminalLabel("t1", "myproject")).toBe("Terminal 1 · myproject");
    expect(terminalLabel("t12", "demo")).toBe("Terminal 12 · demo");
  });
});

describe("terminalStatus", () => {
  it("reads running, exited, and exited with a non-zero code", () => {
    expect(terminalStatus(undefined)).toBe("running");
    expect(terminalStatus(0)).toBe("exited");
    expect(terminalStatus(null)).toBe("exited");
    expect(terminalStatus(1)).toBe("exited (1)");
  });
});
