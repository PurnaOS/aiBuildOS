import { CST, Parser } from "yaml";

/**
 * Writing an artifact back without disturbing what was not edited (RQ-0005#AC-8).
 *
 * This is the write path [DC-0009](../../../docs/decisions/dc-0009.md) deferred, and the reason it
 * insisted on the **CST** rather than the `Document` API: `docs/` is committed, and a writer that
 * reformats frontmatter it never touched destroys the diff. The diff is how a human reviews what an
 * agent changed, so preserving it is not tidiness — it is the property that keeps the record
 * reviewable.
 *
 * The CST keeps every token's original source, including comments, quoting style, indentation and
 * key order. Editing a scalar replaces that scalar and nothing else.
 *
 * The body is not YAML and is not touched by any of this: it is spliced back verbatim.
 */

export class OkfEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkfEditError";
  }
}

const DELIMITER = "---";

interface Split {
  readonly frontmatter: string;
  /**
   * Everything after the line the closing delimiter is on — that line's own newline excluded.
   *
   * The same convention `parseOkfDocument` uses, and it has to be: a body handed to `editArtifact`
   * has usually been round-tripped through that parser, and a one-newline disagreement between the
   * two would silently eat the blank line under the frontmatter on every save.
   */
  readonly body: string;
}

/**
 * Split a document into its frontmatter source and its body.
 *
 * CRLF is refused rather than normalised, exactly as `parseOkfDocument` refuses it: normalising is a
 * whole-file change nobody asked for (okf-conventions §2).
 */
function split(source: string): Split {
  if (source.includes("\r\n")) {
    throw new OkfEditError("OKF documents must use LF line endings, found CRLF");
  }

  const lines = source.split("\n");
  if (lines[0] !== DELIMITER) {
    throw new OkfEditError("OKF document must open with a `---` frontmatter delimiter");
  }

  const closing = lines.indexOf(DELIMITER, 1);
  if (closing === -1) {
    throw new OkfEditError("OKF document has no closing `---` frontmatter delimiter");
  }

  return {
    frontmatter: lines.slice(1, closing).join("\n"),
    body: lines.slice(closing + 1).join("\n"),
  };
}

/** What an edit may set. A `string[]` writes a flow sequence: `links.implements: [RQ-0001]`. */
export type FieldValue = string | number | boolean | readonly string[];

export interface ArtifactEdit {
  /**
   * Top-level frontmatter keys to set. A dotted key reaches one level in, which is all the profile's
   * own shape needs: `links.implements`.
   */
  readonly frontmatter?: Readonly<Record<string, FieldValue>>;
  /**
   * Replaces the body: everything after the line the closing delimiter is on, that line's own
   * newline excluded — `parseOkfDocument`'s convention, which is where a body normally comes from.
   * Left out, the body is untouched.
   */
  readonly body?: string;
  /**
   * Paths this edit is allowed to **create** when the file does not carry them yet.
   *
   * Adding `links.verified_by` to a requirement that has never had one, or `last_result` to a
   * TestCase nobody has walked, is ordinary editing, but the engine has no way to tell either apart
   * from a typo — only the profile knows which relationships and fields a type declares. So the
   * caller vouches for the paths it knows are legal, and every other missing key is still refused
   * rather than invented.
   *
   * Two shapes: `parent.child` with a list value, for a relationship such as `links.implements`; or a
   * bare top-level key with a scalar value, for a profile field with no value yet.
   */
  readonly create?: readonly string[];
}

/**
 * Apply an edit and return the new document.
 *
 * Every key not named is left exactly as it was found — same quoting, same comments, same order.
 */
export function editArtifact(source: string, edit: ArtifactEdit): string {
  const parts = split(source);
  const frontmatter =
    edit.frontmatter === undefined || Object.keys(edit.frontmatter).length === 0
      ? parts.frontmatter
      : setKeys(parts.frontmatter, edit.frontmatter, new Set(edit.create ?? []));

  const body = edit.body ?? parts.body;
  return `${DELIMITER}\n${frontmatter}\n${DELIMITER}\n${body}`;
}

