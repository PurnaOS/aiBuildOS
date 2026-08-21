import { createContext, useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * One execute call's state, folded from the wire (RQ-0031, ST-0047).
 *
 * `ToolCallCard` used to read only `args`/`result` — the two AG-UI events CopilotKit itself
 * understands. Everything a terminal needs beyond that (the command, output as it streams, how long
 * it took) either rides the wire *between* those two events, on the `acp.tool_call_update` CUSTOM
 * event nothing has ever consumed, or needs a clock CopilotKit has no reason to keep. This module is
 * the fold that turns that whole sequence into one small, drawable shape — pure and independently
 * testable (TC-0083) — plus the small store that lets `ToolCallCard` read it by `toolCallId` without
 * CopilotKit ever knowing it exists.
 */
export interface ToolCallState {
  /** The command an `execute` call ran, read from its `rawInput`. Only `execute` calls have one. */
  readonly command: string | null;
  readonly kind: string | null;
  readonly title: string | null;
  /** Output lines in arrival order — streamed while running, and whatever the result adds. */
  readonly chunks: readonly string[];
  readonly outcome: "running" | "succeeded" | "failed" | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Paths the call touched. Kept once a result arrives even if that result carries none of its
   * own — `ToolCallCard`'s old `parsed === null` guard hid these the moment a result parsed
   * successfully, which is the bug AC-5 asks to be rid of. */
  readonly files: readonly string[];
  /** The result's raw text, set only when it could not be read as the JSON the bridge sends (AC-6)
   * — so a call whose result this card cannot parse still shows something rather than nothing. */
  readonly raw: string | null;
}

export const emptyToolCall: ToolCallState = {
  command: null,
  kind: null,
  title: null,
  chunks: [],
  outcome: null,
  startedAt: null,
  endedAt: null,
  files: [],
  raw: null,
};

/** The slice of a `session:event` payload a tool call cares about — the same loose shape
 * `SessionTab.tsx` and `Activity.tsx` already cast their events to. */
export interface ToolCallWireEvent {
  readonly type: string;
  readonly toolCallId?: string;
  readonly delta?: string;
  readonly content?: string;
  readonly name?: string;
  readonly value?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function paths(locations: unknown): string[] {
  if (!Array.isArray(locations)) return [];
  return locations.flatMap((entry) =>
    isRecord(entry) && typeof entry.path === "string" ? [entry.path] : [],
  );
}

/** The honest line a terminal handle renders as, rather than nothing (AC-6): the agent ran this in
 * its own terminal, so there is no output here for the card to show. */
function terminalHandleLine(entry: Record<string, unknown>): string {
  const id = typeof entry.terminalId === "string" ? entry.terminalId : null;
  return id
    ? `Ran in the agent's own terminal (${id}) — its output does not travel over this wire.`
    : "Ran in the agent's own terminal — its output does not travel over this wire.";
}

/** The text a `ToolCallContent[]` array contributes, in order. A diff is someone else's card. */
function textOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const lines: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (
      entry.type === "content" &&
      isRecord(entry.content) &&
      typeof entry.content.text === "string"
    ) {
      lines.push(entry.content.text);
    } else if (entry.type === "terminal") {
      lines.push(terminalHandleLine(entry));
    }
  }
  return lines;
}

/** What a completed command's own output looks like when nothing streamed (AC-2's fallback): the
 * result's `rawOutput`, read generously since only the stub's own shape (`{ output }`) is known. */
function rawOutputText(rawOutput: unknown): string[] {
  if (typeof rawOutput === "string") return rawOutput === "" ? [] : [rawOutput];
  if (isRecord(rawOutput) && typeof rawOutput.output === "string") {
    return rawOutput.output === "" ? [] : [rawOutput.output];
  }
  if (rawOutput != null) return [JSON.stringify(rawOutput)];
  return [];
}

/**
 * One step of the fold: the wire's event sequence into card state (TC-0083).
 *
 * `now` is a parameter rather than a `Date.now()` call inside, so the fold stays deterministic — a
 * fixture drives it with whatever clock a test wants; the live store below passes the real one.
 */
export function applyToolCallEvent(
  state: ToolCallState,
  event: ToolCallWireEvent,
  now: number = Date.now(),
): ToolCallState {
  // The event that starts a call carries everything the agent knew about it up front — the only
  // place `rawInput.command` ever appears.
  if (event.type === "TOOL_CALL_ARGS" && typeof event.delta === "string") {
    let args: { title?: string; kind?: string; locations?: unknown; rawInput?: unknown };
    try {
      args = JSON.parse(event.delta);
    } catch {
      return state;
    }

    const command =
      args.kind === "execute" &&
      isRecord(args.rawInput) &&
      typeof args.rawInput.command === "string"
        ? args.rawInput.command
        : state.command;

    return {
      ...state,
      command,
      kind: args.kind ?? state.kind,
      title: args.title ?? state.title,
      files: [...new Set([...state.files, ...paths(args.locations)])],
      outcome: state.outcome ?? "running",
      startedAt: state.startedAt ?? now,
    };
  }

  // Everything streamed between the start and the result: the update nothing else consumes.
  if (event.type === "CUSTOM" && event.name === "acp.tool_call_update") {
    const lines = isRecord(event.value) ? textOf(event.value.content) : [];
    return lines.length === 0 ? state : { ...state, chunks: [...state.chunks, ...lines] };
  }

  if (event.type === "TOOL_CALL_RESULT" && typeof event.content === "string") {
    let result: {
      status?: string;
      content?: unknown;
      locations?: unknown;
      rawOutput?: unknown;
    } | null;
    try {
      result = JSON.parse(event.content);
    } catch {
      result = null;
    }

    // A result the card cannot parse renders as the text it is, never as an empty card (AC-6). The
    // outcome stays whatever it was — inventing "succeeded" or "failed" from nothing would be a lie
    // the plain text next to it does not tell.
    if (result === null) return { ...state, endedAt: now, raw: event.content };

    const streamed = textOf(result.content);
    const chunks =
      state.chunks.length > 0 || streamed.length > 0
        ? [...state.chunks, ...streamed]
        : rawOutputText(result.rawOutput);

    return {
      ...state,
      chunks,
      files: [...new Set([...state.files, ...paths(result.locations)])],
      outcome: result.status === "failed" ? "failed" : "succeeded",
      endedAt: now,
    };
  }

  return state;
}

