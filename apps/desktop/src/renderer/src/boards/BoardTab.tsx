import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useState } from "react";
import { card, eyebrow, focusRing, mono } from "../ui.js";
import type { Tab } from "../workspace/TabStrip.js";
import { BacklogBoard } from "./BacklogBoard.js";
import type { BoardColumn } from "./derive.js";
import { WorkBoard } from "./WorkBoard.js";

/**
 * The Board tab (RQ-0011, ST-0024): Backlog and Work, behind the same switcher FilesRail uses for
 * files|git. Pinned beside Chat — nowhere else in the workspace shows the record's *shape*, only one
 * artifact at a time.
 */
export function BoardTab({
  projectId,
  onOpen,
  onPrompt,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** Sends text into the conversation as the user's own visible message — how "Plan the selected
   * work" speaks (RQ-0014#AC-1). Unused until the picking lane lands; threaded now so it does not
   * need a Workspace edit then. */
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  const [view, setView] = useState<"backlog" | "work">("backlog");

  return (
    <div data-testid="board-tab" className="flex h-full flex-col overflow-hidden">
      <div className="flex h-[34px] shrink-0 items-stretch border-b border-neutral-200 dark:border-neutral-800">
        {(["backlog", "work"] as const).map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`board-view-${name}`}
            data-active={view === name}
            onClick={() => setView(name)}
            className={`px-3.5 text-xs capitalize ${focusRing} ${
              view === name
                ? "font-medium shadow-[inset_0_-2px_0_currentColor]"
                : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      {view === "backlog" ? (
        <BacklogBoard projectId={projectId} onOpen={onOpen} onPrompt={onPrompt} />
      ) : (
        <WorkBoard projectId={projectId} onOpen={onOpen} onPrompt={onPrompt} />
      )}
    </div>
  );
}

type ArtifactDetail = ChannelResponse<"project:artifact">;

/**
 * One board column: a header (state name, plus why it refuses drops when it does), and its cards in
 * derived order. Shared by both boards — the difference between them is entirely in the policy
 * functions each passes in, never in how a column draws itself.
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
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is mouse-only; "Move to…" below is the keyboard/screen-reader twin for every move dragging can make.
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
