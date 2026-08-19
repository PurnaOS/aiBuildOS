import type { ArtifactGraph } from "./graph.js";
import type { LinkDef, Profile, TypeDef } from "./profile.js";
import { baseArtifactId } from "./schema.js";
import type { Bundle, Finding, LoadedArtifact } from "./validate.js";

/**
 * The profile-driven rules — OKFlint (RQ-0003, ST-0007, ST-0008).
 *
 * Everything here is decided by `docs/profile/`, not by this file: editing a type definition changes
 * what is enforced, which is the whole claim of conventions §6. What is compiled in is the *shape* of
 * a constraint, never a constraint itself.
 *
 * Severity is part of the design. A type the profile does not describe is a **warning** — `AR` is
 * ID-reserved and deliberately unprofiled, and OKF requires a reader to tolerate unknown types
 * (conventions §1). Everything the profile does describe is an error, because there the schema has an
 * opinion and the artifact contradicts it.
 */

/** An artifact whose common frontmatter already parsed, so the rules can read it without re-checking. */
export interface TypedArtifact {
  readonly artifact: LoadedArtifact;
  readonly id: string;
  readonly type: string;
  readonly state: string;
  readonly links: Record<string, string[]>;
}

export interface RuleContext {
  readonly bundle: Bundle;
  readonly profile: Profile;
  readonly graph: ArtifactGraph;
  readonly artifacts: readonly TypedArtifact[];
}

export function profileFindings(ctx: RuleContext): Finding[] {
  // No profile, no profile rules. A newly created project is a valid bundle before it is a described
  // one, and `validate` is right to be silent about that (RQ-0003#AC-14).
  if (ctx.profile.names().length === 0) return [];

  const findings: Finding[] = [];
  const criteria = criteriaByArtifact(ctx.artifacts);

  for (const typed of ctx.artifacts) {
    const def = ctx.profile.get(typed.type);
    if (!def) {
      findings.push({
        rule: "type/unknown",
        severity: "warn",
        ...at(typed.artifact, "type"),
        message: `no type definition for "${typed.type}" — checked against the common rules only`,
      });
      continue;
    }
    checkFrontmatter(findings, ctx, typed, def);
    checkLinks(findings, ctx, typed, def, criteria);
    checkBody(findings, typed, def);
  }

  checkCycles(findings, ctx);
  return findings;
}

// --- frontmatter (ST-0007) ------------------------------------------------------------------

function checkFrontmatter(
  findings: Finding[],
  ctx: RuleContext,
  typed: TypedArtifact,
  def: TypeDef,
): void {
  const { artifact, id, type, state } = typed;

  if (def.abstract) {
    findings.push({
      rule: "type/abstract",
      severity: "error",
      ...at(artifact, "type"),
      message: `${type} is abstract and cannot be used directly`,
    });
  }

  if (def.prefix !== undefined && !id.startsWith(`${def.prefix}-`)) {
    findings.push({
      rule: "type/prefix",
      severity: "error",
      ...at(artifact, "id"),
      message: `a ${type} must use the ${def.prefix} prefix, not ${id.split("-")[0]}`,
    });
  }

  if (def.dir !== undefined) {
    const dir = bundleRelative(ctx.bundle.root, artifact.dir);
    if (dir !== def.dir) {
      findings.push({
        rule: "type/dir",
        severity: "error",
        file: artifact.file,
        message: `a ${type} belongs in ${def.dir}/, not ${dir || "the bundle root"}`,
      });
    }
  }

  for (const [name, field] of Object.entries(def.fields)) {
    const value = artifact.frontmatter[name];
    if (value === undefined || value === null) {
      if (field.required) {
        findings.push({
          rule: "field/required",
          severity: "error",
          ...at(artifact, name),
          message: `${type} requires the field \`${name}\``,
        });
      }
      continue;
    }
    if (field.values && !field.values.includes(String(value))) {
      findings.push({
        rule: "field/enum",
        severity: "error",
        ...at(artifact, name),
        message: `${name}: "${String(value)}" is not one of ${field.values.join(", ")}`,
      });
    }
  }

  // Membership only. Enforcing *transitions* needs to know the previous state, which one commit
  // cannot show — that is its own requirement (RQ-0003).
  if (def.states && !def.states.vocabulary.includes(state)) {
    findings.push({
      rule: "state/unknown",
      severity: "error",
      ...at(artifact, "state"),
      message: `state: "${state}" is not one of ${def.states.vocabulary.join(", ")}`,
    });
  }
}

