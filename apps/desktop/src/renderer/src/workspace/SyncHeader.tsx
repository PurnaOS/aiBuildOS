import type { ChannelResponse } from "@aibuildos/ipc";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { eyebrow, focusRing, mono } from "../ui.js";
import { useBump, useRevision } from "./revision.js";

/**
 * The sync header atop the FilesRail git pane (RQ-0033#AC-1, ST-0050) and, beneath it, the PR chip
 * (RQ-0034, ST-0051).
 *
 * Reads `project:branches` — the one call that carries both the current branch's ahead/behind and
 * every local branch's, so the header and the branch menu never disagree (RQ-0033#AC-2). No separate
 * "current status" read exists on this channel set: `project:changes` does not carry ahead/behind,
 * and the one response that does (`project:open`'s `GitStatus`) is the launch-time snapshot, not a
 * channel this pane can re-poll — `project:branches` covers both jobs this header has.
 *
 * Re-read on mount and whenever the shared revision moves — the watcher already sees `.git/refs`
 * (DC-0023), so a push or pull from a terminal reaches this header exactly as it reaches every other
 * rail. A press *in* this header also calls `bump()` directly rather than waiting on the watcher's
 * debounce, the same convention `CommitBar` already follows.
 */
type Branches = ChannelResponse<"project:branches">;
type BranchInfo = Branches["branches"][number];

/**
 * "↑2 ↓0" for a branch with an upstream, "not published" for one without (RQ-0033#AC-3). Both counts
 * are always shown together once present — a behind of 0 is still a fact, not something to hide.
 */
export function formatSync(ahead: number | null, behind: number | null): string {
  if (ahead === null || behind === null) return "not published";
  return `↑${ahead} ↓${behind}`;
}

// gh's check-run `conclusion` is uppercase; its legacy commit-status `state` is lowercase — matched
// case-insensitively so "success" and "SUCCESS" land in the same bucket.
const PASSING = new Set(["SUCCESS"]);
const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);

/** "3 passing, 1 failing" — the PR chip's compact checks summary. `null` for no checks at all: the
 * chip renders that as nothing, never "0 passing". */
export function summarizeChecks(checks: { name: string; status: string }[]): string | null {
  if (checks.length === 0) return null;
  let passing = 0;
  let failing = 0;
  for (const check of checks) {
    const status = check.status.toUpperCase();
    if (PASSING.has(status)) passing += 1;
    else if (FAILING.has(status)) failing += 1;
  }
  const pending = checks.length - passing - failing;
  const parts: string[] = [];
  if (passing > 0) parts.push(`${passing} passing`);
  if (failing > 0) parts.push(`${failing} failing`);
  if (pending > 0) parts.push(`${pending} pending`);
  return parts.join(", ");
}

/** The PR's number, read out of its URL (`.../pull/123` → `"123"`). `gh pr view --json` was never
 * asked for a `number` field — the URL already carries it, so nothing new needs asking main for. */
export function prNumber(url: string): string | null {
  return url.match(/\/pull\/(\d+)/)?.[1] ?? null;
}

export function SyncHeader({ projectId }: { projectId: string }): React.JSX.Element {
  const [data, setData] = useState<Branches | null>(null);
  const [busy, setBusy] = useState<"push" | "pull" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const revision = useRevision();
  const bump = useBump();

  // `revision` is not read in here — it *is* the trigger, exactly as GitChanges' own effect treats
  // it: the watcher moved something, and re-reading is the whole point of depending on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void window.aibuildos.invoke("project:branches", { id: projectId }).then((next) => {
      if (live) setData(next);
    });
    return () => {
      live = false;
    };
  }, [projectId, revision]);

  const run = useCallback(
    async (kind: "push" | "pull") => {
      setBusy(kind);
      setProblem(null);
      try {
        const result =
          kind === "push"
            ? await window.aibuildos.invoke("project:push", { id: projectId })
            : await window.aibuildos.invoke("project:pull", { id: projectId });
        if (!result.ok) {
          // The backend already carries a friendly lead for the coded failures (`git_auth`,
          // `no_remote`) baked into `message` — git's own words for everything else. Nothing to
          // re-map here.
          setProblem(result.message);
          return;
        }
        bump();
      } finally {
        setBusy(null);
      }
    },
    [projectId, bump],
  );

  if (data === null) {
    return (
      <div
        data-testid="sync-header"
        className="h-[30px] shrink-0 border-b border-neutral-200 dark:border-neutral-800"
      />
    );
  }

  if (data.problem !== null) {
    return (
      <div
        data-testid="sync-header"
        className="shrink-0 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
      >
        <p data-testid="sync-header-problem" className="text-xs text-red-600">
          {data.problem}
        </p>
      </div>
    );
  }

  const current = data.branches.find((branch) => branch.name === data.current) ?? null;

  return (
    <div
      data-testid="sync-header"
      className="flex shrink-0 flex-col border-b border-neutral-200 dark:border-neutral-800"
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <BranchMenu current={data.current} branches={data.branches} />
        <span data-testid="sync-counts" className={`shrink-0 ${mono} text-neutral-500`}>
          {current !== null ? formatSync(current.ahead, current.behind) : "not published"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="sync-push"
          disabled={busy !== null}
          onClick={() => void run("push")}
          className={`rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800 ${focusRing}`}
        >
          Push
        </button>
        <button
          type="button"
          data-testid="sync-pull"
          disabled={busy !== null}
          onClick={() => void run("pull")}
          className={`rounded border border-neutral-300 px-2 py-0.5 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800 ${focusRing}`}
        >
          Pull
        </button>
      </div>
      {problem !== null && (
        <p
          data-testid="sync-error"
          className="px-3 pb-1.5 text-[11px] whitespace-pre-wrap text-red-600"
        >
          {problem}
        </p>
      )}
      <PrChip projectId={projectId} />
    </div>
  );
}

