import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { SessionBridge } from "@aibuildos/acp/bridge";
import { describe, expect, it } from "vitest";
import {
  applyToolCallEvent,
  emptyToolCall,
  type ToolCallWireEvent,
  visibleLines,
} from "./toolCall.js";

/**
 * TC-0083. The reduction from the wire's own events to a terminal card's state — run against
 * fixtures the real bridge produces, so this proves the fold against what the wire actually sends
 * rather than a hand-rolled guess at its shape.
 */
function wire(update: SessionUpdate): ToolCallWireEvent[] {
  return new SessionBridge("thread-1").update(update) as unknown as ToolCallWireEvent[];
}

function fold(events: ToolCallWireEvent[], now: number): ReturnType<typeof applyToolCallEvent> {
  return events.reduce((state, event) => applyToolCallEvent(state, event, now), emptyToolCall);
}

describe("the tool call reducer", () => {
  it("takes the command from the start event, appends chunks in order, and closes with the outcome", () => {
    const start = wire({
      sessionUpdate: "tool_call",
      toolCallId: "exec-1",
      title: "Run the tests",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "bun run test" },
      locations: [{ path: "/work/notes.md" }],
    } as SessionUpdate);
    let state = fold(start, 1000);

    expect(state.command).toBe("bun run test");
    expect(state.kind).toBe("execute");
    expect(state.startedAt).toBe(1000);
    expect(state.outcome).toBe("running");

    const chunk1 = wire({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-1",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "line one\n" } }],
    } as SessionUpdate);
    for (const event of chunk1) state = applyToolCallEvent(state, event, 1100);

    const chunk2 = wire({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-1",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "line two\n" } }],
    } as SessionUpdate);
    for (const event of chunk2) state = applyToolCallEvent(state, event, 1220);

    expect(state.chunks).toEqual(["line one\n", "line two\n"]);

    const result = wire({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-1",
      status: "completed",
      rawOutput: { exitCode: 0, output: "line one\nline two\n" },
    } as SessionUpdate);
    for (const event of result) state = applyToolCallEvent(state, event, 1500);

    // The result carried no `content` of its own — `chunks` already had output, so `rawOutput` is
    // not consulted as a fallback and nothing doubles up.
    expect(state.chunks).toEqual(["line one\n", "line two\n"]);
    expect(state.outcome).toBe("succeeded");
    expect(state.files).toEqual(["/work/notes.md"]);
    expect(state.startedAt).toBe(1000);
    expect(state.endedAt).toBe(1500);
  });

  it("falls back to the result's raw output when nothing streamed", () => {
    const start = wire({
      sessionUpdate: "tool_call",
      toolCallId: "exec-2",
      title: "Run the build",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "bun run build" },
    } as SessionUpdate);
    const result = wire({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-2",
      status: "completed",
      rawOutput: { exitCode: 0, output: "built ok\n" },
    } as SessionUpdate);

    const state = fold([...start, ...result], 2000);

    expect(state.chunks).toEqual(["built ok\n"]);
    expect(state.outcome).toBe("succeeded");
  });

  it("keeps the files a call touched once a failing result carries none of its own", () => {
    const start = wire({
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit ui.ts",
      kind: "edit",
      status: "pending",
      locations: [{ path: "/p/ui.ts" }],
    } as SessionUpdate);
    const result = wire({
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      status: "failed",
    } as SessionUpdate);

    const state = fold([...start, ...result], 3000);

    expect(state.files).toEqual(["/p/ui.ts"]);
    expect(state.outcome).toBe("failed");
  });

  it("renders a result it cannot parse as the text it is, never as an empty state", () => {
    const state = applyToolCallEvent(
      emptyToolCall,
      { type: "TOOL_CALL_RESULT", toolCallId: "x", content: "not json at all" },
      4000,
    );

    expect(state.raw).toBe("not json at all");
    expect(state.endedAt).toBe(4000);
    // No outcome is invented from text that could not be read.
    expect(state.outcome).toBeNull();
  });

  it("renders a terminal handle honestly rather than as nothing", () => {
    const result = wire({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-3",
      status: "completed",
      content: [{ type: "terminal", terminalId: "term-1" }],
    } as SessionUpdate);

    const state = fold(result, 5000);

    expect(state.chunks).toHaveLength(1);
    expect(state.chunks[0]).toContain("term-1");
    expect(state.outcome).toBe("succeeded");
  });
});

describe("the output fold (RQ-0031#AC-4)", () => {
  it("shows everything once it already fits a screenful", () => {
    const { lines, total, folded } = visibleLines(["a\n", "b\n"], false);

    expect(lines).toEqual(["a", "b"]);
    expect(total).toBe(2);
    expect(folded).toBe(false);
  });

  it("folds behind its own count once output runs past a screenful, keeping the latest lines", () => {
    const chunks = Array.from({ length: 25 }, (_, index) => `line ${index}\n`);

    const { lines, total, folded } = visibleLines(chunks, false);

    expect(folded).toBe(true);
    expect(total).toBe(25);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line 5");
    expect(lines.at(-1)).toBe("line 24");
  });

  it("shows every line once asked, nothing silently cut", () => {
    const chunks = Array.from({ length: 25 }, (_, index) => `line ${index}\n`);

    const { lines, folded } = visibleLines(chunks, true);

    expect(folded).toBe(false);
    expect(lines).toHaveLength(25);
    expect(lines[0]).toBe("line 0");
  });
});
