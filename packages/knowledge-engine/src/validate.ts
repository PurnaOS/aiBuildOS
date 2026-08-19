import { ArtifactGraph, type GraphNode } from "./graph.js";
import type { Profile } from "./profile.js";
import { profileFindings, type TypedArtifact } from "./rules.js";
import { ARTIFACT_ID_PATTERN, CommonFrontmatterSchema } from "./schema.js";

export type Severity = "error" | "warn";

export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface LoadedArtifact {
  /** Repo-relative path, used verbatim in findings. */
  readonly file: string;
  /** Directory the artifact lives in, repo-relative — used to find its index. */
  readonly dir: string;
  /** Basename, e.g. `dc-0001.md`. */
  readonly basename: string;
  readonly frontmatter: Record<string, unknown>;
  /** The Markdown after the frontmatter — what the body-section and `[AC-n]` rules read. */
  readonly body: string;
  readonly keyLines: ReadonlyMap<string, number>;
}

export interface Bundle {
  /**
   * The bundle root, relative to the same base as `LoadedArtifact.file` — `docs` for the CLI, `""`
   * when the walk started at the bundle itself. It is what turns an artifact's base-relative
   * directory into the bundle-relative one a type definition's `dir` is written in.
   */
  readonly root: string;
  readonly artifacts: readonly LoadedArtifact[];
  /** Directory (repo-relative) -> the raw text of its `README.md`, where one exists. */
  readonly indexes: ReadonlyMap<string, string>;
}

/**
 * The rules that need no profile — identity, navigability and referential integrity — followed by the
 * profile-driven ones in `rules.ts` when a profile is supplied (RQ-0003).
 *
 * `profile` is optional on purpose: a bundle with no `docs/profile/` is validated against these rules
 * alone rather than refused. A newly created project has a valid bundle before it has a described one.
 *
 * Gates, state-*transition* enforcement and CST-based editing each still await their own requirement
 * (DC-0009).
 */
export function validate(bundle: Bundle, profile?: Profile): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  const nodes: GraphNode[] = [];
  const typed: TypedArtifact[] = [];

  for (const artifact of bundle.artifacts) {
    const at = (key: string): Pick<Finding, "file" | "line"> => {
      const line = artifact.keyLines.get(key);
      return line === undefined ? { file: artifact.file } : { file: artifact.file, line };
    };

    const parsed = CommonFrontmatterSchema.safeParse(artifact.frontmatter);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        findings.push({
          rule: key === "id" ? "id/format" : "doc/field-required",
          severity: "error",
          ...at(key),
          message: `${key || "frontmatter"}: ${issue.message}`,
        });
      }
      continue;
    }

    const { id, type, links, state, provenance } = parsed.data;

    // doc/generated-required — `generated` is required whenever an artifact was authored or revised
    // by an agent (conventions §2). This needs no profile, so it lives with the common rules.
    if (provenance === "agent" && parsed.data.generated === undefined) {
      findings.push({
        rule: "doc/generated-required",
        severity: "error",
        ...at("provenance"),
        message: "provenance is `agent` but `generated` is absent",
      });
    }

    // id/format — belt and braces: the schema already enforces the pattern, but an artifact whose
    // filename disagrees with its ID is the failure this catches.
    if (!ARTIFACT_ID_PATTERN.test(id)) {
      findings.push({
        rule: "id/format",
        severity: "error",
        ...at("id"),
        message: `"${id}" is not a valid artifact ID`,
      });
    }
    const expectedBasename = `${id.toLowerCase()}.md`;
    if (artifact.basename !== expectedBasename) {
      findings.push({
        rule: "id/format",
        severity: "error",
        ...at("id"),
        message: `filename must be the ID lowercased: expected ${expectedBasename}`,
      });
    }

    // id/duplicate
    const previous = seen.get(id);
    if (previous) {
      findings.push({
        rule: "id/duplicate",
        severity: "error",
        ...at("id"),
        message: `${id} is already used by ${previous}`,
      });
    } else {
      seen.set(id, artifact.file);
    }

    // index/listed — an artifact nobody can navigate to is invisible. This is what keeps inbound
    // navigation honest without hand-maintained backlinks (okf-conventions §8).
    const index = bundle.indexes.get(artifact.dir);
    if (index === undefined) {
      findings.push({
        rule: "index/listed",
        severity: "error",
        file: artifact.file,
        message: `${artifact.dir}/README.md is missing`,
      });
    } else if (!index.includes(`(${artifact.basename})`)) {
      findings.push({
        rule: "index/listed",
        severity: "error",
        file: artifact.file,
        message: `not listed in ${artifact.dir}/README.md`,
      });
    }

    const edges = (links ?? {}) as Record<string, string[]>;
    nodes.push({ id, type, links: edges });
    typed.push({ artifact, id, type, state, links: edges });
  }

  // link/target-exists
  const graph = new ArtifactGraph(nodes);
  const byId = new Map(bundle.artifacts.map((a) => [String(a.frontmatter.id ?? ""), a]));
  for (const id of graph.ids()) {
    for (const edge of graph.outgoing(id)) {
      if (graph.has(edge.to)) continue;
      const artifact = byId.get(id);
      const line = artifact?.keyLines.get("links");
      const finding: Finding = {
        rule: "link/target-exists",
        severity: "error",
        file: artifact?.file ?? id,
        message: `${edge.relationship}: ${edge.to} does not exist`,
      };
      findings.push(line === undefined ? finding : { ...finding, line });
    }
  }

  if (profile) {
    findings.push(...profileFindings({ bundle, profile, graph, artifacts: typed }));
  }

  return findings;
}
