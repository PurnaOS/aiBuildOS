import { statSync } from "node:fs";
import { join } from "node:path";
import { probeHarness } from "@aibuildos/acp/probe";
import { createRouter, type Handlers, type IpcMainLike } from "@aibuildos/ipc";
import { loadBundle, summarize } from "@aibuildos/knowledge-engine/load";
import { app, BrowserWindow, dialog } from "electron";
import { GitError, type GitStatus, initRepo, recentCommits, repoRoot, status } from "./git.js";
import { loadHarnesses, removeHarness, saveHarness } from "./harnesses.js";
import { addProject, loadProjects, markOpened, type Project, removeProject } from "./projects.js";
import { claimProjectDirectory, fillProject } from "./scaffold.js";

/**
 * Bind the IPC contract to Electron's ipcMain.
 *
 * `createRouter` takes a structural `IpcMainLike`, so this file is the only place that knows about
 * Electron at all — which is what lets the router itself be tested without it (DC-0006).
 *
 * This is also where the stores get their paths and where agents are spawned: the renderer never
 * holds a child process, and ACP is the only door to AI (DC-0007).
 */
function harnessFile(): string {
  return process.env.AIBUILDOS_HARNESSES_FILE ?? join(app.getPath("userData"), "harnesses.json");
}

/** How much history the project view shows. A constant until something needs to vary it. */
const RECENT_COMMITS = 10;

function projectFile(): string {
  return process.env.AIBUILDOS_PROJECTS_FILE ?? join(app.getPath("userData"), "projects.json");
}

/** A directory that is there *and* is a directory. A file where a project should be is not a project. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Turn an expected failure into the wire shape (ST-0003#AC-8).
 *
 * Thrown handler errors reach the renderer as "Error invoking remote method ...", which is not a
 * sentence to show anyone, so everything a user can provoke comes back as data instead.
 */
function failure(cause: unknown): { ok: false; code: string; message: string } {
  if (cause instanceof GitError) return { ok: false, code: cause.code, message: cause.message };

  const code = (cause as { code?: unknown }).code;
  const message = cause instanceof Error ? cause.message : String(cause);

  if (code === "EEXIST") {
    return { ok: false, code: "path_exists", message: `${message} — pick a different name.` };
  }
  if (code === "EACCES" || code === "EPERM") {
    return {
      ok: false,
      code: "not_writable",
      message: `${message} — that location is not writable.`,
    };
  }
  if (code === "ENOTDIR") return { ok: false, code: "not_a_directory", message };
  if (code === "ENOENT") return { ok: false, code: "not_found", message };

  return { ok: false, code: "failed", message };
}

type RecordSummary = {
  artifacts: number;
  indexes: number;
  byType: Record<string, number>;
  byState: Record<string, number>;
  parseErrors: number;
};

/**
 * The OKF record summary (ST-0005#AC-6).
 *
 * `{ record: null, recordError: null }` means the project has no bundle; a `recordError` means it has
 * one this process could not walk — an unreadable directory, a symlink loop. The walk uses bare
 * `readdirSync`/`readFileSync`, so it *can* throw, and letting that escape would discard the Git
 * reading that already succeeded and leave the whole project unopenable. Git and the record fail
 * independently, which is what `ProjectSnapshotSchema` promises.
 */
function readRecord(path: string): {
  record: RecordSummary | null;
  recordError: { code: string; message: string } | null;
} {
  const root = join(path, "docs");
  if (!isDirectory(root)) return { record: null, recordError: null };

  try {
    // ponytail: re-walks docs/ on every open. Add an mtime cache if a large bundle makes it visible.
    const { bundle, parseErrors } = loadBundle(root, path);
    return {
      record: { ...summarize(bundle), parseErrors: parseErrors.length },
      recordError: null,
    };
  } catch (cause) {
    const { code, message } = failure(cause);
    return { record: null, recordError: { code, message } };
  }
}

/** Branch and working-tree counts for one row of the launch page. Never throws — a row is not fatal. */
async function rowFacts(project: Project): Promise<{
  exists: boolean;
  branch: string | null;
  dirty: number | null;
}> {
  if (!isDirectory(project.path)) return { exists: false, branch: null, dirty: null };

  try {
    const tree = await status(project.path);
    return { exists: true, branch: tree.branch, dirty: dirtyCount(tree) };
  } catch {
    // Git missing, or the directory is not a repository. The row still lists; the project view is
    // where the reason gets explained.
    return { exists: true, branch: null, dirty: null };
  }
}

