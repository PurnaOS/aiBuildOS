import { HARNESS_PRESETS } from "@aibuildos/acp";
import type { ChannelRequest, ChannelResponse } from "@aibuildos/ipc";
import * as Dialog from "@radix-ui/react-dialog";
import { Fragment, useCallback, useEffect, useState } from "react";

/**
 * Harness settings and the first-run attach prompt (ST-0001), plus the result of a live ACP test
 * (ST-0002).
 *
 * The harness list is *not* mirrored into the Zustand store — it is owned by the main process and
 * read across IPC at the point of use (DC-0005).
 */
type Harness = ChannelResponse<"harness:list">[number];
type ProbeResult = ChannelResponse<"harness:test">;
type Draft = ChannelRequest<"harness:save">;

const EMPTY: Draft = { displayName: "", command: "", args: [] };
/** A field the agent did not advertise is not a failure (RQ-0001#AC-6). */
const NONE = "not advertised";

const names = (info: { name: string; version: string } | null): string =>
  info ? `${info.name} ${info.version}` : NONE;

const field =
  "w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
const button =
  "rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

export interface Harnesses {
  /** `null` until the first read lands. */
  harnesses: Harness[] | null;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Called **once**, by `App`, and passed down. Two copies of this hook are two answers to "is a
 * harness attached?", and the first-run prompt reads one while the settings list writes the other.
 */
export function useHarnesses(): Harnesses {
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setHarnesses(await window.aibuildos.invoke("harness:list", undefined));
      setError(null);
    } catch (cause) {
      setError(message(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { harnesses, error, refresh };
}

/** Anything crossing IPC arrives as an unknown rejection; the user still has to be told. */
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The add/edit form. Presets prefill it; every field stays editable (RQ-0001#AC-3). */
function HarnessForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Draft;
  onSaved: () => void;
  onCancel?: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await window.aibuildos.invoke("harness:save", draft);
      onSaved();
    } catch (cause) {
      // Without this the dialog silently flips back to "Save harness" — and it has no dismiss.
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      data-testid="harness-form"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <span className="self-center text-xs text-neutral-500">Start from</span>
        {HARNESS_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid={`preset-${preset.id}`}
            className={button}
            onClick={() =>
              setDraft((current) => ({
                ...current,
                displayName: preset.displayName,
                command: preset.command,
                args: [...preset.args],
                // The supervision mapping is prefill like everything else here (RQ-0050#AC-2), and
                // it is saved onto the record: the id this harness ends up with is minted, so
                // nothing downstream can look the preset back up. A preset that maps nothing
                // spreads nothing rather than an explicit `undefined`.
                ...(preset.supervisionOptions === undefined
                  ? {}
                  : { supervisionOptions: preset.supervisionOptions }),
              }))
            }
          >
            {preset.displayName}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Name
        <input
          data-testid="harness-name"
          className={field}
          value={draft.displayName}
          onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Command
        <input
          data-testid="harness-command"
          className={field}
          placeholder="npx"
          value={draft.command}
          onChange={(event) => setDraft({ ...draft, command: event.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Arguments (one per line)
        <textarea
          data-testid="harness-args"
          className={`${field} font-mono`}
          rows={3}
          value={draft.args.join("\n")}
          onChange={(event) =>
            setDraft({ ...draft, args: event.target.value.split("\n").filter(Boolean) })
          }
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-neutral-500">
        Working directory (optional)
        <input
          data-testid="harness-cwd"
          className={field}
          value={draft.cwd ?? ""}
          onChange={(event) => setDraft({ ...draft, cwd: event.target.value || undefined })}
        />
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          data-testid="harness-save"
          className={button}
          disabled={saving || draft.displayName === "" || draft.command === ""}
        >
          {saving ? "Saving…" : "Save harness"}
        </button>
        {onCancel && (
          <button type="button" className={button} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      {error && (
        <p data-testid="harness-error" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}

/** What the probe found, in the shape the user asked the question in (RQ-0001#AC-6, AC-7). */
function ProbeReport({ result }: { result: ProbeResult }): React.JSX.Element {
  if (result.ok) {
    const rows: [string, string][] = [
      ["reply", result.reply || "(no text)"],
      ["agent", names(result.agentInfo)],
      ["protocol", `v${result.protocolVersion}`],
      ["stop reason", result.stopReason],
      ["capabilities", result.agentCapabilities ? JSON.stringify(result.agentCapabilities) : NONE],
      ["auth methods", result.authMethods.map((m) => m.name).join(", ") || "none required"],
    ];
    return (
      <dl data-testid="probe-ok" className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-neutral-500">{label}</dt>
            <dd className="break-all">{value}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }

  // Needing to log in is a working harness in the wrong state, not a broken one.
  const amber = result.code === "auth_required";
  return (
    <div data-testid="probe-failed" className="text-xs">
      <p className={amber ? "text-amber-600" : "text-red-600"}>
        <span className="font-medium">
          {amber ? "Authentication required" : `Failed at ${result.stage}`}
        </span>{" "}
        — {result.message} <span className="text-neutral-500">({result.code})</span>
      </p>
      {amber && result.authMethods.length > 0 && (
        <p className="mt-1 text-neutral-500">
          Offers: {result.authMethods.map((method) => method.name).join(", ")}
        </p>
      )}
      {result.stderr && (
        <pre className="mt-2 max-h-32 overflow-auto rounded bg-neutral-100 p-2 font-mono dark:bg-neutral-900">
          {result.stderr}
        </pre>
      )}
    </div>
  );
}

/** Renders an IPC rejection through the same report the probe's own failures use. */
function failure(what: string, cause: unknown): ProbeResult {
  return {
    ok: false,
    stage: "spawn",
    code: "ipc_failed",
    message: `${what}: ${message(cause)}`,
    stderr: "",
    authMethods: [],
  };
}

function HarnessRow({ harness, onChanged }: { harness: Harness; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const test = async (): Promise<void> => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await window.aibuildos.invoke("harness:test", { id: harness.id }));
    } catch (cause) {
      setResult(failure("could not run the test", cause));
    } finally {
      setTesting(false);
    }
  };

  const remove = async (): Promise<void> => {
    try {
      await window.aibuildos.invoke("harness:remove", { id: harness.id });
      onChanged();
    } catch (cause) {
      setResult(failure("could not remove this harness", cause));
    }
  };

  return (
    <li
      data-testid="harness-row"
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium">{harness.displayName}</p>
          <p className="truncate font-mono text-xs text-neutral-500">
            {harness.command} {harness.args.join(" ")}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            data-testid="harness-test"
            className={button}
            onClick={() => void test()}
            disabled={testing}
          >
            {testing ? "Testing…" : "Test"}
          </button>
          <button type="button" className={button} onClick={() => setEditing((open) => !open)}>
            {editing ? "Close" : "Edit"}
          </button>
          <button
            type="button"
            data-testid="harness-remove"
            className={button}
            onClick={() => void remove()}
          >
            Remove
          </button>
        </div>
      </div>

      {testing && (
        <p className="mt-3 text-xs text-neutral-500">
          Spawning the agent and sending a prompt — this calls the model.
        </p>
      )}
      {result && (
        <div className="mt-3">
          <ProbeReport result={result} />
        </div>
      )}

      {editing && (
        <div className="mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <HarnessForm
            initial={harness}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
          />
        </div>
      )}
    </li>
  );
}

export function HarnessPanel({ harnesses, error, refresh }: Harnesses): React.JSX.Element {
  const [adding, setAdding] = useState(false);

  return (
    <section className="flex w-full max-w-2xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Harnesses</h2>
        <button
          type="button"
          data-testid="harness-add"
          className={button}
          onClick={() => setAdding((open) => !open)}
        >
          {adding ? "Cancel" : "Add harness"}
        </button>
      </div>

      <p className="text-sm text-neutral-500">
        A harness is a coding agent aiBuildOS drives over ACP. It inherits this application's
        environment, so an agent CLI you have already logged into works as-is.
      </p>

      {adding && (
        <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <HarnessForm
            initial={EMPTY}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              void refresh();
            }}
          />
        </div>
      )}

      {error !== null ? (
        <p data-testid="harness-list-error" className="text-sm text-red-600">
          Could not read the harness list — {error}
        </p>
      ) : harnesses === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : harnesses.length === 0 ? (
        <p data-testid="harness-empty" className="text-sm text-neutral-500">
          No harness attached yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {harnesses.map((harness) => (
            <HarnessRow key={harness.id} harness={harness} onChanged={() => void refresh()} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The first-run prompt (RQ-0001#AC-4). Open when the harness list is empty — an empty list *is* the
 * first run, so there is no persisted flag to drift out of sync with reality.
 */
export function AttachHarnessDialog({
  open,
  onAttached,
}: {
  open: boolean;
  onAttached: () => void;
}): React.JSX.Element {
  return (
    <Dialog.Root open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="attach-dialog"
          className="fixed top-1/2 left-1/2 w-[32rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
        >
          <Dialog.Title className="text-lg font-semibold tracking-tight">
            Attach a coding harness
          </Dialog.Title>
          <Dialog.Description className="mt-1 mb-4 text-sm text-neutral-500">
            aiBuildOS drives coding agents over ACP. Pick one of the agents it ships support for, or
            point it at your own command.
          </Dialog.Description>
          <HarnessForm initial={EMPTY} onSaved={onAttached} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
