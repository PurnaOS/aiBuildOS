import type { ChannelResponse } from "@aibuildos/ipc";
import { useCallback, useEffect, useState } from "react";
import { focusRing } from "../ui.js";
import { useBump, useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import { Column } from "./BoardTab.js";
import { type BoardArtifact, deriveBoard } from "./derive.js";

type Record_ = ChannelResponse<"project:record">;

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

  const artifacts: BoardArtifact[] = (record.artifacts ?? [])
    .filter((a) => a.type === "Requirement")
    .map((a) => ({ id: a.id, type: a.type, title: a.title, state: a.state }));

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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div data-testid="board-columns" className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((column) => (
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
        ))}
      </div>
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
