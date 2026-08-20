import { z } from "zod";

/**
 * Zod compiles parsers with `new Function` by default. Electron's preload context — and the renderer
 * under this app's CSP — disallow code generation from strings, so the compiled parser throws
 * "Code generation from strings disallowed for this context" the first time a channel is validated
 * on the client side.
 *
 * `jitless` swaps in the interpreted path, which works everywhere. IPC payloads are small; the
 * difference is not measurable, and it is what keeps validation running on *both* ends of the
 * boundary rather than only in main (DC-0006).
 */
z.config({ jitless: true });

/**
 * The IPC contract: the single source of truth for the renderer↔main boundary (DC-0006).
 *
 * Every channel declares a Zod schema for its request and its response. The router validates on the
 * way in, the client's types are derived from here, so a handler cannot drift from its channel.
 */
/**
 * One configured coding agent. No credentials: a harness inherits the application's environment, so
 * an agent CLI already logged in on the machine works unchanged (DC-0011 arrives separately).
 */
export const HarnessSchema = z.object({
  id: z.string(),
  displayName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().optional(),
});

const AuthMethodSchema = z.object({ id: z.string(), name: z.string() });

/**
 * The outcome of testing a harness. Mirrors `ProbeResult` in `@aibuildos/acp`; the two are held
 * together by the router's `Handlers` type, which will not compile if the probe drifts from the
 * wire.
 */
export const ProbeResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    protocolVersion: z.number(),
    agentInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
    agentCapabilities: z.record(z.string(), z.unknown()).nullable(),
    authMethods: z.array(AuthMethodSchema),
    sessionId: z.string(),
    reply: z.string(),
    stopReason: z.string(),
    stderr: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    stage: z.enum(["spawn", "initialize", "session", "prompt"]),
    code: z.string(),
    message: z.string(),
    stderr: z.string(),
    authMethods: z.array(AuthMethodSchema),
  }),
]);

/**
 * Absolute paths only, checked with a regex rather than `node:path`.
 *
 * This module is parsed in the renderer too, where there is no Node — so `isAbsolute` is not
 * available here. POSIX `/...`, Windows `C:\...`, or a UNC share `\\server\share` — the picker can
 * return one, and rejecting it here would surface as an opaque contract error rather than as a
 * message. Never a NUL byte, the one character every filesystem call refuses and every path-handling
 * bug hides behind.
 */
const AbsolutePathSchema = z
  .string()
  .min(1)
  .regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/, "must be an absolute path")
  .refine((path) => !path.includes("\0"), "must not contain a NUL byte");

/**
 * A project name is a **directory name, not a path**: no separators, no traversal, nothing Windows
 * refuses. Validated at the boundary so no handler has to reason about `../..` reaching out of the
 * location the user picked (ST-0003#AC-4).
 */
const ProjectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\0/\\:*?"<>|]+$/, 'cannot contain / \\ : * ? " < > |')
  .refine(
    (name) => name !== "." && name !== ".." && !name.endsWith("."),
    "not a usable folder name",
  );

/**
 * How closely a project's sessions are supervised (RQ-0022).
 *
 * A **permission request** is the harness's own tool gating, answerable from the options the agent
 * itself offered; `hands-off` answers that and only that. An **ask** ([RQ-0016](../../../docs/requirements/rq-0016.md))
 * is a question needing a person's judgement — renderer-detected message content this setting never
 * touches, by construction. There is no third level yet; each arrives with its own requirement.
 */
export const SupervisionSchema = z.enum(["closest", "hands-off"]);

/** One registered project. The directory is the project; this record is only how we find it again. */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  path: AbsolutePathSchema,
  /** ISO-8601 UTC, or `null` for a project that has been added but never opened. */
  lastOpened: z.string().nullable(),
  /** Absent reads as `closest` — the discipline every session had before this setting existed. */
  supervision: SupervisionSchema.optional(),
});

/**
 * A registry row plus the cheap Git facts the launch page needs per row (ST-0004#AC-1, AC-3, AC-5).
 *
 * `exists` is read on every call because directories move without telling anyone.
 */
