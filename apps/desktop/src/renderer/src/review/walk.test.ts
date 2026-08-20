import { describe, expect, it } from "vitest";
import {
  acceptStory,
  appendReviewNote,
  buildWalk,
  type Save,
  sendBackStory,
  turnEndWalk,
} from "./walk.js";

/**
 * TC-0048. The build walk and the send-back are record edits, and survive a restart.
 *
 * Verifies RQ-0015#AC-1, AC-4 and AC-6: everything here is derivable from injected record state
 * alone — no fake ever remembers more than the `frontmatter`/`body` it was asked to write, which is
 * exactly what a restart leaves behind on disk.
 */

/** A fake `Save`: records every call in order, and answers each artifact's saves from a script —
 * `null` for "let it through", a string for the refusal a guarded save would have produced. */
function fakeSave(refusals: Record<string, string> = {}): {
  save: Save;
  calls: { artifactId: string; frontmatter: Record<string, unknown>; body?: string }[];
} {
  const calls: { artifactId: string; frontmatter: Record<string, unknown>; body?: string }[] = [];
  const save: Save = async (artifactId, frontmatter, body) => {
    calls.push(
      body === undefined ? { artifactId, frontmatter } : { artifactId, frontmatter, body },
    );
    return { problem: refusals[artifactId] ?? null };
  };
  return { save, calls };
}

describe("the build walk", () => {
  it("emits ready→queued→building as ordered guarded saves, then composes story and requirement into the prompt", async () => {
    const { save, calls } = fakeSave();

    const result = await buildWalk(save, {
      storyId: "ST-0028",
      storyTitle: "A story is built by the agent and accepted by a person",
      requirementId: "RQ-0015",
      requirementTitle: "A story is built by the agent and accepted by a person",
      playbookBody: "I will name one Story.",
    });

    expect(calls).toEqual([
      { artifactId: "ST-0028", frontmatter: { state: "queued" } },
      { artifactId: "ST-0028", frontmatter: { state: "building" } },
    ]);
    expect(result.problem).toBeNull();
    expect(result.prompt).toContain("I will name one Story.");
    expect(result.prompt).toContain(
      "- ST-0028: A story is built by the agent and accepted by a person",
    );
    expect(result.prompt).toContain(
      "- RQ-0015: A story is built by the agent and accepted by a person",
    );
  });

  it("stops at the first refusal and never attempts the second flip", async () => {
    const { save, calls } = fakeSave({ "ST-0028": "ready cannot become queued" });

    const result = await buildWalk(save, {
      storyId: "ST-0028",
      storyTitle: "A story",
      requirementId: "RQ-0015",
      requirementTitle: "A requirement",
      playbookBody: "Body.",
    });

    expect(calls).toEqual([{ artifactId: "ST-0028", frontmatter: { state: "queued" } }]);
    expect(result.problem).toBe("ready cannot become queued");
    expect(result.prompt).toBeNull();
  });
});

describe("the turn-end walk", () => {
  it("flips exactly the stories at building, leaving every other state untouched", async () => {
    const { save, calls } = fakeSave();

    const flipped = await turnEndWalk(save, [
      { id: "ST-0001", type: "Story", state: "building" },
      { id: "ST-0002", type: "Story", state: "review" },
      { id: "ST-0003", type: "Story", state: "building" },
      { id: "BG-0001", type: "Bug", state: "building" },
    ]);

    expect(calls).toEqual([
      { artifactId: "ST-0001", frontmatter: { state: "review" } },
      { artifactId: "ST-0003", frontmatter: { state: "review" } },
    ]);
    expect(flipped).toEqual(["ST-0001", "ST-0003"]);
  });

  it("reports only the stories whose flip actually landed", async () => {
    const { save } = fakeSave({ "ST-0002": "building cannot become review" });

    const flipped = await turnEndWalk(save, [
      { id: "ST-0001", type: "Story", state: "building" },
      { id: "ST-0002", type: "Story", state: "building" },
    ]);

    expect(flipped).toEqual(["ST-0001"]);
  });
});

describe("a verdict from review", () => {
  it("accept emits one flip to accepted", async () => {
    const { save, calls } = fakeSave();

    const result = await acceptStory(save, "ST-0028");

    expect(calls).toEqual([{ artifactId: "ST-0028", frontmatter: { state: "accepted" } }]);
    expect(result.problem).toBeNull();
  });

  it("send-back flips to building, appends the note to the body in the same save, and names the story in the prompt sent onward", async () => {
    const { save, calls } = fakeSave();

    const result = await sendBackStory(
      save,
      "ST-0028",
      "\n# ST-0028 — A story\n\n## Acceptance criteria\n\n- [AC-1] It works.\n",
      "The diff is missing the second file.",
    );

    expect(calls).toEqual([
      {
        artifactId: "ST-0028",
        frontmatter: { state: "building" },
        body:
          "\n# ST-0028 — A story\n\n## Acceptance criteria\n\n- [AC-1] It works.\n\n" +
          "## Review notes\n\nThe diff is missing the second file.\n",
      },
    ]);
    expect(result.problem).toBeNull();
    expect(result.prompt).toContain("ST-0028");
    expect(result.prompt).toContain("The diff is missing the second file.");
  });

  it("a refused send-back leaves neither the state nor the note written, and sends nothing onward", async () => {
    const { save } = fakeSave({ "ST-0028": "review cannot become building" });

    const result = await sendBackStory(save, "ST-0028", "# ST-0028\n", "A note.");

    expect(result.problem).toBe("review cannot become building");
    expect(result.prompt).toBeNull();
  });
});

describe("appendReviewNote", () => {
  it("opens a new section when the story has never been sent back before", () => {
    const body = "# ST-0028 — A story\n\nProse.\n";
    expect(appendReviewNote(body, "First note.")).toBe(
      "# ST-0028 — A story\n\nProse.\n\n## Review notes\n\nFirst note.\n",
    );
  });

  it("appends to the existing section rather than opening a second one", () => {
    const body =
      "# ST-0028\n\n## Review notes\n\nFirst note.\n\n## Acceptance criteria\n\n- [AC-1] X.\n";
    const after = appendReviewNote(body, "Second note.");

    expect(after).toBe(
      "# ST-0028\n\n## Review notes\n\nFirst note.\n\nSecond note.\n\n## Acceptance criteria\n\n- [AC-1] X.\n",
    );
    expect(after.match(/## Review notes/g)).toHaveLength(1);
  });
});
