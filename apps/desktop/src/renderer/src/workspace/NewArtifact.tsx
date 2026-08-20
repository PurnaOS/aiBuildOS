import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { button, eyebrow, field, focusRing, primary } from "../ui.js";

/**
 * Minting an artifact (ST-0017#AC-2, AC-6).
 *
 * The types offered are the project's own, read from its profile as the panel opens. A project with
 * no profile is told it cannot mint artifacts here rather than being handed this repository's
 * vocabulary — someone else's taxonomy silently applied to your record is worse than no button.
 *
 * The number is not asked for. It is append-only and never reused, which makes it a property of the
 * bundle rather than a decision for whoever is typing.
 */
interface ArtifactType {
  type: string;
  prefix: string;
  dir: string;
}

export function NewArtifact({
  projectId,
  onCreated,
}: {
  projectId: string;
  /** Handed the ID that was allocated, so the workspace can open it without looking it up again. */
  onCreated: (artifactId: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<ArtifactType[] | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;

    void window.aibuildos
      .invoke("project:artifact-types", { id: projectId })
      .then((next) => {
        if (!live) return;
        setTypes(next.types);
        setUnavailable(next.problem);
        setType((current) => current || (next.types[0]?.type ?? ""));
      })
      .catch(() => {
        if (live) setUnavailable("The project's types could not be read.");
      });

    return () => {
      live = false;
    };
  }, [open, projectId]);

  const create = async (): Promise<void> => {
    setCreating(true);
    try {
      const result = await window.aibuildos.invoke("project:create-artifact", {
        id: projectId,
        type,
        title,
      });
      setProblem(result.problem);
      if (result.artifactId !== null) {
        onCreated(result.artifactId);
        setOpen(false);
        setTitle("");
      }
    } finally {
      setCreating(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        data-testid="new-artifact"
        aria-label="New artifact"
        onClick={() => setOpen(true)}
        className={`text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
      >
        <Plus size={13} aria-hidden />
      </button>
    );
  }

  return (
    <div
      data-testid="new-artifact-form"
      className="absolute top-8 right-2 left-2 z-10 rounded border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
    >
      {unavailable !== null ? (
        <p data-testid="new-artifact-unavailable" className="text-[11px] text-neutral-500">
          {unavailable}
        </p>
      ) : types === null ? (
        <p className="text-[11px] text-neutral-500">Loading…</p>
      ) : (
        <>
          <p className={`mb-1 ${eyebrow}`}>type</p>
          <select
            data-testid="new-artifact-type"
            className={field}
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            {types.map((candidate) => (
              <option key={candidate.type} value={candidate.type}>
                {candidate.type} · {candidate.prefix}
              </option>
            ))}
          </select>

          <p className={`mt-2 mb-1 ${eyebrow}`}>title</p>
          <input
            data-testid="new-artifact-title"
            className={field}
            value={title}
            placeholder="What it is"
            onChange={(event) => setTitle(event.target.value)}
          />
        </>
      )}

      {problem !== null && (
        <p data-testid="new-artifact-problem" className="mt-1.5 text-[11px] text-red-600">
          {problem}
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          data-testid="new-artifact-create"
          disabled={creating || title.trim() === "" || type === ""}
          onClick={() => void create()}
          className={`${primary} ${focusRing} disabled:opacity-40`}
        >
          {creating ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          data-testid="new-artifact-cancel"
          onClick={() => {
            setOpen(false);
            setProblem(null);
          }}
          className={`${button} ${focusRing}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Starting a file: a path, and nothing else (ST-0017#AC-1, ST-0020#AC-2).
 *
 * Whether it is open, and which directory it starts in, belong to the rail — the same form is opened
 * by the `+` in the header and by the tree's own context menu, and only the rail knows which row was
 * pointed at.
 */
export function NewFile({
  projectId,
  creating,
  onOpen,
  onClose,
  onCreated,
}: {
  projectId: string;
  /** Open when set, carrying the directory the file will be made in. `""` is the project root. */
  creating: { directory: string } | null;
  onOpen: () => void;
  onClose: () => void;
  onCreated: (path: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const directory = creating?.directory ?? "";
  const path = directory === "" ? name : `${directory}/${name}`;

  const create = async (): Promise<void> => {
    const { problem: failed } = await window.aibuildos
      .invoke("project:create-file", { id: projectId, path })
      // A path the schema itself rejects never reaches main; that refusal is this one too.
      .catch(() => ({ problem: `${path} is not a path inside this project.` }));

    setProblem(failed);
    if (failed === null) {
      onCreated(path);
      onClose();
      setName("");
    }
  };

  if (creating === null) {
    return (
      <button
        type="button"
        data-testid="new-file"
        aria-label="New file"
        onClick={onOpen}
        className={`text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
      >
        <Plus size={13} aria-hidden />
      </button>
    );
  }

  return (
    <div
      data-testid="new-file-form"
      className="absolute top-8 right-2 left-2 z-10 rounded border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
    >
      <p className={`mb-1 ${eyebrow}`}>
        {directory === "" ? "path in this project" : `name, in ${directory}`}
      </p>
      <input
        data-testid="new-file-path"
        className={field}
        value={name}
        placeholder={directory === "" ? "src/thing.ts" : "thing.ts"}
        onChange={(event) => setName(event.target.value)}
      />

      {problem !== null && (
        <p data-testid="new-file-problem" className="mt-1.5 text-[11px] text-red-600">
          {problem}
        </p>
      )}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          data-testid="new-file-create"
          disabled={name.trim() === ""}
          onClick={() => void create()}
          className={`${primary} ${focusRing} disabled:opacity-40`}
        >
          Create
        </button>
        <button
          type="button"
          data-testid="new-file-cancel"
          onClick={() => {
            onClose();
            setProblem(null);
          }}
          className={`${button} ${focusRing}`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