function setKeys(
  yaml: string,
  values: Readonly<Record<string, FieldValue>>,
  creatable: ReadonlySet<string>,
): string {
  // A vouched-for key the file does not carry yet is inserted as text before anything is parsed. A
  // pure insertion disturbs nothing else in the file.
  let source = yaml;
  const remaining: Record<string, FieldValue> = {};
  for (const [path, value] of Object.entries(values)) {
    const inserted = creatable.has(path) ? insertMissing(source, path, value) : null;
    if (inserted === null) {
      remaining[path] = value;
      continue;
    }
    source = inserted.source;
    // A scalar insertion only writes a placeholder; the real value still needs `setExisting`, which
    // is where `CST.setScalarValue` decides whether it needs quoting — the same place every value set
    // on an *existing* key already gets that from.
    if (!inserted.resolved) remaining[path] = value;
  }
  if (Object.keys(remaining).length === 0) return source;

  return setExisting(source, remaining);
}

/** A list of IDs as a flow sequence — the form every `links:` entry in this bundle already uses. */
function flow(ids: readonly string[]): string {
  return `[${ids.join(", ")}]`;
}

/**
 * Insert a missing key when the frontmatter does not carry it yet, returning `null` when it already
 * does and the ordinary CST edit should handle it instead.
 *
 * Two shapes:
 * - `parent.child` with a list value — the shape every `links:` relationship uses. Written whole, as
 *   a flow sequence, and reported `resolved: true` since a list has no further quoting question
 *   `setExisting` could answer.
 * - A bare top-level key with a scalar value — a profile field with no value yet, such as a
 *   TestCase's `last_result` before anything has walked it. Only a placeholder is written here;
 *   `resolved: false` sends the real value on to `setExisting`, which is where quoting is decided.
 */
function insertMissing(
  yaml: string,
  path: string,
  value: FieldValue,
): { source: string; resolved: boolean } | null {
  const [key, nested] = path.split(".") as [string, string | undefined];

  if (nested === undefined) {
    if (Array.isArray(value)) return null; // a bare top-level list has never been asked for
    if (yaml.split("\n").some((line) => line.startsWith(`${key}:`))) return null;
    return { source: `${yaml}\n${key}: x`, resolved: false };
  }
  if (!Array.isArray(value)) return null;

  const lines = yaml.split("\n");
  const parentAt = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (parentAt === -1) {
    return { source: `${yaml}\n${key}:\n  ${nested}: ${flow(value)}`, resolved: true };
  }

  // The parent's children are the indented lines that follow it.
  let last = parentAt;
  for (let at = parentAt + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    // Compared as text rather than as a pattern: a relationship name comes from the profile, and a
    // name carrying regex punctuation would otherwise match something it is not.
    if (line.trim().startsWith(`${nested}:`)) return null;
    last = at;
  }

  const indent = /^(\s+)/.exec(lines[parentAt + 1] ?? "")?.[1] ?? "  ";
  lines.splice(last + 1, 0, `${indent}${nested}: ${flow(value)}`);
  return { source: lines.join("\n"), resolved: true };
}

function setExisting(yaml: string, values: Readonly<Record<string, FieldValue>>): string {
  const tokens = [...new Parser().parse(yaml)];
  const document = tokens.find((token) => token.type === "document");
  if (document === undefined) throw new OkfEditError("frontmatter is not a YAML document");

  for (const [path, value] of Object.entries(values)) {
    const [key, nested] = path.split(".") as [string, string | undefined];
    const map = document.value;
    if (map === undefined || map.type !== "block-map") {
      throw new OkfEditError("frontmatter must be a YAML mapping");
    }

    const item = findKey(map, key);
    if (item === undefined) throw new OkfEditError(`frontmatter has no key \`${key}\``);

    if (nested === undefined) {
      write(item, value);
      continue;
    }

    // One level in, for `links.implements` and nothing more elaborate.
    const inner = item.value;
    if (inner === undefined || inner.type !== "block-map") {
      throw new OkfEditError(`\`${key}\` is not a mapping, so \`${path}\` cannot be set`);
    }
    const innerItem = findKey(inner, nested);
    if (innerItem === undefined) throw new OkfEditError(`\`${key}\` has no key \`${nested}\``);
    write(innerItem, value);
  }

  return CST.stringify(document);
}

