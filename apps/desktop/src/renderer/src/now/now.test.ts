import { describe, expect, it } from "vitest";
import { deriveNow, describeActivity, elapsedLabel, emptyMessage, needsYouCount } from "./now.js";

/** TC-0068. Now derives from the sessions and the record, and counts what waits. */
describe("Now's derivation", () => {
  it("derives two rows from two running builds, one waiting on a permission", () => {
    const rows = deriveNow(
      [
        { storyId: "ST-0001", sessionId: "s1", branch: "aibuildos/st-0001" },
        { storyId: "ST-0002", sessionId: "s2", branch: "aibuildos/st-0002" },
      ],
      new Map([
        [
          "s1",
          { state: "busy", activity: "TEXT_MESSAGE_CONTENT", lastEventAt: 1000, waiting: false },
        ],
        ["s2", { state: "busy", activity: "acp.permission", lastEventAt: 2000, waiting: true }],
      ]),
      (id) => (id === "ST-0001" ? "First" : "Second"),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      storyId: "ST-0001",
      title: "First",
      state: "busy",
      branch: "aibuildos/st-0001",
      lastEventAt: 1000,
    });
    expect(rows[1]).toMatchObject({ storyId: "ST-0002", state: "waiting on you", needsYou: true });
    expect(needsYouCount(rows)).toBe(1);
  });

  it("says nothing has a session yet for a build that survived a restart", () => {
    const rows = deriveNow(
      [{ storyId: "ST-0003", sessionId: null, branch: "aibuildos/st-0003" }],
      new Map(),
      (id) => id,
    );
    expect(rows[0]).toMatchObject({ state: "no session yet", needsYou: false, lastEventAt: null });
    expect(needsYouCount(rows)).toBe(0);
  });

  it("names the most recent review-ready story when nothing is building", () => {
    const message = emptyMessage([
      { id: "ST-0001", type: "Story", title: "First", state: "accepted" },
      { id: "ST-0002", type: "Story", title: "Second", state: "review" },
      { id: "ST-0003", type: "Story", title: "Third", state: "building" },
      { id: "BG-0001", type: "Bug", title: "A bug", state: "review" },
    ]);
    expect(message).toContain("ST-0002");
  });

  it("is plainly quiet when nothing is waiting in review either", () => {
    const message = emptyMessage([
      { id: "ST-0001", type: "Story", title: "First", state: "accepted" },
    ]);
    expect(message).toBe("Nothing is building right now.");
  });
});

/** RQ-0030#AC-2: a Now row's activity in plain words, never the wire's own vocabulary. */
describe("describeActivity", () => {
  it("reads a mid-message as writing, and its close as having said something", () => {
    expect(describeActivity("TEXT_MESSAGE_START")).toBe("writing");
    expect(describeActivity("TEXT_MESSAGE_CONTENT")).toBe("writing");
    expect(describeActivity("TEXT_MESSAGE_END")).toBe("said something");
  });

  it("reads reasoning as thinking, and any tool call as running a tool", () => {
    expect(describeActivity("REASONING_MESSAGE_CONTENT")).toBe("thinking");
    expect(describeActivity("TOOL_CALL_ARGS")).toBe("running a tool");
    expect(describeActivity("acp.tool_call_update")).toBe("running a tool");
  });

  it("falls back to working for anything it has not learned to name", () => {
    expect(describeActivity("RUN_STARTED")).toBe("working");
    expect(describeActivity("aibuildos.checkpoint")).toBe("working");
    expect(describeActivity(null)).toBe("working");
  });
});

describe("elapsedLabel", () => {
  it("reads seconds, then minutes, then hours, coarsely", () => {
    expect(elapsedLabel(null, 5000)).toBe(null);
    expect(elapsedLabel(0, 42_000)).toBe("42s ago");
    expect(elapsedLabel(0, 90_000)).toBe("2m ago");
    expect(elapsedLabel(0, 3 * 60 * 60 * 1000)).toBe("3h ago");
  });
});
