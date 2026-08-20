import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { probeHarness } from "@aibuildos/acp/probe";
import {
  createEmitter,
  createRouter,
  type EventSenderLike,
  type Handlers,
  type IpcMainLike,
} from "@aibuildos/ipc";
import {
  ArtifactGraph,
  criteriaRefusal,
  editArtifact,
  type GraphNode,
  insertIndexRow,
  legalNextStates,
  nextId,
  type Profile,
  parseOkfDocument,
  resolveProfile,
  scaffoldArtifact,
  transitionRefusal,
  updateIndexRow,
  validate,
} from "@aibuildos/knowledge-engine";
import { loadBundle, summarize } from "@aibuildos/knowledge-engine/load";
import { app, BrowserWindow, dialog, Menu, nativeTheme } from "electron";
import {
  changes,
  GitError,
  type GitStatus,
  git,
  ignored,
  initRepo,
  recentCommits,
  repoRoot,
  status,
} from "./git.js";
import { loadHarnesses, removeHarness, saveHarness } from "./harnesses.js";
import { fileMenuTarget } from "./menus.js";
import { seedPlaybooks } from "./playbooks.js";
import { addProject, loadProjects, markOpened, type Project, removeProject } from "./projects.js";
import { claimProjectDirectory, fillProject } from "./scaffold.js";
import { SessionRegistry } from "./sessions.js";
import { DEFAULTS, readSettings, saveSettings, settingsFile } from "./settings.js";

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

/**
 * Resolve a path inside a project, refusing anything that lands outside it.
 *
 * The second half of the defence the contract's `RepoPathSchema` begins. A string check cannot see a
 * **symlink**: `docs/out` may be a perfectly ordinary relative path that points at `/`. Resolving
 * both sides through `realpath` and comparing is the only answer that survives one.
 *
 * The target may not exist yet — a file being saved for the first time — so the nearest existing
 * ancestor is what gets resolved, and the rest is appended to it.
 */
function insideProject(root: string, path: string): string {
  const target = resolve(root, path);

  let existing = target;
  const trailing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    // Ran out of path without finding anything: nothing here is inside the project.
    if (parent === existing) throw new Error(`${path} is not inside this project`);
    trailing.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }

  const real = join(realpathSync(existing), ...trailing);
  const away = relative(realpathSync(root), real);
  if (away.startsWith("..") || isAbsolute(away)) {
    throw new Error(`${path} is not inside this project`);
  }
  return real;
}

/**
 * Load the type profile beside a bundle.
 *
 * `loadBundle` skips `profile/` because it holds type definitions rather than artifacts, so the
 * dialect is read separately — by the engine, which is the only thing allowed to parse `docs/`.
 */
