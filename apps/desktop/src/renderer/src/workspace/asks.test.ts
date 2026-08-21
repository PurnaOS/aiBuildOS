import { describe, expect, it } from "vitest";
import { splitAsks } from "./asks.js";

/**
 * TC-0051. A question fence becomes a card, and a broken one becomes text.
 *
 * Verifies RQ-0016#AC-1 and AC-5 at the parser: the pure split of a completed message into prose
 * and question, never a throw, never a half-question.
 */
const fence = (body: string): string => `\`\`\`aibuildos-question\n${body}\n\`\`\``;

describe("splitting a completed message into prose and question", () => {
  it("keeps the prose intact and extracts the question, its options and the free-text flag", () => {
    const question = fence(
      JSON.stringify({
        question: "Which colour?",
        options: [
          { id: "red", label: "Red" },
          { id: "blue", label: "Blue" },
        ],
        allowFreeText: true,
      }),
    );
    const content = `A quick question first.\n\n${question}\n\nThanks.`;

    expect(splitAsks(content)).toEqual([
      { kind: "prose", text: "A quick question first.\n\n" },
      {
        kind: "question",
        question: "Which colour?",
        options: [
          { id: "red", label: "Red" },
          { id: "blue", label: "Blue" },
        ],
        allowFreeText: true,
      },
      { kind: "prose", text: "\n\nThanks." },
    ]);
  });

  it("returns the whole message as one prose segment when there is no fence at all", () => {
    expect(splitAsks("Just an answer, no question in it.")).toEqual([
      { kind: "prose", text: "Just an answer, no question in it." },
    ]);
  });

  it("leaves malformed JSON in the fence as prose", () => {
    const content = `Before.\n\n${fence("{ not json")}\n\nAfter.`;
    expect(splitAsks(content)).toEqual([{ kind: "prose", text: content }]);
  });

  it("leaves a fence with no options as prose", () => {
    const content = fence(JSON.stringify({ question: "Which colour?" }));
    expect(splitAsks(content)).toEqual([{ kind: "prose", text: content }]);
  });

  it("leaves an empty options array as prose", () => {
    const content = fence(JSON.stringify({ question: "Which colour?", options: [] }));
    expect(splitAsks(content)).toEqual([{ kind: "prose", text: content }]);
  });

  it("leaves an option missing a label as prose", () => {
    const content = fence(JSON.stringify({ question: "Which colour?", options: [{ id: "red" }] }));
    expect(splitAsks(content)).toEqual([{ kind: "prose", text: content }]);
  });

  it("leaves an ordinary code fence as prose, untouched", () => {
    const content = 'Here is some code:\n\n```json\n{ "a": 1 }\n```\n';
    expect(splitAsks(content)).toEqual([{ kind: "prose", text: content }]);
  });

  it("leaves an unterminated question fence as prose to the end of the message", () => {
    const content = 'Before.\n\n```aibuildos-question\n{ "question": "Which colour?"';
    expect(splitAsks(content)).toEqual([{ kind: "prose", text: content }]);
  });

  it("defaults allowFreeText to true when the fence omits it", () => {
    const content = fence(
      JSON.stringify({ question: "Who is this for?", options: [{ id: "me", label: "Just me" }] }),
    );
    const [segment] = splitAsks(content);
    expect(segment).toMatchObject({ kind: "question", allowFreeText: true });
  });

  it("never throws, whatever the fence contains", () => {
    expect(() => splitAsks(fence("null"))).not.toThrow();
    expect(() => splitAsks(fence("42"))).not.toThrow();
    expect(() => splitAsks(fence("[1,2,3]"))).not.toThrow();
  });
});
