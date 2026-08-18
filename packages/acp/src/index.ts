/**
 * @aibuildos/acp — the boundary to external agent processes (DC-0007).
 *
 * A harness is one configured coding agent: a name, a command, and its arguments. Agents are stdio
 * child processes speaking ACP, and this package holds the only code that spawns one.
 *
 * Node-compatible only: this is imported by the Electron main process (AR-0001).
 */

/** Everything needed to start one agent as a child process. */
export interface LaunchSpec {
  /** Executable to spawn. Resolved on PATH unless absolute. */
  readonly command: string;
  readonly args: readonly string[];
  /** Working directory for the agent. Defaults to the app's own cwd. */
  readonly cwd?: string | undefined;
}

/** A launch spec the product ships, offered when the user adds a harness (RQ-0001#AC-3). */
export interface HarnessPreset extends LaunchSpec {
  readonly id: string;
  readonly displayName: string;
}

/**
 * The harnesses aiBuildOS ships support for. Adding one is a config entry, not an integration.
 *
 * These commands are the ones that actually exist today — the `@zed-industries/*` adapters were
 * renamed to `@agentclientprotocol/*`, and Gemini's `--experimental-acp` is deprecated in favour of
 * `--acp`. There is an upstream registry of ACP agents; three hardcoded presets are a few lines and
 * a fetch-and-cache layer is a project, so that arrives when these go stale.
 */
export const HARNESS_PRESETS: readonly HarnessPreset[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
  },
  {
    id: "codex",
    displayName: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    command: "npx",
    args: ["-y", "@google/gemini-cli", "--acp"],
  },
];

export function findPreset(id: string): HarnessPreset | undefined {
  return HARNESS_PRESETS.find((preset) => preset.id === id);
}

// The probe lives behind `@aibuildos/acp/probe`, not here: it imports `node:child_process`, and this
// module is imported by the renderer for the preset list.