/** How many output lines RQ-0031#AC-4 calls "a screenful" before folding the rest behind their own
 * count. */
export const OUTPUT_CLAMP = 20;

/**
 * Which of a call's output lines to show right now (AC-4): all of them once they already fit, or
 * once the reader asked to see everything; otherwise the most recent `limit`, since a call still
 * running is more usefully judged by its latest output than its first. Pure and separate from
 * `ToolCallCard` so the fold itself — the count, and what "show all" reveals — is exercised directly
 * here (TC-0083) rather than only through a stub whose own output never runs long enough to fold.
 */
export function visibleLines(
  chunks: readonly string[],
  expanded: boolean,
  limit: number = OUTPUT_CLAMP,
): { lines: string[]; total: number; folded: boolean } {
  const text = chunks.join("");
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const folded = !expanded && lines.length > limit;
  return { lines: folded ? lines.slice(-limit) : lines, total: lines.length, folded };
}

// -------------------------------------------------------------------------------------------------
// The live store: one subscription `Chat.tsx` mounts once, so every `ToolCallCard` can read its own
// call by id without CopilotKit passing it through — the `now/badge.ts` `useSyncExternalStore`
// pattern, keyed rather than singular because one session runs more than one tool call.
//
// ponytail: keyed by `toolCallId` alone, never evicted — fine for one interactive session's worth of
// calls. Real agents mint unique ids, so cross-session collision is theoretical; if two `Chat` panels
// are ever mounted at once against agents that reuse ids (the stub does), namespace by session too.
// -------------------------------------------------------------------------------------------------

// Keyed `sessionId:toolCallId` — the stub's own ids are small counters every session repeats, so
// the session is part of the identity. Entries live as long as the workspace: a session tab opened
// after its events already streamed still finds the history here, which is the whole point.
// ponytail: unbounded across a very long run; evict a session's entries on session:state closed if
// memory ever matters.
const calls = new Map<string, { sessionId: string; state: ToolCallState }>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getToolCall(sessionId: string | null, toolCallId: string): ToolCallState {
  if (sessionId === null) return emptyToolCall;
  return calls.get(`${sessionId}:${toolCallId}`)?.state ?? emptyToolCall;
}

/** Every call one session has made, in start order — what a session tab renders as its history. */
export function getSessionToolCalls(sessionId: string): ToolCallState[] {
  return [...calls.values()]
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.state)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

export function subscribeToolCall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The id a wire event belongs to — top-level on the standard events, nested in the raw ACP update
 * the CUSTOM event carries whole. */
function toolCallIdOf(event: ToolCallWireEvent): string | null {
  if (typeof event.toolCallId === "string") return event.toolCallId;
  if (isRecord(event.value) && typeof event.value.toolCallId === "string") {
    return event.value.toolCallId;
  }
  return null;
}

/**
 * Mounted once by `Workspace.tsx`, for **every** session at once: a build session's tool calls
 * stream whether or not anything is looking, so a session tab opened a minute later still shows
 * what ran (BG-0008's real fix — `session:event` is never replayed for a late subscriber, and a
 * fast build's calls are all "late" for any tab a human opens).
 */
export function useToolCallStream(): void {
  useEffect(() => {
    return window.aibuildos.subscribe("session:event", (payload) => {
      const event = payload.event as ToolCallWireEvent;
      const id = toolCallIdOf(event);
      if (id === null) return;

      const key = `${payload.sessionId}:${id}`;
      const current = calls.get(key)?.state ?? emptyToolCall;
      const next = applyToolCallEvent(current, event);
      if (next === current) return;
      calls.set(key, { sessionId: payload.sessionId, state: next });
      notify();
    });
  }, []);
}

/** The session whose tool calls a card belongs to — provided by the surface that hosts the cards
 * (`Chat.tsx` wraps its transcript in it), read by `ToolCallCard` which CopilotKit renders with no
 * session in its props. */
export const ToolSessionContext = createContext<string | null>(null);

/** What `ToolCallCard` reads for one call — live as the store updates, `emptyToolCall` for any id it
 * has never seen (a call that never streamed anything). */
export function useToolCall(sessionId: string | null, toolCallId: string): ToolCallState {
  return useSyncExternalStore(subscribeToolCall, () => getToolCall(sessionId, toolCallId));
}

/** A session's whole call history, live — what `SessionTab` renders. */
export function useSessionToolCalls(sessionId: string): ToolCallState[] {
  // The snapshot must be referentially stable between store changes, or useSyncExternalStore
  // loops; cached per notify by the store's own listener mechanics.
  const subscribe = subscribeToolCall;
  return useSyncExternalStore(
    subscribe,
    useMemo(() => {
      let last: { key: string; value: ToolCallState[] } | null = null;
      return () => {
        const value = getSessionToolCalls(sessionId);
        const key = value.map((s) => `${s.title}:${s.chunks.length}:${s.outcome}`).join("|");
        if (last !== null && last.key === key) return last.value;
        last = { key, value };
        return value;
      };
    }, [sessionId]),
  );
}
