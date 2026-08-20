import { CopilotKit, useCopilotChatInternal } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import { type ComponentProps, useEffect, useState } from "react";
import { useHarnesses } from "../harness/HarnessPanel.js";
import type { Session } from "../session/useSession.js";
import { button, eyebrow, focusRing, mono, primary } from "../ui.js";
import { Activity } from "./Activity.js";
import { Controls } from "./Controls.js";
import { PlaybookStrip } from "./PlaybookStrip.js";
import { AsksAssistantMessage } from "./QuestionCard.js";
import { ToolCallCard } from "./ToolCallCard.js";
import { ToolSessionContext } from "./toolCall.js";

/**
 * The conversation (ST-0011).
 *
 * CopilotKit renders the transcript and `selfManagedAgents` hands it our own agent
 * ([DC-0008](../../../../../docs/decisions/dc-0008.md), [DC-0017](../../../../../docs/decisions/dc-0017.md)) —
 * so there is no runtime server, no open port and no change to this application's
 * Content-Security-Policy.
 */
/**
 * CopilotKit types a tool renderer as three mutually exclusive prop shapes, one per status. A single
 * card that simply reads `result` when there is one cannot be written that way, so its shape is
 * asserted at registration rather than the component being split into three.
 */
type ToolRenderer = NonNullable<ComponentProps<typeof CopilotKit>["renderToolCalls"]>[number];

export function Chat({
  projectId,
  session,
  pending,
  onSent,
}: {
  projectId: string;
  session: Session;
  /** Text the record rail asked to be sent, or `null`. */
  pending?: string | null;
  onSent?: () => void;
}): React.JSX.Element {
  const { harnesses } = useHarnesses();
  const { state, start } = session;
  /** A slash command the user picked. It is sent as ordinary text, which is all a command is. */
  const [command, setCommand] = useState<string | null>(null);
  // Which harness this session was actually started with — `SessionState` does not carry it, and
  // it is RQ-0013#AC-6's fallback: what a playbook button runs with when its own preference matches
  // nothing configured.
  const [startedWith, setStartedWith] = useState<string | null>(null);
  // Feeds ToolCallCard's terminal cards the streamed `acp.tool_call_update` content CopilotKit never
  // sees (ST-0047) — one subscription for the whole conversation, called unconditionally so it stays
  // ahead of the conditional returns below rather than becoming a conditional hook itself.
  const pick = async (harnessId: string): Promise<void> => {
    setStartedWith(harnessId);
    await start(harnessId);
  };

  if (state.status === "ready") {
    const attachedHarness =
      harnesses?.find((harness) => harness.id === startedWith)?.displayName ??
      "the attached harness";
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="chat">
        {/* Project-scoped, so it sits above the agent's own controls rather than among them. Not
            wrapped in a bordered row of its own: while the level is still loading it renders
            nothing at all, rather than an empty strip flashing above the conversation. */}
        <Supervision projectId={projectId} />
        {/* What the agent is set to, above the conversation it applies to. */}
        <Controls
          sessionId={state.sessionId}
          offered={state.offered}
          onCommand={(text) => setCommand(text)}
        />
        <CopilotKit
          selfManagedAgents={{ default: state.agent }}
          agent="default"
          // A wildcard renderer, because an agent's tool names are its own and are not known in
          // advance — one card draws whatever it ran, where it ran it.
          renderToolCalls={[{ name: "*", render: ToolCallCard as ToolRenderer["render"] }]}
        >
          {/* The standard steps, filtered from the record alone (DC-0019) — above the transcript,
              because they are how a session that has nothing asked of it yet gets started. */}
          <PlaybookStrip
            projectId={projectId}
            harnesses={harnesses}
            attachedHarness={attachedHarness}
          />
          <div className="min-h-0 flex-1">
            {/* The cards CopilotKit renders carry no session of their own; this is how a
                ToolCallCard knows which session's stream to read (BG-0008's store). */}
            <ToolSessionContext value={state.sessionId}>
              <CopilotChat className="h-full" AssistantMessage={AsksAssistantMessage} />
            </ToolSessionContext>
          </div>
          {/* The plan and any question the agent is waiting on, kept above the composer rather than
              left to scroll away. */}
          <Activity sessionId={state.sessionId} />
          <PendingPrompt text={pending ?? null} onSent={onSent} />
          <PendingPrompt text={command} onSent={() => setCommand(null)} />
        </CopilotKit>
      </div>
    );
  }

  if (state.status === "starting") {
    return (
      <Centred>
        <p data-testid="session-starting" className="text-sm text-neutral-500">
          Starting the agent…
        </p>
      </Centred>
    );
  }

  if (state.status === "failed") {
    const { failure } = state;
    return (
      <Centred>
        <div className="max-w-md text-left">
          <p className={`${eyebrow} text-red-600`}>
            {failure.code === "auth_required" ? "not signed in" : failure.code.replace(/_/g, " ")}
          </p>
          <p data-testid="session-failed" className="mt-2 text-sm">
            {failure.message}
          </p>

          {/* The agent said how to sign in; offering anything else would be inventing it. */}
          {failure.authMethods.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {failure.authMethods.map((method) => (
                <span key={method.id} className={`${button} cursor-default`}>
                  {method.name}
                </span>
              ))}
            </div>
          )}

          <div className="mt-4">
            <HarnessButtons harnesses={harnesses} onPick={pick} label="Try again with" />
          </div>
        </div>
      </Centred>
    );
  }

  // Idle: a project is open and nothing has been asked yet.
  return (
    <Centred>
      <div className="max-w-md">
        <Supervision projectId={projectId} />
        <p className="text-sm">Nothing has been asked yet.</p>
        <p className="mt-1 text-xs text-neutral-500">
          Pick a coding agent to work on this project. It runs in{" "}
          <span className={mono}>{projectId ? "this project" : "the project"}</span>, with your own
          Git and your own credentials.
        </p>
        <div className="mt-4">
          <HarnessButtons harnesses={harnesses} onPick={pick} label="Start with" />
        </div>
      </div>
    </Centred>
  );
}