export const ProjectSummarySchema = ProjectSchema.extend({
  exists: z.boolean(),
  branch: z.string().nullable(),
  /** Changed paths in the working tree. `null` when the directory is gone or Git could not answer. */
  dirty: z.number().int().nullable(),
});

/**
 * The outcome of creating or adopting a project.
 *
 * Expected failures are **data, not exceptions** — the same choice `ProbeResultSchema` made. Electron
 * rewraps a thrown handler error as "Error invoking remote method ...", which is not a sentence to
 * show anyone (ST-0003#AC-8).
 */
export const ProjectResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), project: ProjectSchema }),
  z.object({
    ok: z.literal(false),
    /**
     * `git_missing` · `git_identity` · `git_failed` · `path_exists` · `not_found` ·
     * `not_a_directory` · `not_writable`. Stable enough for the UI to branch on.
     */
    code: z.string(),
    message: z.string(),
  }),
]);

const GitCommitSchema = z.object({
  hash: z.string(),
  subject: z.string(),
  date: z.string(),
});

const GitStatusSchema = z.object({
  branch: z.string().nullable(),
  /** Distinct paths touched — *not* the sum of the counters below. See `GitStatus` in `git.ts`. */
  changed: z.number().int(),
  staged: z.number().int(),
  unstaged: z.number().int(),
  untracked: z.number().int(),
  conflicted: z.number().int(),
  commits: z.array(GitCommitSchema),
});

/**
 * Counts only. The renderer never sees frontmatter: parsing `docs/` belongs to the knowledge engine
 * alone (AR-0002), and a count is all the view shows.
 */
const RecordSummarySchema = z.object({
  artifacts: z.number().int(),
  indexes: z.number().int(),
  byType: z.record(z.string(), z.number()),
  byState: z.record(z.string(), z.number()),
  parseErrors: z.number().int(),
});

/**
 * Everything the project view shows, in one round trip (ST-0005).
 *
 * Git and the record fail independently: a project with no `docs/` is `record: null`, and a project
 * Git cannot read is `gitError`, with the record still readable.
 */
export const ProjectSnapshotSchema = z.object({
  project: ProjectSchema,
  exists: z.boolean(),
  git: GitStatusSchema.nullable(),
  gitError: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** `null` for a project with no bundle *and* for one whose bundle could not be read. */
  record: RecordSummarySchema.nullable(),
  /** Set only when a bundle exists but could not be walked — the two cases read differently. */
  recordError: z.object({ code: z.string(), message: z.string() }).nullable(),
});

/**
 * A path **inside** a project, relative to its root.
 *
 * The renderer is not trusted — that is the entire reason this boundary exists (AR-0001) — so a path
 * it supplies is checked here before any handler sees it. Absolute paths and `..` segments are
 * refused, because `join(project, "../../etc/passwd")` is otherwise an arbitrary read, and the same
 * path through `project:save` is an arbitrary **write**.
 *
 * This is the boundary half of the defence. The main process resolves the path as well and refuses
 * anything that lands outside the project, which catches what a string check cannot: a symlink.
 */
const RepoPathSchema = z
  .string()
  .max(4096)
  .refine((path) => !path.includes("\0"), "must not contain a NUL byte")
  .refine((path) => !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path), "must be relative to the project")
  .refine((path) => !path.split(/[\\/]/).includes(".."), "must not climb out of the project");

/**
 * What the application's appearance follows: the operating system, or the user's own mind.
 *
 * `system` is the default and the state of a fresh installation — an application that insists on
 * matching the desktop is one you have to change the desktop to change, but matching it is still the
 * right thing to do until told otherwise.
 */
export const AppearanceSchema = z.enum(["system", "light", "dark"]);

