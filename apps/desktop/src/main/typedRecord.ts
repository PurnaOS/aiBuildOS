import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ArtifactIdSchema,
  type Bundle,
  baseArtifactId,
  editArtifact,
  insertIndexRow,
  LinkTargetSchema,
  type LoadedArtifact,
  nextId,
  type Profile,
  parseOkfDocument,
  scaffoldArtifact,
  validate,
} from "@aibuildos/knowledge-engine";
import { loadBundle, loadProfile } from "@aibuildos/knowledge-engine/load";
import { z } from "zod";
import { git } from "./git.js";
import { applyArtifactEdit, insideProject } from "./record.js";
import { noteSelfWrite } from "./watch.js";

/**
 * Where a typed plan or verdict lands on the record (RQ-0052, ST-0068).
 *
 * The extension wire lives in `packages/acp`; what belongs here is the half that touches `docs/`.
 * A typed plan becomes draft artifacts exactly the way plans already land — files in the bundle,
 * minted, indexed, validated — so `derivePlan` stays the single authority on what a plan *is*: it
 * re-derives the view from the record, and this module only ever writes the record. A typed verdict
 * persists the way the manual walk already persists one: `last_result`/`last_run`/`last_run_by`
 * through the guarded save. Exit codes remain the truth for what *ran* (RQ-0019) — a verdict is the
 * agent reporting, never the application parsing.
 *
 * IDs are minted here, never by the agent: two agents proposing concurrently must not collide on a
 * number, and append-only numbering is the record's discipline, not a guest's.
 */

