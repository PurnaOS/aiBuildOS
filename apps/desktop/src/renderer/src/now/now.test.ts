import { describe, expect, it } from "vitest";
import { deriveNow, emptyMessage, needsYouCount } from "./now.js";

/** TC-0068. Now derives from the sessions and the record, and counts what waits. */
describe("Now's derivation", () => {
  it("derives two rows from two running builds, one waiting on a permission", () => {
    const rows = deriveNow(
      [
        { storyId: "ST-0001", sessionId: "s1" },
        { storyId: "ST-0002", sessionId: "s2" },
      ],
      new Map([
        ["s1", { state: "busy", activity: "TEXT_MESSAGE_CONTENT", waiting: false }],
        ["s2", { state: "busy", activity: "acp.permission", waiting: true }],
      ]),
      (id) => (id === "ST-0001" ? "First" : "Second"),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ storyId: "ST-0001", title: "First", state: "busy" });
    expect(rows[1]).toMatchObject({ storyId: "ST-0002", state: "waiting on you", needsYou: true });
    expect(needsYouCount(rows)).toBe(1);
  });

  it("says nothing has a session yet for a build that survived a restart", () => {
    const rows = deriveNow([{ storyId: "ST-0003", sessionId: null }], new Map(), (id) => id);
    expect(rows[0]).toMatchObject({ state: "no session yet", needsYou: false });
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