export const SettingsSchema = z.object({
  appearance: AppearanceSchema,
  /**
   * Where the user left the furniture (RQ-0009, BG-0004).
   *
   * Here rather than in the renderer's own storage, which is where it obviously belonged until a
   * probe showed nothing there survives a restart: Chromium flushes local storage on its own
   * schedule, and an exit that does not wait loses whatever had not been written.
   *
   * Defaulted so a settings file written before these existed still parses, rather than being read as
   * one that cannot be used.
   */
  sidebarCollapsed: z.boolean().default(false),
  /** The pane layout, as `react-resizable-panels` reports it. Opaque here on purpose. */
  layout: z.unknown().default(null),
});

export const channels = {
  /** Runtime identity of the host process — the smallest useful real channel. */
  "app:info": {
    request: z.void(),
    response: z.object({
      name: z.string(),
      version: z.string(),
      /** Which runtime is actually executing the main process. See AR-0001. */
      runtime: z.object({
        node: z.string(),
        electron: z.string().optional(),
        chrome: z.string().optional(),
      }),
    }),
  },

  /** Every configured harness (RQ-0001#AC-1). */
  "harness:list": {
    request: z.void(),
    response: z.array(HarnessSchema),
  },
  /** Upsert: no `id` creates one, an existing `id` replaces it (RQ-0001#AC-2). */
  "harness:save": {
    request: HarnessSchema.partial({ id: true }),
    response: HarnessSchema,
  },
  "harness:remove": {
    request: z.object({ id: z.string() }),
    response: z.void(),
  },
  /**
   * Spawn the harness and run a full ACP round trip (RQ-0001#AC-5). Slow by nature — a real agent
   * is a subprocess and a model call — so the renderer treats this as a long-running invoke.
   */
  "harness:test": {
    request: z.object({ id: z.string() }),
    response: ProbeResultSchema,
  },
  /** Every registered project, with the Git facts each row shows (RQ-0002#AC-2, AC-10). */
  "project:list": {
    request: z.void(),
    response: z.array(ProjectSummarySchema),
  },
  /**
   * The native directory picker (RQ-0002#AC-6).
   *
   * Its own channel rather than a step inside create/add: both flows use it, the user has to see the
   * location before naming anything, and a cancelled picker is not a failed creation. `null` is
   * cancel, which is not an error.
   */
  "project:choose-directory": {
    request: z.object({ title: z.string().optional() }),
    response: z.object({ path: AbsolutePathSchema.nullable() }),
  },
  /** Create a directory, `git init` it, seed an OKF bundle, and make one commit (RQ-0002#AC-3, AC-4). */
  "project:create": {
    request: z.object({ parentDir: AbsolutePathSchema, name: ProjectNameSchema }),
    response: ProjectResultSchema,
  },
  /** Adopt a directory that already exists, initialising it only if needed (RQ-0002#AC-5, AC-12). */
  "project:add": {
    request: z.object({ path: AbsolutePathSchema }),
    response: ProjectResultSchema,
  },
  /** Forget a project. Never touches the directory (RQ-0002#AC-9). */
  "project:remove": {
    request: z.object({ id: z.string() }),
    response: z.void(),
  },
  /**
   * Open a project: stamp it as opened and return everything the view shows (RQ-0002#AC-7, AC-8).
   * Refreshing the view re-invokes this, so "last opened" means the last time it was looked at.
   */
  "project:open": {
    request: z.object({ id: z.string() }),
    response: ProjectSnapshotSchema,
  },
  /**
   * Set how closely this project's sessions are supervised (RQ-0022#AC-1).
   *
   * Read fresh on every permission request rather than cached at session start, so a change made
   * mid-session applies from the next request and nothing already answered is revisited (AC-5) — that
   * reading happens in `sessions.ts`, not here.
   */
  "project:set-supervision": {
    request: z.object({ id: z.string(), level: SupervisionSchema }),
    response: z.object({ problem: z.string().nullable() }),
  },
  /**
   * Open a live session on a project, with one of the configured harnesses (ST-0009).
   *
   * Returns what the agent advertised when the session opened — its modes, its models, its effort
   * levels. Empty when the agent advertises none, which the interface must render as *absent*
   * rather than as an empty menu (RQ-0004#AC-12).
   */
  "session:start": {
    request: z.object({ projectId: z.string(), harnessId: z.string() }),
    response: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        sessionId: z.string(),
        /** `NewSessionResponse` as the agent sent it: modes, config options, whatever else. */
        offered: z.looseObject({}),
      }),
      z.object({
        ok: z.literal(false),
        /** `command_not_found` · `auth_required` · `exited` · `protocol_error` · `cwd_not_found`. */
        code: z.string(),
        message: z.string(),
        /** How to log in, when the agent refused for want of it — the agent's own methods. */
        authMethods: z.array(z.object({ id: z.string(), name: z.string() })),
      }),
    ]),
  },
  /**
   * Send a prompt and wait for the turn to stop. Slow by nature — the narration arrives as events,
   * not in this response, which carries only how the turn ended.
   */
  "session:prompt": {
    request: z.object({ sessionId: z.string(), text: z.string().min(1) }),
    response: z.object({ stopReason: z.string() }),
  },
  /** Ask the agent to stop the turn in progress. Returns as soon as it has been asked. */
  "session:cancel": {
    request: z.object({ sessionId: z.string() }),
    response: z.void(),
  },
  /**
   * Answer a permission request the agent made.
   *
   * `optionId: null` declines by cancelling — which is also what a cancelled turn does to any
   * request still outstanding, because the protocol requires it.
   */
  "session:permission": {
    request: z.object({
      sessionId: z.string(),
      requestId: z.string(),
      optionId: z.string().nullable(),
    }),
    response: z.void(),
  },
  /** Close the session and reap the agent. */
  "session:close": {
    request: z.object({ sessionId: z.string() }),
    response: z.void(),
  },
  /**
   * The project's record, for the left rail (RQ-0004#AC-14).
   *
   * Counts are not enough here as they were for the status page: the rail lists artifacts. It still
   * never sends frontmatter — only the fields a row shows — because parsing `docs/` belongs to the
   * knowledge engine alone (AR-0002).
   */
  "project:record": {
    request: z.object({ id: z.string() }),
    response: z.object({
      /** `null` when the project has no bundle at all, which reads differently from an empty one. */
      artifacts: z
        .array(
          z.object({
            id: z.string(),
            type: z.string(),
            title: z.string(),
            state: z.string(),
            /** Absent when the artifact carries none — the boards sort by it, absent last (BG-0005). */
            priority: z.string().optional(),
            file: z.string(),
            /**
             * From the same `validate()` run `docs:check` performs, carried over this channel rather
             * than a new one (ST-0025). Counts, not the findings themselves — a list mark needs to say
             * "2 errors", not what they are; opening the artifact is where each one is named
             * (RQ-0012#AC-1, AC-2). Always present, `{ errors: 0, warnings: 0 }` for a clean artifact —
             * the rail renders that as nothing (RQ-0012#AC-4).
             */
            problems: z.object({ errors: z.number().int(), warnings: z.number().int() }),
            /**
             * The reverse of links stored elsewhere — what implements this, what verifies it.
             * Derived, never stored: a written backlink is a second source of truth that drifts.
             */
            inbound: z.array(z.object({ relationship: z.string(), id: z.string() })),
          }),
        )
        .nullable(),
      problem: z.string().nullable(),
    }),
  },
  /**
   * One directory of the working tree, for the right rail (RQ-0004#AC-15, AC-16).
   *
   * One directory, not the tree: a rail that reads the whole working tree to show one folder is a
   * rail that stalls on a large repository.
   */
  "project:tree": {
    request: z.object({ id: z.string(), path: RepoPathSchema }),
    response: z.object({
      entries: z.array(
        z.object({
          name: z.string(),
          /** Repo-relative, so it is the same key Git reports a change against. */
          path: z.string(),
          directory: z.boolean(),
          changed: z.boolean(),
        }),
      ),
      problem: z.string().nullable(),
    }),
  },
  /** The working tree as changes, and recent history — the right rail's second tab. */
  "project:changes": {
    request: z.object({ id: z.string() }),
    response: z.object({
      staged: z.array(z.object({ path: z.string(), status: z.string() })),
      unstaged: z.array(z.object({ path: z.string(), status: z.string() })),
      untracked: z.array(z.object({ path: z.string(), status: z.string() })),
      commits: z.array(z.object({ hash: z.string(), subject: z.string(), date: z.string() })),
      problem: z.string().nullable(),
    }),
  },
  /**
   * One changed path, as it was and as it is (ST-0012#AC-8).
   *
   * Read-only. Editing a file is [RQ-0005](../../../docs/requirements/rq-0005.md); this is the
   * viewer the Git rail opens, and it uses the same two-sides shape a tool call's diff already
   * carries, so one component draws both.
   */
  "project:diff": {
    request: z.object({ id: z.string(), path: RepoPathSchema.min(1) }),
    response: z.object({
      path: z.string(),
      /** `null` for a file that is new — there is no previous version to show. */
      oldText: z.string().nullable(),
      newText: z.string(),
      problem: z.string().nullable(),
    }),
  },
  /**
   * Change what the agent is set to (RQ-0004#AC-12).
   *
   * The response carries nothing: what the interface shows follows the agent's own
   * `current_mode_update` / `config_option_update`, never the request. A control that showed what was
   * clicked would be reporting the user's intention as though it were the agent's state.
   */
  "session:set-mode": {
    request: z.object({ sessionId: z.string(), modeId: z.string() }),
    response: z.void(),
  },
  "session:set-config": {
    request: z.object({
      sessionId: z.string(),
      configId: z.string(),
      value: z.union([z.string(), z.boolean()]),
    }),
    response: z.void(),
  },
  /**
   * What the agent last said it is set to (ST-0010#AC-5).
   *
   * Events tell the interface when something changes; this tells it where things stood before it was
   * listening. An agent announces its commands and its mode as soon as a session opens — before any
   * component has mounted to hear it — so without this the controls would show whatever the session
   * happened to open with and never the truth.
   */
  "session:controls": {
    request: z.object({ sessionId: z.string() }),
    response: z.object({
      modeId: z.string().nullable(),
      configOptions: z.array(z.looseObject({ id: z.string() })),
      commands: z.array(z.looseObject({ name: z.string() })),
    }),
  },
  /** One file's text, for the editor (RQ-0005#AC-1). */
  "project:file": {
    request: z.object({ id: z.string(), path: RepoPathSchema.min(1) }),
    response: z.object({
      text: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  },
  /**
   * Write a file back (RQ-0005#AC-1, AC-11).
   *
   * What lands on disk is exactly what was shown — no trailing-newline fixing, no reformatting. A
   * writer that tidies is a writer that produces a diff nobody asked for.
   */
  "project:save": {
    request: z.object({ id: z.string(), path: RepoPathSchema.min(1), text: z.string() }),
    response: z.object({ problem: z.string().nullable() }),
  },
  /**
   * One artifact, as its own shape rather than as text (RQ-0005#AC-5, AC-6, AC-9).
   *
   * The vocabularies come with it: the states this type declares, and for each relationship the
   * artifacts that are legal targets. The renderer offers what the profile allows and never a list
   * it made up — the same rule the agent controls follow.
   */
  "project:artifact": {
    request: z.object({ id: z.string(), artifactId: z.string() }),
    response: z.object({
      markdown: z.string().nullable(),
      /** Frontmatter as read. Values are whatever YAML produced. */
      frontmatter: z.record(z.string(), z.unknown()),
      body: z.string(),
      /** The current state, then the legal next states (RQ-0010) — never the whole vocabulary.
       * Empty when the profile does not describe this type. */
      states: z.array(z.string()),
      links: z.array(
        z.object({
          relationship: z.string(),
          current: z.array(z.string()),
          /** Every artifact whose type this relationship declares as a legal target. */
          candidates: z.array(z.object({ id: z.string(), title: z.string(), type: z.string() })),
        }),
      ),
      /** Reported against the frontmatter key that caused them, where one can be identified. */
      findings: z.array(
        z.object({
          rule: z.string(),
          severity: z.string(),
          message: z.string(),
          key: z.string().nullable(),
        }),
      ),
      problem: z.string().nullable(),
    }),
  },
  /**
   * Write an artifact back (RQ-0005#AC-8, AC-10).
   *
   * Only the named fields and the body change; everything else in the file is left byte-identical,
   * and the artifact's row in its directory index is kept in step.
   */
  "project:artifact-save": {
    request: z.object({
      id: z.string(),
      artifactId: z.string(),
      frontmatter: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      /** Left out when nothing in the body moved, so the prose is not rewritten by a field edit. */
      body: z.string().optional(),
    }),
    response: z.object({
      problem: z.string().nullable(),
      /**
       * What was actually written. The editor holds this as its idea of the file on disk, so its own
       * save is not mistaken for the agent having changed the artifact underneath it.
       */
      markdown: z.string().nullable(),
      findings: z.array(
        z.object({
          rule: z.string(),
          severity: z.string(),
          message: z.string(),
          key: z.string().nullable(),
        }),
      ),
    }),
  },
  /**
   * The artifact types this project can mint (RQ-0006#AC-6).
   *
   * Read from the project's own profile, never from this application's vocabulary: a project whose
   * profile declares types nobody here has heard of gets those, and a project with no profile is
   * told it cannot mint artifacts rather than being handed someone else's taxonomy.
   */
  "project:artifact-types": {
    request: z.object({ id: z.string() }),
    response: z.object({
      types: z.array(
        z.object({
          type: z.string(),
          prefix: z.string(),
          dir: z.string(),
          /** The type's whole state vocabulary, in declared order — what a board's columns are
           * (RQ-0011#AC-1). Empty when the type declares no states. */
          states: z.array(z.string()),
        }),
      ),
      problem: z.string().nullable(),
    }),
  },
  /**
   * Create an empty file at a path the user chose (RQ-0006#AC-1).
   *
   * The path is the user's own text and therefore the least trusted input this process takes, which
   * is why it goes through the same schema and the same containment as every other write.
   */
  "project:create-file": {
    request: z.object({ id: z.string(), path: RepoPathSchema.min(1) }),
    response: z.object({ problem: z.string().nullable() }),
  },
  /**
   * Close an open project: stops its watcher (RQ-0026#AC-7). The renderer's view state is its
   * own; this is the main-process half of "nobody has it open any more".
   */
  "project:close": {
    request: z.object({ id: z.string() }),
    response: z.void(),
  },
  /**
   * Seed the standard playbooks into a project that has none (RQ-0013#AC-4, DC-0019).
   *
   * The template ships with the application, so writing it is main's job; the renderer only asks.
   */
  "project:seed-playbooks": {
    request: z.object({ id: z.string() }),
    response: z.object({ problem: z.string().nullable() }),
  },
  /** Stage one path (RQ-0018#AC-1). The user's own Git; argv only, like every Git call here. */
  "project:stage": {
    request: z.object({ id: z.string(), path: RepoPathSchema.min(1) }),
    response: z.object({ problem: z.string().nullable() }),
  },
  "project:unstage": {
    request: z.object({ id: z.string(), path: RepoPathSchema.min(1) }),
    response: z.object({ problem: z.string().nullable() }),
  },
  /**
   * Commit what is staged (RQ-0018#AC-2, AC-3). A hook's rejection is an expected failure carried
   * as data, in the hook's own words — not a paraphrase and not a thrown error.
   */
  "project:commit": {
    request: z.object({ id: z.string(), message: z.string().min(1) }),
    response: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), hash: z.string() }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
  },
  /**
   * Run the checks playbook's fenced commands (RQ-0019). Resolves when every command has exited;
   * the live output arrives over the `check:output` event, and the exit code is the whole verdict.
   */
  "check:run": {
    request: z.object({ id: z.string() }),
    response: z.object({
      results: z.array(
        z.object({
          command: z.string(),
          outcome: z.enum(["passed", "failed", "could_not_run"]),
          exitCode: z.number().int().nullable(),
        }),
      ),
      problem: z.string().nullable(),
    }),
  },
  /**
   * Start a build in its own worktree (RQ-0020, DC-0021): walk the story's states in main, create
   * the worktree on `aibuildos/<story>`, spawn the session there. Failures are data, as always.
   */
  "build:start": {
    request: z.object({ projectId: z.string(), storyId: z.string(), harnessId: z.string() }),
    response: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), sessionId: z.string() }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
  },
  /** Every build the enumeration knows: `git worktree list` plus the registry's live sessions. */
  "build:list": {
    request: z.object({ projectId: z.string() }),
    response: z.object({
      builds: z.array(
        z.object({
          storyId: z.string(),
          branch: z.string(),
          /** `null` for a build that survived a restart and has no session yet (DC-0021). */
          sessionId: z.string().nullable(),
          dirty: z.boolean(),
        }),
      ),
      problem: z.string().nullable(),
    }),
  },
  /** The branch's changes against main — what a worktree build's review reads (RQ-0020#AC-4). */
  "build:changes": {
    request: z.object({ projectId: z.string(), storyId: z.string() }),
    response: z.object({
      changes: z.array(z.object({ path: z.string() })),
      problem: z.string().nullable(),
    }),
  },
  "build:diff": {
    request: z.object({ projectId: z.string(), storyId: z.string(), path: RepoPathSchema.min(1) }),
    response: z.object({
      path: z.string(),
      oldText: z.string().nullable(),
      newText: z.string(),
      problem: z.string().nullable(),
    }),
  },
  /** Accept: --no-ff merge into main, worktree removed, branch deleted — the person's commit. */
  "build:merge": {
    request: z.object({ projectId: z.string(), storyId: z.string() }),
    response: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
  },
  "build:discard": {
    request: z.object({ projectId: z.string(), storyId: z.string() }),
    response: z.object({ problem: z.string().nullable() }),
  },
  /** Every live session the registry holds — what the Now surface derives from (RQ-0021). */
  "session:list": {
    request: z.object({}),
    response: z.object({
      sessions: z.array(
        z.object({
          sessionId: z.string(),
          projectId: z.string(),
          /** The story a build session is for; `null` for the workspace's own conversation. */
          storyId: z.string().nullable(),
        }),
      ),
    }),
  },
  /**
   * Start the project's declared preview server and resolve once its URL answers (RQ-0025,
   * DC-0012). The page renders in a WebContentsView main positions from `preview:bounds`.
   */
  "preview:start": {
    request: z.object({ projectId: z.string() }),
    response: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), url: z.string() }),
      z.object({ ok: z.literal(false), message: z.string() }),
    ]),
  },
  "preview:stop": {
    request: z.object({ projectId: z.string() }),
    response: z.object({ problem: z.string().nullable() }),
  },
  /** Where the preview's view sits, in window coordinates; zero size hides it. */
  "preview:bounds": {
    request: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().min(0),
      height: z.number().min(0),
    }),
    response: z.void(),
  },
  /**
   * Mint an artifact (RQ-0006#AC-2 to AC-5, AC-7).
   *
   * The number is allocated here rather than asked for: it is append-only and never reused, which is
   * a property of the bundle, not a decision for whoever is typing.
   */
  "project:create-artifact": {
    request: z.object({ id: z.string(), type: z.string(), title: z.string().min(1) }),
    response: z.object({
      /** The ID it was given, so the workspace can open it without looking it up again. */
      artifactId: z.string().nullable(),
      problem: z.string().nullable(),
    }),
  },
  /**
   * Show the file tree's own context menu, and answer with what was chosen (RQ-0006#AC-9).
   *
   * The menu is built and shown by **main**, because the platform already has a real one: a floating
   * element on a `contextmenu` event has to reimplement dismissal, keyboard navigation and appearance,
   * and gets all three slightly wrong.
   *
   * The renderer learns only the decision. `null` is a dismissal, which does nothing.
   */
  "project:file-menu": {
    request: z.object({
      /** The row that was pointed at, and whether it is a directory. */
      path: RepoPathSchema,
      directory: z.boolean(),
    }),
    response: z.object({
      action: z.enum(["new-file"]).nullable(),
      /** The directory the chosen action applies to: the row itself, or the folder it sits in. */
      directory: z.string(),
    }),
  },
  /**
   * The installation's settings (RQ-0007).
   *
   * Appearance is set in the **main** process through `nativeTheme.themeSource`, which changes
   * `prefers-color-scheme` in every renderer. So there is nothing to hand back to the renderer for it
   * to apply: the media query it already reads simply answers differently.
   */
  "settings:get": {
    request: z.object({}),
    response: z.object({
      /** What is **in force**, which is the platform's own value rather than what is on disk. */
      appearance: AppearanceSchema,
      sidebarCollapsed: z.boolean(),
      layout: z.unknown(),
      /** Set when a settings file exists but cannot be used, so the fallback is not silent. */
      problem: z.string().nullable(),
    }),
  },
  "settings:set-appearance": {
    request: z.object({ appearance: AppearanceSchema }),
    response: SettingsSchema,
  },
  /** Where the furniture was left. Merged into what is stored, so one field does not erase another. */
  "settings:set-chrome": {
    request: z.object({
      sidebarCollapsed: z.boolean().optional(),
      layout: z.unknown().optional(),
    }),
    response: SettingsSchema,
  },
} as const satisfies Record<string, ChannelDefinition>;

