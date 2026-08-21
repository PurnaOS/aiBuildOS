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
}

/** A launch spec the product ships, offered when the user adds a harness (RQ-0001#AC-3). */
export interface HarnessPreset extends LaunchSpec {
  readonly id: string;
  readonly displayName: string;
  /**
   * What this agent's own config option is set to at each supervision level (RQ-0050#AC-2) — the
   * prefill the form copies onto the saved record, because a saved harness carries an arbitrary id
   * and a preset-id lookup at session time would miss every real one.
   *
   * Partial and optional on purpose: an agent that advertises no permission-shaped config option
   * gets no entry, which is AC-3's honest case rather than a gap to fill with a guess.
   */
  readonly supervisionOptions?: Partial<
    Record<"closest" | "hands-off", { readonly configId: string; readonly value: string }>
  >;
}

/**
 * The harnesses aiBuildOS ships support for. Adding one is a config entry, not an integration.
 *
 * These commands are the ones that actually exist today — the `@zed-industries/*` adapters were
 * renamed to `@agentclientprotocol/*`, and Gemini's `--experimental-acp` is deprecated in favour of
 * `--acp`. There is an upstream registry of ACP agents; three hardcoded presets are a few lines and
 * a fetch-and-cache layer is a project, so that arrives when these go stale.
 *
 * `supervisionOptions` was read off each adapter's own published bundle rather than recalled, and
 * only what was found is written down — Gemini CLI produces no session config options at all, so it
 * maps none. ponytail: hand-checked against claude-agent-acp 0.70 and codex-acp 1.6; these go stale
 * the same way the commands do, and the same fetch-and-cache layer would refresh both at once.
 */
export const HARNESS_PRESETS: readonly HarnessPreset[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    // Its `mode` option, which the adapter itself describes as "Session permission mode": `default`
    // is the one that "prompts for dangerous operations", `acceptEdits` auto-accepts file edits.
    // Not `bypassPermissions` — an agent that stops asking altogether cannot have its automatic
    // answers shown on the transcript, and RQ-0022#AC-3 requires that they are.
    supervisionOptions: {
      closest: { configId: "mode", value: "default" },
      "hands-off": { configId: "mode", value: "acceptEdits" },
    },
  },
  {
    id: "codex",
    displayName: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    // Its `mode` option — "Approval and sandboxing preset for the session". `read-only` "requires
    // approval to edit files and run commands"; `agent` is the adapter's own default. Not
    // `agent-full-access`, whose approval policy is `never`, for the reason above.
    supervisionOptions: {
      closest: { configId: "mode", value: "read-only" },
      "hands-off": { configId: "mode", value: "agent" },
    },
  },
  {
    id: "gemini",
    displayName: "Gemini CLI",
    command: "npx",
    args: ["-y", "@google/gemini-cli", "--acp"],
    // No `supervisionOptions`: this adapter advertises no session config options, so there is
    // nothing to map and nothing honest to invent (RQ-0050#AC-3).
  },
];

// The probe lives behind `@aibuildos/acp/probe`, not here: it imports `node:child_process`, and this
// module is imported by the renderer for the preset list.