/**
 * The branch menu: every local branch, name/upstream/ahead-behind, the current one marked. There is
 * no `checkout` channel (switching branches is not in scope here), so this is deliberately a
 * **non-interactive list** — rows, not buttons — rather than a menu that looks like it can switch and
 * quietly does nothing.
 */
function BranchMenu({
  current,
  branches,
}: {
  current: string | null;
  branches: BranchInfo[];
}): React.JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-testid="sync-branch"
          className={`flex min-w-0 items-center gap-1 rounded px-1 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${focusRing}`}
        >
          <span className="shrink-0 text-neutral-400" aria-hidden="true">
            ⎇
          </span>
          <span className={`truncate font-medium ${mono}`}>{current ?? "no branch"}</span>
          <ChevronDown size={10} className="shrink-0 text-neutral-400" aria-hidden="true" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          data-testid="sync-branch-menu"
          align="start"
          sideOffset={4}
          className="z-20 max-h-64 w-72 overflow-auto rounded border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
        >
          <p className={`${eyebrow} px-2 py-1`}>Local branches</p>
          {branches.map((branch) => (
            <div
              key={branch.name}
              data-testid="sync-branch-row"
              data-current={branch.name === current}
              className={`flex items-center gap-2 px-2 py-1 text-xs ${
                branch.name === current ? "font-medium" : ""
              }`}
            >
              <span className={`min-w-0 flex-1 truncate ${mono}`}>{branch.name}</span>
              <span className={`min-w-0 shrink truncate ${mono} text-neutral-500`}>
                {branch.upstream ?? "not published"}
              </span>
              <span className={`shrink-0 ${mono} text-neutral-500`}>
                {formatSync(branch.ahead, branch.behind)}
              </span>
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type PrResult = ChannelResponse<"project:pr-status">;

/**
 * The PR chip (RQ-0034, ST-0051): fetched on demand only — once when this mounts (which is the git
 * view's own first render, since `SyncHeader` only ever exists inside FilesRail's `git` tab) and
 * again only on the refresh press. No poll, no timer (RQ-0034#AC-3).
 *
 * There is no shell-open channel in this contract, so a PR's URL is rendered as selectable text
 * rather than a link that would silently do nothing in Electron's sandboxed renderer.
 */
function PrChip({ projectId }: { projectId: string }): React.JSX.Element {
  const [result, setResult] = useState<PrResult | null>(null);

  const load = useCallback(async () => {
    const next = await window.aibuildos.invoke("project:pr-status", { id: projectId });
    setResult(next);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const number = result?.ok === true ? prNumber(result.url) : null;
  const checks = result?.ok === true ? summarizeChecks(result.checks) : null;

  return (
    <div className="flex items-center gap-1.5 border-t border-neutral-100 px-3 py-1 text-[11px] dark:border-neutral-900">
      {result?.ok === true && (
        <div
          data-testid="pr-chip"
          className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5"
        >
          <span className="font-medium">
            {number !== null ? `PR #${number}` : "PR"} · {result.state.toLowerCase()}
          </span>
          <span className="text-neutral-500">{result.mergeable.toLowerCase()}</span>
          {result.reviewDecision !== null && (
            <span className="text-neutral-500">
              {result.reviewDecision.toLowerCase().replaceAll("_", " ")}
            </span>
          )}
          {checks !== null && <span className={`${mono} text-neutral-500`}>{checks}</span>}
          <span
            data-testid="pr-url"
            className={`min-w-0 truncate select-text ${mono} text-neutral-400`}
            title={result.url}
          >
            {result.url}
          </span>
        </div>
      )}
      {result?.ok === false && result.code === "gh_missing" && (
        <p data-testid="pr-gh-missing" className="min-w-0 flex-1 truncate text-neutral-400">
          {result.message}
        </p>
      )}
      {(result === null || (result.ok === false && result.code !== "gh_missing")) && (
        <span className="flex-1" />
      )}
      <button
        type="button"
        data-testid="pr-refresh"
        title="Check PR status"
        onClick={() => void load()}
        className={`shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 ${focusRing}`}
      >
        <RefreshCw size={11} aria-hidden="true" />
      </button>
    </div>
  );
}
