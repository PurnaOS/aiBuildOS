import { type BaseEvent, EventType } from "@ag-ui/core";
import type { SessionUpdate, StopReason } from "@agentclientprotocol/sdk";

/**
 * The ACP → AG-UI bridge (ST-0009, DC-0017).
 *
 * This module is the whole of [DC-0008](../../../docs/decisions/dc-0008.md)'s promise that "the
 * renderer consumes AG-UI only". It runs in the main process, so the agent's wire format never
 * crosses the IPC boundary, and a change to that format lands here rather than in components.
 *
 * Pure and synchronous by design — no process, no socket, no window — which is what makes every
 * mapping testable one update at a time (TC-0016).
 *
 * Two shapes have to be reconciled. ACP narrates a turn as **stateful updates**: a tool call is
 * created and then amended, a message arrives as chunks that belong together. AG-UI is a **stream of
 * events** with explicit starts and ends. So the bridge is a small state machine: it remembers which
 * message is open and closes it when the next one begins.
 *
 * Where ACP carries more than AG-UI has a name for — a tool call's kind, status, diffs and locations
 * — the detail rides on a `CUSTOM` event beside the standard one. Nothing is dropped: an update kind
 * this bridge has never seen still emits a `CUSTOM` carrying it, because silently discarding an
 * update is exactly the failure the probe has today.
 */

/** The `name` on every `CUSTOM` event this bridge emits, so a renderer can switch on one field. */
export const CUSTOM = {
  toolCallUpdate: "acp.tool_call_update",
  plan: "acp.plan",
  commands: "acp.commands",
  mode: "acp.mode",
  configOptions: "acp.config_options",
  sessionInfo: "acp.session_info",
  usage: "acp.usage",
  permission: "acp.permission",
  content: "acp.content",
  unknown: "acp.unknown",
  planProposal: "acp.plan_proposal",
  checkVerdict: "acp.check_verdict",
} as const;

/** A content block that is not plain text — an image, a linked resource, an embedded document. */
interface NonTextContent {
  readonly messageId: string;
  readonly content: unknown;
}

function custom(name: string, value: unknown): BaseEvent {
  return { type: EventType.CUSTOM, name, value } as BaseEvent;
}

/**
 * Bridges one session's updates.
 *
 * One instance per session, because the open-message state it keeps is per session.
 */
export class SessionBridge {
  /** The AG-UI message currently open, if any, and whether it is reasoning rather than speech. */
  private open: { id: string; reasoning: boolean } | null = null;
  private turn = 0;

  constructor(private readonly threadId: string) {}

  /** The events that begin a turn. `runId` identifies it for the whole of its life. */
  runStarted(runId: string): BaseEvent[] {
    this.turn += 1;
    return [{ type: EventType.RUN_STARTED, threadId: this.threadId, runId } as BaseEvent];
  }

  /**
   * The events that end a turn.
   *
   * A refusal is not a crash and a cancellation is not a failure, so only the outcomes that are
   * genuinely errors become `RUN_ERROR`. Whatever was open is closed first — leaving a message open
   * across the end of a turn strands it in the renderer forever.
   */
  runFinished(runId: string, stopReason: StopReason): BaseEvent[] {
    const events = this.closeOpen();

    if (stopReason === "refusal") {
      events.push({
        type: EventType.RUN_ERROR,
        message: "The agent declined to continue.",
        code: stopReason,
      } as BaseEvent);
      return events;
    }

    events.push({
      type: EventType.RUN_FINISHED,
      threadId: this.threadId,
      runId,
      result: { stopReason },
    } as BaseEvent);
    return events;
  }

  /** A failure that is not the agent's own stop reason — a spawn that died, a protocol error. */
  runFailed(message: string, code: string): BaseEvent[] {
    const events = this.closeOpen();
    events.push({ type: EventType.RUN_ERROR, message, code } as BaseEvent);
    return events;
  }

  /**
   * Extension traffic (DC-0028), forwarded **whole**. The known update kinds above each pick the
   * fields AG-UI has a name for and drop the rest — including `_meta`, which is exactly where an
   * extension payload lives. So extension events get their own mapping with no field selection at
   * all: the payload is the point, and stripping it would be the bridge silently un-typing what
   * RQ-0052 exists to keep typed.
   */
  extension(name: string, value: unknown): BaseEvent[] {
    return [custom(name, value)];
  }

  /** Translate one session update. Returns every AG-UI event it produces, in order. */
  update(update: SessionUpdate): BaseEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.chunk(update.content, update.messageId ?? null, false, "assistant");
      case "user_message_chunk":
        // Arrives when a conversation is replayed rather than lived; it is still a message.
        return this.chunk(update.content, update.messageId ?? null, false, "user");
      case "agent_thought_chunk":
        return this.chunk(update.content, update.messageId ?? null, true, "assistant");

