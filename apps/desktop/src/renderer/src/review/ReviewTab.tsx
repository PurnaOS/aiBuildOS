import type { ChannelResponse } from "@aibuildos/ipc";
import { useCallback, useEffect, useState } from "react";
import { button, eyebrow, field, focusRing, mono, primary } from "../ui.js";
import { splitBody } from "../workspace/ArtifactTab.js";
import { Diff } from "../workspace/Diff.js";
import { useBump, useRevision } from "../workspace/revision.js";
import type { Tab } from "../workspace/TabStrip.js";
import { acceptStory, commitMessage, type Save, sendBackStory } from "./walk.js";

type Artifact = ChannelResponse<"project:artifact">;
type DiffResult = ChannelResponse<"project:diff">;

/**
 * A story under review: its criteria beside the working tree's changes (RQ-0015, ST-0028).
 *
 * The story is read the way every other tab reads the record — `project:artifact` — and the tab id
 * is `review:<story-id>`, so a story that leaves review while this tab is open just re-renders as a
 * sentence naming wherever it went (RQ-0015#AC-6): nothing here remembers that it was ever open on
 * this story, which is what lets it survive a restart with nothing but the files on disk.
 */
export function ReviewTab({
  projectId,
  storyId,
  onOpen: _onOpen,
  onPrompt,
}: {
  projectId: string;
  storyId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  const revision = useRevision();
  const bump = useBump();
  const [story, setStory] = useState<Artifact | null>(null);
  const [diffs, setDiffs] = useState<DiffResult[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Set the moment Accept lands; offered until Commit or Not now is pressed (RQ-0018#AC-4). */
  const [offer, setOffer] = useState<{ storyId: string; title: string } | null>(null);

  const load = useCallback(async () => {
    const next = await window.aibuildos.invoke("project:artifact", {
      id: projectId,
      artifactId: storyId,
    });
    setStory(next);

    const state = String((next.frontmatter as { state?: unknown }).state ?? "");
    if (state !== "review" || next.markdown === null) {
      setDiffs(null);
      return;
    }

    const changes = await window.aibuildos.invoke("project:changes", { id: projectId });
    // Staged, unstaged and untracked, unioned: a story built moments ago is untracked, never staged
    // or unstaged, and the review surface owes the reviewer every changed file, not only Git's own
    // subset of them.
    const paths = [
      ...new Set([...changes.staged, ...changes.unstaged, ...changes.untracked].map((c) => c.path)),
    ];
    const results = await Promise.all(
      paths.map((path) => window.aibuildos.invoke("project:diff", { id: projectId, path })),
    );
    setDiffs(results);
  }, [projectId, storyId]);

  // `revision` is a trigger, not a read: the turn-end hook flips this story's state out from under
  // this tab, and a save made anywhere else does too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a trigger
  useEffect(() => {
    void load();
  }, [load, revision]);

  const save: Save = (artifactId, frontmatter, body) =>
    window.aibuildos.invoke("project:artifact-save", {
      id: projectId,
      artifactId,
      frontmatter,
      ...(body === undefined ? {} : { body }),
    });

  const accept = async (): Promise<void> => {
    if (story === null) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await acceptStory(save, storyId);
      if (result.problem !== null) {
        setProblem(result.problem);
        return;
      }
      setOffer({
        storyId,
        title: String((story.frontmatter as { title?: unknown }).title ?? storyId),
      });
      bump();
    } finally {
      setBusy(false);
    }
  };

  const sendBack = async (): Promise<void> => {
    if (story?.markdown === null || story === null || note.trim() === "") return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await sendBackStory(save, storyId, story.body, note.trim());
      if (result.problem !== null) {
        setProblem(result.problem);
        return;
      }
      setNote("");
      bump();
      if (result.prompt !== null) onPrompt(result.prompt);
    } finally {
      setBusy(false);
    }
  };

  if (story === null) return <p className="p-6 text-sm text-neutral-500">Loading…</p>;
  if (story.markdown === null) {
    return (
      <p data-testid="review-problem" className="p-6 text-sm text-red-600">
        {story.problem ?? "That story could not be read."}
      </p>
    );
  }

  const title = String((story.frontmatter as { title?: unknown }).title ?? storyId);
  const state = String((story.frontmatter as { state?: unknown }).state ?? "");

  if (state !== "review") {
    // Accept just landed: offer to commit what it changed, in place of the usual "not under
    // review" line — declining (or closing this tab) drops back to that line, and the Git tab
    // remains where the same commit can always be made by hand.
    if (offer !== null && offer.storyId === storyId) {
      return (
        <CommitOffer
          projectId={projectId}
          storyId={offer.storyId}
          title={offer.title}
          onDone={() => setOffer(null)}
        />
      );
    }
    return (
      <p data-testid="review-not-ready" className="p-6 text-sm text-neutral-500">
        {storyId} is at <span className={mono}>{state}</span>, not under review.
      </p>
    );
  }

  const parts = splitBody(story.body);

  return (
    <div data-testid="review-tab" className="flex h-full min-h-0 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-neutral-200 dark:divide-neutral-800">
        <div data-testid="review-story" className="min-h-0 overflow-auto p-4">
          <p className={eyebrow}>{storyId}</p>
          <h2 className="mt-0.5 text-sm font-medium">{title}</h2>

          {parts.head.trim() !== "" && (
            <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
              {parts.head.trim()}
            </p>
          )}

          <div className="mt-5">
            <p className={eyebrow}>Must be true when done</p>
            {parts.criteria.length === 0 ? (
              <p className="mt-1.5 text-xs text-neutral-500">
                This story has no acceptance criteria.
              </p>
            ) : (
              <ul className="mt-1.5 space-y-1.5 text-sm">
                {parts.criteria.map((criterion) => (
                  <li key={criterion.number} className="flex items-start gap-2">
                    <span className={`mt-px shrink-0 text-[11px] text-neutral-500 ${mono}`}>
                      AC-{criterion.number}
                    </span>
                    <span>{criterion.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

        </div>

        <div data-testid="review-diffs" className="min-h-0 overflow-auto p-4">
          <p className={eyebrow}>Working tree</p>
          {diffs === null ? (
            <p className="mt-1.5 text-xs text-neutral-500">Loading…</p>
          ) : diffs.length === 0 ? (
            <p className="mt-1.5 text-xs text-neutral-500">
              Nothing has changed in the working tree.
            </p>
          ) : (
            <div className="mt-1.5">
              {diffs.map((diff) =>
                diff.problem !== null ? (
                  <p key={diff.path} className="mt-2 text-xs text-red-600">
                    {diff.problem}
                  </p>
                ) : (
                  <Diff
                    key={diff.path}
                    path={diff.path}
                    oldText={diff.oldText ?? ""}
                    newText={diff.newText}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-neutral-200 p-3 dark:border-neutral-800">
        {problem !== null && (
          <p data-testid="review-save-problem" className="mb-2 text-xs text-red-600">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <button
              type="button"
              data-testid="review-accept"
              disabled={busy}
              onClick={() => void accept()}
              className={`${primary} ${focusRing}`}
            >
              Accept
            </button>
            <p className="mt-1 max-w-48 text-[11px] text-neutral-500">
              Flips {storyId} to accepted — the person's okay, made in the record.
            </p>
          </div>

          <div className="flex min-w-64 flex-1 flex-col gap-1.5">
            <label htmlFor="review-note" className={eyebrow}>
              Send back
            </label>
            <div className="flex gap-2">
              <input
                id="review-note"
                data-testid="review-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What needs another pass?"
                className={field}
              />
              <button
                type="button"
                data-testid="review-send-back"
                disabled={busy || note.trim() === ""}
                onClick={() => void sendBack()}
                className={`${button} ${focusRing} shrink-0`}
              >
                Send back
              </button>
            </div>
            <p className="text-[11px] text-neutral-500">
              Returns {storyId} to building, appends this note to the story, and sends it to the
              agent.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The commit RQ-0018#AC-4 offers, never performs, once Accept lands.
 *
 * Staging: exactly the paths `project:changes` currently lists — the same union of staged,
 * unstaged and untracked the diff pane above already reads — never `git add -A`. Those are the
 * paths a reviewer just looked at; a blanket add would also catch anything unrelated that happens
 * to be sitting in the tree.
 */
function CommitOffer({
  projectId,
  storyId,
  title,
  onDone,
}: {
  projectId: string;
  storyId: string;
  title: string;
  onDone: () => void;
}): React.JSX.Element {
  const bump = useBump();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const message = commitMessage(storyId, title);

  const commit = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const changes = await window.aibuildos.invoke("project:changes", { id: projectId });
      const paths = [
        ...new Set(
          [...changes.staged, ...changes.unstaged, ...changes.untracked].map((c) => c.path),
        ),
      ];
      for (const path of paths) {
        const staged = await window.aibuildos.invoke("project:stage", { id: projectId, path });
        if (staged.problem !== null) {
          setProblem(staged.problem);
          return;
        }
      }
      const result = await window.aibuildos.invoke("project:commit", { id: projectId, message });
      if (!result.ok) {
        setProblem(result.message);
        return;
      }
      bump();
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="review-commit-offer" className="p-6">
      <p className="text-sm">
        Commit this work — <span className={mono}>{storyId}</span>: {title}
      </p>
      {problem !== null && (
        <p
          data-testid="review-commit-problem"
          className="mt-2 whitespace-pre-wrap text-xs text-red-600"
        >
          {problem}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          data-testid="review-commit-accept"
          disabled={busy}
          onClick={() => void commit()}
          className={`${primary} ${focusRing}`}
        >
          Commit
        </button>
        <button
          type="button"
          data-testid="review-commit-decline"
          disabled={busy}
          onClick={onDone}
          className={`${button} ${focusRing}`}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
