import { ArtifactGraph, type GraphNode } from "./graph.js";
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
  readonly keyLines: ReadonlyMap<string, number>;
}

export interface Bundle {
  readonly artifacts: readonly LoadedArtifact[];
  /** Directory (repo-relative) -> the raw text of its `README.md`, where one exists. */
  readonly indexes: ReadonlyMap<string, string>;
}

/**
 * The four rules worth having on day one. Gates, state-machine enforcement and the wider rule
 * registry each arrive with their own requirement (DC-0009).
 */
export function validate(bundle: Bundle): Finding[] {
  const findings: Finding[] = [];
  const seen = new Map<string, string>();
  const nodes: GraphNode[] = [];

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

    const { id, type, links } = parsed.data;

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

    nodes.push({ id, type, links: (links ?? {}) as Record<string, string[]> });
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

  return findings;
}
