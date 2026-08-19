import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { button, field, mono, primary } from "../ui.js";

/**
 * Creating a project (ST-0003).
 *
 * Location first, then the name — and the location is a *native picker*, not a text field, so nobody
 * has to type a path (RQ-0002#AC-6). The chosen folder is shown before anything is written, which is
 * why the picker is its own IPC channel instead of a step hidden inside creating.
 */
export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}): React.JSX.Element {
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const reset = (): void => {
    setParentDir(null);
    setName("");
    setProblem(null);
  };

  const choose = async (): Promise<void> => {
    setProblem(null);
    try {
      const { path } = await window.aibuildos.invoke("project:choose-directory", {
        title: "Where should the project live?",
      });
      if (path !== null) setParentDir(path);
    } catch (cause) {
      // Without this the button looks broken: the rejection is swallowed by `void choose()` and
      // nothing on screen changes. `LaunchPage.addExisting` wraps the same call for the same reason.
      setProblem(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const create = async (): Promise<void> => {
    if (parentDir === null) return;

    setCreating(true);
    setProblem(null);
    try {
      const result = await window.aibuildos.invoke("project:create", { parentDir, name });
      if (result.ok) {
        reset();
        onCreated(result.project.id);
      } else {
        setProblem(result.message);
      }
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="new-project-dialog"
          className="fixed top-1/2 left-1/2 w-[32rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
        >
          <Dialog.Title className="text-lg font-semibold tracking-tight">New project</Dialog.Title>
          <Dialog.Description className="mt-1 mb-4 text-sm text-neutral-500">
            aiBuildOS creates the folder, makes it a Git repository, and starts its record.
          </Dialog.Description>

          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="flex flex-col gap-1">
              <span className="text-xs text-neutral-500">Location</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="project-choose-location"
                  className={button}
                  onClick={() => void choose()}
                >
                  Choose folder…
                </button>
                <span
                  data-testid="project-location"
                  className={`min-w-0 flex-1 truncate text-xs ${mono} ${
                    parentDir === null ? "text-neutral-500" : ""
                  }`}
                  title={parentDir ?? ""}
                >
                  {parentDir ?? "no folder chosen"}
                </span>
              </div>
            </div>

            <label className="flex flex-col gap-1 text-xs text-neutral-500">
              Name
              <input
                data-testid="project-name"
                className={field}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="my-project"
              />
            </label>

            {parentDir !== null && name !== "" && (
              <p className={`text-xs text-neutral-500 ${mono}`} data-testid="project-preview">
                {parentDir}/{name}
              </p>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                data-testid="project-create"
                className={primary}
                disabled={creating || parentDir === null || name.trim() === ""}
              >
                {creating ? "Creating…" : "Create project"}
              </button>
              <Dialog.Close asChild>
                <button type="button" className={button}>
                  Cancel
                </button>
              </Dialog.Close>
            </div>

            {problem && (
              <p data-testid="project-create-error" className="text-xs text-red-600">
                {problem}
              </p>
            )}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
