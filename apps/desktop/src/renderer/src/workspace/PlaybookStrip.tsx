import { useCopilotChatInternal } from "@copilotkit/react-core";
import { useEffect, useState } from "react";
import { button, eyebrow, focusRing, mono } from "../ui.js";
import { compose, derivePlaybooks, type PlaybookButton, resolveHarness } from "./playbooks.js";
import { useBump, useRevision } from "./revision.js";

/**
 * The playbook strip (ST-0026, TC-0045): the standard steps as buttons, once a session is ready to
 * receive them.
 *
 * Named `PlaybookStrip`, not `Playbooks`: this file sits beside `playbooks.ts`, the pure module
 * `derivePlaybooks`/`compose`/`resolveHarness` live in, and the two names would differ only in case
 * — fine on this filesystem, fatal to `tsc` on one that is not.
 *
 * A filtered view of the record and nothing else (DC-0019) — `derivePlaybooks` decides which
 * artifacts are buttons, `project:artifact` supplies each one's body and `harness` field, and
 * pressing calls the *same* `sendMessage` `PendingPrompt` uses in `Chat.tsx`, which is what keeps a
 * press inside the transcript rather than reaching the agent behind it.
 *
 * Rendered only once `state.status === "ready"`: sending needs the live `CopilotKit` provider, and a
 * button nobody can press yet is not a button worth showing.
 */
interface LoadedPlaybook extends PlaybookButton {
  readonly body: string;
  readonly harness: string;
}

export function PlaybookStrip({
  projectId,
  harnesses,
  attachedHarness,
}: {
  projectId: string;
  harnesses: { id: string; displayName: string }[] | null;
  /** The display name of the harness this session was actually started with — AC-6's fallback. */
  attachedHarness: string;
}): React.JSX.Element | null {
  const revision = useRevision();
  // Seeding writes artifacts, so everything reading the record — this strip *and* the rails — has
  // to look again; the shared bump is how one change reaches all of them.
  const bump = useBump();
  const { sendMessage } = useCopilotChatInternal();
  const [playbooks, setPlaybooks] = useState<LoadedPlaybook[] | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // `revision` is a trigger, not a read: it is how an edit made anywhere — the artifact editor,
  // the agent, a seed — reaches this strip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a trigger
  useEffect(() => {
    let live = true;
    void (async () => {
      const record = await window.aibuildos
        .invoke("project:record", { id: projectId })
        .catch(() => ({ artifacts: null, problem: "The record could not be read." }));

      const buttons = derivePlaybooks(record.artifacts ?? []);
      const loaded = await Promise.all(
        buttons.map(async (playbook) => {
          const artifact = await window.aibuildos.invoke("project:artifact", {
            id: projectId,
            artifactId: playbook.id,
          });
          const preferred =
            typeof artifact.frontmatter.harness === "string"
              ? artifact.frontmatter.harness
              : undefined;
          return {
            ...playbook,
            body: artifact.body,
            harness: resolveHarness(preferred, harnesses ?? [], attachedHarness),
          };
        }),
      );

      if (live) setPlaybooks(loaded);
    })();
    return () => {
      live = false;
    };
  }, [projectId, revision, harnesses, attachedHarness]);

  const seed = async (): Promise<void> => {
    setSeeding(true);
    setProblem(null);
    try {
      const result = await window.aibuildos.invoke("project:seed-playbooks", { id: projectId });
      if (result.problem) setProblem(result.problem);
      else bump();
    } catch (cause) {
      // Anything crossing IPC arrives as an unknown rejection; the user still has to be told.
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSeeding(false);
    }
  };

  const press = (playbook: LoadedPlaybook): void => {
    void sendMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: compose(playbook.body, []),
    });
  };

  if (playbooks === null) return null;

  if (playbooks.length === 0) {
    return (
      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          data-testid="seed-playbooks"
          className={`${button} text-xs`}
          onClick={() => void seed()}
          disabled={seeding}
        >
          {seeding ? "Adding…" : "Add the standard playbooks"}
        </button>
        {problem !== null && (
          <span data-testid="seed-playbooks-problem" className="text-xs text-red-600">
            {problem}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="playbooks"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
    >
      <span className={eyebrow}>Playbooks</span>
      {playbooks.map((playbook) => (
        <PlaybookButtonView key={playbook.id} playbook={playbook} onPress={() => press(playbook)} />
      ))}
    </div>
  );
}

function PlaybookButtonView({
  playbook,
  onPress,
}: {
  playbook: LoadedPlaybook;
  onPress: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        data-testid={`playbook-${playbook.id}`}
        className={`${button} rounded-r-none text-xs`}
        onClick={onPress}
      >
        {playbook.title}
      </button>
      <button
        type="button"
        data-testid={`playbook-info-${playbook.id}`}
        aria-label={`About ${playbook.title}`}
        aria-expanded={open}
        className={`rounded rounded-l-none border border-l-0 border-neutral-300 px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 ${focusRing}`}
        onClick={() => setOpen((current) => !current)}
      >
        ⓘ
      </button>

      {open && (
        <div
          data-testid={`playbook-popover-${playbook.id}`}
          className="absolute top-full left-0 z-10 mt-1 w-96 rounded border border-neutral-300 bg-white p-3 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
        >
          <p className="font-medium">{playbook.title}</p>
          <p className="mt-1 text-neutral-500">
            Runs with <span className={mono}>{playbook.harness}</span>
          </p>
          <pre
            data-testid={`playbook-text-${playbook.id}`}
            className={`mt-2 max-h-48 overflow-auto whitespace-pre-wrap ${mono}`}
          >
            {compose(playbook.body, [])}
          </pre>
        </div>
      )}
    </span>
  );
}
