import type { FieldDef, Profile, TypeDef } from "./profile.js";

/**
 * Minting an artifact (RQ-0006#AC-2 to AC-4).
 *
 * The act this exists for is not "write a Markdown file". An artifact has an **identity** — a prefix,
 * a number that is append-only and never reused, a directory, the frontmatter its type requires, the
 * body sections its type declares, and a row in an index. Get any of it wrong and the result is a
 * document that looks like an artifact and is not one, which is worse than not having written it.
 *
 * So nothing here is hardcoded. What a type requires comes from the profile
 * ([RQ-0003](../../../docs/requirements/rq-0003.md)); what every artifact requires comes from the
 * conventions. A project whose profile declares types this application has never heard of gets those.
 */

export class OkfCreateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkfCreateError";
  }
}

/** The common frontmatter every artifact carries, in the order the conventions present it. */
const COMMON = ["type", "id", "title", "state", "owner", "provenance", "created"] as const;

/**
 * The next unused number for a prefix.
 *
 * The high-water mark of what the bundle has, plus one — so a gap left by a retired artifact stays a
 * gap, which is what append-only means.
 *
 * ponytail: a number belonging to a *deleted* artifact is reused, because nothing outside git history
 * records that it was ever taken. Recovering it would mean a register the profile does not have.
 */
export function nextId(ids: Iterable<string>, prefix: string): string {
  let highest = 0;
  for (const id of ids) {
    const match = new RegExp(`^${quoteForRegExp(prefix)}-(\\d+)$`, "i").exec(id.trim());
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  // Four digits, widening past 9999 without re-padding what came before (conventions §3).
  return `${prefix.toUpperCase()}-${String(highest + 1).padStart(4, "0")}`;
}

function quoteForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface Scaffold {
  /** The type's `defines` name, which must be one the profile describes and permits directly. */
  readonly type: string;
  readonly id: string;
  readonly title: string;
  /** A git handle. The conventions require one and this code has no way to invent a real one. */
  readonly owner: string;
  /** `YYYY-MM-DD`. Passed in rather than read from a clock, so the caller owns what "today" means. */
  readonly created: string;
}

/**
 * Write out a new artifact.
 *
 * Deliberately `provenance: human` and no `generated` block: a person filled this in through the
 * interface. `generated` is required only when an agent authored or revised the artifact
 * (conventions §2), and claiming otherwise would put a false origin in the record.
 */
export function scaffoldArtifact(profile: Profile, scaffold: Scaffold): string {
  const definition = profile.get(scaffold.type);
  if (definition === undefined) {
    throw new OkfCreateError(`the profile does not describe \`${scaffold.type}\``);
  }
  if (definition.abstract) {
    throw new OkfCreateError(`\`${scaffold.type}\` is abstract, so nothing can be one directly`);
  }
  if (scaffold.owner.trim() === "") {
    throw new OkfCreateError("an artifact needs an owner, and none was given");
  }

  const state = definition.states?.initial ?? definition.states?.vocabulary?.[0];
  if (state === undefined) {
    throw new OkfCreateError(`\`${scaffold.type}\` declares no state to start in`);
  }

  const common: Record<string, string> = {
    type: scaffold.type,
    id: scaffold.id,
    title: JSON.stringify(scaffold.title),
    state,
    owner: scaffold.owner,
    provenance: "human",
    created: scaffold.created,
  };

  const lines = COMMON.map((key) => `${key}: ${common[key]}`);
  // Whatever else this type requires, in the profile's own order, and nothing it does not.
  for (const [key, field] of Object.entries(definition.fields)) {
    if (!field.required || COMMON.includes(key as (typeof COMMON)[number])) continue;
    lines.push(`${key}: ${placeholder(field)}`);
  }

  const body = sections(definition);
  return `---\n${lines.join("\n")}\n---\n\n# ${scaffold.id} — ${scaffold.title}\n${body}`;
}

/**
 * A value for a required field this application knows nothing about.
 *
 * An enum takes its first declared value, because that is a real member of the vocabulary rather than
 * a guess. Anything else is left empty for the author to fill, which the validator will ask for — an
 * empty required field is a question on screen, an invented one is a wrong answer in the record.
 */
function placeholder(field: FieldDef): string {
  if (field.kind === "enum" && field.values?.[0] !== undefined) return field.values[0];
  if (field.kind === "boolean") return "false";
  if (field.kind === "number") return "0";
  return `""`;
}

function sections(definition: TypeDef): string {
  const declared = definition.sections.filter((section) => section.required !== false);
  if (declared.length === 0) return "";

  return declared
    .map((section) => {
      // A criteria section is a list, and its first criterion is `AC-1` — the numbering starts
      // somewhere, and starting it here is what makes the section the shape the validator expects.
      const contents = section.items === "AC" ? "\n- [AC-1] " : "\n";
      return `\n## ${section.name}\n${contents}`;
    })
    .join("");
}

/**
 * Add an artifact's row to its directory index (RQ-0006#AC-4).
 *
 * An artifact not listed in an index is an error the validator reports, so a creation that skipped
 * this would ship a broken bundle the moment it succeeded (conventions §8).
 *
 * Appended rather than sorted: an index's order is the author's, and reordering one to insert a row
 * is a change to every line of a file nobody asked to have rewritten.
 */
export function insertIndexRow(index: string, row: string): string {
  const lines = index.split("\n");

  // The table is the header, its separator, and the rows under it. The last row is where this goes.
  const separator = lines.findIndex((line) => /^\|[\s|:-]+\|$/.test(line));
  if (separator === -1) throw new OkfCreateError("that index has no table to add a row to");

  let last = separator;
  while (lines[last + 1]?.startsWith("|")) last += 1;

  lines.splice(last + 1, 0, row);
  return lines.join("\n");
}
