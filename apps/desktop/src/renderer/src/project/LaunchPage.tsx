import type { ChannelResponse } from "@aibuildos/ipc";
import { useCallback, useEffect, useState } from "react";
import {
  button,
  eyebrow,
  focusRing,
  middleTruncate,
  mono,
  primary,
  rail,
  relativeTime,
} from "../ui.js";
import { NewProjectDialog } from "./NewProjectDialog.js";

/**
 * The launch page (ST-0004): the ledger of projects, and the two ways to add one.
 *
 * A ledger of repositories rather than a grid of tiles, because in this product Git *is* the record.
 * Rows are hairline-separated and the whole informational area of a row is one control; the only
 * colour on the page is the status rail, which means a working tree with uncommitted work in it.
 *
 * The list is owned by the main process and read here at the point of use — never mirrored into the
 * store (DC-0005). Which project is *open* is the only part of this that is UI state.
 */
export type ProjectSummary = ChannelResponse<"project:list">[number];

export interface Projects {
  /** `null` until the first read lands. */
  projects: ProjectSummary[] | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Called **once**, by `App`, and passed down — the same rule `useHarnesses` follows.
 *
 * Every call is a `project:list`, and that runs a `git status` subprocess per registered project. Two
 * copies of this hook are two fans-out of that work, and two answers to "what branch is this on".
 */
export function useProjects(): Projects {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProjects(await window.aibuildos.invoke("project:list", undefined));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { projects, error, refresh };
}

export function LaunchPage({
  projects,
  error,
  refresh,
  onOpen,
}: Projects & { onOpen: (id: string) => void }): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Adopt a folder: one picker, then straight to registering it. There is nothing to name. */
  const addExisting = async (): Promise<void> => {
    setAdding(true);
    setProblem(null);
    try {
      const { path } = await window.aibuildos.invoke("project:choose-directory", {
        title: "Choose a project folder",
      });
      if (path === null) return; // Cancelled. Nothing happened, so say nothing.

      const result = await window.aibuildos.invoke("project:add", { path });
      if (result.ok) {
        await refresh();
        onOpen(result.project.id);
      } else {
        setProblem(result.message);
      }
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  const forget = async (id: string): Promise<void> => {
    try {
      await window.aibuildos.invoke("project:remove", { id });
      await refresh();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="flex w-full flex-col">
      <div className="flex items-start justify-between gap-6">
        <p className="text-sm text-neutral-500">Git is the record.</p>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            data-testid="project-new"
            className={`${primary} ${focusRing}`}
            onClick={() => setCreating(true)}
          >
            New project
          </button>
          <button
            type="button"
            data-testid="project-add"
            className={`${button} ${focusRing}`}
            onClick={() => void addExisting()}
            disabled={adding}
          >
            {adding ? "Adding…" : "Add existing"}
          </button>
        </div>
      </div>

      {(problem ?? error) && (
        <p data-testid="project-error" className="mt-4 text-xs text-red-600">
          {problem ?? error}
        </p>
      )}

      <div className="mt-6 border-t border-neutral-200 dark:border-neutral-800">
        {projects === null ? (
          <p className="py-4 text-sm text-neutral-500">Loading…</p>
        ) : projects.length === 0 ? (
          <p data-testid="project-empty" className="py-4 text-sm text-neutral-500">
            No projects yet. Create one, or add a folder you already have.
          </p>
        ) : (
          <ul>
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onOpen={() => onOpen(project.id)}
                onForget={() => void forget(project.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <Runtime />

      <NewProjectDialog
        open={creating}
        onClose={() => {
          setCreating(false);
          // A creation that failed part-way still registered the project, so the ledger has to be
          // re-read even when nothing was reported as created.
          void refresh();
        }}
        onCreated={(id) => {
          setCreating(false);
          void refresh();
          onOpen(id);
        }}
      />
    </section>
  );
}

/**
 * One row of the ledger.
 *
 * The informational area is the button — one target, not a row with a control revealed on hover.
 * Forget is a *separate* control in its own column rather than nested inside that button, which would
 * be invalid HTML and unreachable from the keyboard.
 */
function ProjectRow({
  project,
  onOpen,
  onForget,
}: {
  project: ProjectSummary;
  onOpen: () => void;
  onForget: () => void;
}): React.JSX.Element {
  const missing = !project.exists;
  const dirty = project.dirty !== null && project.dirty > 0;
  const state = missing ? "missing" : dirty ? "dirty" : "clean";

  return (
    <li
      data-testid="project-row"
      className="flex items-stretch border-b border-neutral-200 dark:border-neutral-800"
    >
      <span aria-hidden className={`w-0.5 shrink-0 ${rail(state)}`} />

      <button
        type="button"
        data-testid="project-open"
        disabled={missing}
        onClick={onOpen}
        className={`grid flex-1 grid-cols-[minmax(7rem,12rem)_1fr_auto] items-baseline gap-x-6 px-4 py-3 text-left transition-colors duration-100 hover:bg-neutral-50 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-neutral-900 ${focusRing}`}
      >
        <span className="truncate text-sm font-medium">{project.name}</span>

        <span className={`truncate text-xs text-neutral-500 ${mono}`} title={project.path}>
          {middleTruncate(project.path)}
        </span>

        <span className={`text-xs ${mono}`}>
          {missing ? (
            <span data-testid="project-missing" className="text-red-600">
              unavailable
            </span>
          ) : (
            <>
              <span className="text-neutral-500">{project.branch ?? "no branch"}</span>
              {/* Colour is never the only signal the rail carries. */}
              {dirty && <span className="ml-2 text-amber-600">{project.dirty} uncommitted</span>}
            </>
          )}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-4 pr-2">
        <span className={`text-xs text-neutral-500 ${mono}`}>
          {relativeTime(project.lastOpened)}
        </span>
        <button
          type="button"
          data-testid="project-forget"
          onClick={onForget}
          className={`${eyebrow} ${focusRing} rounded px-1 py-0.5 hover:text-neutral-900 dark:hover:text-neutral-100`}
        >
          Forget
        </button>
      </div>
    </li>
  );
}

/** What this app is running on. The front door is where that question gets asked. */
function Runtime(): React.JSX.Element {
  const [info, setInfo] = useState<ChannelResponse<"app:info"> | null>(null);

  useEffect(() => {
    void window.aibuildos.invoke("app:info", undefined).then(setInfo);
  }, []);

  return (
    <dl data-testid="runtime" className={`mt-6 flex gap-6 text-xs text-neutral-500 ${mono}`}>
      <div className="flex gap-2">
        <dt>node</dt>
        <dd>{info?.runtime.node ?? "…"}</dd>
      </div>
      <div className="flex gap-2">
        <dt>electron</dt>
        <dd>{info?.runtime.electron ?? "…"}</dd>
      </div>
    </dl>
  );
}
