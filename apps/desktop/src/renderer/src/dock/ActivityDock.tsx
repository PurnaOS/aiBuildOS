import type { ChannelResponse } from "@aibuildos/ipc";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHarnesses } from "../harness/HarnessPanel.js";
import { button, eyebrow, focusRing, mono, primary } from "../ui.js";
import { useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import {
  type BuildInfo,
  type BuildRow,
  deriveDock,
  describeActivity,
  elapsedLabel,
  needsYouCount,
  nextAction,
  type SessionInfo,
} from "./derive.js";
import { PermissionCard, type PermissionInfo } from "./PermissionCard.js";

type Record_ = ChannelResponse<"project:record">;
type OpenTab = (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;

/** The `name` a permission `CUSTOM` event carries — matches `Activity.tsx`'s own copy (the bridge's
 * vocabulary is main-only, DC-0017, so both keep their own name for the one event a renderer needs). */
const PERMISSION_EVENT = "acp.permission";
/** RQ-0021's stated ceiling — a number to raise deliberately, not one discovered under load. */
const CONCURRENCY_CAP = 3;

interface Live {
  readonly state: SessionInfo["state"];
  readonly activity: string | null;
  readonly lastEventAt: number | null;
}

/**
 * The activity dock (RQ-0044, ST-0062, DC-0027): Now's replacement, mounted once at the bottom of
 * every surface rather than behind a tab. Collapsed it is a 28px strip carrying one motion line, the
 * amber "N needs you" rollup and the next-action line; `Workspace.tsx` owns the resizable panel this
 * sits in and hands down whether it is `collapsed` right now — this component owns everything about
 * *what* to show, not how much room it gets.
 *
 * The derivation input is the session inventory (RQ-0044#AC-2), not `build:list` alone: `session:list`
 * plus `build:list` plus `project:record`, refetched on the shared `revision` the way every other rail
 * already does, and opportunistically the moment a `session:state` names a session not seen before —
 * a session appearing needs no file write to be worth showing.
 */
export function ActivityDock({
  projectId,
  onOpen,
  collapsed,
  onToggle,
}: {
  projectId: string;
  onOpen: OpenTab;
  collapsed: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const revision = useRevision();
  const { harnesses } = useHarnesses();
  const [sessionRows, setSessionRows] = useState<ChannelResponse<"session:list">["sessions"]>([]);
  const [builds, setBuilds] = useState<ChannelResponse<"build:list">["builds"]>([]);
  const [record, setRecord] = useState<Record_ | null>(null);
  const [live, setLive] = useState<Map<string, Live>>(new Map());
  const [permissions, setPermissions] = useState<Map<string, PermissionInfo>>(new Map());
  const [cancelled, setCancelled] = useState<Set<string>>(new Set());
  const [resuming, setResuming] = useState<Set<string>>(new Set());
  // A coarse clock for "42s ago" (RQ-0030#AC-2) — the same tick `NowTab` used.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const refetch = useCallback(async () => {
    const [sessions, buildList, nextRecord] = await Promise.all([
      window.aibuildos.invoke("session:list", {}),
      window.aibuildos.invoke("build:list", { projectId }),
      window.aibuildos.invoke("project:record", { id: projectId }),
    ]);
    setSessionRows(sessions.sessions.filter((session) => session.projectId === projectId));
    setBuilds(buildList.builds);
    setRecord(nextRecord);
  }, [projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a trigger, not a read
  useEffect(() => {
    void refetch();
  }, [refetch, revision]);

  const knownSessionIds = useMemo(
    () => new Set(sessionRows.map((session) => session.sessionId)),
    [sessionRows],
  );

  useEffect(() => {
    return window.aibuildos.subscribe("session:event", (payload) => {
      const event = payload.event as { type: string; name?: string; value?: unknown };
      const activity = event.type === "CUSTOM" ? (event.name ?? "CUSTOM") : event.type;

      setLive((current) => {
        const next = new Map(current);
        const existing = next.get(payload.sessionId) ?? {
          state: null,
          activity: null,
          lastEventAt: null,
        };
        next.set(payload.sessionId, { ...existing, activity, lastEventAt: Date.now() });
        return next;
      });

      if (event.type === "CUSTOM" && event.name === PERMISSION_EVENT) {
        setPermissions((current) => {
          const next = new Map(current);
          next.set(payload.sessionId, event.value as PermissionInfo);
          return next;
        });
      }

      // A turn that ends with a *live* request still open is nobody's to answer any more; one
      // hands-off already answered stays visible as a settled record (RQ-0022#AC-3), the same rule
      // `Activity.tsx` follows.
      if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
        setPermissions((current) => {
          const existing = current.get(payload.sessionId);
          if (existing === undefined || existing.automatic) return current;
          const next = new Map(current);
          next.delete(payload.sessionId);
          return next;
        });
      }
    });
  }, []);

  useEffect(() => {
    return window.aibuildos.subscribe("session:state", (payload) => {
      setLive((current) => {
        const next = new Map(current);
        const existing = next.get(payload.sessionId) ?? {
          state: null,
          activity: null,
          lastEventAt: null,
        };
        next.set(payload.sessionId, { ...existing, state: payload.state, lastEventAt: Date.now() });
        return next;
      });
      // A session this dock has never enumerated — starting one needs no file write to be worth
      // showing, unlike every other rail's trigger (ST-0015#AC-3's own `revision`).
      if (!knownSessionIds.has(payload.sessionId)) void refetch();
    });
  }, [knownSessionIds, refetch]);

  const sessions: SessionInfo[] = sessionRows.map((row) => {
    const info = live.get(row.sessionId);
    const permission = permissions.get(row.sessionId);
    return {
      sessionId: row.sessionId,
      projectId: row.projectId,
      storyId: row.storyId,
      label: row.label,
      startedAt: row.startedAt,
      state: info?.state ?? null,
      activity: info?.activity ?? null,
      lastEventAt: info?.lastEventAt ?? null,
      waiting: permission !== undefined && permission.automatic !== true,
    };
  });
  const buildInfos: BuildInfo[] = builds.map((build) => ({
    storyId: build.storyId,
    sessionId: build.sessionId,
    branch: build.branch,
    path: build.path,
    sprintId: build.sprintId,
    ahead: build.ahead,
    lastCheckpointAt: build.lastCheckpointAt,
  }));
  const titleOf = (id: string): string => record?.artifacts?.find((a) => a.id === id)?.title ?? id;
  const artifactStateOf = (id: string): string | undefined =>
    record?.artifacts?.find((a) => a.id === id)?.state;

  const derived = deriveDock(sessions, buildInfos, titleOf);
  const data = {
    ...derived,
    builds: derived.builds.map(
      (row): BuildRow =>
        row.sessionId !== null && cancelled.has(row.sessionId)
          ? { ...row, state: "cancelled" }
          : row,
    ),
  };
  const needsYou = needsYouCount(data);
  const action = nextAction(data, record?.artifacts ?? []);
  const busyCount = [data.main, ...data.builds, ...data.background].filter(
    (row) => row.state === "busy",
  ).length;

  const cancel = async (sessionId: string): Promise<void> => {
    setCancelled((current) => new Set(current).add(sessionId));
    await window.aibuildos.invoke("session:cancel", { sessionId });
  };

  const resume = async (storyId: string): Promise<void> => {
    const harnessId = harnesses?.[0]?.id;
    if (harnessId === undefined) return;
    setResuming((current) => new Set(current).add(storyId));
    try {
      await window.aibuildos.invoke("build:resume", { projectId, storyId, harnessId });
      await refetch();
    } finally {
      setResuming((current) => {
        const next = new Set(current);
        next.delete(storyId);
        return next;
      });
    }
  };

  const openSession = (sessionId: string, title: string): void =>
    onOpen({ id: `session:${sessionId}`, kind: "session", title }, { preview: false });

  return (
    <div data-testid="activity-dock" className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        data-testid="dock-collapsed"
        className="flex h-7 shrink-0 items-center gap-3 border-t border-neutral-200 px-3 dark:border-neutral-800"
      >
        <span
          data-testid="dock-motion"
          className="flex items-center gap-1.5 text-[11px] text-neutral-500"
        >
          {busyCount > 0 && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400" aria-hidden />
          )}
          {busyCount > 0 ? `${busyCount} running` : "quiet"}
        </span>

        {needsYou > 0 && (
          <span
            data-testid="now-badge"
            className="rounded-full bg-amber-500 px-1.5 text-[10px] font-medium text-white"
          >
            {needsYou} needs you
          </span>
        )}

        <span
          data-testid="dock-next-action-text"
          className="flex-1 truncate text-[11px] text-neutral-500"
        >
          {action.text}
        </span>
        <button
          type="button"
          data-testid="dock-next-action"
          onClick={() =>
            onOpen(action.action.open as Omit<Tab, "preview">, {
              preview: action.action.open.kind !== "session",
            })
          }
          className={`${button} ${focusRing} px-2 py-0.5 text-[11px]`}
        >
          {action.action.label}
        </button>

        <button
          type="button"
          data-testid="dock-toggle"
          aria-label={collapsed ? "Expand the activity dock" : "Collapse the activity dock"}
          onClick={onToggle}
          className={`text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
        >
          {collapsed ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
        </button>
      </div>

      {!collapsed && (
        <div data-testid="dock-expanded" className="min-h-0 flex-1 overflow-y-auto p-3">
          <section>
            <p className={eyebrow}>Builds — up to {CONCURRENCY_CAP} run at once</p>
            {data.builds.length === 0 ? (
              <p data-testid="now-empty" className="mt-1.5 text-xs text-neutral-500">
                Nothing is building right now.
              </p>
            ) : (
              <div className="mt-1.5 flex flex-col gap-2">
                {data.builds.map((row) => {
                  const permission =
                    row.sessionId === null ? undefined : permissions.get(row.sessionId);
                  const reviewReady = artifactStateOf(row.storyId) === "review";
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
                              onClick={() => openSession(row.sessionId as string, row.storyId)}
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
                          {row.sessionId === null && (
                            <button
                              type="button"
                              data-testid={`now-row-resume-${row.storyId}`}
                              disabled={resuming.has(row.storyId) || harnesses?.[0] === undefined}
                              onClick={() => void resume(row.storyId)}
                              className={`${button} ${focusRing} text-xs`}
                            >
                              {resuming.has(row.storyId) ? "Resuming…" : "Resume"}
                            </button>
                          )}
                          {reviewReady && (
                            <button
                              type="button"
                              data-testid={`now-row-review-${row.storyId}`}
                              onClick={() =>
                                onOpen({
                                  id: `review:${row.storyId}`,
                                  kind: "review",
                                  title: row.storyId,
                                })
                              }
                              className={`${primary} ${focusRing} text-xs`}
                            >
                              Review
                            </button>
                          )}
                        </div>
                      </div>

                      {row.branch !== "" && (
                        <p
                          data-testid={`now-row-worktree-${row.storyId}`}
                          className="mt-1 text-[11px] text-neutral-500"
                        >
                          Works in its own copy of the code —{" "}
                          <span className={mono}>{row.branch}</span>.
                        </p>
                      )}

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
                        <div className="mt-2 -mx-3 -mb-3">
                          <PermissionCard
                            sessionId={row.sessionId}
                            permission={permission}
                            wrapperTestId={`now-row-waiting-${row.storyId}`}
                            automaticTestId={`now-row-waiting-${row.storyId}-automatic`}
                            answerTestId={(optionId) => `now-row-answer-${row.storyId}-${optionId}`}
                            onAnswered={() =>
                              setPermissions((current) => {
                                const next = new Map(current);
                                next.delete(row.sessionId as string);
                                return next;
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="mt-4">
            <p className={eyebrow}>Main chat</p>
            <div data-testid="dock-main" className="mt-1.5 flex items-center justify-between gap-2">
              <span
                data-testid="dock-main-state"
                className={`text-xs ${data.main.needsYou ? "text-amber-600 dark:text-amber-500" : "text-neutral-500"}`}
              >
                {data.main.sessionId === null
                  ? "not started"
                  : data.main.needsYou
                    ? "waiting on you"
                    : (data.main.state ?? "starting")}
                {data.main.activity !== null &&
                  ` · ${describeActivity(data.main.activity)}${data.main.lastEventAt !== null ? ` · ${elapsedLabel(data.main.lastEventAt, clock)}` : ""}`}
              </span>
              <button
                type="button"
                data-testid="dock-main-open"
                onClick={() =>
                  onOpen({ id: "chat", kind: "chat", title: "Chat" }, { preview: false })
                }
                className={`${button} ${focusRing} text-xs`}
              >
                Open
              </button>
            </div>
          </section>

          <section className="mt-4">
            <p className={eyebrow}>Background runs</p>
            {data.background.length === 0 ? (
              <p className="mt-1.5 text-xs text-neutral-500">Nothing running in the background.</p>
            ) : (
              <div className="mt-1.5 flex flex-col gap-2">
                {data.background.map((row) => (
                  <div
                    key={row.sessionId}
                    data-testid={`dock-background-${row.sessionId}`}
                    className="flex items-center justify-between gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800"
                  >
                    <div>
                      <p className="text-sm">{row.label}</p>
                      <span
                        className={`text-xs ${row.needsYou ? "text-amber-600 dark:text-amber-500" : "text-neutral-500"}`}
                      >
                        {row.needsYou ? "waiting on you" : (row.state ?? "starting")}
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid={`dock-background-open-${row.sessionId}`}
                      onClick={() => openSession(row.sessionId, row.label)}
                      className={`${button} ${focusRing} text-xs`}
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Terminals: a placeholder header only — a concurrent lane's slot (RQ-0038), not this
              one's. Nothing renders below it until that lane fills it in. */}
          <section className="mt-4">
            <p data-testid="dock-section-terminals" className={eyebrow}>
              Terminals
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