      case "tool_call": {
        // The detail travels as the tool call's *arguments* rather than beside it. AG-UI has no
        // field for a tool's kind or the files it touched, but it does have a channel for a tool
        // call — and putting it there is what lets the transcript draw the card inline, in order,
        // instead of in a separate list that has lost its place in the conversation.
        const args = {
          title: update.title,
          kind: update.kind ?? "other",
          status: update.status ?? "pending",
          locations: update.locations ?? [],
          rawInput: update.rawInput ?? null,
        };

        return [
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: update.toolCallId,
            toolCallName: update.title,
          } as BaseEvent,
          {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: update.toolCallId,
            delta: JSON.stringify(args),
          } as BaseEvent,
          { type: EventType.TOOL_CALL_END, toolCallId: update.toolCallId } as BaseEvent,
        ];
      }

      case "tool_call_update": {
        // ACP defines `content` and `locations` as a replacement, not an append. The renderer is
        // told the whole update and replaces what it holds, which is the only reading that matches.
        const finished = update.status === "completed" || update.status === "failed";
        if (!finished) return [custom(CUSTOM.toolCallUpdate, update)];

        // A result is what marks a tool call finished in AG-UI, so only a terminal status becomes
        // one. Anything earlier would draw the card as done while it is still running.
        return [
          {
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: update.toolCallId,
            messageId: `${update.toolCallId}-result`,
            content: JSON.stringify({
              status: update.status,
              content: update.content ?? [],
              locations: update.locations ?? [],
              rawOutput: update.rawOutput ?? null,
            }),
          } as BaseEvent,
        ];
      }

      // The agent resends the complete list every time and the client replaces it wholesale.
      case "plan":
        return [custom(CUSTOM.plan, update)];
      case "available_commands_update":
        return [custom(CUSTOM.commands, update)];
      case "current_mode_update":
        return [custom(CUSTOM.mode, update)];
      case "config_option_update":
        return [custom(CUSTOM.configOptions, update)];
      case "session_info_update":
        return [custom(CUSTOM.sessionInfo, update)];
      case "usage_update":
        return [custom(CUSTOM.usage, update)];

      default:
        // An update kind added to the protocol after this was written, or one marked unstable. It
        // still reaches the renderer: dropping it here is how a UI silently stops telling the truth.
        return [custom(CUSTOM.unknown, update)];
    }
  }

  /**
   * A chunk of a message, of whichever sort.
   *
   * ACP says chunks sharing a `messageId` are one message and a change of id begins another. When the
   * agent sends no id at all, the turn itself is the message — otherwise every chunk would open and
   * close its own.
   */
  private chunk(
    content: SessionUpdate extends { content: infer C } ? C : unknown,
    messageId: string | null,
    reasoning: boolean,
    role: "assistant" | "user",
  ): BaseEvent[] {
    const id = messageId ?? `turn-${this.turn}-${reasoning ? "thought" : "message"}`;
    const events: BaseEvent[] = [];

    if (this.open && (this.open.id !== id || this.open.reasoning !== reasoning)) {
      events.push(...this.closeOpen());
    }

    if (!this.open) {
      events.push(
        reasoning
          ? ({
              type: EventType.REASONING_MESSAGE_START,
              messageId: id,
              role: "reasoning",
            } as BaseEvent)
          : ({ type: EventType.TEXT_MESSAGE_START, messageId: id, role } as BaseEvent),
      );
      this.open = { id, reasoning };
    }

    const block = content as { type?: string; text?: string };
    if (block?.type === "text" && typeof block.text === "string") {
      events.push(
        reasoning
          ? ({
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: id,
              delta: block.text,
            } as BaseEvent)
          : ({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: id,
              delta: block.text,
            } as BaseEvent),
      );
      return events;
    }

    // An image, a resource link, an embedded document. AG-UI's text stream has nowhere to put it, so
    // it travels intact rather than being flattened into a caption or thrown away.
    events.push(custom(CUSTOM.content, { messageId: id, content } satisfies NonTextContent));
    return events;
  }

  /** Close whatever message is open. Safe to call when none is. */
  private closeOpen(): BaseEvent[] {
    if (!this.open) return [];

    const { id, reasoning } = this.open;
    this.open = null;
    return [
      reasoning
        ? ({ type: EventType.REASONING_MESSAGE_END, messageId: id } as BaseEvent)
        : ({ type: EventType.TEXT_MESSAGE_END, messageId: id } as BaseEvent),
    ];
  }
}