/**
 * One AG-UI event, on its way from the bridge in main to the renderer (DC-0017).
 *
 * Deliberately **not** a discriminated union of AG-UI's own event shapes. AG-UI owns that vocabulary
 * and versions it; restating all twenty-odd variants here would be a second copy of someone else's
 * schema, drifting from the day it was written. What this boundary guarantees is what it can actually
 * enforce: the envelope is well-formed and the session it belongs to is named. The renderer hands the
 * body to `@ag-ui/client`, which is the thing that does know those shapes.
 */
export const SessionEventSchema = z.object({
  sessionId: z.string(),
  /** An AG-UI `BaseEvent`. Every one carries a `type`; the rest is AG-UI's business. */
  event: z.looseObject({ type: z.string() }),
});

/**
 * The one-way half of the boundary: notifications main sends without being asked (ST-0009).
 *
 * Anything that needs an answer is a channel above, not an event here.
 */
export const events = {
  /** One bridged AG-UI event from a live agent session. */
  "session:event": SessionEventSchema,
  /**
   * A session's lifecycle, which is not part of the agent's own narration: it covers the states an
   * agent cannot report because it is not running yet, or no longer is.
   */
  "session:state": z.object({
    sessionId: z.string(),
    state: z.enum(["starting", "ready", "busy", "closed", "failed"]),
    /** Present only on `failed`, and written to be shown to a person. */
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
  /**
   * A command from the application's own menu (RQ-0008#AC-2, AC-7).
   *
   * The menu lives in main, where the accelerators are the platform's rather than a key handler's
   * guess at them; what a command *means* is the renderer's, because only it knows what is on screen.
   */
  "app:command": z.object({ command: z.enum(["save", "toggle-sidebar"]) }),
  /** The open project's files moved — whoever wrote them (RQ-0026, DC-0022). One debounced
   * event per burst; the renderer's answer is one bump. */
  "project:changed": z.object({ projectId: z.string() }),
  /** One chunk of a running check command's output, as it arrives (RQ-0019#AC-2). */
  "check:output": z.object({
    projectId: z.string(),
    command: z.string(),
    chunk: z.string(),
  }),
} as const satisfies Record<string, z.ZodType>;

export type EventName = keyof typeof events;
export type EventPayload<E extends EventName> = z.infer<(typeof events)[E]>;
export const EVENT_NAMES = Object.keys(events) as EventName[];

export interface ChannelDefinition {
  readonly request: z.ZodType;
  readonly response: z.ZodType;
}

export type ChannelName = keyof typeof channels;

export type ChannelRequest<C extends ChannelName> = z.infer<(typeof channels)[C]["request"]>;
export type ChannelResponse<C extends ChannelName> = z.infer<(typeof channels)[C]["response"]>;

export const CHANNEL_NAMES = Object.keys(channels) as ChannelName[];
