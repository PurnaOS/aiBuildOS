import { useCopilotChatInternal } from "@copilotkit/react-core";
import type { InputProps } from "@copilotkit/react-ui";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { Plus, Send, Square } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { button, card, eyebrow, field, focusRing, mono, primary } from "../ui.js";
import { Activity } from "./Activity.js";
import type { Command } from "./agentControls.js";
import { compose, derivePlaybooks, type PlaybookButton, resolveHarness } from "./playbooks.js";
import { useBump, useRevision } from "./revision.js";

/**
 * Playbooks and agent commands, offered where messages are composed (RQ-0043, ST-0061).
 *
 * `PlaybookStrip.tsx` is gone; what it did — read the record, derive the buttons, fetch each one's
 * body, resolve its harness, and send exactly that body through `useCopilotChatInternal` — lives here
 * now, behind a `+` menu on the composer and, on an empty transcript, as starter cards. The pure
 * modules it depended on (`derivePlaybooks`, `compose`, `resolveHarness`) are unchanged (RQ-0043's own
 * words) — only where their output is offered moves.
 */
interface LoadedPlaybook extends PlaybookButton {
  readonly body: string;
  readonly harness: string;
}

/** The intake playbook (RQ-0017#AC-1): title-first, ID fallback — moved verbatim from
 * `PlaybookStrip.tsx`. Its press opens the idea prompt instead of sending at once. */
function isIntake(playbook: LoadedPlaybook): boolean {
  return playbook.title === "Draft requirements from an idea" || playbook.id === "PB-0001";
}

interface ComposerMenuValue {
  playbooks: LoadedPlaybook[] | null;
  seed: () => Promise<void>;
  seeding: boolean;
  seedProblem: string | null;
  commands: Command[];
  /** Starts a playbook exactly as the old strip did: sends at once, or — for intake — opens the
   * idea prompt first. The one function both the `+` menu and the starter cards call, so "picking
   * a card is the same action as the menu entry" (RQ-0043#AC-3) is true by construction. */
  start: (playbook: LoadedPlaybook) => void;
  /** So `Composer` can render the plan/question strip immediately above its own input row —
   * `CopilotChat` gives a custom `Input` no seam between its messages and itself, so this is the
   * only place left that renders "above the composer" and is still true (Activity.tsx's own words). */
  sessionId: string;
}

const ComposerMenuContext = createContext<ComposerMenuValue | null>(null);

function useComposerMenu(): ComposerMenuValue {
  const value = useContext(ComposerMenuContext);
  if (value === null) throw new Error("ComposerMenuProvider is missing above this component.");
  return value;
}

/**
 * Loads the playbooks and holds the idea-prompt dialog, both inside the `CopilotKit` provider so a
 * press can reach `sendMessage` — the same seam `PlaybookStrip.tsx` used.
 */