/** Today, as the conventions write a date. Local, because it is the author's own calendar day. */
function today(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function loadProfile(root: string): { profile: Profile } {
  const dir = join(root, "profile");
  if (!isDirectory(dir)) return { profile: resolveProfile([]).profile };

  const raw = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .flatMap((name) => {
      try {
        const parsed = parseOkfDocument(readFileSync(join(dir, name), "utf8"));
        return [{ file: name, frontmatter: parsed.frontmatter }];
      } catch {
        // A profile document that will not parse is reported by `docs:check`, not by the editor.
        return [];
      }
    });

  return { profile: resolveProfile(raw).profile };
}

/**
 * The findings for one artifact, each tied to the frontmatter key that caused it where possible.
 *
 * A finding carries a line; `keyLines` maps a key to its line. Inverting that is what turns "this
 * file is wrong" into "this field is wrong", which is the difference between a validator and an
 * editor (RQ-0005#AC-9).
 */
function findingsFor(
  bundle: Parameters<typeof validate>[0],
  profile: Profile,
  file: string,
  keyLines: ReadonlyMap<string, number>,
): { rule: string; severity: string; message: string; key: string | null }[] {
  const byLine = new Map([...keyLines].map(([key, line]) => [line, key]));

  return validate(bundle, profile)
    .filter((finding) => finding.file === file)
    .map((finding) => ({
      rule: finding.rule,
      severity: finding.severity,
      message: finding.message,
      key: finding.line === undefined ? null : (byLine.get(finding.line) ?? null),
    }));
}

/** Every handler that works on a project starts here. An unknown id is a renderer bug. */
function requireProject(id: string) {
  const project = loadProjects(projectFile()).find((candidate) => candidate.id === id);
  if (!project) throw new Error(`no project with id ${id}`);
  return project;
}

function createHandlers(sessions: SessionRegistry): Handlers {
  return {
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
        return {
          project,
          exists: false,
          git: null,
          gitError: null,
          record: null,
          recordError: null,
        };
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

    "project:record": ({ id }) => {
      const project = requireProject(id);
      const root = join(project.path, "docs");
      if (!isDirectory(root)) return { artifacts: null, problem: null };

      try {
        const { bundle } = loadBundle(root, project.path);

        // The engine builds a graph only inside `validate` today, so the rail builds its own. Three
        // lines, and it is what turns stored links into the reverse the rail actually shows.
        const nodes: GraphNode[] = bundle.artifacts.flatMap((artifact) => {
          const {
            id: artifactId,
            type,
            links,
          } = artifact.frontmatter as {
            id?: unknown;
            type?: unknown;
            links?: unknown;
          };
          if (typeof artifactId !== "string" || typeof type !== "string") return [];
          return [{ id: artifactId, type, links: (links ?? {}) as Record<string, string[]> }];
        });
        const graph = new ArtifactGraph(nodes);

        const artifacts = bundle.artifacts.flatMap((artifact) => {
          const front = artifact.frontmatter as Record<string, unknown>;
          const artifactId = front.id;
          if (typeof artifactId !== "string") return [];

          return [
            {
              id: artifactId,
              type: typeof front.type === "string" ? front.type : "",
              title: typeof front.title === "string" ? front.title : artifactId,
              state: typeof front.state === "string" ? front.state : "",
              file: artifact.file,
              // Deduplicated: a test that verifies two criteria of one requirement
              // (`verifies: [RQ-0004#AC-3, RQ-0004#AC-18]`) is one relationship, not two. The graph
              // flattens `#AC-n` to the artifact, so without this the rail lists it once per
              // criterion — four TC-0017s under one requirement.
              inbound: [
                ...new Map(
                  graph
                    .incoming(artifactId)
                    .map((edge) => [
                      `${edge.relationship}:${edge.from}`,
                      { relationship: edge.relationship, id: edge.from },
                    ]),
                ).values(),
              ],
            },
          ];
        });

        artifacts.sort((a, b) => a.id.localeCompare(b.id));
        return { artifacts, problem: null };
      } catch (cause) {
        return { artifacts: null, problem: failure(cause).message };
      }
    },

    "project:tree": async ({ id, path }) => {
      const project = requireProject(id);

      let root: string;
      try {
        root = insideProject(project.path, path);
      } catch (cause) {
        return { entries: [], problem: failure(cause).message };
      }
      if (!isDirectory(root)) return { entries: [], problem: `${path || "."} is not a folder.` };

      // Which paths Git says changed, so a row can be marked without asking per file.
      let changed = new Set<string>();
      try {
        const { entries } = await changes(project.path);
        changed = new Set(entries.map((entry) => entry.path));
      } catch {
        // No repository, or no Git. The tree still lists; it just says nothing about change.
      }

      try {
        const listed = readdirSync(root, { withFileTypes: true })
          // `.git` is machinery, not the project.
          .filter((entry) => entry.name !== ".git");

        const relativeOf = (name: string) => (path === "" ? name : `${path}/${name}`);
        // What the repository ignores, asked of Git so the answer matches the repository the user
        // actually has: `.gitignore` composes global, repo and nested rules, and a hand-rolled
        // matcher would disagree with the one thing that counts.
        const hidden = await ignored(
          project.path,
          listed.map((entry) => relativeOf(entry.name)),
        );

        const entries = listed
          .filter((entry) => !hidden.has(relativeOf(entry.name)))
          .map((entry) => {
            const relative = path === "" ? entry.name : `${path}/${entry.name}`;
            return {
              name: entry.name,
              path: relative,
              directory: entry.isDirectory(),
              changed: entry.isDirectory()
                ? [...changed].some((c) => c.startsWith(`${relative}/`))
                : changed.has(relative),
            };
          });

        // Folders first, then by name — the order a person expects, since `readdir` guarantees none.
        entries.sort((a, b) =>
          a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1,
        );
        return { entries, problem: null };
      } catch (cause) {
        return { entries: [], problem: failure(cause).message };
      }
    },

    "project:changes": async ({ id }) => {
      const project = requireProject(id);
      const empty = { staged: [], unstaged: [], untracked: [], commits: [] };

      if (!isDirectory(project.path)) {
        return { ...empty, problem: "That folder is not there any more." };
      }

      try {
        const { entries } = await changes(project.path);
        return {
          staged: entries
            .filter((entry) => !entry.untracked && entry.staged !== ".")
            .map((entry) => ({ path: entry.path, status: entry.staged })),
          unstaged: entries
            .filter((entry) => !entry.untracked && entry.unstaged !== ".")
            .map((entry) => ({ path: entry.path, status: entry.unstaged })),
          untracked: entries
            .filter((entry) => entry.untracked)
            .map((entry) => ({ path: entry.path, status: "?" })),
          commits: (await recentCommits(project.path, RECENT_COMMITS)).map((commit) => ({
            hash: commit.hash,
            subject: commit.subject,
            date: commit.date,
          })),
          problem: null,
        };
      } catch (cause) {
        return { ...empty, problem: failure(cause).message };
      }
    },

    "project:diff": async ({ id, path }) => {
      const project = requireProject(id);

      let absolute: string;
      try {
        absolute = insideProject(project.path, path);
      } catch (cause) {
        return { path, oldText: null, newText: "", problem: failure(cause).message };
      }

      // `HEAD:<path>` is the committed version. A path that is not in HEAD is new, and `null` says
      // so rather than pretending it used to be empty.
      let oldText: string | null = null;
      try {
        oldText = await git(project.path, "show", `HEAD:${path}`);
      } catch {
        oldText = null;
      }

      let newText = "";
      try {
        newText = readFileSync(absolute, "utf8");
      } catch (cause) {
        // Deleted in the working tree: there is still a previous version worth showing.
        if (oldText === null) {
          return { path, oldText: null, newText: "", problem: failure(cause).message };
        }
      }

      return { path, oldText, newText, problem: null };
    },

    "project:file": ({ id, path }) => {
      const project = requireProject(id);
      try {
        return { text: readFileSync(insideProject(project.path, path), "utf8"), problem: null };
      } catch (cause) {
        return { text: null, problem: failure(cause).message };
      }
    },

    "project:save": ({ id, path, text }) => {
      const project = requireProject(id);
      try {
        // Exactly what was shown, byte for byte. Nothing is appended, trimmed or normalised.
        writeFileSync(insideProject(project.path, path), text, "utf8");
        return { problem: null };
      } catch (cause) {
        return { problem: failure(cause).message };
      }
    },

    "project:artifact": ({ id, artifactId }) => {
      const project = requireProject(id);
      const empty = {
        markdown: null,
        frontmatter: {},
        body: "",
        states: [],
        links: [],
        findings: [],
      };

      const root = join(project.path, "docs");
      if (!isDirectory(root)) return { ...empty, problem: null };

      try {
        const { bundle } = loadBundle(root, project.path);
        const found = bundle.artifacts.find(
          (artifact) => (artifact.frontmatter as { id?: unknown }).id === artifactId,
        );
        if (!found) return { ...empty, problem: `${artifactId} is not in this bundle.` };

        const markdown = readFileSync(join(project.path, found.file), "utf8");
        const parsed = parseOkfDocument(markdown);
        const type = String((found.frontmatter as { type?: unknown }).type ?? "");

        const { profile } = loadProfile(root);
        const definition = profile.get(type);

        // The current state — so the control has something to show even when it is not one of the
        // type's own — plus exactly what its transitions declare from there, never the whole
        // vocabulary (RQ-0010#AC-1, AC-3, AC-5).
        const currentState = String((found.frontmatter as { state?: unknown }).state ?? "");
        const states = definition?.states
          ? [...new Set([currentState, ...legalNextStates(definition, currentState)])]
          : [];
        const stored = (found.frontmatter as { links?: Record<string, string[]> }).links ?? {};
        const links = Object.entries(definition?.links ?? {}).map(([relationship, def]) => ({
          relationship,
          current: stored[relationship] ?? [],
          candidates: bundle.artifacts
            .flatMap((candidate) => {
              const front = candidate.frontmatter as {
                id?: unknown;
                title?: unknown;
                type?: unknown;
              };
              if (typeof front.id !== "string" || typeof front.type !== "string") return [];
              if (front.id === artifactId) return [];
              // A link is satisfied by the target type or anything extending it (conventions §4).
              if (!def.target.some((target) => profile.isA(front.type as string, target)))
                return [];
              return [
                {
                  id: front.id,
                  title: typeof front.title === "string" ? front.title : front.id,
                  type: front.type,
                },
              ];
            })
            .sort((a, b) => a.id.localeCompare(b.id)),
        }));

        return {
          markdown,
          frontmatter: found.frontmatter,
          body: parsed.body,
          states,
          links,
          findings: findingsFor(bundle, profile, found.file, parsed.keyLines),
          problem: null,
        };
      } catch (cause) {
        return { ...empty, problem: failure(cause).message };
      }
    },

    "project:artifact-save": ({ id, artifactId, frontmatter, body }) => {
      const project = requireProject(id);
      const root = join(project.path, "docs");

      try {
        const { bundle } = loadBundle(root, project.path);
        const found = bundle.artifacts.find(
          (artifact) => (artifact.frontmatter as { id?: unknown }).id === artifactId,
        );
        if (!found) {
          return { problem: `${artifactId} is not in this bundle.`, markdown: null, findings: [] };
        }

        // The path comes from the bundle walk rather than from the renderer, so nothing untrusted
        // reaches it — but this is a write, and every write in this process is contained the same
        // way rather than each one arguing for itself (TC-0023).
        const file = insideProject(project.path, found.file);
        // The profile is what knows which relationships this type declares, so it is what vouches
        // for a link key the file does not carry yet. Anything else missing is still refused.
        const { profile: dialect } = loadProfile(root);
        const type = String((found.frontmatter as { type?: unknown }).type ?? "");
        const definition = dialect.get(type);
        const create = Object.keys(definition?.links ?? {}).map((rel) => `links.${rel}`);

        const before = readFileSync(file, "utf8");

        // This is the one place the previous state is known: read before the write, the same file
        // the write is about to change. That is what lets a transition be checked here at all
        // (RQ-0010).
        if (definition && typeof frontmatter.state === "string") {
          const currentState = String((found.frontmatter as { state?: unknown }).state ?? "");
          if (frontmatter.state !== currentState) {
            const refusal = transitionRefusal(definition, type, currentState, frontmatter.state);
            if (refusal !== null) return { problem: refusal, markdown: null, findings: [] };
          }
        }
        if (body !== undefined) {
          const refusal = criteriaRefusal(parseOkfDocument(before).body, body);
          if (refusal !== null) return { problem: refusal, markdown: null, findings: [] };
        }

        // Only the named keys and the body change; the rest of the file is byte-identical.
        const written = editArtifact(before, {
          frontmatter,
          ...(body === undefined ? {} : { body }),
          create,
        });
        writeFileSync(file, written, "utf8");

        // The record must not disagree with itself: the index says what the artifact says (AC-10).
        const indexFile = join(project.path, found.dir, "README.md");
        if (existsSync(indexFile)) {
          const contained = insideProject(project.path, join(found.dir, "README.md"));
          const title = frontmatter.title;
          const state = frontmatter.state;
          writeFileSync(
            contained,
            updateIndexRow(readFileSync(contained, "utf8"), artifactId, {
              ...(typeof title === "string" ? { title } : {}),
              ...(typeof state === "string" ? { state } : {}),
            }),
            "utf8",
          );
        }

        // Re-read so what comes back is what the bundle now says, not what was hoped for.
        const after = loadBundle(root, project.path);
        const parsed = parseOkfDocument(readFileSync(file, "utf8"));
        return {
          problem: null,
          markdown: written,
          findings: findingsFor(after.bundle, dialect, found.file, parsed.keyLines),
        };
      } catch (cause) {
        return { problem: failure(cause).message, markdown: null, findings: [] };
      }
    },

    "project:artifact-types": ({ id }) => {
      const project = requireProject(id);
      const root = join(project.path, "docs");
      if (!isDirectory(join(root, "profile"))) {
        return {
          types: [],
          problem: "This project has no OKF profile, so it has no artifact types to mint.",
        };
      }

      const { profile } = loadProfile(root);
      // Only what the profile declares, permits directly, and can put somewhere.
      const types = profile
        .names()
        .flatMap((name) => {
          const definition = profile.get(name);
          if (!definition || definition.abstract) return [];
          if (!definition.prefix || !definition.dir) return [];
          return [{ type: name, prefix: definition.prefix, dir: definition.dir }];
        })
        .sort((a, b) => a.type.localeCompare(b.type));

      return { types, problem: null };
    },

    "project:create-file": ({ id, path }) => {
      const project = requireProject(id);

      try {
        const file = insideProject(project.path, path);
        if (existsSync(file)) return { problem: `${path} already exists.` };

        mkdirSync(dirname(file), { recursive: true });
        // `wx` rather than a check and a write: between the two, something else could have created
        // it, and the point of refusing is that nothing of anyone's is overwritten.
        writeFileSync(file, "", { encoding: "utf8", flag: "wx" });
        return { problem: null };
      } catch (cause) {
        return { problem: failure(cause).message };
      }
    },

    "project:seed-playbooks": ({ id }) => {
      const project = requireProject(id);
      return { problem: seedPlaybooks(project.path) };
    },

    "project:create-artifact": async ({ id, type, title }) => {
      const project = requireProject(id);
      const root = join(project.path, "docs");

      try {
        const { profile } = loadProfile(root);
        const definition = profile.get(type);
        if (!definition?.prefix || !definition.dir) {
          return {
            artifactId: null,
            problem: `This project's profile has no \`${type}\` to mint.`,
          };
        }

        // The conventions require a git handle, and this application has no way to invent a real
        // one. Refusing names the setting rather than writing an empty field into the record.
        const owner = (await git(project.path, "config", "user.name").catch(() => "")).trim();
        if (owner === "") {
          return {
            artifactId: null,
            problem: "This repository has no `user.name` configured, so an artifact has no owner.",
          };
        }

        const { bundle } = loadBundle(root, project.path);
        const artifactId = nextId(
          bundle.artifacts.map((artifact) =>
            String((artifact.frontmatter as { id?: unknown }).id ?? ""),
          ),
          definition.prefix,
        );

        const file = insideProject(
          project.path,
          join("docs", definition.dir, `${artifactId.toLowerCase()}.md`),
        );
        const source = scaffoldArtifact(profile, {
          type,
          id: artifactId,
          title,
          owner,
          created: today(),
        });

        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, source, { encoding: "utf8", flag: "wx" });

        // Written with it: an artifact missing from its index is a validation error, so a creation
        // that skipped this would leave a broken bundle the moment it succeeded (AC-4).
        const indexFile = join(project.path, "docs", definition.dir, "README.md");
        if (existsSync(indexFile)) {
          const contained = insideProject(project.path, join("docs", definition.dir, "README.md"));
          const state = definition.states?.initial ?? "";
          writeFileSync(
            contained,
            insertIndexRow(
              readFileSync(contained, "utf8"),
              `| [${artifactId}](${artifactId.toLowerCase()}.md) | ${title} | ${state} | — |`,
            ),
            "utf8",
          );
        }

        return { artifactId, problem: null };
      } catch (cause) {
        return { artifactId: null, problem: failure(cause).message };
      }
    },

    "project:file-menu": async ({ path, directory }) => {
      const target = fileMenuTarget(path, directory);

      return await new Promise((resolve) => {
        let chosen: "new-file" | null = null;
        Menu.buildFromTemplate([
          {
            label: target === "" ? "New file…" : `New file in ${target}…`,
            click: () => {
              chosen = "new-file";
            },
          },
        ]).popup({
          // Resolved when the menu closes, however it closed: dismissal is an answer too, and it is
          // the one that does nothing.
          callback: () => resolve({ action: chosen, directory: target }),
        });
      });
    },

    "settings:get": () => {
      const stored = readSettings(settingsFile(app.getPath("userData")));
      const settings = stored ?? DEFAULTS;
      return {
        // What is in force, not what was persisted. The two can disagree — the appearance is applied
        // before it is written, so a failed write leaves the window changed and the file behind — and
        // a panel that reported the file would then show the wrong choice as current.
        appearance: nativeTheme.themeSource,
        sidebarCollapsed: settings.sidebarCollapsed,
        layout: settings.layout,
        problem:
          stored === null
            ? "Your settings file could not be read, so the appearance below is not what it says."
            : null,
      };
    },

    "settings:set-appearance": ({ appearance }) => {
      // Applied before it is written, so a disk that will not take the setting is a failure to
      // *remember* the choice rather than a failure to make it. `themeSource` changes
      // `prefers-color-scheme` in every renderer, so the media query the stylesheets already read
      // simply answers differently — there is nothing to hand back for the renderer to apply.
      nativeTheme.themeSource = appearance;
      const file = settingsFile(app.getPath("userData"));
      return saveSettings(file, { ...(readSettings(file) ?? DEFAULTS), appearance });
    },

    "settings:set-chrome": (chrome) => {
      const file = settingsFile(app.getPath("userData"));
      // Merged, so setting one piece of furniture does not forget another.
      return saveSettings(file, {
        ...(readSettings(file) ?? DEFAULTS),
        ...(chrome.sidebarCollapsed === undefined
          ? {}
          : { sidebarCollapsed: chrome.sidebarCollapsed }),
        ...(chrome.layout === undefined ? {} : { layout: chrome.layout }),
      });
    },

    "session:start": async ({ projectId, harnessId }) => {
      const project = loadProjects(projectFile()).find((candidate) => candidate.id === projectId);
      if (!project) {
        return {
          ok: false,
          code: "not_found",
          message: "that project is not registered.",
          authMethods: [],
        };
      }

      const harness = loadHarnesses(harnessFile()).find((candidate) => candidate.id === harnessId);
      if (!harness) {
        return {
          ok: false,
          code: "not_found",
          message: "that harness is not configured.",
          authMethods: [],
        };
      }

      // The session runs in the project, not in the harness's own working directory: the agent is
      // being asked to work on *this* repository.
      return await sessions.start(harness, project.path, app.getVersion());
    },

    "session:prompt": async ({ sessionId, text }) => await sessions.prompt(sessionId, text),

    "session:cancel": async ({ sessionId }) => {
      await sessions.cancel(sessionId);
    },

    "session:permission": ({ sessionId, requestId, optionId }) => {
      sessions.answerPermission(sessionId, requestId, optionId);
    },

    "session:controls": ({ sessionId }) => sessions.controlsOf(sessionId),

    "session:set-mode": async ({ sessionId, modeId }) => {
      await sessions.setMode(sessionId, modeId);
    },

    "session:set-config": async ({ sessionId, configId, value }) => {
      await sessions.setConfigOption(sessionId, configId, value);
    },

    "session:close": async ({ sessionId }) => {
      await sessions.close(sessionId);
    },
  };
}

/**
 * Bind the contract to Electron.
 *
 * `sender` is resolved on each emit rather than captured, because handlers are registered before the
 * window exists and the window can be replaced while the application runs. An event with nowhere to
 * go is dropped rather than thrown on: a session narrating into a closed window is not an error.
 */
export function registerIpc(
  ipcMain: IpcMainLike,
  sender: () => EventSenderLike | null,
): SessionRegistry {
  const emitter = createEmitter({
    send: (channel, payload) => sender()?.send(channel, payload),
  });

  const sessions = new SessionRegistry((event, payload) => emitter.emit(event, payload));
  createRouter(ipcMain, createHandlers(sessions));
  return sessions;
}
