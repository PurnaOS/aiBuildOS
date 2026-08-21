/**
 * The agent popover's pure half (RQ-0042, TC-0107): what the agent is set to, grouped by origin.
 *
 * Nothing here talks to `window.aibuildos` or React — that is `AgentPopover.tsx`'s job, the same
 * split `playbooks.ts`/`PlaybookStrip.tsx` already draws. What has to be *exactly right* is the
 * grouping itself: two settings can legitimately share a name, and the only thing that may never
 * happen is one of them being renamed, merged, or quietly dropped because of it — that is easiest to
 * get right, and keep right, as something a test can call directly.
 */

export interface Mode {
  readonly id: string;
  readonly name: string;
}

export interface ConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: string | boolean;
  /** A select option is identified by `value`, not `id` — that is the protocol's own naming. */
  readonly options?: { value: string; name: string }[];
}

export interface Command {
  readonly name: string;
  readonly description?: string;
}

export interface SettingsGroup {
  readonly heading: string;
  readonly options: readonly ConfigOption[];
}

/**
 * Groups every agent setting by origin (RQ-0042#AC-1, AC-2): the ACP session mode under "Session",
 * the harness's own options verbatim under its `displayName`. The two are simply two arrays,
 * rendered under two headings — nothing here compares names across them, so a collision (the
 * session's own control and a harness option both landing on the word "Mode") survives whole: both
 * render, neither renamed, deduped, nor dropped.
 *
 * A group with nothing to show is omitted — "absent, not an empty menu" (Controls.tsx's own rule)
 * carries over unchanged.
 */
export function groupAgentSettings(
  modes: readonly Mode[],
  modeId: string | null,
  options: readonly ConfigOption[],
  harnessDisplayName: string,
): SettingsGroup[] {
  const groups: SettingsGroup[] = [];

  if (modes.length > 0) {
    groups.push({
      heading: "Session",
      options: [
        {
          id: "mode",
          name: "Mode",
          // Spread, not `currentValue: modeId ?? undefined` — `exactOptionalPropertyTypes` treats
          // an explicit `undefined` as a value, not as "absent", and `ConfigOption` allows only the
          // latter.
          ...(modeId !== null ? { currentValue: modeId } : {}),
          options: modes.map((mode) => ({ value: mode.id, name: mode.name })),
        },
      ],
    });
  }

  if (options.length > 0) {
    groups.push({ heading: `Agent options — ${harnessDisplayName}`, options });
  }

  return groups;
}

/** What a harness record maps one supervision level onto — `supervisionOptions[level]` (RQ-0050). */
export interface SupervisionMapping {
  readonly configId: string;
  readonly value: string;
}

/** How far the supervision level actually reaches, and whether the agent has since disagreed. */
export interface SupervisionReach {
  readonly note: string;
  /** The agent's own option no longer holds what the level put there — shown, never silent. */
  readonly diverged: boolean;
}

/**
 * What the Supervision section says about its own reach (RQ-0050#AC-3, AC-4) — a decision, so it
 * lives here where a test can call it rather than inside JSX.
 *
 * Three honest answers. Nothing to set: either the record maps no option to this level or the agent
 * advertises none by that id, which from the reader's seat are the same fact — the level holds in
 * this application alone, and saying more would imply depth that is not there. Set and holding: name
 * the option and the value, so what the level did is visible. Set and moved: the agent changed it
 * from its own side, and a line still claiming the first would be exactly the silent disagreement
 * AC-4 forbids.
 *
 * The level shown is deliberately *not* rewritten to match the agent. This application's own
 * hands-off answering still follows the project's level, so a display that flipped to follow the
 * agent would misreport the half the reader can actually feel.
 */
export function supervisionReach(
  mapping: SupervisionMapping | undefined,
  options: readonly ConfigOption[],
  harnessDisplayName: string,
): SupervisionReach {
  const option =
    mapping === undefined
      ? undefined
      : options.find((candidate) => candidate.id === mapping.configId);

  if (mapping === undefined || option === undefined) {
    return {
      note: `Applies in aiBuildOS only — ${harnessDisplayName} offers no option this level can set.`,
      diverged: false,
    };
  }

  return option.currentValue === mapping.value
    ? {
        note: `Also sets ${harnessDisplayName}'s ${option.name} to ${valueName(option)}.`,
        diverged: false,
      }
    : {
        note: `${harnessDisplayName}'s ${option.name} is now ${valueName(option)} — changed on the agent's side.`,
        diverged: true,
      };
}

/** The text a setting's chip shows for its current value — a boolean reads as on/off, a select
 * option reads as its own name, and anything else is shown as-is. */
export function valueName(option: ConfigOption): string {
  if (typeof option.currentValue === "boolean") return option.currentValue ? "on" : "off";
  return (
    option.options?.find((choice) => choice.value === option.currentValue)?.name ??
    String(option.currentValue ?? "—")
  );
}
