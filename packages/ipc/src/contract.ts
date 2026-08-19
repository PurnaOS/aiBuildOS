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

/** One registered project. The directory is the project; this record is only how we find it again. */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  path: AbsolutePathSchema,
  /** ISO-8601 UTC, or `null` for a project that has been added but never opened. */
  lastOpened: z.string().nullable(),
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
            file: z.string(),
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
   * One artifact's own text (ST-0012#AC-4).
   *
   * The rail lists artifacts; attaching one to the conversation needs what it actually *says* —
   * its acceptance criteria above all. The bundle loader keeps only frontmatter, so this reads the
   * one file the user asked for, which is the retrieval pattern `docs/README.md` prescribes:
   * load an index, then the one artifact you need.
   */
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
      /** This type's own state vocabulary, empty when the profile does not describe it. */
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
