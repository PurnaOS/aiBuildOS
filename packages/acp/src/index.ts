/**
 * @aibuildos/acp — the boundary to external agent processes (DC-0007).
 *
 * Agents are stdio child processes speaking ACP. An adapter is configuration, not code: a name, a
 * command, and its arguments. No live client lives here yet — this package fixes the vocabulary and
 * the spawn shape so the rest of the app can be written against it.
 *
 * Node-compatible only: this is imported by the Electron main process (AR-0001).
 */

/** How to start one agent as a child process. */
export interface AgentDescriptor {
  /** Stable key used in configuration and transcripts. */
  readonly id: string;
  readonly displayName: string;
  /** Executable to spawn. Resolved on PATH unless absolute. */
  readonly command: string;
  readonly args: readonly string[];
}

/** The agents supported at bootstrap. Adding one is a config entry, not an integration. */
export const TIER_1_AGENTS: readonly AgentDescriptor[] = [
  { id: "claude-code", displayName: "Claude Code", command: "claude", args: ["--acp"] },
  { id: "codex-cli", displayName: "Codex CLI", command: "codex", args: ["acp"] },
  { id: "pi", displayName: "pi", command: "pi", args: ["acp"] },
];

/**
 * A live agent process. Implemented against `@agentclientprotocol/sdk` when the ACP client lands;
 * `tools/stub-acp-agent` is spawned through the same interface in tests (DC-0013).
 */
export interface AgentConnection {
  readonly descriptor: AgentDescriptor;
  /** Send one JSON-RPC message to the agent's stdin. */
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface AgentSpawner {
  spawn(descriptor: AgentDescriptor): Promise<AgentConnection>;
}

export function describeAgent(id: string): AgentDescriptor | undefined {
  return TIER_1_AGENTS.find((agent) => agent.id === id);
}