/**
 * Sends what the record rail attached.
 *
 * Inside the provider, because that is the only place a message can be put into the conversation —
 * anywhere else it would reach the agent without appearing in the transcript.
 */
function PendingPrompt({
  text,
  onSent,
}: {
  text: string | null;
  onSent?: (() => void) | undefined;
}): null {
  // `useCopilotChatInternal`, not the headless hook: this is the store `CopilotChat` itself reads,
  // and a message sent to any other one is delivered to the agent without ever appearing in the
  // conversation — which is exactly the thing this must not do.
  const { sendMessage } = useCopilotChatInternal();

  useEffect(() => {
    if (text === null) return;
    void sendMessage({ id: crypto.randomUUID(), role: "user", content: text });
    onSent?.();
  }, [text, sendMessage, onSent]);

  return null;
}

function HarnessButtons({
  harnesses,
  onPick,
  label,
}: {
  harnesses: { id: string; displayName: string }[] | null;
  onPick: (harnessId: string) => Promise<void>;
  label: string;
}): React.JSX.Element {
  if (harnesses === null) return <p className="text-xs text-neutral-500">Loading…</p>;

  if (harnesses.length === 0) {
    return (
      <p data-testid="no-harness" className="text-xs text-neutral-500">
        No coding agent is attached. Attach one in Settings.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={eyebrow}>{label}</span>
      {harnesses.map((harness) => (
        <button
          key={harness.id}
          type="button"
          data-testid={`start-${harness.id}`}
          className={`${primary} ${focusRing}`}
          onClick={() => void onPick(harness.id)}
        >
          {harness.displayName}
        </button>
      ))}
    </div>
  );
}

function Centred({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex h-full items-center justify-center p-8 text-center">{children}</div>;
}

type SupervisionLevel = "closest" | "hands-off";

/**
 * How closely this project's sessions are supervised (RQ-0022#AC-1).
 *
 * Project-scoped rather than session-scoped, so it reads and writes independent of whether a session
 * is even open — on screen before one starts, on the start surface, and again once one is running.
 * A two-word toggle rather than a menu: there are exactly two levels today, and the vision names more
 * only as their own requirement arrives.
 */
function Supervision({ projectId }: { projectId: string }): React.JSX.Element | null {
  const [level, setLevel] = useState<SupervisionLevel | null>(null);

  useEffect(() => {
    let live = true;
    void window.aibuildos.invoke("project:list", undefined).then((projects) => {
      if (!live) return;
      setLevel(projects.find((project) => project.id === projectId)?.supervision ?? "closest");
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  if (level === null) return null;

  const change = async (next: SupervisionLevel): Promise<void> => {
    const previous = level;
    setLevel(next);
    const { problem } = await window.aibuildos.invoke("project:set-supervision", {
      id: projectId,
      level: next,
    });
    // A change that did not actually persist must not be shown as though it had.
    if (problem) setLevel(previous);
  };

  return (
    <button
      type="button"
      data-testid="supervision"
      title="How closely permission requests are supervised"
      onClick={() => void change(level === "hands-off" ? "closest" : "hands-off")}
      className={`mt-2 mb-3 flex shrink-0 items-center gap-1.5 self-start rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800 ${focusRing}`}
    >
      <span className={eyebrow}>supervision</span>
      <span>{level}</span>
    </button>
  );
}