// --- links (ST-0008) ------------------------------------------------------------------------

function checkLinks(
  findings: Finding[],
  ctx: RuleContext,
  typed: TypedArtifact,
  def: TypeDef,
  criteria: ReadonlyMap<string, ReadonlySet<number>>,
): void {
  const { artifact, links, state } = typed;

  for (const [relationship, targets] of Object.entries(links)) {
    const linkDef = def.links[relationship];
    if (!linkDef) {
      findings.push({
        rule: "link/unknown-relationship",
        severity: "warn",
        ...at(artifact, "links"),
        message: `${typed.type} does not declare the relationship \`${relationship}\``,
      });
      continue;
    }

    for (const target of targets) {
      const targetId = baseArtifactId(target);
      const node = ctx.graph.node(targetId);
      // A target that does not exist is `link/target-exists`'s finding. Two findings for one typo
      // is noise (ST-0008#AC-5).
      if (!node) continue;

      if (!linkDef.target.some((accepted) => ctx.profile.isA(node.type, accepted))) {
        findings.push({
          rule: "link/target-type",
          severity: "error",
          ...at(artifact, "links"),
          message: `${relationship}: ${targetId} is a ${node.type}, expected ${linkDef.target.join(" or ")}`,
        });
      }

      const hash = target.indexOf("#");
      if (hash === -1) continue;
      const number = Number(target.slice(hash + 1).replace("AC-", ""));
      if (!criteria.get(targetId.toUpperCase())?.has(number)) {
        findings.push({
          rule: "link/criterion-exists",
          severity: "error",
          ...at(artifact, "links"),
          message: `${relationship}: ${targetId} has no criterion AC-${number}`,
        });
      }
    }
  }

  for (const [relationship, linkDef] of Object.entries(def.links)) {
    checkCardinality(findings, artifact, relationship, linkDef, links[relationship]?.length ?? 0, {
      ...(def.states === undefined ? {} : { initial: def.states.initial }),
      state,
    });
  }
}

/**
 * Conventions §4 spells the constraint as "min: 1 **for a Story at `ready`**" while the profile
 * stores a bare `min: 1`; conventions win by precedence. Flipping to `ready` is the scheduling act,
 * so a draft is allowed to be half-written — a validator that forbids that makes drafting impossible.
 * `max` has no such exemption: too many links is wrong at every state.
 */
function checkCardinality(
  findings: Finding[],
  artifact: LoadedArtifact,
  relationship: string,
  linkDef: LinkDef,
  count: number,
  states: { initial?: string; state: string },
): void {
  if (linkDef.min !== undefined && count < linkDef.min && states.state !== states.initial) {
    findings.push({
      rule: "link/cardinality",
      severity: "error",
      ...at(artifact, "links"),
      message: `${relationship}: needs at least ${linkDef.min}, found ${count}`,
    });
  }
  if (linkDef.max !== undefined && count > linkDef.max) {
    findings.push({
      rule: "link/cardinality",
      severity: "error",
      ...at(artifact, "links"),
      message: `${relationship}: allows at most ${linkDef.max}, found ${count}`,
    });
  }
}

/** One finding per cycle, naming the path around it — not one per artifact standing on it. */
function checkCycles(findings: Finding[], ctx: RuleContext): void {
  const forbidden = new Set<string>();
  for (const name of ctx.profile.names()) {
    for (const [relationship, linkDef] of Object.entries(ctx.profile.get(name)?.links ?? {})) {
      if (linkDef.cycles === "forbid") forbidden.add(relationship);
    }
  }

  const fileOf = new Map(ctx.artifacts.map((t) => [t.id.toUpperCase(), t.artifact]));
  for (const relationship of forbidden) {
    for (const cycle of findCycles(ctx.graph, relationship)) {
      const artifact = fileOf.get(cycle[0] ?? "");
      findings.push({
        rule: "link/cycle",
        severity: "error",
        ...(artifact ? at(artifact, "links") : { file: cycle[0] ?? relationship }),
        message: `${relationship} is cyclic: ${[...cycle, cycle[0]].join(" -> ")}`,
      });
    }
  }
}