const PlanSchema = z.object({
  stories: z
    .array(
      z.object({
        title: z.string().min(1),
        implements: z.array(ArtifactIdSchema).min(1),
        criteria: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  testCases: z
    .array(
      z.object({
        title: z.string().min(1),
        kind: z.enum(["manual", "automated"]),
        verifies: z.array(LinkTargetSchema).min(1),
        steps: z.array(z.string().min(1)).min(1),
      }),
    )
    .default([]),
});

const VerdictSchema = z.object({
  testCaseId: ArtifactIdSchema,
  result: z.enum(["passed", "failed", "could_not_run"]),
  ranAt: z.iso.datetime(),
});

export interface PlanFinding {
  readonly rule: string;
  readonly severity: string;
  readonly message: string;
}

/** What the agent's `_aibuildos/plan` request is answered with — the reject-back is findings. */
export type PlanResponse =
  | { accepted: true; ids: string[] }
  | { accepted: false; findings: PlanFinding[] };

function rejected(rule: string, messages: string[]): PlanResponse {
  return {
    accepted: false,
    findings: messages.map((message) => ({ rule, severity: "error", message })),
  };
}

/**
 * Land a typed plan as draft artifacts, or reject it back with findings (RQ-0052#AC-1).
 *
 * Validated **before** anything touches disk: the drafts are composed in memory, joined onto the
 * loaded bundle, and run through the same `validate()` the record lives by. A conforming payload
 * that would still break the record — a story implementing a requirement that is not there — is
 * rejected by the record's own rules, and nothing was ever written to roll back.
 */
export async function landPlan(
  projectPath: string,
  /** The agent identity for the drafts' `generated:` block — they are agent-authored. */
  generatedBy: string,
  payload: unknown,
): Promise<PlanResponse> {
  const parsed = PlanSchema.safeParse(payload);
  if (!parsed.success) {
    return rejected(
      "plan/schema",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`),
    );
  }

  // The same owner discipline `project:create-artifact` has: the conventions require a git handle,
  // and this code has no way to invent a real one.
  const owner = (await git(projectPath, "config", "user.name").catch(() => "")).trim();
  if (owner === "") {
    return rejected("plan/owner", [
      "this repository has no git `user.name` configured, so a draft has no owner",
    ]);
  }

  try {
    return land(projectPath, generatedBy, owner, parsed.data);
  } catch (cause) {
    return rejected("plan/failed", [cause instanceof Error ? cause.message : String(cause)]);
  }
}

function land(
  projectPath: string,
  generatedBy: string,
  owner: string,
  plan: z.infer<typeof PlanSchema>,
): PlanResponse {
  const root = join(projectPath, "docs");
  const { profile } = loadProfile(root);
  const { bundle } = loadBundle(root, projectPath);
  const storyType = profile.get("Story");
  const testType = profile.get("TestCase");
  if (!storyType?.prefix || !storyType.dir || !testType?.prefix || !testType.dir) {
    return rejected("plan/profile", [
      "this project's profile has no Story and TestCase to mint drafts of",
    ]);
  }

  const at = new Date().toISOString();
  const taken = bundle.artifacts.map((artifact) =>
    String((artifact.frontmatter as { id?: unknown }).id ?? ""),
  );
  const mint = (prefix: string): string => {
    const id = nextId(taken, prefix);
    taken.push(id);
    return id;
  };
  const storyIds = plan.stories.map(() => mint(storyType.prefix as string));
  const testIds = plan.testCases.map(() => mint(testType.prefix as string));

  const files: { artifact: LoadedArtifact; source: string; row: string; dir: string }[] = [];
  const add = (dir: string, id: string, source: string, row: string): void => {
    const basename = `${id.toLowerCase()}.md`;
    const doc = parseOkfDocument(source);
    files.push({
      artifact: {
        // Forward slashes, not `join`: these are engine-facing paths compared against `loadBundle`'s
        // '/'-normalized artifact files and index keys, and win32 `join` would miss every one.
        file: `docs/${dir}/${basename}`,
        dir: `docs/${dir}`,
        basename,
        frontmatter: doc.frontmatter,
        body: doc.body,
        keyLines: doc.keyLines,
      },
      source,
      row,
      dir,
    });
  };

  plan.testCases.forEach((testCase, index) => {
    const id = testIds[index] as string;
    const source = compose(profile, {
      type: "TestCase",
      id,
      title: testCase.title,
      owner,
      generatedBy,
      at,
      fields: { kind: testCase.kind },
      links: { verifies: testCase.verifies },
      body: `\n# ${id} — ${testCase.title}\n\n## Steps\n\n${testCase.steps
        .map((step, n) => `${n + 1}. ${step}`)
        .join("\n")}\n`,
    });
    add(testType.dir as string, id, source, indexRow(id, testCase.title, testCase.verifies));
  });

  plan.stories.forEach((story, index) => {
    const id = storyIds[index] as string;
    // Its verifying tests are the proposed ones covering the same requirements — the same link
    // shape the plan surface already groups by, and what lets approval flip the story to `ready`
    // past the profile's `verified_by` minimum.
    const verifiedBy = testIds.filter((_, n) =>
      plan.testCases[n]?.verifies.some((target) =>
        story.implements.includes(baseArtifactId(target)),
      ),
    );
    const source = compose(profile, {
      type: "Story",
      id,
      title: story.title,
      owner,
      generatedBy,
      at,
      fields: {},
      links: {
        implements: story.implements,
        ...(verifiedBy.length === 0 ? {} : { verified_by: verifiedBy }),
      },
      body: `\n# ${id} — ${story.title}\n\n## Acceptance criteria\n\n${story.criteria
        .map((criterion, n) => `- [AC-${n + 1}] ${criterion}`)
        .join("\n")}\n`,
    });
    add(storyType.dir as string, id, source, indexRow(id, story.title, story.implements));
  });

  // The drafts' index rows, composed on the loaded index text — an artifact missing from its index
  // is a validation error, so a directory with no index simply leaves the findings to say so.
  const indexes = new Map(bundle.indexes);
  for (const file of files) {
    const key = `docs/${file.dir}`;
    const index = indexes.get(key);
    if (index !== undefined) indexes.set(key, insertIndexRow(index, file.row));
  }

  // Validated in memory, before anything touches disk (RQ-0052#AC-1): the record's own rules are
  // the reject-back, and a rejected plan leaves no transient files behind.
  const hypothetical: Bundle = {
    root: bundle.root,
    artifacts: [...bundle.artifacts, ...files.map((file) => file.artifact)],
    indexes,
  };
  const drafted = new Set(files.map((file) => file.artifact.file));
  const errors = validate(hypothetical, profile).filter(
    (finding) => finding.severity === "error" && drafted.has(finding.file),
  );
  if (errors.length > 0) {
    return {
      accepted: false,
      findings: errors.map(({ rule, severity, message }) => ({ rule, severity, message })),
    };
  }

  // `wx`, like `project:create-artifact`: a concurrent minter racing this one lands on EEXIST
  // rather than a clobber, and whatever this call already wrote is taken back.
  const written: string[] = [];
  try {
    for (const file of files) {
      const target = insideProject(projectPath, file.artifact.file);
      writeFileSync(target, file.source, { encoding: "utf8", flag: "wx" });
      written.push(target);
    }
    for (const [key, text] of indexes) {
      if (bundle.indexes.get(key) === text) continue;
      writeFileSync(insideProject(projectPath, `${key}/README.md`), text, "utf8");
    }
  } catch (cause) {
    for (const target of written) rmSync(target, { force: true });
    return rejected("plan/write", [cause instanceof Error ? cause.message : String(cause)]);
  }

  // Main's own write must not depend on the watcher noticing it — same reason `applyArtifactEdit`
  // notes its writes: the revision bump is what refreshes the plan surface.
  noteSelfWrite(projectPath);
  return { accepted: true, ids: [...storyIds, ...testIds] };
}

interface Draft {
  readonly type: string;
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly generatedBy: string;
  readonly at: string;
  readonly fields: Record<string, string>;
  readonly links: Record<string, readonly string[]>;
  readonly body: string;
}

/** One draft artifact: scaffolded by the profile, then edited into the agent's proposed shape. */
function compose(profile: Profile, draft: Draft): string {
  let source = scaffoldArtifact(profile, {
    type: draft.type,
    id: draft.id,
    title: draft.title,
    owner: draft.owner,
    created: draft.at.slice(0, 10),
  });
  // ponytail: `generated:` is a map and `editArtifact`'s FieldValue cannot write one, so the line is
  // inserted textually — safe only because this file was scaffolded two lines up. Upgrade path is
  // map support in the engine's edit layer.
  source = source.replace(
    /^created: .*$/m,
    (line) =>
      `${line}\ngenerated: { by: ${JSON.stringify(draft.generatedBy)}, at: ${JSON.stringify(draft.at)} }`,
  );
  return editArtifact(source, {
    // `provenance: agent` with the `generated` block above: the content is the agent's, and
    // claiming otherwise would put a false origin in the record (okf-conventions §2).
    frontmatter: {
      provenance: "agent",
      ...draft.fields,
      ...Object.fromEntries(
        Object.entries(draft.links).map(([relation, ids]) => [`links.${relation}`, [...ids]]),
      ),
    },
    create: Object.keys(draft.links).map((relation) => `links.${relation}`),
    body: draft.body,
  });
}

/** The same row shape the index tables already use: ID, title, state, key relationships. */
function indexRow(id: string, title: string, targets: readonly string[]): string {
  const links = targets
    .map(baseArtifactId)
    .map((target) => `[${target}](../${dirOf(target)}/${target.toLowerCase()}.md)`)
    .join(" · ");
  return `| [${id}](${id.toLowerCase()}.md) | ${title.replaceAll("|", "\\|")} | draft | ${links || "—"} |`;
}

/** Where a link target's row should point — the bundle's own prefix-to-directory table. */
// ponytail: hardcoded prefix table, feeding only the index rows' navigation links (unvalidated by
// design). A project whose profile moves a type's `dir` gets a wrong nav link; read the target
// type's `dir` from the profile if custom bundle layouts arrive.
function dirOf(id: string): string {
  const prefix = id.slice(0, 2).toUpperCase();
  return (
    { RQ: "requirements", ST: "user-stories", TC: "testing", BG: "bugs", EP: "epics" }[prefix] ??
    "requirements"
  );
}

/**
 * Persist a typed check verdict through the guarded save (RQ-0052#AC-2), returning the problem to
 * log when there is one — a notification cannot be rejected, so an invalid verdict is dropped and
 * the caller narrates why.
 */
export function recordVerdict(
  projectPath: string,
  /** Who ran it — the harness's display name, for `last_run_by`. */
  ranBy: string,
  payload: unknown,
): string | null {
  const parsed = VerdictSchema.safeParse(payload);
  if (!parsed.success) {
    return `not a typed verdict: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
      .join("; ")}`;
  }

  // `could_not_run` is a legal thing for an agent to say, but the record has nowhere honest to put
  // it: the TestCase profile's `last_result` vocabulary is `passed | failed`, and what actually ran
  // is the exit code's truth, not the agent's (RQ-0019). Forwarded as an event, persisted as
  // nothing.
  if (parsed.data.result === "could_not_run") return null;

  try {
    const saved = applyArtifactEdit(projectPath, parsed.data.testCaseId, {
      last_result: parsed.data.result,
      last_run: parsed.data.ranAt,
      last_run_by: ranBy,
    });
    return saved.problem;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}
