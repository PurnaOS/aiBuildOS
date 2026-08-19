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
} as const satisfies Record<string, ChannelDefinition>;

export interface ChannelDefinition {
  readonly request: z.ZodType;
  readonly response: z.ZodType;
}

export type ChannelName = keyof typeof channels;

export type ChannelRequest<C extends ChannelName> = z.infer<(typeof channels)[C]["request"]>;
export type ChannelResponse<C extends ChannelName> = z.infer<(typeof channels)[C]["response"]>;

export const CHANNEL_NAMES = Object.keys(channels) as ChannelName[];