type BlockMap = Extract<NonNullable<CST.Document["value"]>, { type: "block-map" }>;
type Item = BlockMap["items"][number];

function findKey(map: BlockMap, key: string): Item | undefined {
  return map.items.find((item) => {
    const token = item.key;
    return token !== undefined && token !== null && "source" in token && token.source === key;
  });
}

/**
 * Replace one value, in the form the file already writes it.
 *
 * A list found as a flow sequence stays flow; a list found as a block sequence stays block, at the
 * indentation it already uses. Converting between the two is a formatting change to a region nobody
 * asked about, which is the whole thing this writer exists to avoid.
 */
function write(item: Item, value: FieldValue): void {
  const target = item.value;
  if (target === undefined || target === null) {
    throw new OkfEditError("cannot set a key that has no value token");
  }

  if (Array.isArray(value)) {
    const ids = value as readonly string[];
    if (target.type === "block-seq") {
      rewriteBlockSequence(target, ids);
      return;
    }
    // A flow sequence is a single token whose source is the whole `[a, b]`, so it is replaced as
    // source rather than through `setScalarValue`, which would quote the brackets into a string.
    if ("source" in target) {
      target.source = flow(ids);
      if (target.type !== "scalar") (target as { type: string }).type = "scalar";
      return;
    }
    const replacement = CST.createScalarToken(flow(ids), { indent: 0 });
    replacement.source = flow(ids);
    item.value = replacement;
    return;
  }

  if (!("source" in target)) {
    throw new OkfEditError("cannot set a key whose value is not a scalar");
  }
  // `setScalarValue` does its own quoting and escaping, so the text is handed over raw.
  CST.setScalarValue(target, String(value));
}

type BlockSeq = Extract<NonNullable<Item["value"]>, { type: "block-seq" }>;

/**
 * Rewrite a block sequence's entries in place, keeping the indentation and the `- ` the file uses.
 *
 * The first entry sits on the line the key opened, so it carries no leading indent of its own; every
 * later one begins with the sequence's own indentation. Each entry's newline belongs to its value.
 */
function rewriteBlockSequence(sequence: BlockSeq, ids: readonly string[]): void {
  const first = sequence.items[0];
  if (first === undefined) throw new OkfEditError("cannot rewrite an empty block sequence");

  const pad = " ".repeat(sequence.indent);
  const marker = first.start.filter((token) => token.type !== "space" || token.source !== pad);

  sequence.items = ids.map((id, at) => ({
    start:
      at === 0 ? first.start : [{ type: "space", indent: 0, offset: -1, source: pad }, ...marker],
    value: {
      type: "scalar",
      indent: sequence.indent,
      offset: -1,
      source: id,
      end: [{ type: "newline", indent: 0, offset: -1, source: "\n" }],
    },
  }));
}

/**
 * Keep a directory index in step with the artifact it lists (RQ-0005#AC-10).
 *
 * An index is navigation, hand-maintained, and the validator insists every artifact appears in one
 * (conventions §8). Saving a state change without touching the index leaves the record disagreeing
 * with itself — the artifact says `built`, the table still says `draft`.
 *
 * The row is found by the link in its **first cell** and edited in place: its title and state cells,
 * and nothing else. Matching anywhere in the line would catch a sibling's row too — a requirement's
 * row names the requirements it depends on, with exactly the same link — and rewrite that row's
 * title and state with this artifact's.
 */
export function updateIndexRow(
  index: string,
  id: string,
  values: { title?: string; state?: string },
): string {
  if (values.title === undefined && values.state === undefined) return index;

  const link = `[${id}](${id.toLowerCase()}.md)`;
  return index
    .split("\n")
    .map((line) => {
      if (!line.startsWith("|")) return line;

      // `| ID | Title | State | …` — split on the pipes, keeping the leading and trailing empties so
      // the row rebuilds exactly as it was apart from the cells being set.
      const cells = line.split("|");
      if (cells.length < 5 || !cells[1]?.includes(link)) return line;

      if (values.title !== undefined) cells[2] = ` ${values.title} `;
      if (values.state !== undefined) cells[3] = ` ${values.state} `;
      return cells.join("|");
    })
    .join("\n");
}