export function ComposerMenuProvider({
  projectId,
  harnesses,
  attachedHarness,
  commands,
  sessionId,
  children,
}: {
  projectId: string;
  harnesses: { id: string; displayName: string }[] | null;
  attachedHarness: string;
  commands: Command[];
  sessionId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const revision = useRevision();
  // Seeding writes artifacts, so everything reading the record has to look again.
  const bump = useBump();
  const { sendMessage } = useCopilotChatInternal();
  const [playbooks, setPlaybooks] = useState<LoadedPlaybook[] | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedProblem, setSeedProblem] = useState<string | null>(null);
  const [ideaTarget, setIdeaTarget] = useState<LoadedPlaybook | null>(null);
  const [idea, setIdea] = useState("");

  // `revision` is a trigger, not a read: it is how an edit made anywhere — the artifact editor,
  // the agent, a seed — reaches this menu.
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
    setSeedProblem(null);
    try {
      const result = await window.aibuildos.invoke("project:seed-playbooks", { id: projectId });
      if (result.problem) setSeedProblem(result.problem);
      else bump();
    } catch (cause) {
      setSeedProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSeeding(false);
    }
  };

  const start = (playbook: LoadedPlaybook): void => {
    if (isIntake(playbook)) {
      setIdeaTarget(playbook);
      return;
    }
    void sendMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: compose(playbook.body, []),
    });
  };

  const startIdea = (): void => {
    if (ideaTarget === null || idea.trim() === "") return;
    void sendMessage({
      id: crypto.randomUUID(),
      role: "user",
      content: `${compose(ideaTarget.body, [])}\n\nThe idea, in the user's words:\n${idea}`,
    });
    setIdeaTarget(null);
    setIdea("");
  };

  return (
    <ComposerMenuContext
      value={{ playbooks, seed, seeding, seedProblem, commands, start, sessionId }}
    >
      {children}

      {/* RQ-0017#AC-1: intake starts from whatever the user typed or pasted. Reuses the same Radix
          Dialog idiom `TabStrip.tsx`'s discard dialog does, and the same testids the strip's own
          popup carried, so `intake.spec.ts` migrates by adding one open-the-menu step. */}
      <Dialog.Root
        open={ideaTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setIdeaTarget(null);
            setIdea("");
          }
        }}
      >
        <Dialog.Portal>
          {/* z-40: above the starter cards' z-10 and the popovers' z-20/z-30 — a modal sits over
              everything, including the overlay it opened from (this can open while the empty
              transcript's starter cards are still showing underneath). */}
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content
            data-testid={ideaTarget ? `playbook-idea-${ideaTarget.id}` : undefined}
            className="fixed top-1/2 left-1/2 z-40 w-[26rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-200 bg-white p-4 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
          >
            <Dialog.Title className="text-sm font-medium">The idea, in your own words</Dialog.Title>
            <textarea
              data-testid={ideaTarget ? `playbook-idea-input-${ideaTarget.id}` : undefined}
              className={`${field} mt-2`}
              rows={4}
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="Type or paste it here…"
            />
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                data-testid={ideaTarget ? `playbook-idea-start-${ideaTarget.id}` : undefined}
                className={`${button} ${focusRing}`}
                disabled={idea.trim() === ""}
                onClick={startIdea}
              >
                Start
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </ComposerMenuContext>
  );
}

/**
 * Centred starter cards on an empty transcript (RQ-0043#AC-3) — the same `start` a menu entry would
 * run, offered where there is nothing else to show yet. Rendered over the transcript area rather than
 * inside `CopilotChat`'s own message list, which this component has no seam into.
 */
