import { describe, expect, it } from "vitest";
import type { Save } from "../review/walk.js";
import { injectionPrompt, shouldWalk, workOn } from "./workOn.js";

/**
 * TC-0077. The rail's walk and the board's walk are one walk.
 *
 * Verifies RQ-0027#AC-1 and AC-2 as logic, against injected saves — no `window.aibuildos` anywhere
 * here, exactly as `walk.test.ts` proves `buildWalk` itself.
 */

function fakeSave(refusals: Record<string, string> = {}): {
  save: Save;
  calls: { artifactId: string; frontmatter: Record<string, unknown> }[];
} {
  const calls: { artifactId: string; frontmatter: Record<string, unknown> }[] = [];
  const save: Save = async (artifactId, frontmatter) => {
    calls.push({ artifactId, frontmatter });
    return { problem: refusals[artifactId] ?? null };
  };
  return { save, calls };
}

const WALK_CONTEXT = {
  storyId: "ST-0028",
  storyTitle: "A story",
  requirementId: "RQ-0015",
  requirementTitle: "A requirement",
  playbookBody: "I will name one Story.",
};

describe("shouldWalk", () => {
  it("is true for a Story at ready or queued", () => {
    expect(shouldWalk({ type: "Story", state: "ready" })).toBe(true);
    expect(shouldWalk({ type: "Story", state: "queued" })).toBe(true);
  });

  it("is false for a Story anywhere else, and for any other type", () => {
    expect(shouldWalk({ type: "Story", state: "building" })).toBe(false);
    expect(shouldWalk({ type: "Story", state: "draft" })).toBe(false);
    expect(shouldWalk({ type: "Requirement", state: "ready" })).toBe(false);
    expect(shouldWalk({ type: "TestCase", state: "draft" })).toBe(false);
  });
});

describe("injectionPrompt", () => {
  it("names the artifact alone when it has no text", () => {
    expect(injectionPrompt("RQ-0001", null)).toBe("Work on RQ-0001.");
  });

  it("quotes the text beneath the artifact when there is one — byte for byte, the behaviour from before RQ-0027", () => {
    expect(injectionPrompt("RQ-0001", "# RQ-0001\n\nBody.")).toBe(
      "Work on RQ-0001. This is what it says:\n\n# RQ-0001\n\nBody.",
    );
  });
});

describe("workOn", () => {
  it("walks a ready Story: buildWalk's exact flips and composed prompt, via the injected save", async () => {
    const { save, calls } = fakeSave();
    let textCalled = false;

    const result = await workOn(
      save,
      { id: "ST-0028", type: "Story", state: "ready" },
      async () => WALK_CONTEXT,
      async () => {
        textCalled = true;
        return "unused";
      },
    );

    expect(calls).toEqual([
      { artifactId: "ST-0028", frontmatter: { state: "queued" } },
      { artifactId: "ST-0028", frontmatter: { state: "building" } },
    ]);
    expect(result.problem).toBeNull();
    expect(result.prompt).toContain("I will name one Story.");
    expect(result.prompt).toContain("- ST-0028: A story");
    expect(result.prompt).toContain("- RQ-0015: A requirement");
    // The inject fetcher is never called on the walk path.
    expect(textCalled).toBe(false);
  });

  it("walks a queued Story the same way", async () => {
    const { save, calls } = fakeSave();

    const result = await workOn(
      save,
      { id: "ST-0028", type: "Story", state: "queued" },
      async () => WALK_CONTEXT,
      async () => "unused",
    );

    expect(calls[0]).toEqual({ artifactId: "ST-0028", frontmatter: { state: "queued" } });
    expect(calls[1]).toEqual({ artifactId: "ST-0028", frontmatter: { state: "building" } });
    expect(result.prompt).not.toBeNull();
  });

  it("a refusal stops the walk and surfaces it, exactly as buildWalk reports it", async () => {
    const { save, calls } = fakeSave({ "ST-0028": "ready cannot become queued" });

    const result = await workOn(
      save,
      { id: "ST-0028", type: "Story", state: "ready" },
      async () => WALK_CONTEXT,
      async () => null,
    );

    expect(calls).toEqual([{ artifactId: "ST-0028", frontmatter: { state: "queued" } }]);
    expect(result.problem).toBe("ready cannot become queued");
    expect(result.prompt).toBeNull();
  });

  it("a Story implementing no requirement refuses without ever touching save", async () => {
    const { save, calls } = fakeSave();

    const result = await workOn(
      save,
      { id: "ST-0028", type: "Story", state: "ready" },
      async () => null,
      async () => null,
    );

    expect(result.problem).toBe("This story implements no requirement.");
    expect(result.prompt).toBeNull();
    expect(calls).toEqual([]);
  });

  it("a Requirement is injection-only, byte for byte, and never reaches save or the walk context", async () => {
    const { save, calls } = fakeSave();
    let walkContextCalled = false;

    const result = await workOn(
      save,
      { id: "RQ-0001", type: "Requirement", state: "ready" },
      async () => {
        walkContextCalled = true;
        return WALK_CONTEXT;
      },
      async () => "# RQ-0001\n\nBody.",
    );

    expect(result).toEqual({
      problem: null,
      prompt: "Work on RQ-0001. This is what it says:\n\n# RQ-0001\n\nBody.",
    });
    expect(calls).toEqual([]);
    expect(walkContextCalled).toBe(false);
  });

  it("a draft Story is injection-only, exactly as before RQ-0027", async () => {
    const { save } = fakeSave();

    const result = await workOn(
      save,
      { id: "ST-0002", type: "Story", state: "draft" },
      async () => WALK_CONTEXT,
      async () => null,
    );

    expect(result).toEqual({ problem: null, prompt: "Work on ST-0002." });
  });

  it("a TestCase is injection-only", async () => {
    const { save } = fakeSave();

    const result = await workOn(
      save,
      { id: "TC-0001", type: "TestCase", state: "draft" },
      async () => WALK_CONTEXT,
      async () => null,
    );

    expect(result).toEqual({ problem: null, prompt: "Work on TC-0001." });
  });
});