function dirtyCount(tree: GitStatus): number {
  // `changed`, not the sum of the counters: a path that is both staged and unstaged is one change.
  return tree.changed;
}

const handlers: Handlers = {
  "app:info": () => ({
    name: "aiBuildOS",
    version: app.getVersion(),
    runtime: {
      node: process.versions.node,
      ...(process.versions.electron === undefined ? {} : { electron: process.versions.electron }),
      ...(process.versions.chrome === undefined ? {} : { chrome: process.versions.chrome }),
    },
  }),

  "harness:list": () => loadHarnesses(harnessFile()),

  "harness:save": (harness) => saveHarness(harnessFile(), harness),

  "harness:remove": ({ id }) => removeHarness(harnessFile(), id),

  "harness:test": async ({ id }) => {
    const harness = loadHarnesses(harnessFile()).find((candidate) => candidate.id === id);
    if (!harness) {
      return {
        ok: false,
        stage: "spawn",
        code: "unknown_harness",
        message: `no harness with id ${id}`,
        stderr: "",
        authMethods: [],
      };
    }

    return await probeHarness(harness, {
      cwd: harness.cwd ?? app.getPath("home"),
      clientVersion: app.getVersion(),
    });
  },

  "project:list": async () => {
    const projects = loadProjects(projectFile());
    // One Git read per row, concurrently. `status --porcelain=v2 --branch` answers both questions in
    // a single invocation, which is what makes this affordable at all.
    const facts = await Promise.all(projects.map(rowFacts));
    return projects.map((project, index) => ({
      ...project,
      // biome-ignore lint/style/noNonNullAssertion: same length by construction.
      ...facts[index]!,
    }));
  },

  /**
   * The native picker. `dialog.showOpenDialog` is called as a **property of `dialog`**, never
   * destructured: TC-0008 replaces it on the module object from the test process, and a destructured
   * reference would keep pointing at the real one and hang the suite on a window nobody can click.
   */
  "project:choose-directory": async ({ title }) => {
    const parent = BrowserWindow.getFocusedWindow();
    const options = {
      title: title ?? "Choose a folder",
      properties: ["openDirectory" as const, "createDirectory" as const],
    };

    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);

    const [path] = result.filePaths;
    return { path: result.canceled || path === undefined ? null : path };
  },

  "project:create": async ({ parentDir, name }) => {
    if (!isDirectory(parentDir)) {
      return { ok: false, code: "not_a_directory", message: `${parentDir} is not a folder.` };
    }

    let path: string;
    try {
      path = claimProjectDirectory(parentDir, name);
    } catch (cause) {
      return failure(cause);
    }

    // Registered the moment the directory is real, *before* the steps that can fail. Otherwise a
    // failed first commit — the ordinary state of a machine with no Git identity configured — leaves
    // a folder the app created, refuses to list, and then refuses to create again as `path_exists`.
    const project = addProject(projectFile(), { name, path });

    try {
      await fillProject(path, name);
      return { ok: true, project };
    } catch (cause) {
      return failure(cause);
    }
  },

  "project:add": async ({ path }) => {
    if (!isDirectory(path)) {
      return { ok: false, code: "not_found", message: `${path} is not a folder.` };
    }

    try {
      // A subdirectory of an existing repository must not become a nested repository, so ask Git
      // where the root is rather than looking for a `.git` entry (RQ-0002#AC-5).
      if ((await repoRoot(path)) === null) await initRepo(path);

      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      return { ok: true, project: addProject(projectFile(), { name, path }) };
    } catch (cause) {
      return failure(cause);
    }
  },

  "project:remove": ({ id }) => removeProject(projectFile(), id),

  "project:open": async ({ id }) => {
    const file = projectFile();
    // An unknown id is a renderer bug, not something a user did, so it throws rather than earning a
    // wire code of its own.
    const project = markOpened(file, id, new Date().toISOString());
    if (!project) throw new Error(`no project with id ${id}`);

    if (!isDirectory(project.path)) {
      return { project, exists: false, git: null, gitError: null, record: null, recordError: null };
    }

    let git = null;
    let gitError = null;
    try {
      const tree = await status(project.path);
      git = { ...tree, commits: await recentCommits(project.path, RECENT_COMMITS) };
    } catch (cause) {
      const { code, message } = failure(cause);
      gitError = { code, message };
    }

    return { project, exists: true, git, gitError, ...readRecord(project.path) };
  },
};

export function registerIpc(ipcMain: IpcMainLike): void {
  createRouter(ipcMain, handlers);
}
