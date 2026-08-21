import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { eyebrow, focusRing } from "../ui.js";

/**
 * What the agent is set to, and how to change it (ST-0010#AC-5 to AC-7).
 *
 * One rule decides everything here: **the agent advertises what is on offer and this renders exactly
 * that.** An agent offering no model shows no model control — absent, not an empty menu. A category
 * the protocol has never named still appears, under the agent's own label, because that label is all
 * anyone can honestly know about it.
 *
 * And the value shown is the agent's, not the click's: changing a control asks the agent, and the
 * chip updates when the agent says it changed. A control that showed what was clicked would be
 * reporting an intention as though it were a fact.
 */
interface Mode {
  id: string;
  name: string;
}

interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type?: string;
  currentValue?: string | boolean;
  /** A select option is identified by `value`, not `id` — that is the protocol's own naming. */
  options?: { value: string; name: string }[];
}

interface Offered {
  modes?: { currentModeId?: string; availableModes?: Mode[] } | null;
  configOptions?: ConfigOption[] | null;
}

interface Command {
  name: string;
  description?: string;
}

const CUSTOM = {
  mode: "acp.mode",
  configOptions: "acp.config_options",
  commands: "acp.commands",
};

export function Controls({
  sessionId,
  offered,
  onCommand,
}: {
  sessionId: string;
  offered: Offered;
  /** Send a slash command as an ordinary message — there is no separate invoke for one. */
  onCommand: (text: string) => void;
}): React.JSX.Element | null {
  const [modeId, setModeId] = useState(offered.modes?.currentModeId ?? null);
  const [options, setOptions] = useState<ConfigOption[]>(offered.configOptions ?? []);
  const [commands, setCommands] = useState<Command[]>([]);

  // Where things stood before this mounted. An agent announces its commands and its mode as the
  // session opens, which is before any of this exists to hear it.
  useEffect(() => {
    let live = true;
    void window.aibuildos.invoke("session:controls", { sessionId }).then((known) => {
      if (!live) return;
      if (known.modeId !== null) setModeId(known.modeId);
      if (known.configOptions.length > 0)
        setOptions(known.configOptions as unknown as ConfigOption[]);
      if (known.commands.length > 0) setCommands(known.commands as unknown as Command[]);
    });
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => {
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
      if (event.name === CUSTOM.commands) {
        setCommands((event.value as { availableCommands?: Command[] })?.availableCommands ?? []);
      }
    });
  }, [sessionId]);

  const modes = offered.modes?.availableModes ?? [];
  if (modes.length === 0 && options.length === 0 && commands.length === 0) return null;

  return (
    <div
      data-testid="controls"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
    >
      {modes.length > 0 && (
        <Chip
          testId="control-mode"
          label="mode"
          value={modes.find((mode) => mode.id === modeId)?.name ?? modeId ?? "—"}
          options={modes.map((mode) => ({ id: mode.id, name: mode.name }))}
          onPick={(id) => {
            void window.aibuildos.invoke("session:set-mode", { sessionId, modeId: id });
          }}
        />
      )}

      {options.map((option) => (
        <Chip
          key={option.id}
          testId={`control-${option.id}`}
          // Its own label, whatever category it claims — including one this protocol never named.
          label={option.name}
          value={valueName(option)}
          options={(option.options ?? []).map((choice) => ({
            id: choice.value,
            name: choice.name,
          }))}
          onPick={(id) => {
            void window.aibuildos.invoke("session:set-config", {
              sessionId,
              configId: option.id,
              value: id,
            });
          }}
        />
      ))}

      {commands.length > 0 && (
        <Chip
          testId="control-commands"
          label="commands"
          value={`${commands.length}`}
          options={commands.map((command) => ({
            id: command.name,
            name: command.description
              ? `/${command.name} — ${command.description}`
              : `/${command.name}`,
          }))}
          onPick={(name) => onCommand(`/${name}`)}
        />
      )}
    </div>
  );
}

function valueName(option: ConfigOption): string {
  if (typeof option.currentValue === "boolean") return option.currentValue ? "on" : "off";
  return (
    option.options?.find((choice) => choice.value === option.currentValue)?.name ??
    String(option.currentValue ?? "—")
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
