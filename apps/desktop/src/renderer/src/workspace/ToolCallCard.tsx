import { Eye, FileDiff, Pencil, Search, Terminal, Trash2, Wrench } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { eyebrow, focusRing, mono } from "../ui.js";
import { Diff } from "./Diff.js";
import {
  applyToolCallEvent,
  type ToolCallState,
  ToolSessionContext,
  useToolCall,
  visibleLines,
} from "./toolCall.js";

/**
 * One tool call, drawn where it happened in the conversation (ST-0011).
 *
 * Registered as CopilotKit's wildcard tool renderer, so it draws whatever the agent ran without a
 * component per tool — an agent's tool names are its own and are not known in advance.
 *
 * The left rule carries status and the word beside it says the same thing, because a colour is not
 * a signal to everyone. An `execute` call gets its own body (RQ-0031, ST-0047): the command it ran,
 * live output, an outcome in words beside how long it took — everything else still draws the way it
 * always has.
 */
interface Args {
  title?: string;
  kind?: string;
  status?: string;
  locations?: { path: string; line?: number | null }[];
  rawInput?: unknown;
}

interface Result {
  status?: string;
  content?: ToolContent[];
  locations?: { path: string; line?: number | null }[];
}

type ToolContent =
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "content"; content?: { type?: string; text?: string } }
  | { type: string; [key: string]: unknown };

const ICONS: Record<string, typeof Eye> = {
  read: Eye,
  edit: Pencil,
  delete: Trash2,
  move: FileDiff,
  search: Search,
  execute: Terminal,
};

