import type { ChannelResponse } from "@aibuildos/ipc";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { eyebrow, focusRing, mono } from "../ui.js";
import {
  type ConfigOption,
  groupAgentSettings,
  type Mode,
  supervisionReach,
  valueName,
} from "./agentControls.js";

/** The mapping half of the harness record, straight off the wire (RQ-0050#AC-2). */
type SupervisionOptions = ChannelResponse<"harness:list">[number]["supervisionOptions"];

/**
 * One popover for everything the agent is set to (RQ-0042, ST-0060): the ACP session mode, the
 * harness's own options, and supervision — grouped by origin, because origin is the one honest
 * disambiguator when two settings share a name.
 *
 * The rule `Controls.tsx` (this file's former self) already followed still decides everything
 * rendered here: **the agent advertises what is on offer and this renders exactly that.** An agent
 * offering no model shows no model control — absent, not an empty menu.
 *
 * And the value shown is the agent's, not the click's: changing a control asks the agent, and the
 * chip updates when the agent says it changed.
 */
interface Offered {
  modes?: { currentModeId?: string; availableModes?: Mode[] } | null;
  configOptions?: ConfigOption[] | null;
}

const CUSTOM = {
  mode: "acp.mode",
  configOptions: "acp.config_options",
};

/**
 * What the agent is set to, live: loaded once from what the session already knows, then followed
 * as the agent's own `session:event` corrections arrive. Settings only — the harness's advertised
 * commands are `commands.ts`'s per-session store now (RQ-0051), read by the one surface that
 * renders them, rather than a second copy of the same feed kept here.
 *
 * `sessionId` is nullable so this can be called unconditionally, ahead of `Chat.tsx`'s own
 * `state.status === "ready"` branch, rather than becoming a conditional hook itself.
 */
export function useAgentControls(
  sessionId: string | null,
  offered: Offered,
): {
  modes: Mode[];
  modeId: string | null;
  options: ConfigOption[];
  setMode: (id: string) => void;
  setOption: (option: ConfigOption, value: string) => void;
} {
  const [modeId, setModeId] = useState(offered.modes?.currentModeId ?? null);
  const [options, setOptions] = useState<ConfigOption[]>(offered.configOptions ?? []);

  // Where things stood before this mounted. An agent announces its mode as the session opens, which
  // is before any of this exists to hear it.
  useEffect(() => {
    if (sessionId === null) return;
    let live = true;
    void window.aibuildos.invoke("session:controls", { sessionId }).then((known) => {
      if (!live) return;
      if (known.modeId !== null) setModeId(known.modeId);
      if (known.configOptions.length > 0)
        setOptions(known.configOptions as unknown as ConfigOption[]);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === null) return;
    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;

      const event = payload.event as { type: string; name?: string; value?: unknown };
      if (event.type !== "CUSTOM") return;

      // The agent is the authority on what it is set to; these are its own corrections.
      if (event.name === CUSTOM.mode) {
        setModeId((event.value as { currentModeId?: string })?.currentModeId ?? null);
      }
      if (event.name === CUSTOM.configOptions) {
        setOptions((event.value as { configOptions?: ConfigOption[] })?.configOptions ?? []);
      }
    });
  }, [sessionId]);

  return {
    modes: offered.modes?.availableModes ?? [],
    modeId,
    options,
    setMode: (id) =>
      void (
        sessionId !== null && window.aibuildos.invoke("session:set-mode", { sessionId, modeId: id })
      ),
    setOption: (option, value) =>
      void (
        sessionId !== null &&
        window.aibuildos.invoke("session:set-config", { sessionId, configId: option.id, value })
      ),
  };
}

type SupervisionLevel = "closest" | "hands-off";

/**
 * How closely this project's sessions are supervised (RQ-0022#AC-1), shared by the standalone pill
 * shown before a session exists and by the popover's own Supervision section once one does.
 *
 * Project-scoped rather than session-scoped, so it reads and writes independent of whether a session
 * is even open.
 */
function useSupervision(projectId: string): {
  level: SupervisionLevel | null;
  change: (next: SupervisionLevel) => Promise<void>;
} {
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

  return { level, change };
}

/**
 * The supervision toggle where sessions start — before there is a popover to hold it (DC-0027's
 * usage on the idle surface is left alone by RQ-0042; this is that same surface's control, unchanged
 * in behaviour and testid, only moved out of `Chat.tsx`).
 */
