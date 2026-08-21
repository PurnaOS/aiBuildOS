import type { ChannelResponse } from "@aibuildos/ipc";
import { useCallback, useEffect, useState } from "react";
import { useHarnesses } from "../harness/HarnessPanel.js";
import { Loading } from "../Loading.js";
import { buildWalk } from "../review/walk.js";
import { button, card, eyebrow, focusRing, mono } from "../ui.js";
import { useBump, useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import { Column } from "./Column.js";
import { type BoardArtifact, type BoardColumn, deriveBoard, mergeVocabularies } from "./derive.js";

type Record_ = ChannelResponse<"project:record">;
type ArtifactDetail = ChannelResponse<"project:artifact">;

/** The states a person owns on this board (RQ-0011#AC-6): verdicts on `review` work, plus retirement
 * from anywhere. Every other transition — including the builders' own `ready → queued → building` —
 * is written by the builder, never dragged or menu'd here. */
const BUILDER_COLUMNS = new Set(["ready", "queued", "building"]);
const REVIEW_VERDICTS = new Set(["accepted", "building", "rejected", "retired"]);

function humanMoves(current: string, states: string[]): string[] {
  if (current === "review") return states.filter((s) => REVIEW_VERDICTS.has(s));
  return states.filter((s) => s === "retired");
}

const PLAYBOOK_ID = "PB-0003";

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
  onPrompt,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** Sends text into the conversation as the user's own visible message — how Build sends the build
   * playbook (RQ-0015#AC-1). */
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  const revision = useRevision();
  const bump = useBump();
  const { harnesses } = useHarnesses();
  const [record, setRecord] = useState<Record_ | null>(null);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [showRetired, setShowRetired] = useState(false);
  const [dragging, setDragging] = useState<{ id: string; state: string } | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  /** Stories with a build walk in flight, so the button reads "Building…" and cannot be pressed
   * twice into the same two guarded saves. */
  const [building, setBuilding] = useState<Set<string>>(new Set());
  /** Stories starting a worktree build (RQ-0020) — a separate flag from `building` because the two
   * buttons must not race each other into the same story's guarded saves. */
  const [buildingWorktree, setBuildingWorktree] = useState<Set<string>>(new Set());

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

  /**
   * Build (RQ-0015#AC-1): the two guarded saves `walk.ts` orders, against a story's own title and
   * the requirement it implements — both read from the record already on screen, so this reaches for
   * only what it does not already have: the story's outbound `implements` link, and PB-0003's body.
   */
  const startBuild = useCallback(
    async (storyId: string) => {
      const titleOf = (id: string): string =>
        record?.artifacts?.find((a) => a.id === id)?.title ?? id;

      setBuilding((current) => new Set(current).add(storyId));
      setProblems((current) => {
        const next = { ...current };
        delete next[storyId];
        return next;
      });
      try {
        const [story, playbook] = await Promise.all([
          window.aibuildos.invoke("project:artifact", { id: projectId, artifactId: storyId }),
          window.aibuildos.invoke("project:artifact", { id: projectId, artifactId: PLAYBOOK_ID }),
        ]);
        const requirementId = story.links.find((link) => link.relationship === "implements")
          ?.current[0];
        if (requirementId === undefined) {
          setProblems((current) => ({
            ...current,
            [storyId]: "This story implements no requirement.",
          }));
          return;
        }

        const result = await buildWalk(
          (artifactId, frontmatter) =>
            window.aibuildos.invoke("project:artifact-save", {
              id: projectId,
              artifactId,
              frontmatter,
            }),
          {
            storyId,
            storyTitle: titleOf(storyId),
            requirementId,
            requirementTitle: titleOf(requirementId),
            playbookBody: playbook.body,
          },
        );

        if (result.problem !== null) {
          setProblems((current) => ({ ...current, [storyId]: result.problem as string }));
          return;
        }
        bump();
        if (result.prompt !== null) onPrompt(result.prompt);
      } finally {
        setBuilding((current) => {
          const next = new Set(current);
          next.delete(storyId);
          return next;
        });
      }
    },
    [projectId, bump, onPrompt, record],
  );

  /**
   * Build in a worktree (RQ-0020#AC-1): `build:start` creates the worktree and the session before
   * anything in the record moves, so a story implementing no requirement — the one thing that can
   * still refuse the walk below — never leaves a worktree and a session orphaned behind it. Only
   * once the session exists does the walk run and the composed prompt go straight to it, never
   * through `onPrompt` — the worktree session's own stream is where its conversation lives
   * (ST-0037), not the main transcript.
   */
  const startWorktreeBuild = useCallback(
    async (storyId: string, harnessId: string) => {
      if (building.has(storyId) || buildingWorktree.has(storyId)) return;
      const titleOf = (id: string): string =>
        record?.artifacts?.find((a) => a.id === id)?.title ?? id;

      setBuildingWorktree((current) => new Set(current).add(storyId));
      setProblems((current) => {
        const next = { ...current };
        delete next[storyId];
        return next;
      });
      try {
        const [story, playbook] = await Promise.all([
          window.aibuildos.invoke("project:artifact", { id: projectId, artifactId: storyId }),
          window.aibuildos.invoke("project:artifact", { id: projectId, artifactId: PLAYBOOK_ID }),
        ]);
        const requirementId = story.links.find((link) => link.relationship === "implements")
          ?.current[0];
        if (requirementId === undefined) {
          setProblems((current) => ({
            ...current,
            [storyId]: "This story implements no requirement.",
          }));
          return;
        }

        const started = await window.aibuildos.invoke("build:start", {
          projectId,
          storyId,
          harnessId,
        });
        if (!started.ok) {
          setProblems((current) => ({ ...current, [storyId]: started.message }));
          return;
        }

        const result = await buildWalk(
          (artifactId, frontmatter) =>
            window.aibuildos.invoke("project:artifact-save", {
              id: projectId,
              artifactId,
              frontmatter,
            }),
          {
            storyId,
            storyTitle: titleOf(storyId),
            requirementId,
            requirementTitle: titleOf(requirementId),
            playbookBody: playbook.body,
          },
        );

        if (result.problem !== null) {
          setProblems((current) => ({ ...current, [storyId]: result.problem as string }));
          return;
        }
        bump();
        if (result.prompt !== null) {
          // Fire-and-forget: this resolves at the worktree session's turn end, which the Now tab —
          // not this button — is what watches for.
          void window.aibuildos.invoke("session:prompt", {
            sessionId: started.sessionId,
            text: result.prompt,
          });
        }
      } finally {
        setBuildingWorktree((current) => {
          const next = new Set(current);
          next.delete(storyId);
          return next;
        });
      }
    },
    [projectId, bump, record, building, buildingWorktree],
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
    .filter((a) => a.type === "Story" || a.type === "Bug")
    .map((a) => ({ id: a.id, type: a.type, title: a.title, state: a.state, priority: a.priority }));

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

  /**
   * The ready column's Build control (RQ-0045#AC-4, DC-0027 — the owner's decision): the primary
   * press now starts a worktree build, with the first configured harness — today's first caret entry,
   * simply promoted — since parallel worktree builds are the default and the conversation is the
   * exception. The caret still lists every configured harness (a multi-harness project still has to
   * choose which one a *non-default* worktree build spawns with, `parallel.spec.ts`'s own case), with
   * "In this conversation" first — the old primary action, now one press further away. `null` for a
   * Bug, which offers no build control at all.
   */
  const buildControlFor = (artifact: BoardArtifact): BuildControl | null => {
    if (artifact.type !== "Story") return null;
    const busy = building.has(artifact.id);
    const busyWorktree = buildingWorktree.has(artifact.id);
    const configured = harnesses ?? [];
    const defaultHarness = configured[0];
    return {
      buildTestId: `board-card-build-${artifact.id}`,
      buildLabel: busy ? "Building…" : busyWorktree ? "Starting…" : "Build",
      // A worktree build needs a harness to spawn with; with none configured the primary press has
      // nothing to do (the caret's "In this conversation" still works — that reuses whatever the
      // main chat already picked, never a harness this button chose).
      buildDisabled: busy || busyWorktree || defaultHarness === undefined,
      onBuild: () => defaultHarness && void startWorktreeBuild(artifact.id, defaultHarness.id),
      menuTestId: `board-card-build-menu-${artifact.id}`,
      menuDisabled: busy || busyWorktree,
      menuEntries: [
        {
          testId: `board-card-build-chat-${artifact.id}`,
          label: "In this conversation",
          disabled: busy || busyWorktree,
          onClick: () => void startBuild(artifact.id),
        },
        // One entry per configured harness (RQ-0020#AC-1): a worktree build spawns a session right
        // away, so it has to know which harness to spawn with before the click ever fires.
        ...configured.map((harness) => ({
          testId: `board-card-build-worktree-${artifact.id}-${harness.id}`,
          label: `In a worktree — ${harness.displayName}`,
          disabled: busy || busyWorktree,
          onClick: () => void startWorktreeBuild(artifact.id, harness.id),
        })),
      ],
    };
  };

  const reviewActions = (artifact: BoardArtifact): CardAction[] => {
    if (artifact.type !== "Story") return [];
    return [
      {
        testId: `board-card-review-${artifact.id}`,
        label: "Review",
        onClick: () => onOpen({ id: `review:${artifact.id}`, kind: "review", title: artifact.id }),
      },
    ];
  };

  return (
    <div data-testid="work-board" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div data-testid="board-columns" className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {columns.map((column) =>
          column.state === "ready" || column.state === "review" ? (
            <ActionColumn
              key={column.state}
              column={column}
              projectId={projectId}
              onOpen={onOpen}
              dragging={dragging}
              onDragStart={(id, state) => setDragging({ id, state })}
              onDragEnd={() => setDragging(null)}
              filterMoves={humanMoves}
              onMove={attemptMove}
              problems={problems}
              caption={BUILDER_COLUMNS.has(column.state) ? "moved by the builder" : undefined}
              actions={column.state === "ready" ? () => [] : reviewActions}
              build={column.state === "ready" ? buildControlFor : undefined}
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
              canDrop={(cardState) =>
                cardState === "review" &&
                (column.state === "accepted" || column.state === "rejected")
              }
              filterMoves={humanMoves}
              onMove={attemptMove}
              problems={problems}
              caption={BUILDER_COLUMNS.has(column.state) ? "moved by the builder" : undefined}
            />
          ),
        )}
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

interface CardAction {
  readonly testId: string;
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

/**
 * The ready column's split Build control (ST-0044#AC-4, RQ-0045#AC-4): a primary button that starts a
 * worktree build with the default harness, plus a caret beside it — "In this conversation" first,
 * then one entry per configured harness — in place of a row of always-visible buttons.
 */
interface BuildControl {
  readonly buildTestId: string;
  readonly buildLabel: string;
  readonly buildDisabled: boolean;
  readonly onBuild: () => void;
  readonly menuTestId: string;
  /** The caret's own disabled state — deliberately not `buildDisabled`: with no harness configured
   * the primary press has nothing to start, but "In this conversation" still works. */
  readonly menuDisabled: boolean;
  readonly menuEntries: readonly CardAction[];
}

/**
 * `ready` and `review`, rendered locally rather than through BoardTab's `Column`/`Card` — Build and
 * Review are card-level actions neither of those exports a slot for (`Card` is not exported, and
 * BoardTab.tsx is out of scope while another agent edits the boards it shares). Every testid and the
 * menu/drag behaviour `board-card-<id>` carries elsewhere is reproduced here so the existing board
 * assertions still hold for these two columns.
 *
 * ponytail: duplicates BoardTab's Column/Card shape for two states out of nine. Extract a shared
 * `actions` prop on `Column` itself if a third board ever needs the same.
 */
function ActionColumn({
  column,
  projectId,
  onOpen,
  dragging,
  onDragStart,
  onDragEnd,
  filterMoves,
  onMove,
  problems,
  caption,
  actions,
  build,
}: {
  column: BoardColumn;
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  dragging: { id: string; state: string } | null;
  onDragStart: (id: string, state: string) => void;
  onDragEnd: () => void;
  filterMoves: (current: string, states: string[]) => string[];
  onMove: (artifactId: string, state: string) => void;
  problems: Record<string, string>;
  caption?: string | undefined;
  /** Empty when this artifact offers no extra action — a Bug sitting in `ready`, say. */
  actions: (artifact: BoardArtifact) => CardAction[];
  /** The ready column's Build control (ST-0044#AC-4). Absent for review, which has no build of its
   * own to offer. */
  build?: ((artifact: BoardArtifact) => BuildControl | null) | undefined;
}): React.JSX.Element {
  return (
    <div
      data-testid={`board-column-${column.state}`}
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
          <ActionCard
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
            actions={actions(artifact)}
            build={build?.(artifact) ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function ActionCard({
  artifact,
  projectId,
  onOpen,
  dragging,
  onDragStart,
  onDragEnd,
  filterMoves,
  onMove,
  problem,
  actions,
  build,
}: {
  artifact: BoardArtifact;
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  dragging: { id: string; state: string } | null;
  onDragStart: (id: string, state: string) => void;
  onDragEnd: () => void;
  filterMoves: (current: string, states: string[]) => string[];
  onMove: (artifactId: string, state: string) => void;
  problem?: string | undefined;
  actions: CardAction[];
  build?: BuildControl | null;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moves, setMoves] = useState<string[] | null>(null);
  const [buildMenuOpen, setBuildMenuOpen] = useState(false);

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
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is mouse-only; each card's "Move to…" menu is the keyboard/screen-reader path to the same move.
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

      {actions.map((action) => (
        <button
          key={action.testId}
          type="button"
          data-testid={action.testId}
          onClick={action.onClick}
          disabled={action.disabled}
          className={`mt-1 block w-full text-center text-xs ${button} ${focusRing}`}
        >
          {action.label}
        </button>
      ))}

      {build !== null && build !== undefined && (
        <div className="mt-1 flex items-stretch gap-1">
          <button
            type="button"
            data-testid={build.buildTestId}
            onClick={build.onBuild}
            disabled={build.buildDisabled}
            className={`flex-1 text-center text-xs ${button} ${focusRing}`}
          >
            {build.buildLabel}
          </button>
          {build.menuEntries.length > 0 && (
            <button
              type="button"
              data-testid={build.menuTestId}
              aria-label={`Build options for ${artifact.id}`}
              onClick={() => setBuildMenuOpen((open) => !open)}
              disabled={build.menuDisabled}
              className={`px-1.5 text-xs ${button} ${focusRing}`}
            >
              ▾
            </button>
          )}
        </div>
      )}

      {build !== null && build !== undefined && buildMenuOpen && build.menuEntries.length > 0 && (
        <div
          data-testid={`board-card-build-worktree-options-${artifact.id}`}
          className="mt-1 flex flex-col items-start gap-0.5"
        >
          {build.menuEntries.map((entry) => (
            <button
              key={entry.testId}
              type="button"
              data-testid={entry.testId}
              disabled={entry.disabled}
              onClick={() => {
                setBuildMenuOpen(false);
                entry.onClick();
              }}
              className={`text-[11px] underline hover:text-neutral-900 dark:hover:text-neutral-100 ${mono}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}

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
            <Loading className="text-[11px]" />
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
