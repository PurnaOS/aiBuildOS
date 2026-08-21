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

/** The text a setting's chip shows for its current value — a boolean reads as on/off, a select
 * option reads as its own name, and anything else is shown as-is. */
export function valueName(option: ConfigOption): string {
  if (typeof option.currentValue === "boolean") return option.currentValue ? "on" : "off";
  return (
    option.options?.find((choice) => choice.value === option.currentValue)?.name ??
    String(option.currentValue ?? "—")
  );
}
