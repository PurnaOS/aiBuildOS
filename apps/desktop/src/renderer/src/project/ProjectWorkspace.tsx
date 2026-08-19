import type { ChannelResponse } from "@aibuildos/ipc";
import { useCallback, useEffect, useState } from "react";
import { button, eyebrow, mono, rail, relativeTime } from "../ui.js";

/**
 * The project view (ST-0005): where the repository stands, and what its record contains.
 *
 * Bands separated by hairlines, not cards. Two independent readings of the same directory — Git and
 * the OKF record — and either can be absent without the other failing.
 */
type Snapshot = ChannelResponse<"project:open">;

export function ProjectWorkspace({
  id,
  onRefreshed,
}: {
  id: string;
  /** Re-read the project list too, so the sidebar's branch does not go stale behind this view. */
  onRefreshed: () => void;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot(await window.aibuildos.invoke("project:open", { id }));
      setError(null);
      onRefreshed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }, [id, onRefreshed]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error !== null) {
    return (
      <p data-testid="workspace-error" className="text-sm text-red-600">
        {error}
      </p>
    );
  }
  if (snapshot === null) return <p className="text-sm text-neutral-500">Loading…</p>;

  const { project, exists, git, gitError, record, recordError } = snapshot;
  const changed = git === null ? 0 : git.staged + git.unstaged + git.untracked + git.conflicted;
  const state = !exists ? "missing" : changed > 0 ? "dirty" : "clean";

  return (
    <section data-testid="workspace" className="w-full max-w-3xl">
      <div className="flex items-start gap-4">
        <span aria-hidden className={`mt-1 w-0.5 self-stretch ${rail(state)}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-4">
            <h2 data-testid="workspace-name" className="text-lg font-semibold tracking-tight">
              {project.name}
            </h2>
            <span data-testid="workspace-branch" className={`shrink-0 text-xs ${mono}`}>
              {git === null ? "—" : (git.branch ?? "detached HEAD")}
            </span>
          </div>
          <p className={`truncate text-xs text-neutral-500 ${mono}`} title={project.path}>
            {project.path}
          </p>
        </div>
      </div>

      {!exists && (
        <p data-testid="workspace-missing" className="mt-4 text-sm text-red-600">
          This folder is not there any more. Forget the project from the launch page, or put the
          folder back.
        </p>
      )}

      {gitError && (
        <p data-testid="workspace-git-error" className="mt-4 text-sm text-red-600">
          {gitError.message}
        </p>
      )}

      {git && (
        <>
          <Band>
            {changed === 0 ? (
              <p data-testid="workspace-clean" className="text-sm text-neutral-500">
                Working tree clean.
              </p>
            ) : (
              <dl data-testid="workspace-counts" className="flex flex-wrap gap-x-10 gap-y-2">
                <Count label="staged" value={git.staged} />
                <Count label="unstaged" value={git.unstaged} />
                <Count label="untracked" value={git.untracked} />
                {git.conflicted > 0 && <Count label="conflicted" value={git.conflicted} />}
              </dl>
            )}
          </Band>

          <Band>
            <p className={eyebrow}>Recent</p>
            {git.commits.length === 0 ? (
              <p data-testid="workspace-no-commits" className="mt-2 text-sm text-neutral-500">
                No commits yet.
              </p>
            ) : (
              <ul data-testid="workspace-commits" className="mt-2 flex flex-col gap-1">
                {git.commits.map((commit) => (
                  <li key={commit.hash} className="flex items-baseline gap-4 text-xs">
                    <span className={`shrink-0 text-neutral-500 ${mono}`}>{commit.hash}</span>
                    <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                    <span className={`shrink-0 text-neutral-500 ${mono}`}>
                      {relativeTime(commit.date)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Band>
        </>
      )}

      <Band>
        <p className={eyebrow}>The record</p>
        {recordError ? (
          <p data-testid="workspace-record-error" className="mt-2 text-sm text-red-600">
            {recordError.message}
          </p>
        ) : record === null ? (
          <p data-testid="workspace-no-record" className="mt-2 text-sm text-neutral-500">
            No OKF bundle in this project.
          </p>
        ) : record.artifacts === 0 ? (
          <p data-testid="workspace-record" className="mt-2 text-sm text-neutral-500">
            {/* An empty bundle is the correct state for a new project, not a failure. */}
            No artifacts yet — {record.indexes} indexes ready for the first requirement.
          </p>
        ) : (
          <div data-testid="workspace-record" className="mt-2 flex flex-col gap-1 text-xs">
            <p className={mono}>{tally(record.byType)}</p>
            <p className={`text-neutral-500 ${mono}`}>{tally(record.byState)}</p>
            {record.parseErrors > 0 && (
              <p className="text-amber-600">
                {record.parseErrors} {record.parseErrors === 1 ? "artifact" : "artifacts"} would not
                parse.
              </p>
            )}
          </div>
        )}
      </Band>

      <div className="mt-6">
        <button
          type="button"
          data-testid="workspace-refresh"
          className={button}
          onClick={() => void load()}
          disabled={refreshing}
        >
          {refreshing ? "Reading…" : "Refresh"}
        </button>
      </div>
    </section>
  );
}

function Band({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mt-6 border-t border-neutral-200 pt-6 dark:border-neutral-800">{children}</div>
  );
}

function Count({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className={eyebrow}>{label}</dt>
      <dd className={`text-sm ${mono}`}>{value}</dd>
    </div>
  );
}

/** `RQ 2 · ST 5 · TC 9` — the record's own vocabulary, in the order the bundle reports it. */
function tally(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key} ${value}`).join(" · ");
}
