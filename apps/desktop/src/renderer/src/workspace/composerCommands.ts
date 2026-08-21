import type { Command } from "./agentControls.js";
import type { PlaybookButton } from "./playbooks.js";

/**
 * The composer menu's pure half (RQ-0051, ST-0069): the project's playbooks and the harness's own
 * commands, as sections grouped by origin.
 *
 * `agentControls.ts`'s sibling — same split, same discipline. Nothing here talks to
 * `window.aibuildos` or React; `Composer.tsx` renders what this returns. What has to be *exactly*
 * right is the grouping and the text that gets sent, and both are easiest to keep right as something
 * a test can call directly (there is no component-rendering harness in this codebase — AR-0002).
 *
 * Which rule serves which criterion:
 *
 * - **RQ-0051#AC-1 / ST-0069#AC-1** — two sections, ordered, never interleaved: playbooks first,
 *   then the harness's commands under a heading naming the harness. Structurally impossible to
 *   interleave: they are separate arrays, exactly as `groupAgentSettings` keeps its groups apart.
 * - **RQ-0051#AC-1** — names and descriptions pass through *verbatim*. No renaming, no dedup across
 *   origins: a playbook and a command may legitimately share a word, and both survive whole — the
 *   same collision rule `groupAgentSettings` follows for two same-named settings.
 * - **RQ-0051#AC-2** — an entry carries the text invoking it sends: `/name`, exactly, and nothing
 *   else. The echo stub proves that string crossed the wire, so it must not be decorated here.
 *   `commandLine` is that criterion's other half — how the transcript recognises the send it just
 *   made and draws a card instead of prose.
 * - **RQ-0051#AC-3 / TC-0123** — the Commands section is *absent* when the session advertises
 *   nothing, rather than present and empty. `commands.ts` replaces the list wholesale, so a
 *   withdrawal down to nothing simply stops producing this section.
 *
 * One deliberate asymmetry with `groupAgentSettings`, which omits every empty group: the
 * **Playbooks section is always present, even with nothing in it**. Its empty and loading states are
 * something the menu shows *under that heading* — "Add the standard playbooks" (RQ-0043) has to live
 * somewhere, and a heading that vanishes takes the only way to get playbooks with it.
 */

/** What a renderer needs to draw one advertised command and to invoke it (AC-1, AC-2). */
export interface CommandEntry {
  /** Stable across a re-advertise, and namespaced so it cannot collide with a playbook's ID. */
  readonly key: string;
  /** The harness's own name, verbatim. */
  readonly name: string;
  /** The harness's own description, verbatim — `undefined` when it gave none. */
  readonly description: string | undefined;
  /** Exactly what invoking sends (AC-2): `/name`, no trailing space, nothing appended. */
  readonly prompt: string;
}

/**
 * The command line a sent user message *is*, or `null` when it is ordinary prose (AC-2's second
 * half). `Chat.tsx`'s `UserMessage` slot draws the first as a command card and lets the second fall
 * through to CopilotKit's own bubble.
 *
 * Judged by shape at send time, deliberately, rather than by looking the name up in what the session
 * currently advertises: a transcript is a record of what was sent, and a live lookup would demote an
 * already-sent invocation back to prose the moment the harness withdrew that command — which is a
 * path AC-3 makes routine, not hypothetical. Shape is also all there is on the send side:
 * `InputProps.onSend` carries a string, so nothing can ride along with it to be read back here.
 *
 * One line, a leading `/`, and a first token that reads as a name — which is what tells `/review` and
 * `/review the diff` apart from a pasted `/Users/…`, whose first token runs straight into another
 * separator.
 */
// ponytail: shape only, so a typed `/notacommand` reads as a command card too. Narrow it to the
// names the *send* saw advertised if that ever misleads — never to the live list.
export function commandLine(text: string): string | null {
  const line = text.trim();
  if (line.includes("\n")) return null;
  return /^\/[A-Za-z][\w:-]*(?:\s|$)/.test(line) ? line : null;
}

/**
 * One origin's worth of the menu. A discriminated union rather than a common item type: playbooks
 * pass through as whatever the caller loaded them into — body, harness and all — the way
 * `groupAgentSettings` hands back the harness's own `ConfigOption` objects untouched.
 */
export type MenuSection<P extends PlaybookButton> =
  | { readonly kind: "playbooks"; readonly heading: string; readonly playbooks: readonly P[] }
  | {
      readonly kind: "commands";
      readonly heading: string;
      readonly commands: readonly CommandEntry[];
    };

/**
 * The composer's `+` menu, by origin (AC-1): the project's playbooks, then — only when the session
 * advertises any — the harness's commands under its own display name.
 *
 * `commands` is whatever the session last advertised, whole: this maps it, it never merges it with
 * a previous list, so a withdrawn command is gone the moment the harness stops naming it (AC-3).
 */
export function composerMenu<P extends PlaybookButton>(
  playbooks: readonly P[],
  commands: readonly Command[],
  harnessDisplayName: string,
): MenuSection<P>[] {
  const sections: MenuSection<P>[] = [{ kind: "playbooks", heading: "Playbooks", playbooks }];

  if (commands.length > 0) {
    sections.push({
      kind: "commands",
      heading: `Commands — ${harnessDisplayName}`,
      commands: commands.map((command) => ({
        key: `command:${command.name}`,
        name: command.name,
        description: command.description,
        prompt: `/${command.name}`,
      })),
    });
  }

  return sections;
}