export function SupervisionPill({ projectId }: { projectId: string }): React.JSX.Element | null {
  const { level, change } = useSupervision(projectId);
  if (level === null) return null;

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

export function AgentPopover({
  attachedHarness,
  supervisionOptions,
  projectId,
  modes,
  modeId,
  options,
  setMode,
  setOption,
}: {
  attachedHarness: string;
  supervisionOptions?: SupervisionOptions;
  projectId: string;
  modes: Mode[];
  modeId: string | null;
  options: ConfigOption[];
  setMode: (id: string) => void;
  setOption: (option: ConfigOption, value: string) => void;
}): React.JSX.Element {
  const { level, change } = useSupervision(projectId);
  const groups = groupAgentSettings(modes, modeId, options, attachedHarness);
  const modeName = modes.find((mode) => mode.id === modeId)?.name ?? null;
  const handsOff = level === "hands-off";
  // What the level actually reaches (RQ-0050#AC-3, AC-4). `options` is the agent's own live list —
  // the same `session:event` subscription every other group here already rides — so a change the
  // harness makes from its side lands in this line without a second subscription to keep true.
  const reach =
    level === null ? null : supervisionReach(supervisionOptions?.[level], options, attachedHarness);

  return (
    <div className="flex shrink-0 items-center border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-testid="agent-popover-trigger"
            className={`flex items-center gap-1.5 rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800 ${focusRing}`}
          >
            <span>{attachedHarness}</span>
            {modeName !== null && <span className={mono}>{modeName}</span>}
            {/* Colour plus the word, never colour alone — the state is readable without opening
                anything (RQ-0042#AC-4). */}
            {handsOff && (
              <span className="font-medium text-amber-600 dark:text-amber-500">hands-off</span>
            )}
            <ChevronDown size={10} className="text-neutral-400" aria-hidden />
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            data-testid="agent-popover"
            align="start"
            sideOffset={4}
            className="z-20 w-72 rounded border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
          >
            {groups.map((group) => (
              <div key={group.heading} className="mb-2 last:mb-0">
                <p className={`${eyebrow} px-1`}>{group.heading}</p>
                <div className="mt-1 flex flex-col items-start gap-1">
                  {group.options.map((option) => (
                    <Chip
                      key={option.id}
                      testId={`control-${option.id}`}
                      label={option.name}
                      value={valueName(option)}
                      options={(option.options ?? []).map((choice) => ({
                        id: choice.value,
                        name: choice.name,
                      }))}
                      onPick={(id) =>
                        group.heading === "Session" ? setMode(id) : setOption(option, id)
                      }
                    />
                  ))}
                </div>
              </div>
            ))}

            {level !== null && (
              <div>
                <p className={`${eyebrow} px-1`}>Supervision</p>
                <button
                  type="button"
                  data-testid="supervision"
                  title="How closely permission requests are supervised"
                  onClick={() => void change(handsOff ? "closest" : "hands-off")}
                  className={`mt-1 flex items-center gap-1.5 rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800 ${focusRing}`}
                >
                  <span>{level}</span>
                </button>
                {reach !== null && (
                  <p
                    data-testid="supervision-reach"
                    className={`mt-1 px-1 text-[11px] ${
                      reach.diverged
                        ? "text-amber-600 dark:text-amber-500"
                        : "text-neutral-500 dark:text-neutral-400"
                    }`}
                  >
                    {reach.note}
                  </p>
                )}
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function Chip({
  testId,
  label,
  value,
  options,
  onPick,
}: {
  testId: string;
  label: string;
  value: string;
  options: { id: string; name: string }[];
  onPick: (id: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        data-testid={testId}
        onClick={() => setOpen((current) => !current)}
        className={`flex items-center gap-1.5 rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-800 ${focusRing}`}
      >
        <span className={eyebrow}>{label}</span>
        <span>{value}</span>
        <ChevronDown size={10} className="text-neutral-400" aria-hidden />
      </button>

      {open && options.length > 0 && (
        <div className="absolute top-full left-0 z-10 mt-1 min-w-[10rem] overflow-hidden rounded border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              data-testid={`${testId}-${option.id}`}
              onClick={() => {
                onPick(option.id);
                setOpen(false);
              }}
              className={`block w-full px-2.5 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900 ${focusRing}`}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
