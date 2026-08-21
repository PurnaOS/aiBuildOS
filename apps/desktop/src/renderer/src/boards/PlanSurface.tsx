import type { ChannelResponse } from "@aibuildos/ipc";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useState } from "react";
import { Loading } from "../Loading.js";
import { approve, describeApproval, flipsFor, type SaveFn } from "../plan/approve.js";
import { derivePlan, type PlanDraft, type PlanGroup, type PlanStory } from "../plan/derive.js";
import { button, card, eyebrow, focusRing, mono, primary } from "../ui.js";
import { splitBody } from "../workspace/ArtifactTab.js";
import { compose } from "../workspace/playbooks.js";
import { useBump, useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import { Column } from "./Column.js";
import { type BoardArtifact, type BoardColumn, deriveBoard } from "./derive.js";

type Record_ = ChannelResponse<"project:record">;
type RecordArtifact = NonNullable<Record_["artifacts"]>[number];
type OpenTab = (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;

/** The plan playbook a "Plan the selected work" press starts (ST-0027#AC-1). */
function findPlanPlaybook(artifacts: readonly RecordArtifact[]): RecordArtifact | undefined {
  const playbooks = artifacts.filter((a) => a.type === "Playbook" && a.state === "active");
  return (
    playbooks.find((p) => p.title === "Propose a plan") ?? playbooks.find((p) => p.id === "PB-0002")
  );
}

const everyMove = (_current: string, states: string[]): string[] => states;
const alwaysDroppable = (): true => true;

/**
 * The Plan surface (RQ-0045#AC-2, ST-0064): `BacklogBoard` — every Requirement, picked into a plan —
 * merged with what `PlanTab` used to gate behind a banner: the drafts a plan produced, reviewed and
 * approved right here. Browsing to Plan is the only door either half needs; there is no second
 * conditional entry to click through first.
 *
 * One `project:record` read backs both halves, the same rule every other rail follows: the same
 * record, read twice, must derive the same view both times (RQ-0014#AC-2, AC-3).
 */
export function PlanSurface({
  projectId,
  onOpen,
  onPrompt,
}: {
  projectId: string;
  onOpen: OpenTab;
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  const revision = useRevision();
  const bump = useBump();
  const [record, setRecord] = useState<Record_ | null>(null);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; state: string } | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  /** Requirement IDs picked in the `ready` column (ST-0027#AC-1). */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [planning, setPlanning] = useState(false);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [approving, setApproving] = useState(false);
  /** What Retire is asking about — the application's own dialog (RQ-0041#AC-2). */
  const [retiring, setRetiring] = useState<{ id: string; title: string } | null>(null);

  const fetchRecord = useCallback(async () => {
    const [nextRecord, kinds] = await Promise.all([
      window.aibuildos.invoke("project:record", { id: projectId }),
      window.aibuildos.invoke("project:artifact-types", { id: projectId }),
    ]);
    setRecord(nextRecord);
    setVocabulary(kinds.types.find((entry) => entry.type === "Requirement")?.states ?? []);
  }, [projectId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a trigger, not a read
  useEffect(() => {
    void fetchRecord();
  }, [fetchRecord, revision]);

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

  if (record === null) return <Loading className="p-4 text-xs" />;
  if (record.problem !== null) {
    return (
      <p data-testid="board-problem" className="p-4 text-xs text-red-600">
        {record.problem}
      </p>
    );
  }

  const artifacts: BoardArtifact[] = (record.artifacts ?? [])
    .filter((a) => a.type === "Requirement")
    .map((a) => ({ id: a.id, type: a.type, title: a.title, state: a.state, priority: a.priority }));

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

  const groups = derivePlan(record.artifacts ?? []);
  const flips = flipsFor(groups);
  const consequence = describeApproval(flips);

  const save: SaveFn = async (artifactId, state) => {
    const result = await window.aibuildos.invoke("project:artifact-save", {
      id: projectId,
      artifactId,
      frontmatter: { state },
    });
    return { problem: result.problem, findings: result.findings };
  };

  const runApprove = async (): Promise<void> => {
    setApproving(true);
    try {
      const outcomes = await approve(flips, save);
      setRefusals(
        Object.fromEntries(
          outcomes
            .filter((outcome) => !outcome.flipped && outcome.refusal !== null)
            .map((outcome) => [outcome.id, outcome.refusal as string]),
        ),
      );
    } finally {
      setApproving(false);
      bump();
    }
  };

  const askRetire = (artifactId: string, title: string): void =>
    setRetiring({ id: artifactId, title });

  const confirmRetire = async (): Promise<void> => {
    if (retiring === null) return;
    const { id: artifactId } = retiring;
    setRetiring(null);
    await window.aibuildos.invoke("project:artifact-save", {
      id: projectId,
      artifactId,
      frontmatter: { state: "retired" },
    });
    bump();
  };

  return (
    <div data-testid="plan-surface" className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 shrink-0 flex-col" style={{ height: "45%" }}>
        <div data-testid="board-columns" className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {artifacts.length === 0 ? (
            <p data-testid="board-empty" className="p-1 text-xs text-neutral-500">
              Nothing on the list yet.
            </p>
          ) : (
            columns.map((column) =>
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
            )
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

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-neutral-200 dark:border-neutral-800">
        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <p className={eyebrow}>Drafts waiting for review</p>
          {groups.length > 0 && (
            <div>
              <button
                type="button"
                data-testid="plan-approve"
                disabled={approving}
                onClick={() => void runApprove()}
                className={`${primary} ${focusRing}`}
              >
                {approving ? "Approving…" : "Approve the plan"}
              </button>
              <p
                data-testid="plan-approve-consequence"
                className="mt-1 text-right text-[11px] text-neutral-500"
              >
                {consequence}
              </p>
            </div>
          )}
        </div>

        {groups.length === 0 ? (
          <p data-testid="plan-empty" className="px-3 pb-3 text-sm text-neutral-500">
            Nothing is waiting for approval.
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3 pt-0">
            {groups.map((group) => (
              <GroupRow
                key={group.requirementId}
                group={group}
                projectId={projectId}
                onOpen={onOpen}
                onRetire={askRetire}
                refusals={refusals}
              />
            ))}
          </div>
        )}
      </div>

      {/* The application's own dialog (RQ-0041#AC-2), the `TabStrip` discard idiom. */}
      <Dialog.Root
        open={retiring !== null}
        onOpenChange={(next) => {
          if (!next) setRetiring(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content
            data-testid="plan-retire-dialog"
            className="fixed top-1/2 left-1/2 w-[26rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
          >
            <Dialog.Title className="text-lg font-semibold tracking-tight">
              Retire {retiring?.title ?? "this"}?
            </Dialog.Title>
            <Dialog.Description className="mt-1 mb-4 text-sm text-neutral-500">
              This cannot be undone from the plan.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="plan-retire-cancel"
                onClick={() => setRetiring(null)}
                className={`${button} ${focusRing}`}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="plan-retire-confirm"
                onClick={() => void confirmRetire()}
                className={`${primary} ${focusRing}`}
              >
                Retire
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/**
 * The `ready` column, with a checkbox per card (ST-0027#AC-1) — a fork of `Column`/`Card`, unchanged
 * from `BacklogBoard.tsx`.
 *
 * ponytail: no "Move to…" menu here, unlike every other column — forking that too would mean
 * duplicating `project:artifact`'s move-fetching dance for one column. Drag still works, in and out,
 * since dragging is tracked by the parent board regardless of which column a card started in.
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
  onOpen: OpenTab;
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

/** Below here, unchanged from `PlanTab.tsx`: one draft group per requirement, its stories, its tests. */
function GroupRow({
  group,
  projectId,
  onOpen,
  onRetire,
  refusals,
}: {
  group: PlanGroup;
  projectId: string;
  onOpen: OpenTab;
  onRetire: (id: string, title: string) => void;
  refusals: Record<string, string>;
}): React.JSX.Element {
  return (
    <div
      data-testid={`plan-group-${group.requirementId}`}
      className="mb-4 rounded border border-neutral-200 dark:border-neutral-800"
    >
      <p className="border-b border-neutral-200 px-2.5 py-1.5 text-xs dark:border-neutral-800">
        {group.requirementTitle} <span className={mono}>{group.requirementId}</span>
      </p>
      <div className="flex flex-col gap-1.5 p-1.5">
        {group.stories.map((story) => (
          <StoryRow
            key={story.id}
            projectId={projectId}
            story={story}
            onOpen={onOpen}
            onRetire={onRetire}
            refusal={refusals[story.id]}
            testRefusals={refusals}
          />
        ))}
        {group.tests.map((test) => (
          <TestRow
            key={test.id}
            test={test}
            onOpen={onOpen}
            onRetire={onRetire}
            refusal={refusals[test.id]}
          />
        ))}
      </div>
    </div>
  );
}

function StoryRow({
  projectId,
  story,
  onOpen,
  onRetire,
  refusal,
  testRefusals,
}: {
  projectId: string;
  story: PlanStory;
  onOpen: OpenTab;
  onRetire: (id: string, title: string) => void;
  refusal: string | undefined;
  testRefusals: Record<string, string>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ChannelResponse<"project:artifact"> | null>(null);

  useEffect(() => {
    if (!open || detail !== null) return;
    let live = true;
    void window.aibuildos
      .invoke("project:artifact", { id: projectId, artifactId: story.id })
      .then((next) => {
        if (live) setDetail(next);
      });
    return () => {
      live = false;
    };
  }, [open, detail, projectId, story.id]);

  const criteria = detail === null ? null : splitBody(detail.body).criteria;

  return (
    <div
      data-testid={`plan-story-${story.id}`}
      className="rounded border border-neutral-200 p-1.5 dark:border-neutral-800"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`plan-story-toggle-${story.id}`}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className={`text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="flex-1 truncate text-sm">{story.title}</span>
        <span className={`text-[11px] text-neutral-500 ${mono}`}>{story.id}</span>
        <button
          type="button"
          data-testid={`plan-story-open-${story.id}`}
          onClick={() =>
            onOpen({ id: story.id, kind: "artifact", title: story.id }, { preview: true })
          }
          className={`${button} px-2 py-0.5 text-[11px]`}
        >
          Open
        </button>
        <button
          type="button"
          data-testid={`plan-story-retire-${story.id}`}
          onClick={() => onRetire(story.id, story.title)}
          className={`${button} px-2 py-0.5 text-[11px]`}
        >
          Retire
        </button>
      </div>

      {story.rejected && (
        <p
          data-testid={`plan-story-rejected-${story.id}`}
          className="mt-1 text-[11px] text-red-600"
        >
          The validator already flags problems with this draft; fix them before approving.
        </p>
      )}
      {refusal !== undefined && (
        <p data-testid={`plan-story-refusal-${story.id}`} className="mt-1 text-[11px] text-red-600">
          {refusal}
        </p>
      )}

      {open && (
        <div className="mt-1.5 ml-6">
          <p className={eyebrow}>Must be true when done</p>
          {criteria === null ? (
            <Loading className="mt-1 text-[11px]" />
          ) : criteria.length === 0 ? (
            <p className="mt-1 text-[11px] text-neutral-500">No acceptance criteria written yet.</p>
          ) : (
            criteria.map((criterion) => (
              <p
                key={criterion.number}
                data-testid={`plan-story-ac-${story.id}-${criterion.number}`}
                className="mt-1 text-[11px]"
              >
                <span className={mono}>AC-{criterion.number}</span> {criterion.text}
              </p>
            ))
          )}

          {story.tests.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {story.tests.map((test) => (
                <TestRow
                  key={test.id}
                  test={test}
                  onOpen={onOpen}
                  onRetire={onRetire}
                  refusal={testRefusals[test.id]}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TestRow({
  test,
  onOpen,
  onRetire,
  refusal,
}: {
  test: PlanDraft;
  onOpen: OpenTab;
  onRetire: (id: string, title: string) => void;
  refusal: string | undefined;
}): React.JSX.Element {
  return (
    <div
      data-testid={`plan-test-${test.id}`}
      className="flex items-center gap-2 rounded border border-neutral-200 p-1.5 dark:border-neutral-800"
    >
      <span className="flex-1 truncate text-sm">{test.title}</span>
      <span className={`text-[11px] text-neutral-500 ${mono}`}>{test.id}</span>
      <button
        type="button"
        data-testid={`plan-test-open-${test.id}`}
        onClick={() => onOpen({ id: test.id, kind: "artifact", title: test.id }, { preview: true })}
        className={`${button} px-2 py-0.5 text-[11px]`}
      >
        Open
      </button>
      <button
        type="button"
        data-testid={`plan-test-retire-${test.id}`}
        onClick={() => onRetire(test.id, test.title)}
        className={`${button} px-2 py-0.5 text-[11px]`}
      >
        Retire
      </button>
      {test.rejected && (
        <p data-testid={`plan-test-rejected-${test.id}`} className="text-[11px] text-red-600">
          Validator-flagged
        </p>
      )}
      {refusal !== undefined && (
        <p data-testid={`plan-test-refusal-${test.id}`} className="text-[11px] text-red-600">
          {refusal}
        </p>
      )}
    </div>
  );
}
