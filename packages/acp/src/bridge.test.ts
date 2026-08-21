import { type BaseEvent, EventType } from "@ag-ui/core";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { CUSTOM, SessionBridge } from "./bridge.js";

/**
 * TC-0016. Every ACP session update maps onto AG-UI events.
 *
 * A pure function over recorded updates, so this needs neither a process nor a window. It is the case
 * that stops the bridge doing what the probe does today — keeping the message text and throwing the
 * other twelve update kinds away.
 */
// `BaseEvent` is a passthrough schema, so the fields each variant adds are not statically known.
const types = (events: BaseEvent[]): string[] => events.map((event) => event.type);
const names = (events: BaseEvent[]): string[] =>
  events.map((event) => (event as unknown as { name?: string }).name ?? "").filter(Boolean);
const readValue = <T>(event: BaseEvent | undefined): T => (event as unknown as { value: T }).value;

const text = (t: string, messageId?: string): SessionUpdate =>
  ({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: t },
    ...(messageId === undefined ? {} : { messageId }),
  }) as SessionUpdate;

/** Every kind the protocol defines today, one of each. */
const everyKind: SessionUpdate[] = [
  text("hello", "m-1"),
  { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" }, messageId: "u-1" },
  { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" }, messageId: "t-1" },
  {
    sessionUpdate: "tool_call",
    toolCallId: "tc-1",
    title: "Read ui.ts",
    kind: "read",
    status: "pending",
  },
  { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" },
  {
    sessionUpdate: "plan",
    entries: [{ content: "Read", priority: "medium", status: "completed" }],
  },
  {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "review", description: "Review" }],
  },
  { sessionUpdate: "current_mode_update", currentModeId: "plan" },
  { sessionUpdate: "config_option_update", configOptions: [] },
  { sessionUpdate: "session_info_update", title: "Working on RQ-0004" },
  { sessionUpdate: "usage_update", used: 1200, size: 200000 },
] as unknown as SessionUpdate[];

describe("the ACP to AG-UI bridge", () => {
  it("produces events for every update kind, dropping none", () => {
    const bridge = new SessionBridge("thread-1");

    for (const update of everyKind) {
      const events = bridge.update(update);
      expect(events.length, `${update.sessionUpdate} produced nothing`).toBeGreaterThan(0);
    }
  });

  it("carries an update kind it has never seen rather than discarding it", () => {
    const bridge = new SessionBridge("thread-1");

    const events = bridge.update({ sessionUpdate: "invented_in_a_later_version" } as never);

    expect(names(events)).toEqual([CUSTOM.unknown]);
  });

  it("treats chunks sharing an identifier as one message, opened and closed once", () => {
    const bridge = new SessionBridge("thread-1");

    const first = bridge.update(text("Hel", "m-1"));
    const second = bridge.update(text("lo", "m-1"));
    const closed = bridge.runFinished("run-1", "end_turn");

    expect(types(first)).toEqual([EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]);
    expect(types(second)).toEqual([EventType.TEXT_MESSAGE_CONTENT]);
    expect(types(closed)).toEqual([EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]);
  });

  it("begins a second message when the identifier changes", () => {
    const bridge = new SessionBridge("thread-1");
    bridge.update(text("one", "m-1"));

    const events = bridge.update(text("two", "m-2"));

    expect(types(events)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
  });

  it("keeps reasoning distinguishable from speech, and switches between them cleanly", () => {
    const bridge = new SessionBridge("thread-1");

    const thinking = bridge.update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "considering" },
      messageId: "t-1",
    } as SessionUpdate);
    const speaking = bridge.update(text("answer", "m-1"));

    expect(types(thinking)).toEqual([
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
    ]);
    expect(types(speaking)).toEqual([
      EventType.REASONING_MESSAGE_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
  });

  it("keeps a message open across chunks when the agent sends no identifier", () => {
    const bridge = new SessionBridge("thread-1");
    bridge.runStarted("run-1");

    const first = bridge.update(text("a"));
    const second = bridge.update(text("b"));

    expect(types(first)).toEqual([EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]);
    // Without a stable fallback id every chunk would open and close its own message.
    expect(types(second)).toEqual([EventType.TEXT_MESSAGE_CONTENT]);
  });

  it("carries a tool call's kind and locations as its arguments, so it can be drawn inline", () => {
    const bridge = new SessionBridge("thread-1");

    const events = bridge.update({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "Edit ui.ts",
      kind: "edit",
      status: "pending",
      rawInput: { path: "ui.ts" },
      locations: [{ path: "/p/ui.ts", line: 12 }],
    } as SessionUpdate);

    expect(types(events)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);

    // AG-UI has no field for a tool's kind or the files it touched; its arguments do.
    const args = JSON.parse((events[1] as unknown as { delta: string }).delta) as {
      kind: string;
      locations: { path: string }[];
    };
    expect(args.kind).toBe("edit");
    expect(args.locations[0]?.path).toBe("/p/ui.ts");
  });

  it("finishes a tool call only when the agent says it finished", () => {
    const bridge = new SessionBridge("thread-1");

    // Still running: a result here would draw the card as done while it is not.
    const running = bridge.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "in_progress",
    } as SessionUpdate);
    expect(types(running)).toEqual([EventType.CUSTOM]);

    const done = bridge.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
    } as SessionUpdate);
    expect(types(done)).toEqual([EventType.TOOL_CALL_RESULT]);
  });

  it("carries a diff through with its path and both sides intact", () => {
    const bridge = new SessionBridge("thread-1");

    const events = bridge.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "completed",
      content: [
        { type: "diff", path: "/p/ui.ts", oldText: "const a = 1;", newText: "const a = 2;" },
      ],
    } as SessionUpdate);

    expect(types(events)).toEqual([EventType.TOOL_CALL_RESULT]);
    const result = JSON.parse((events[0] as unknown as { content: string }).content) as {
      content: { path: string; oldText: string }[];
    };
    expect(result.content[0]?.path).toBe("/p/ui.ts");
    expect(result.content[0]?.oldText).toBe("const a = 1;");
  });

  it("passes a whole plan every time, so the renderer can replace rather than merge", () => {
    const bridge = new SessionBridge("thread-1");

    const first = bridge.update({
      sessionUpdate: "plan",
      entries: [{ content: "one", priority: "medium", status: "pending" }],
    } as SessionUpdate);
    const second = bridge.update({
      sessionUpdate: "plan",
      entries: [
        { content: "one", priority: "medium", status: "completed" },
        { content: "two", priority: "medium", status: "pending" },
      ],
    } as SessionUpdate);

    expect(names(first)).toEqual([CUSTOM.plan]);
    expect(readValue<{ entries: unknown[] }>(second[0]).entries).toHaveLength(2);
  });

  it("distinguishes an ordinary end, a refusal and a cancellation", () => {
    const ended = new SessionBridge("t").runFinished("r", "end_turn");
    const refused = new SessionBridge("t").runFinished("r", "refusal");
    const cancelled = new SessionBridge("t").runFinished("r", "cancelled");

    expect(types(ended)).toEqual([EventType.RUN_FINISHED]);
    // A refusal is the agent declining; a cancellation is the user stopping. Neither is a crash,
    // but only one of them is an error.
    expect(types(refused)).toEqual([EventType.RUN_ERROR]);
    expect(types(cancelled)).toEqual([EventType.RUN_FINISHED]);
    expect((cancelled[0] as unknown as { result: { stopReason: string } }).result.stopReason).toBe(
      "cancelled",
    );
  });

  it("closes an open message when the turn ends, however it ends", () => {
    const bridge = new SessionBridge("thread-1");
    bridge.update(text("half a sentence", "m-1"));

    // Leaving it open would strand the message in the renderer forever.
    expect(types(bridge.runFailed("the agent exited", "exited"))).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_ERROR,
    ]);
  });

  it("carries non-text content instead of flattening or dropping it", () => {
    const bridge = new SessionBridge("thread-1");

    const events = bridge.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "iVBOR", mimeType: "image/png" },
      messageId: "m-1",
    } as SessionUpdate);

    expect(names(events)).toEqual([CUSTOM.content]);
  });

  it("forwards extension payloads whole, `_meta` intact (RQ-0052)", () => {
    const bridge = new SessionBridge("thread-1");
    // The known update kinds each pick their fields; an extension payload keeps every one it came
    // with — `_meta` above all, because that is where the extension's own data rides (DC-0028).
    const payload = {
      _meta: { "aibuildos/typed-record": { attempt: 1 } },
      stories: [{ title: "Deliver RQ-0001", implements: ["RQ-0001"] }],
    };

    const proposal = bridge.extension(CUSTOM.planProposal, { payload, response: null });
    expect(types(proposal)).toEqual([EventType.CUSTOM]);
    expect(names(proposal)).toEqual([CUSTOM.planProposal]);
    expect(readValue<{ payload: unknown }>(proposal[0]).payload).toBe(payload);

    const verdict = bridge.extension(CUSTOM.checkVerdict, {
      _meta: { note: "kept" },
      testCaseId: "TC-0001",
      result: "passed",
    });
    expect(names(verdict)).toEqual([CUSTOM.checkVerdict]);
    expect(readValue<{ _meta: unknown; result: string }>(verdict[0])).toEqual({
      _meta: { note: "kept" },
      testCaseId: "TC-0001",
      result: "passed",
    });
  });

  it("never emits the agent's own vocabulary as an event type", () => {
    const bridge = new SessionBridge("thread-1");
    const emitted = [
      ...bridge.runStarted("run-1"),
      ...everyKind.flatMap((update) => bridge.update(update)),
      ...bridge.runFinished("run-1", "end_turn"),
    ];

    const allowed = new Set<string>(Object.values(EventType));
    for (const event of emitted) {
      expect(allowed.has(event.type), `${event.type} is not an AG-UI event type`).toBe(true);
    }
  });
});