function findCycles(graph: ArtifactGraph, relationship: string): string[][] {
  enum Mark {
    Unvisited = 0,
    OnStack = 1,
    Done = 2,
  }
  const marks = new Map<string, Mark>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const reported = new Set<string>();

  const visit = (id: string): void => {
    marks.set(id, Mark.OnStack);
    stack.push(id);
    for (const edge of graph.outgoing(id, relationship)) {
      const mark = marks.get(edge.to) ?? Mark.Unvisited;
      if (mark === Mark.Unvisited) {
        if (graph.has(edge.to)) visit(edge.to);
      } else if (mark === Mark.OnStack) {
        const cycle = stack.slice(stack.indexOf(edge.to));
        const key = canonical(cycle);
        if (!reported.has(key)) {
          reported.add(key);
          cycles.push(cycle);
        }
      }
    }
    stack.pop();
    marks.set(id, Mark.Done);
  };

  for (const id of graph.ids()) {
    if ((marks.get(id) ?? Mark.Unvisited) === Mark.Unvisited) visit(id);
  }
  return cycles;
}

/** Rotate a cycle to start at its smallest member, so the same loop found twice compares equal. */
function canonical(cycle: string[]): string {
  let start = 0;
  for (let i = 1; i < cycle.length; i++) {
    if ((cycle[i] ?? "") < (cycle[start] ?? "")) start = i;
  }
  return [...cycle.slice(start), ...cycle.slice(0, start)].join(">");
}

// --- body (ST-0008) -------------------------------------------------------------------------

function checkBody(findings: Finding[], typed: TypedArtifact, def: TypeDef): void {
  if (def.sections.length === 0) return;
  const sections = splitSections(typed.artifact.body);

  for (const section of def.sections) {
    const text = sections.get(section.name);
    if (text === undefined) {
      if (section.required) {
        findings.push({
          rule: "body/section-missing",
          severity: "error",
          file: typed.artifact.file,
          message: `${typed.type} requires a "## ${section.name}" section`,
        });
      }
      continue;
    }

    if (section.items !== "AC") continue;
    const numbers = criteriaIn(text);
    if (numbers.length === 0) {
      findings.push({
        rule: "body/criteria",
        severity: "error",
        file: typed.artifact.file,
        message: `"${section.name}" has no [AC-n] items`,
      });
      continue;
    }
    // Numbers are append-only, not dense: retiring AC-2 leaves 1, 3, 4. Only reuse is wrong.
    const seen = new Set<number>();
    for (const number of numbers) {
      if (seen.has(number)) {
        findings.push({
          rule: "body/criteria",
          severity: "error",
          file: typed.artifact.file,
          message: `[AC-${number}] is used more than once — criterion IDs are unique per artifact`,
        });
      }
      seen.add(number);
    }
  }
}

/** Second-level headings only — a required section is a `## `, not a `### `. */
function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];

  for (const line of body.split("\n")) {
    const heading = /^##[^#]\s*(.+?)\s*$/.exec(line);
    if (!heading) {
      if (name !== undefined) lines.push(line);
      continue;
    }
    if (name !== undefined) sections.set(name, lines.join("\n"));
    name = heading[1];
    lines = [];
  }
  if (name !== undefined) sections.set(name, lines.join("\n"));
  return sections;
}

const CRITERION = /^\s*[-*]\s*\[AC-(\d+)\]/gm;

function criteriaIn(text: string): number[] {
  return [...text.matchAll(CRITERION)].map((match) => Number(match[1]));
}

/**
 * Every artifact's criterion numbers, for resolving `RQ-0007#AC-2`. Scanned from the whole body
 * rather than from the marked section: criterion IDs are unique per *artifact* (conventions §3), and
 * the target of a criterion link may be a type the profile does not describe.
 */
function criteriaByArtifact(artifacts: readonly TypedArtifact[]): Map<string, ReadonlySet<number>> {
  return new Map(
    artifacts.map((typed) => [typed.id.toUpperCase(), new Set(criteriaIn(typed.artifact.body))]),
  );
}

function bundleRelative(root: string, dir: string): string {
  if (root === "" || dir === root) return dir === root ? "" : dir;
  return dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : dir;
}

function at(artifact: LoadedArtifact, key: string): Pick<Finding, "file" | "line"> {
  const line = artifact.keyLines.get(key);
  return line === undefined ? { file: artifact.file } : { file: artifact.file, line };
}
