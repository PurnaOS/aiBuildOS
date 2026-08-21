import type { ChannelResponse } from "@aibuildos/ipc";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Loading } from "../Loading.js";
import { button, eyebrow, focusRing, mono, primary } from "../ui.js";
import { splitBody } from "../workspace/ArtifactTab.js";
import { useBump, useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import { approve, describeApproval, flipsFor, type SaveFn } from "./approve.js";
import { derivePlan, type PlanDraft, type PlanGroup, type PlanStory } from "./derive.js";

type Record_ = ChannelResponse<"project:record">;
type ArtifactDetail = ChannelResponse<"project:artifact">;
type OpenTab = (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;

/**
 * The plan (RQ-0014, ST-0027): everything at `draft`, gathered for review and approval.
 *
 * Derived entirely from `project:record` — `derivePlan` decides the grouping and order, this
 * component only fetches and renders. The workspace holds no plan state of its own: close the
 * application mid-review and the same record produces the same plan (RQ-0014#AC-2, AC-3).
 */
export function PlanTab({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: OpenTab;
  /** Picking lives on the Backlog board (ST-0027#AC-1) — nothing here sends a prompt. Kept in the
   * signature because Workspace already threads it to every tab kind. */
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  const revision = useRevision();
  const bump = useBump();
  const [record, setRecord] = useState<Record_ | null>(null);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [approving, setApproving] = useState(false);
  /** What Retire is asking about — the application's own dialog (RQ-0041#AC-2), the same Radix
   * idiom `TabStrip`'s discard dialog uses, in place of `window.confirm` blocking the renderer. */
  const [retiring, setRetiring] = useState<{ id: string; title: string } | null>(null);

  // `revision` is the trigger, not a read — the same rule every other rail follows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void window.aibuildos.invoke("project:record", { id: projectId }).then((next) => {
      if (live) setRecord(next);
    });
    return () => {
      live = false;
    };
  }, [projectId, revision]);

  if (record === null) return <Loading className="p-6 text-sm" />;
  if (record.problem !== null) {
    return (
      <p data-testid="plan-problem" className="p-6 text-sm text-red-600">
        {record.problem}
      </p>
    );
  }

  const groups = derivePlan(record.artifacts ?? []);

  if (groups.length === 0) {
    return (
      <p data-testid="plan-empty" className="p-6 text-sm text-neutral-500">
        Nothing is waiting for approval.
      </p>
    );
  }

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
      // Whatever flipped is no longer draft — the next read of the record drops it from the view.
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
    <div data-testid="plan-tab" className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <button
          type="button"
          data-testid="plan-approve"
          disabled={approving}
          onClick={() => void runApprove()}
          className={`${primary} ${focusRing}`}
        >
          {approving ? "Approving…" : "Approve the plan"}
        </button>
        <p data-testid="plan-approve-consequence" className="mt-1 text-[11px] text-neutral-500">
          {consequence}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
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

      {/* The application's own dialog (RQ-0041#AC-2), the `TabStrip` discard idiom: Radix, styled
          for both appearances, in place of `window.confirm` blocking the renderer. */}
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
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);

  // Fetched only on expand — the plan can list hundreds of drafts, and a body nobody opened is a
  // body nobody needed to read.
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
