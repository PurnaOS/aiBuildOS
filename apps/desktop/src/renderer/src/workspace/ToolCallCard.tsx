import { Eye, FileDiff, Pencil, Search, Terminal, Trash2, Wrench } from "lucide-react";
import { eyebrow, mono } from "../ui.js";
import { Diff } from "./Diff.js";

/**
 * One tool call, drawn where it happened in the conversation (ST-0011).
 *
 * Registered as CopilotKit's wildcard tool renderer, so it draws whatever the agent ran without a
 * component per tool — an agent's tool names are its own and are not known in advance.
 *
 * The left rule carries status and the word beside it says the same thing, because a colour is not
 * a signal to everyone.
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

  const Icon = ICONS[args.kind ?? ""] ?? Wrench;
  const rule = failed
    ? "bg-red-600"
    : running
      ? "bg-amber-500"
      : "bg-neutral-200 dark:bg-neutral-800";

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
            {label(state)}
          </span>
        </div>

        {parsed?.content?.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the agent sends an ordered list, not keyed items.
          <Content key={`${entry.type}-${index}`} entry={entry} />
        ))}

        {parsed === null && (args.locations?.length ?? 0) > 0 && (
          <p className={`px-2.5 pb-1.5 text-[11px] text-neutral-500 ${mono}`}>
            {args.locations?.map((location) => location.path).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
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
