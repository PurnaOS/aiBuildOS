import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useState } from "react";
import { card, eyebrow, mono } from "../ui.js";
import type { Tab } from "../workspace/TabStrip.js";
import type { BoardColumn } from "./derive.js";

/**
 * One board column and its cards — shared by both boards (RQ-0011, RQ-0045#AC-2, ST-0064): the
 * difference between the Plan surface and the Work surface is entirely in the policy functions each
 * passes in, never in how a column or a card draws itself. Moved out of the old `BoardTab.tsx`, which
 * used to be the nested Backlog/Work strip both boards sat behind — that strip is gone (RQ-0045#AC-1),
 * this is what it left shared.
 */
export function Column({
  column,
  projectId,
  onOpen,
  dragging,
  onDragStart,
  onDragEnd,
  canDrop,
  filterMoves,
  onMove,
  problems,
  caption,
}: {
  column: BoardColumn;
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** The card currently being dragged, tracked here rather than read from `dataTransfer` — browsers
   * refuse to read drag data before `drop`, and this is the same window regardless. */
  dragging: { id: string; state: string } | null;
  onDragStart: (id: string, state: string) => void;
  onDragEnd: () => void;
  /** Whether a card in `cardState` may be dropped on this column. */
  canDrop: (cardState: string) => boolean;
  /** Narrows what `project:artifact` offers down to the moves this board lets a person choose. */
  filterMoves: (current: string, states: string[]) => string[];
  onMove: (artifactId: string, state: string) => void;
  /** Keyed by artifact ID: the refusal text from the last move attempted on that card. */
  problems: Record<string, string>;
  caption?: string | undefined;
}): React.JSX.Element {
  const droppable = dragging !== null && canDrop(dragging.state);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is mouse-only; each card's "Move to…" menu is the keyboard/screen-reader path to the same move.
    <div
      data-testid={`board-column-${column.state}`}
      onDragOver={(event) => {
        if (droppable) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (dragging !== null && canDrop(dragging.state) && dragging.state !== column.state) {
          onMove(dragging.id, column.state);
        }
      }}
      className="flex w-64 shrink-0 flex-col rounded border border-neutral-200 dark:border-neutral-800"
    >
      <div className="shrink-0 border-b border-neutral-200 px-2.5 py-1.5 dark:border-neutral-800">
        <p className={`${mono} text-xs`}>
          {column.state} <span className="text-neutral-500">· {column.cards.length}</span>
        </p>
        {caption !== undefined && <p className="mt-0.5 text-[10px] text-neutral-500">{caption}</p>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
        {column.cards.map((artifact) => (
          <Card
            key={artifact.id}
            artifact={artifact}
            projectId={projectId}
            onOpen={onOpen}
            dragging={dragging}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            filterMoves={filterMoves}
            onMove={onMove}
            problem={problems[artifact.id]}
          />
        ))}
      </div>
    </div>
  );
}

type ArtifactDetail = ChannelResponse<"project:artifact">;

function Card({
  artifact,
  projectId,
  onOpen,
  dragging,
  onDragStart,
  onDragEnd,
  filterMoves,
  onMove,
  problem,
}: {
  artifact: {
    id: string;
    type: string;
    title: string;
    state: string;
    priority?: string | undefined;
  };
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  dragging: { id: string; state: string } | null;
  onDragStart: (id: string, state: string) => void;
  onDragEnd: () => void;
  filterMoves: (current: string, states: string[]) => string[];
  onMove: (artifactId: string, state: string) => void;
  problem?: string | undefined;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moves, setMoves] = useState<string[] | null>(null);

  // The drag twin: fetched only when the menu opens, since `project:artifact` re-reads the whole
  // bundle — cheap for one gesture, not for one call per card on every render.
  useEffect(() => {
    if (!menuOpen) return;
    let live = true;
    setMoves(null);
    void window.aibuildos
      .invoke("project:artifact", { id: projectId, artifactId: artifact.id })
      .then((next: ArtifactDetail) => {
        if (!live) return;
        setMoves(
          filterMoves(
            artifact.state,
            next.states.filter((s) => s !== artifact.state),
          ),
        );
      });
    return () => {
      live = false;
    };
  }, [menuOpen, projectId, artifact.id, artifact.state, filterMoves]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is mouse-only; "Move to…" below is the keyboard/screen-reader path to every move dragging can make.
    <div
      data-testid={`board-card-${artifact.id}`}
      draggable
      onDragStart={() => onDragStart(artifact.id, artifact.state)}
      onDragEnd={onDragEnd}
      className={`${card} ${dragging?.id === artifact.id ? "opacity-50" : ""}`}
    >
      <button
        type="button"
        data-testid={`board-card-open-${artifact.id}`}
        onClick={() =>
          onOpen({ id: artifact.id, kind: "artifact", title: artifact.id }, { preview: true })
        }
        onDoubleClick={() =>
          onOpen({ id: artifact.id, kind: "artifact", title: artifact.id }, { preview: false })
        }
        className="block w-full"
      >
        <span className="block truncate">{artifact.title}</span>
        <span className={`mt-0.5 block text-[11px] text-neutral-500 ${mono}`}>
          {artifact.id}
          {artifact.priority !== undefined ? ` · ${artifact.priority}` : ""}
        </span>
      </button>

      <button
        type="button"
        data-testid={`board-card-menu-${artifact.id}`}
        onClick={() => setMenuOpen((open) => !open)}
        className={`mt-1 ${eyebrow} hover:text-neutral-900 dark:hover:text-neutral-100`}
      >
        Move to…
      </button>

      {menuOpen && (
        <div
          data-testid={`board-card-moves-${artifact.id}`}
          className="mt-1 flex flex-col items-start gap-0.5"
        >
          {moves === null ? (
            <span className="text-[11px] text-neutral-500">Loading…</span>
          ) : moves.length === 0 ? (
            <span className="text-[11px] text-neutral-500">Nothing to move to from here.</span>
          ) : (
            moves.map((state) => (
              <button
                key={state}
                type="button"
                data-testid={`board-card-move-${artifact.id}-${state}`}
                onClick={() => {
                  setMenuOpen(false);
                  onMove(artifact.id, state);
                }}
                className={`text-[11px] underline hover:text-neutral-900 dark:hover:text-neutral-100 ${mono}`}
              >
                {state}
              </button>
            ))
          )}
        </div>
      )}

      {problem !== undefined && (
        <p data-testid={`board-refusal-${artifact.id}`} className="mt-1 text-[11px] text-red-600">
          {problem}
        </p>
      )}
    </div>
  );
}
