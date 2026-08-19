import { CopilotKit, useCopilotChatInternal } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import { type ComponentProps, useEffect, useState } from "react";
import { useHarnesses } from "../harness/HarnessPanel.js";
import type { Session } from "../session/useSession.js";
import { button, eyebrow, focusRing, mono, primary } from "../ui.js";
import { Activity } from "./Activity.js";
import { Controls } from "./Controls.js";
import { ToolCallCard } from "./ToolCallCard.js";

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

  if (state.status === "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="chat">
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
          <div className="min-h-0 flex-1">
            <CopilotChat className="h-full" />
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
            <HarnessButtons harnesses={harnesses} onPick={start} label="Try again with" />
          </div>
        </div>
      </Centred>
    );
  }

  // Idle: a project is open and nothing has been asked yet.
  return (
    <Centred>
      <div className="max-w-md">
        <p className="text-sm">Nothing has been asked yet.</p>
        <p className="mt-1 text-xs text-neutral-500">
          Pick a coding agent to work on this project. It runs in{" "}
          <span className={mono}>{projectId ? "this project" : "the project"}</span>, with your own
          Git and your own credentials.
        </p>
        <div className="mt-4">
          <HarnessButtons harnesses={harnesses} onPick={start} label="Start with" />
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
