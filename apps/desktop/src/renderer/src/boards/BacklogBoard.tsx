import type { ChannelResponse } from "@aibuildos/ipc";
import { useCallback, useEffect, useState } from "react";
import { button, card, focusRing, mono, primary } from "../ui.js";
import { compose } from "../workspace/playbooks.js";
import { useBump, useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import { Column } from "./BoardTab.js";
import { type BoardArtifact, type BoardColumn, deriveBoard } from "./derive.js";

type Record_ = ChannelResponse<"project:record">;
type RecordArtifact = NonNullable<Record_["artifacts"]>[number];

/** The plan playbook a "Plan the selected work" press starts (ST-0027#AC-1): the active playbook
 * titled the way the standard bundle names it, falling back to the standard ID if a project retitled
 * it — honest about there being no registry, simple about how to find the one that matters. */
function findPlanPlaybook(artifacts: readonly RecordArtifact[]): RecordArtifact | undefined {
  const playbooks = artifacts.filter((a) => a.type === "Playbook" && a.state === "active");
  return (
    playbooks.find((p) => p.title === "Propose a plan") ?? playbooks.find((p) => p.id === "PB-0002")
  );
}

/** Every profile-legal move, unfiltered. Module scope: a fresh closure every render would sit in
 * `Card`'s fetch effect deps and refetch an open menu on any unrelated board re-render. */
const everyMove = (_current: string, states: string[]): string[] => states;
/** Every column takes a drop; the guarded save decides whether the move is legal. */
const alwaysDroppable = (): true => true;

/**
 * The Backlog board (RQ-0011#AC-1, AC-5): every Requirement, one column per state in the profile's
 * own order.
 *
 * Every profile-legal move is offered, drag or menu, and refused or not by the same guarded save the
 * editor uses — this board never pre-decides legality, it attempts the move and shows what the
 * validator says (RQ-0010's job, not this one's). That is also why post-`ready` states are draggable
 * here at all: requirements' states are set by hand in this project (okf-conventions §7 deviation 3).
 */
export function BacklogBoard({
  projectId,
  onOpen,
  onPrompt,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** Sends text into the conversation — the picking lane (ST-0027) wires the button that uses it. */
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  const revision = useRevision();
  const bump = useBump();
  const [record, setRecord] = useState<Record_ | null>(null);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; state: string } | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  /** Requirement IDs picked in the `ready` column (ST-0027#AC-1). Pruned to whatever is still there
   * on every render, so a requirement that moved out of `ready` cannot be planned from a stale tick. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [planning, setPlanning] = useState(false);

  // `revision` is not read in here — it *is* the trigger, the same rule every other rail follows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void Promise.all([
      window.aibuildos.invoke("project:record", { id: projectId }),
      window.aibuildos.invoke("project:artifact-types", { id: projectId }),
    ]).then(([nextRecord, kinds]) => {
      if (!live) return;
      setRecord(nextRecord);
      setVocabulary(kinds.types.find((entry) => entry.type === "Requirement")?.states ?? []);
    });
    return () => {
      live = false;
    };
  }, [projectId, revision]);

  const attemptMove = useCallback(
    (artifactId: string, state: string) => {
      void window.aibuildos
        .invoke("project:artifact-save", { id: projectId, artifactId, frontmatter: { state } })
        .then((result) => {
          setProblems((current) => {
            const next = { ...current };
            if (result.problem === null) delete next[artifactId];
            else next[artifactId] = result.problem;
            return next;
          });
          if (result.problem === null) bump();
        });
    },
    [projectId, bump],
  );

  if (record === null) return <p className="p-4 text-xs text-neutral-500">Loading…</p>;
  if (record.problem !== null) {
    return (
      <p data-testid="board-problem" className="p-4 text-xs text-red-600">
        {record.problem}
      </p>
    );
  }

  const draftWork = (record.artifacts ?? []).filter(
    (a) => (a.type === "Story" || a.type === "TestCase") && a.state === "draft",
  );

  const artifacts: BoardArtifact[] = (record.artifacts ?? [])
    .filter((a) => a.type === "Requirement")
    .map((a) => ({ id: a.id, type: a.type, title: a.title, state: a.state, priority: a.priority }));

  if (artifacts.length === 0) {
    return (
      <p data-testid="board-empty" className="p-4 text-xs text-neutral-500">
        Nothing on the list yet.
      </p>
    );
  }

  const columns = deriveBoard(artifacts, vocabulary).filter(
    (column) => showRetired || column.state !== "retired",
  );
  const readyColumn = columns.find((column) => column.state === "ready");
  const readyIds = new Set((readyColumn?.cards ?? []).map((c) => c.id));
  const picked = [...selected].filter((id) => readyIds.has(id));

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const planSelected = async (): Promise<void> => {
    const chosen = (readyColumn?.cards ?? []).filter((c) => picked.includes(c.id));
    const playbook = findPlanPlaybook(record.artifacts ?? []);
    if (chosen.length === 0 || playbook === undefined) return;

    setPlanning(true);
    try {
      const body = await window.aibuildos.invoke("project:artifact", {
        id: projectId,
        artifactId: playbook.id,
      });
      onPrompt(
        compose(
          body.body,
          chosen.map((c) => ({ id: c.id, title: c.title })),
        ),
      );
      setSelected(new Set());
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {draftWork.length > 0 && (
        <div
          data-testid="plan-banner"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5 text-xs dark:border-neutral-800 dark:bg-neutral-900"
        >
          <span>
            {draftWork.length} {draftWork.length === 1 ? "piece" : "pieces"} of proposed work{" "}
            {draftWork.length === 1 ? "is" : "are"} waiting for your review
          </span>
          <button
            type="button"
            data-testid="plan-banner-open"
            onClick={() => onOpen({ id: "plan", kind: "plan", title: "Plan" })}
            className={`${button} px-2 py-0.5 text-[11px]`}
          >
            Review the plan
          </button>
        </div>
      )}

      <div data-testid="board-columns" className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((column) =>
          column.state === "ready" ? (
            <ReadyColumn
              key={column.state}
              column={column}
              onOpen={onOpen}
              dragging={dragging}
              onDragStart={(id, state) => setDragging({ id, state })}
              onDragEnd={() => setDragging(null)}
              onMove={attemptMove}
              problems={problems}
              selected={picked}
              onToggle={toggle}
            />
          ) : (
            <Column
              key={column.state}
              column={column}
              projectId={projectId}
              onOpen={onOpen}
              dragging={dragging}
              onDragStart={(id, state) => setDragging({ id, state })}
              onDragEnd={() => setDragging(null)}
              canDrop={alwaysDroppable}
              filterMoves={everyMove}
              onMove={attemptMove}
              problems={problems}
            />
          ),
        )}
      </div>

      {picked.length > 0 && (
        <div
          data-testid="plan-footer"
          className="flex shrink-0 items-center gap-2 border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
        >
          <span className="text-[11px] text-neutral-500">{picked.length} picked</span>
          <button
            type="button"
            data-testid="plan-start"
            disabled={planning}
            onClick={() => void planSelected()}
            className={`${primary} px-2 py-0.5 text-[11px]`}
          >
            {planning ? "Sending…" : "Plan the selected work"}
          </button>
        </div>
      )}

      <div className="shrink-0 border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <button
          type="button"
          data-testid="board-show-retired"
          onClick={() => setShowRetired((current) => !current)}
          className={`text-[11px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
        >
          {showRetired ? "Hide retired" : "Show retired"}
        </button>
      </div>
    </div>
  );
}

/**
 * The `ready` column, with a checkbox per card (ST-0027#AC-1) — a fork of `Column`/`Card`, not a
 * reuse of them: neither is exported from `BoardTab.tsx`, which this story does not touch.
 *
 * ponytail: no "Move to…" menu here, unlike every other column — forking that too would mean
 * duplicating `project:artifact`'s move-fetching dance for one column. Drag still works, in and out,
 * since dragging is tracked by the parent board regardless of which column a card started in; add the
 * menu back by exporting `Card` from `BoardTab.tsx` if a mouse-only gap here turns out to matter.
 */
function ReadyColumn({
  column,
  onOpen,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  problems,
  selected,
  onToggle,
}: {
  column: BoardColumn;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  dragging: { id: string; state: string } | null;
  onDragStart: (id: string, state: string) => void;
  onDragEnd: () => void;
  onMove: (artifactId: string, state: string) => void;
  problems: Record<string, string>;
  selected: string[];
  onToggle: (id: string) => void;
}): React.JSX.Element {
  const droppable = dragging !== null && dragging.state !== "ready";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is mouse-only, matching every other column.
    <div
      data-testid="board-column-ready"
      onDragOver={(event) => {
        if (droppable) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (droppable) onMove(dragging.id, "ready");
      }}
      className="flex w-64 shrink-0 flex-col rounded border border-neutral-200 dark:border-neutral-800"
    >
      <div className="shrink-0 border-b border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800">
        <p className={`${mono} text-xs`}>
          {column.state} <span className="text-neutral-500">· {column.cards.length}</span>
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
        {column.cards.map((artifact) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is mouse-only; the checkbox and "Open" button below are the keyboard/screen-reader path.
          <div
            key={artifact.id}
            data-testid={`board-card-${artifact.id}`}
            draggable
            onDragStart={() => onDragStart(artifact.id, "ready")}
            onDragEnd={onDragEnd}
            className={`${card} ${dragging?.id === artifact.id ? "opacity-50" : ""}`}
          >
            <label className="mb-1 flex items-center gap-1.5 text-[11px] text-neutral-500">
              <input
                type="checkbox"
                data-testid={`plan-pick-${artifact.id}`}
                checked={selected.includes(artifact.id)}
                onChange={() => onToggle(artifact.id)}
              />
              Pick for planning
            </label>
            <button
              type="button"
              data-testid={`board-card-open-${artifact.id}`}
              onClick={() =>
                onOpen({ id: artifact.id, kind: "artifact", title: artifact.id }, { preview: true })
              }
              onDoubleClick={() =>
                onOpen(
                  { id: artifact.id, kind: "artifact", title: artifact.id },
                  { preview: false },
                )
              }
              className="block w-full text-left"
            >
              <span className="block truncate">{artifact.title}</span>
              <span className={`mt-0.5 block text-[11px] text-neutral-500 ${mono}`}>
                {artifact.id}
                {artifact.priority !== undefined ? ` · ${artifact.priority}` : ""}
              </span>
            </button>
            {problems[artifact.id] !== undefined && (
              <p
                data-testid={`board-refusal-${artifact.id}`}
                className="mt-1 text-[11px] text-red-600"
              >
                {problems[artifact.id]}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