export function StarterCards(): React.JSX.Element | null {
  const { messages } = useCopilotChatInternal();
  const { playbooks, start } = useComposerMenu();

  if (messages.length > 0 || playbooks === null || playbooks.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white p-8 dark:bg-neutral-950">
      <div className="pointer-events-auto grid w-full max-w-md gap-2">
        {playbooks.map((playbook) => (
          <button
            key={playbook.id}
            type="button"
            data-testid={`playbook-card-${playbook.id}`}
            onClick={() => start(playbook)}
            className={`${card} ${focusRing}`}
          >
            <p className="font-medium">{playbook.title}</p>
            <p className="mt-0.5 text-xs text-neutral-500">{leadLine(playbook.body)}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The first line of a playbook's body that is not its own heading — "one line from the body"
 * (RQ-0043#AC-3), not the whole disclosed text. */
function leadLine(body: string): string {
  const line = body
    .split("\n")
    .map((raw) => raw.trim())
    .find((candidate) => candidate.length > 0 && !candidate.startsWith("#"));
  return line ?? "";
}

/**
 * The composer (RQ-0043#AC-1): `CopilotChat`'s `Input` slot, replaced so a `+` button can sit beside
 * it. Defined at module level — an inline component here would change identity on every render of
 * `Chat.tsx` and remount the textarea underneath whatever the user was typing.
 *
 * Deliberately minimal next to CopilotKit's own default `Input`: no attachments, no push-to-talk, no
 * "powered by" tag — none of this application uses them, and the default component isn't exported to
 * wrap rather than replace.
 */
export function Composer({
  inProgress,
  onSend,
  onStop,
  hideStopButton,
}: InputProps): React.JSX.Element {
  const { playbooks, seed, seeding, seedProblem, commands, start, sessionId } = useComposerMenu();
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = !inProgress && text.trim() !== "";
  const canStop = inProgress === true && hideStopButton !== true;

  const send = (): void => {
    if (!canSend) return;
    void onSend(text);
    setText("");
    textareaRef.current?.focus();
  };

  const insertCommand = (name: string): void => {
    setText(`/${name} `);
    setMenuOpen(false);
    textareaRef.current?.focus();
  };

  return (
    <div className="flex shrink-0 flex-col">
      {/* The plan and any question the agent is waiting on — above this row, so scrolling the
          transcript never carries them away (Activity.tsx's own rule). */}
      <Activity sessionId={sessionId} />
      <div className="flex items-end gap-2 border-t border-neutral-200 p-2 dark:border-neutral-800">
        <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              data-testid="composer-menu-trigger"
              aria-label="Playbooks and commands"
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded border border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 ${focusRing}`}
            >
              <Plus size={14} aria-hidden />
            </button>
          </Popover.Trigger>

          <Popover.Portal>
            <Popover.Content
              data-testid="composer-menu"
              align="start"
              side="top"
              sideOffset={4}
              className="z-20 max-h-[60vh] w-80 overflow-auto rounded border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
            >
              <p className={`${eyebrow} px-1`}>Playbooks</p>
              <div className="mt-1 flex flex-col items-stretch gap-1">
                {playbooks === null && <p className="px-1 text-xs text-neutral-500">Loading…</p>}
                {playbooks !== null && playbooks.length === 0 && (
                  <div className="px-1">
                    <button
                      type="button"
                      data-testid="seed-playbooks"
                      className={`${button} text-xs`}
                      onClick={() => void seed()}
                      disabled={seeding}
                    >
                      {seeding ? "Adding…" : "Add the standard playbooks"}
                    </button>
                    {seedProblem !== null && (
                      <p data-testid="seed-playbooks-problem" className="mt-1 text-xs text-red-600">
                        {seedProblem}
                      </p>
                    )}
                  </div>
                )}
                {playbooks?.map((playbook) => (
                  <PlaybookMenuItem
                    key={playbook.id}
                    playbook={playbook}
                    onPress={() => {
                      start(playbook);
                      setMenuOpen(false);
                    }}
                  />
                ))}
              </div>

              {commands.length > 0 && (
                <>
                  <p className={`${eyebrow} mt-2 px-1`}>Commands</p>
                  <div className="mt-1 flex flex-col items-stretch gap-1">
                    {commands.map((command) => (
                      <button
                        key={command.name}
                        type="button"
                        data-testid={`command-${command.name}`}
                        onClick={() => insertCommand(command.name)}
                        className={`rounded px-2 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900 ${focusRing}`}
                      >
                        <span className={mono}>/{command.name}</span>
                        {command.description !== undefined && (
                          <span className="text-neutral-500"> — {command.description}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <textarea
          ref={textareaRef}
          data-testid="composer-textarea"
          className={`${field} min-h-[2.25rem] flex-1 resize-none py-1.5`}
          rows={1}
          placeholder="Message…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />

        <button
          type="button"
          data-testid="copilot-send-button"
          aria-label={canStop ? "Stop" : "Send"}
          disabled={!canSend && !canStop}
          onClick={canStop ? onStop : send}
          className={`${primary} flex h-8 w-8 shrink-0 items-center justify-center p-0 ${focusRing}`}
        >
          {canStop ? <Square size={12} aria-hidden /> : <Send size={12} aria-hidden />}
        </button>
      </div>
    </div>
  );
}

function PlaybookMenuItem({
  playbook,
  onPress,
}: {
  playbook: LoadedPlaybook;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        data-testid={`playbook-${playbook.id}`}
        onClick={onPress}
        className={`flex-1 rounded px-2 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900 ${focusRing}`}
      >
        {playbook.title}
      </button>
      {/* A nested Popover, not an inline absolutely-positioned div: the outer menu scrolls
          (`overflow-auto`), and a plain child would be clipped by it rather than shown. */}
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-testid={`playbook-info-${playbook.id}`}
            aria-label={`About ${playbook.title}`}
            className={`rounded px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${focusRing}`}
          >
            ⓘ
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            data-testid={`playbook-popover-${playbook.id}`}
            side="right"
            align="start"
            sideOffset={4}
            className="z-30 w-72 rounded border border-neutral-300 bg-white p-3 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
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
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}
