import type { ChannelResponse } from "@aibuildos/ipc";
import { useCallback, useEffect, useState } from "react";
import { focusRing } from "../ui.js";
import { useBump, useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import { Column } from "./BoardTab.js";
import { type BoardArtifact, deriveBoard, mergeVocabularies } from "./derive.js";

type Record_ = ChannelResponse<"project:record">;

/** The states a person owns on this board (RQ-0011#AC-6): verdicts on `review` work, plus retirement
 * from anywhere. Every other transition — including the builders' own `ready → queued → building` —
 * is written by the builder, never dragged or menu'd here. */
const BUILDER_COLUMNS = new Set(["ready", "queued", "building"]);
const REVIEW_VERDICTS = new Set(["accepted", "building", "rejected", "retired"]);

function humanMoves(current: string, states: string[]): string[] {
  if (current === "review") return states.filter((s) => REVIEW_VERDICTS.has(s));
  return states.filter((s) => s === "retired");
}

/**
 * The Work board (RQ-0011#AC-6): Stories and Bugs on one board, one column per state — Story's and
 * Bug's vocabularies are identical today, merged in case they ever diverge.
 *
 * Drop targets exist only for `review → accepted` and `review → rejected`: sending work back and
 * retiring stay menu-only, since a card landing in a builder's column by drag would write a fact
 * nobody made true.
 */
export function WorkBoard({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
}): React.JSX.Element {
  const revision = useRevision();
  const bump = useBump();
  const [record, setRecord] = useState<Record_ | null>(null);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; state: string } | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});

  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void Promise.all([
      window.aibuildos.invoke("project:record", { id: projectId }),
      window.aibuildos.invoke("project:artifact-types", { id: projectId }),
    ]).then(([nextRecord, kinds]) => {
      if (!live) return;
      setRecord(nextRecord);
      const of = (name: string): string[] =>
        kinds.types.find((entry) => entry.type === name)?.states ?? [];
      setVocabulary(mergeVocabularies(of("Story"), of("Bug")));
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
    .filter((a) => a.type === "Story" || a.type === "Bug")
    .map((a) => ({ id: a.id, type: a.type, title: a.title, state: a.state }));

  if (artifacts.length === 0) {
    return (
      <p data-testid="board-empty" className="p-4 text-xs text-neutral-500">
        No work planned yet. Pick requirements on the Backlog and ask for a plan.
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
            canDrop={(cardState) =>
              cardState === "review" && (column.state === "accepted" || column.state === "rejected")
            }
            filterMoves={humanMoves}
            onMove={attemptMove}
            problems={problems}
            caption={BUILDER_COLUMNS.has(column.state) ? "moved by the builder" : undefined}
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