export function ToolCallCard({
  toolCallId,
  name,
  args,
  status,
  result,
}: {
  name: string;
  toolCallId?: string;
  args: Partial<Args>;
  status: string;
  result?: string | undefined;
}): React.JSX.Element {
  const parsed = parseResult(result);
  // The agent's own last word about the call outranks CopilotKit's view of the stream.
  const state = parsed?.status ?? (result === undefined ? "in_progress" : args.status) ?? status;
  const failed = state === "failed";
  const running = state === "in_progress" || state === "pending";
  const executing = args.kind === "execute";

  // Fed by the same wire this card's own props come from (`Chat.tsx`'s one `useToolCallStream`
  // subscription) — the only source for what streamed *between* the start and the result, which
  // neither `args` nor `result` ever carries.
  const sessionId = useContext(ToolSessionContext);
  const stored = useToolCall(sessionId, toolCallId ?? "");
  const call = executing ? mergeWithProps(stored, args, result) : stored;

  const Icon = ICONS[args.kind ?? ""] ?? Wrench;
  const rule = failed
    ? "bg-red-600"
    : running
      ? "bg-amber-500"
      : "bg-neutral-200 dark:bg-neutral-800";
  const files = fileList(args, parsed);

  return (
    <div
      data-testid="tool-call"
      data-status={state}
      className="my-2 flex overflow-hidden rounded border border-neutral-200 dark:border-neutral-800"
    >
      <span aria-hidden className={`w-0.5 shrink-0 ${rule}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <Icon size={12} className="shrink-0 text-neutral-500" aria-hidden />
          <span className={eyebrow}>{args.kind ?? "tool"}</span>
          <span className={`min-w-0 flex-1 truncate text-xs ${mono}`}>{args.title ?? name}</span>
          <span
            className={`shrink-0 text-[11px] ${mono} ${
              failed ? "text-red-600" : running ? "text-amber-600" : "text-neutral-500"
            }`}
          >
            {executing ? headerWord(call) : label(state)}
          </span>
        </div>

        {executing ? (
          <ExecuteBody call={call} />
        ) : (
          <>
            {parsed?.content?.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the agent sends an ordered list, not keyed items.
              <Content key={`${entry.type}-${index}`} entry={entry} />
            ))}

            {files.length > 0 && (
              <p className={`px-2.5 pb-1.5 text-[11px] text-neutral-500 ${mono}`}>
                {files.join(", ")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The header's status word for an execute call: "running" until it ends, then its outcome in the
 * same words the body uses — "finished" only for the AC-6 case where a result arrived but this card
 * could not read it, so nothing pretends to know whether it succeeded. */
function headerWord(call: ToolCallState): string {
  if (call.endedAt === null) return "running";
  return call.outcome ?? "finished";
}

/**
 * The store already holds everything a *live* execute call needs, built from the exact events
 * `Chat.tsx` subscribes to. This only fills the gap for the instant before that subscription has
 * produced anything — or a store this card's own `toolCallId` never reached at all — by folding
 * CopilotKit's own `args`/`result` props through the same reducer the store runs.
 */
function mergeWithProps(
  stored: ToolCallState,
  args: Partial<Args>,
  result: string | undefined,
): ToolCallState {
  if (stored.command !== null || stored.chunks.length > 0 || stored.outcome !== null) return stored;

  let call = stored;
  if (args.title !== undefined || args.kind !== undefined || args.rawInput !== undefined) {
    call = applyToolCallEvent(call, {
      type: "TOOL_CALL_ARGS",
      delta: JSON.stringify({
        title: args.title,
        kind: args.kind,
        locations: args.locations,
        rawInput: args.rawInput,
      }),
    });
  }
  if (result !== undefined) {
    call = applyToolCallEvent(call, { type: "TOOL_CALL_RESULT", content: result });
  }
  return call;
}

const CLAMP = 20;

function ExecuteBody({ call }: { call: ToolCallState }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const { lines, total, folded } = visibleLines(call.chunks, expanded, CLAMP);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs on new output, not on a value it reads.
  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [call.chunks, expanded]);

  const duration =
    call.startedAt !== null && call.endedAt !== null ? call.endedAt - call.startedAt : null;

  return (
    <>
      {call.command !== null && (
        <p data-testid="tool-call-command" className={`px-2.5 pt-1 pb-1.5 text-[11px] ${mono}`}>
          <span aria-hidden className="text-neutral-400">
            {"$ "}
          </span>
          {call.command}
        </p>
      )}

      {lines.length > 0 && (
        <div className="border-t border-neutral-200 dark:border-neutral-800">
          <pre
            ref={outputRef}
            data-testid="tool-call-output"
            className={`max-h-56 overflow-auto px-2.5 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap ${mono}`}
          >
            {lines.join("\n")}
          </pre>
          {folded && (
            <button
              type="button"
              data-testid="tool-call-expand"
              onClick={() => setExpanded(true)}
              className={`block w-full border-t border-neutral-200 px-2.5 py-1 text-left text-[11px] text-neutral-500 hover:bg-neutral-100 dark:border-neutral-800 dark:hover:bg-neutral-800 ${focusRing}`}
            >
              show all {total} lines
            </button>
          )}
        </div>
      )}

      {call.raw !== null && (
        <p
          className={`border-t border-neutral-200 px-2.5 py-1.5 text-[11px] whitespace-pre-wrap dark:border-neutral-800 ${mono}`}
        >
          {call.raw}
        </p>
      )}

      {call.endedAt !== null && (
        <p
          data-testid="tool-call-outcome"
          className={`flex items-center gap-2 border-t border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-500 dark:border-neutral-800 ${mono}`}
        >
          <span>{call.outcome ?? "finished"}</span>
          {duration !== null && <span>{formatDuration(duration)}</span>}
        </p>
      )}

      {call.files.length > 0 && (
        <p className={`px-2.5 pb-1.5 text-[11px] text-neutral-500 ${mono}`}>
          {call.files.join(", ")}
        </p>
      )}
    </>
  );
}

/** Coarse on purpose, matching `ui.ts`'s own `relativeTime`: the exact millisecond is never the
 * question a transcript is answering. */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function fileList(args: Partial<Args>, parsed: Result | null): string[] {
  const fromArgs = (args.locations ?? []).map((location) => location.path);
  const fromResult = (parsed?.locations ?? []).map((location) => location.path);
  return [...new Set([...fromArgs, ...fromResult])];
}

function Content({ entry }: { entry: ToolContent }): React.JSX.Element | null {
  if (entry.type === "diff") {
    const diff = entry as Extract<ToolContent, { type: "diff" }>;
    return <Diff path={diff.path} oldText={diff.oldText ?? ""} newText={diff.newText} />;
  }

  if (entry.type === "content") {
    const text = (entry as { content?: { text?: string } }).content?.text;
    if (!text) return null;
    return (
      <pre
        className={`max-h-40 overflow-auto border-t border-neutral-200 px-2.5 py-1.5 text-[11px] whitespace-pre-wrap dark:border-neutral-800 ${mono}`}
      >
        {text}
      </pre>
    );
  }

  return null;
}

function parseResult(result: string | undefined): Result | null {
  if (result === undefined) return null;
  try {
    return JSON.parse(result) as Result;
  } catch {
    // A tool whose result is not ours to read still gets a card; it just has no body.
    return null;
  }
}

function label(state: string): string {
  return state === "in_progress" ? "running" : state;
}
