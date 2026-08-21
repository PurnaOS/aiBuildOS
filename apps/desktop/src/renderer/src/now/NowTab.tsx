import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useState } from "react";
import { button, eyebrow, focusRing, mono, primary } from "../ui.js";
import { useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import { setNowBadge } from "./badge.js";
import {
  deriveNow,
  describeActivity,
  elapsedLabel,
  emptyMessage,
  type LiveSession,
  needsYouCount,
} from "./now.js";

type Record_ = ChannelResponse<"project:record">;
type BuildRow = ChannelResponse<"build:list">["builds"][number];

/** The `name` a permission `CUSTOM` event carries (matches `Activity.tsx`'s own local copy — the
 * bridge's vocabulary is main-only, DC-0017, so both keep their own name for the one event a
 * renderer component needs to recognise). */
const PERMISSION = "acp.permission";

interface Permission {
  requestId: string;
  toolCall?: { title?: string };
  options: { optionId: string; name: string; kind?: string }[];
}

/** RQ-0021's stated ceiling — a number to raise deliberately, not one discovered under load. */
const CONCURRENCY_CAP = 3;

/**
 * Now: every running build, live, and what waits on a person (RQ-0021, ST-0038).
 *
 * Pinned, so it is always mounted — which used to be why the turn-end half of the build/review walk
 * for a *worktree* build lived here rather than in `useTurnEnd.ts`: that hook watches only the main
 * chat session, and a build session's stream never reached it. ST-0041 moved the flip into main
 * instead — `builds.ts`'s own turn-end hook performs it against the build's own project through the
 * same guarded edit the save handler uses, whether or not this tab, or any window, is even open
 * (BG-0007). What is left here is VIEW state only: which permission is waiting, what a session is
 * doing right now, cleared once its turn ends because nobody can still answer a question that turn
 * already closed — never written back to the record.
 */
export function NowTab({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
}): React.JSX.Element {
  const revision = useRevision();
  const [builds, setBuilds] = useState<BuildRow[]>([]);
  const [record, setRecord] = useState<Record_ | null>(null);
  const [sessions, setSessions] = useState<Map<string, Omit<LiveSession, "waiting">>>(new Map());
  const [permissions, setPermissions] = useState<Map<string, Permission>>(new Map());
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());
  const [answering, setAnswering] = useState<string | null>(null);
  // A coarse clock for "42s ago" (RQ-0030#AC-2): nothing here needs the exact second, only enough
  // ticks that a row's elapsed time is not frozen at whenever this component last happened to render.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void Promise.all([
      window.aibuildos.invoke("build:list", { projectId }),
      window.aibuildos.invoke("project:record", { id: projectId }),
    ]).then(([nextBuilds, nextRecord]) => {
      if (!live) return;
      setBuilds(nextBuilds.builds);
      setRecord(nextRecord);
    });
    return () => {
      live = false;
    };
  }, [projectId, revision]);

  useEffect(() => {
    return window.aibuildos.subscribe("session:event", (payload) => {
      const event = payload.event as { type: string; name?: string; value?: unknown };
      const activity = event.type === "CUSTOM" ? (event.name ?? "CUSTOM") : event.type;

      setSessions((current) => {
        const next = new Map(current);
        const existing = next.get(payload.sessionId) ?? {
          state: null,
          activity: null,
          lastEventAt: null,
        };
        next.set(payload.sessionId, { ...existing, activity, lastEventAt: Date.now() });
        return next;
      });

      if (event.type === "CUSTOM" && event.name === PERMISSION) {
        const value = event.value as Permission & { automatic?: boolean };
        setPermissions((current) => {
          const next = new Map(current);
          if (value.automatic) next.delete(payload.sessionId);
          else next.set(payload.sessionId, value);
          return next;
        });
      }

      if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
        // A turn that ends with a request still open is nobody's to answer any more. VIEW state
        // only — the flip this used to chase down through `session:list` now happens in main,
        // against the build's own project, whether or not this component exists at all (ST-0041).
        setPermissions((current) => {
          if (!current.has(payload.sessionId)) return current;
          const next = new Map(current);
          next.delete(payload.sessionId);
          return next;
        });
      }
    });
  }, []);

  useEffect(() => {
    return window.aibuildos.subscribe("session:state", (payload) => {
      setSessions((current) => {
        const next = new Map(current);
        const existing = next.get(payload.sessionId) ?? {
          state: null,
          activity: null,
          lastEventAt: null,
        };
        next.set(payload.sessionId, { ...existing, state: payload.state, lastEventAt: Date.now() });
        return next;
      });
    });
  }, []);

  const withWaiting = new Map(
    [...sessions.entries()].map(([id, info]) => [id, { ...info, waiting: permissions.has(id) }]),
  );
  const rows = deriveNow(
    builds,
    withWaiting,
    (id) => record?.artifacts?.find((a) => a.id === id)?.title ?? id,
  ).map((row) =>
    row.sessionId !== null && cancelled.has(row.sessionId) ? { ...row, state: "cancelled" } : row,
  );
  const needsYou = needsYouCount(rows);

  useEffect(() => {
    setNowBadge(needsYou);
  }, [needsYou]);
  // Only on unmount — a badge reset on every render would fight the effect above every commit.
  useEffect(() => () => setNowBadge(0), []);

  const cancel = async (sessionId: string): Promise<void> => {
    setCancelled((current) => new Set(current).add(sessionId));
    await window.aibuildos.invoke("session:cancel", { sessionId });
  };

  const answer = async (
    sessionId: string,
    requestId: string,
    optionId: string | null,
  ): Promise<void> => {
    setAnswering(sessionId);
    try {
      await window.aibuildos.invoke("session:permission", { sessionId, requestId, optionId });
    } finally {
      setAnswering(null);
    }
  };

  return (
    <div data-testid="now-tab" className="flex h-full min-h-0 flex-col overflow-auto p-4">
      <p className={eyebrow}>Up to {CONCURRENCY_CAP} builds run at once</p>

      {rows.length === 0 ? (
        <p data-testid="now-empty" className="mt-3 text-sm text-neutral-500">
          {emptyMessage(record?.artifacts ?? [])}
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {rows.map((row) => {
            const permission = row.sessionId === null ? undefined : permissions.get(row.sessionId);
            return (
              <div
                key={row.storyId}
                data-testid={`now-row-${row.storyId}`}
                className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className={`${mono} text-xs text-neutral-500`}>{row.storyId}</p>
                    <p className="text-sm font-medium">{row.title}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      data-testid={`now-row-state-${row.storyId}`}
                      className={`text-xs ${row.needsYou ? "text-amber-600 dark:text-amber-500" : "text-neutral-500"}`}
                    >
                      {row.state}
                    </span>
                    {row.sessionId !== null && (
                      <button
                        type="button"
                        data-testid={`now-row-open-${row.storyId}`}
                        onClick={() =>
                          onOpen(
                            { id: `session:${row.sessionId}`, kind: "session", title: row.storyId },
                            { preview: false },
                          )
                        }
                        className={`${button} ${focusRing} text-xs`}
                      >
                        Open
                      </button>
                    )}
                    {row.sessionId !== null && (
                      <button
                        type="button"
                        data-testid={`now-row-cancel-${row.storyId}`}
                        onClick={() => void cancel(row.sessionId as string)}
                        className={`${button} ${focusRing} text-xs`}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                {/* `build:list` (`builds.ts`'s `listBuilds`) only ever names worktree branches, so
                    every row here already has an answer to "where are my files" (RQ-0030#AC-4). */}
                <p
                  data-testid={`now-row-worktree-${row.storyId}`}
                  className="mt-1 text-[11px] text-neutral-500"
                >
                  Works in its own copy of the code — <span className={mono}>{row.branch}</span>.
                </p>

                {row.activity !== null && (
                  <p
                    data-testid={`now-row-activity-${row.storyId}`}
                    className="mt-1.5 text-xs text-neutral-500"
                  >
                    {describeActivity(row.activity)}
                    {row.lastEventAt !== null && ` · ${elapsedLabel(row.lastEventAt, clock)}`}
                  </p>
                )}

                {permission !== undefined && row.sessionId !== null && (
                  <div data-testid={`now-row-waiting-${row.storyId}`} className="mt-2">
                    <p className="text-xs text-amber-700 dark:text-amber-500">
                      {permission.toolCall?.title ?? "The agent needs permission."}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {permission.options.map((option, index) => (
                        <button
                          key={option.optionId}
                          type="button"
                          data-testid={`now-row-answer-${row.storyId}-${option.optionId}`}
                          disabled={answering === row.sessionId}
                          onClick={() =>
                            void answer(
                              row.sessionId as string,
                              permission.requestId,
                              option.optionId,
                            )
                          }
                          className={`${index === 0 ? primary : button} ${focusRing} text-xs`}
                        >
                          {option.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
