import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ProjectSchema } from "@aibuildos/ipc";

/**
 * The project registry (ST-0003, TC-0005). Plain JSON on disk, `node:fs`, no store library — the same
 * shape as `harnesses.ts`, for the same reasons.
 *
 * The file path is a **parameter**, not something this module looks up: that is what lets it be
 * tested on Node with a temp directory and no Electron runtime, and what lets the end-to-end test
 * point the app at an empty registry. `ipc.ts` supplies the real path.
 *
 * A registry entry is a **reference, never a copy**. The directory on disk is the project; this record
 * is only how the app finds it again, which is why forgetting a project cannot delete anything
 * (RQ-0002#AC-9).
 */
export type Project = ReturnType<typeof ProjectSchema.parse>;

const ProjectsSchema = ProjectSchema.array();

/**
 * `[]` for a file that is not there — a fresh install — and `null` for one that is there but cannot
 * be read as project configuration. Reads treat both as empty; writes must not.
 */
function read(file: string): Project[] | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  try {
    return ProjectsSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * A missing or unreadable file is an empty list, never a throw. The alternative is an app that cannot
 * start because of one bad character in a config file nobody remembers editing.
 */
export function loadProjects(file: string): Project[] {
  return read(file) ?? [];
}

/**
 * The same read, for the paths that write back.
 *
 * Reading a corrupt file as empty and then saving over it deletes every project in it — silently,
 * because the app looks like a fresh install right up until the write lands. Refusing keeps the file
 * exactly as it is, and the renderer shows the user why.
 */
function readForWrite(file: string): Project[] {
  const projects = read(file);
  if (projects === null) {
    throw new Error(
      `${file} exists but is not valid project configuration. ` +
        "Move it aside or fix it by hand — saving would overwrite it.",
    );
  }
  return projects;
}

/**
 * One path, one identity.
 *
 * `realpathSync` first, because a symlinked home directory would otherwise register the same folder
 * twice under two names; `resolve` as the fallback for a path that does not exist yet, which also
 * strips a trailing separator. Neither is case-folded.
 *
 * ponytail: exact compare after realpath. Add case-folding if someone hits it on APFS or NTFS.
 */
function identity(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Register a directory, or return the project already registered for it (RQ-0002#AC-12).
 *
 * Idempotent on path rather than an error: the user asked to work on that folder, and afterwards they
 * are. Growing the list with a second entry for one directory would be the surprising outcome.
 */
export function addProject(file: string, project: Omit<Project, "id" | "lastOpened">): Project {
  const projects = readForWrite(file);

  const target = identity(project.path);
  const existing = projects.find((candidate) => identity(candidate.path) === target);
  if (existing) return existing;

  const added: Project = { ...project, id: randomUUID(), lastOpened: null };
  projects.push(added);
  write(file, projects);
  return added;
}

/** Record that a project was opened. Returns the updated record, or `undefined` if it is unknown. */
export function markOpened(file: string, id: string, at: string): Project | undefined {
  const projects = readForWrite(file);
  const index = projects.findIndex((project) => project.id === id);

  const project = projects[index];
  if (index === -1 || project === undefined) return undefined;

  const opened: Project = { ...project, lastOpened: at };
  projects[index] = opened;
  write(file, projects);
  return opened;
}

/** Forget a project. Touches the registry and nothing else — never the directory (RQ-0002#AC-9). */
export function removeProject(file: string, id: string): void {
  write(
    file,
    readForWrite(file).filter((project) => project.id !== id),
  );
}

function write(file: string, projects: Project[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
}
