import type { ChannelResponse } from "@aibuildos/ipc";
import { useCallback, useEffect, useState } from "react";
import { AcpAgent } from "./AcpAgent.js";

/**
 * Opening and holding one agent session for the project on screen (ST-0009).
 *
 * A session is domain state owned by the main process; what lives here is only the handle to it and
 * whatever the interface has to show about it (DC-0005). Nothing about the conversation itself is
 * kept — that is the transcript's own business, accumulated from events.
 */
type StartResult = ChannelResponse<"session:start">;
type Failure = Extract<StartResult, { ok: false }>;

export type SessionState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "ready"; sessionId: string; agent: AcpAgent; offered: Record<string, unknown> }
  | { status: "failed"; failure: Failure };

export interface Session {
  state: SessionState;
  /** Open a session on this project with this harness. */
  start: (harnessId: string) => Promise<void>;
  close: () => Promise<void>;
}

export function useSession(projectId: string | null): Session {
  const [state, setState] = useState<SessionState>({ status: "idle" });

  const start = useCallback(
    async (harnessId: string) => {
      if (projectId === null) return;

      setState({ status: "starting" });
      try {
        const result = await window.aibuildos.invoke("session:start", { projectId, harnessId });
        setState(
          result.ok
            ? {
                status: "ready",
                sessionId: result.sessionId,
                agent: new AcpAgent(result.sessionId),
                offered: result.offered,
              }
            : { status: "failed", failure: result },
        );
      } catch (cause) {
        setState({
          status: "failed",
          failure: {
            ok: false,
            code: "failed",
            message: cause instanceof Error ? cause.message : String(cause),
            authMethods: [],
          },
        });
      }
    },
    [projectId],
  );

  const close = useCallback(async () => {
    setState((current) => {
      if (current.status === "ready") {
        void window.aibuildos.invoke("session:close", { sessionId: current.sessionId });
      }
      return { status: "idle" };
    });
  }, []);

  // Closing the project ends its session. An agent outliving the thing it was working on is a
  // process nobody can see and nobody asked for.
  useEffect(() => {
    if (projectId !== null) return;
    void close();
  }, [projectId, close]);

  return { state, start, close };
}
