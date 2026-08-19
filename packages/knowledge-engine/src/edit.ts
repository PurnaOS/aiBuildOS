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
  readonly body: string;
  /** The exact newline the file uses between the closing delimiter and the body. */
  readonly separator: string;
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
    separator: "\n",
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
  /** Replaces everything after the closing delimiter. Left out, the body is untouched. */
  readonly body?: string;
  /**
   * Paths this edit is allowed to **create** when the file does not carry them yet.
   *
   * Adding `links.verified_by` to a requirement that has never had one is ordinary editing, but the
   * engine has no way to tell that apart from a typo — only the profile knows which relationships a
   * type declares. So the caller vouches for the paths it knows are legal, and every other missing
   * key is still refused rather than invented.
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
  return `${DELIMITER}\n${frontmatter}\n${DELIMITER}${parts.separator}${body}`;
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
    if (inserted === null) remaining[path] = value;
    else source = inserted;
  }
  if (Object.keys(remaining).length === 0) return source;

  return setExisting(source, remaining);
}

/**
 * Render a value as YAML source. A list becomes a flow sequence — the form every `links:` entry in
 * this bundle already uses — and a scalar is quoted only when leaving it bare would change its
 * meaning.
 */
function render(value: FieldValue): string {
  if (Array.isArray(value)) return `[${(value as readonly string[]).join(", ")}]`;
  const text = String(value);
  return /^[\w][\w .@/-]*$/.test(text) ? text : JSON.stringify(text);
}

/**
 * Insert `path` with its value if the frontmatter has no such key, returning `null` when it is
 * already there and the ordinary CST edit should handle it.
 */
function insertMissing(yaml: string, path: string, value: FieldValue): string | null {
  const [key, nested] = path.split(".") as [string, string | undefined];
  const lines = yaml.split("\n");
  const parentAt = lines.findIndex((line) => line.startsWith(`${key}:`));

  if (nested === undefined) {
    if (parentAt !== -1) return null;
    return `${yaml}\n${key}: ${render(value)}`;
  }

  if (parentAt === -1) return `${yaml}\n${key}:\n  ${nested}: ${render(value)}`;

  // The parent's children are the indented lines that follow it.
  let last = parentAt;
  for (let at = parentAt + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? "";
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    if (new RegExp(`^\\s+${nested}:`).test(line)) return null;
    last = at;
  }

  const indent = /^(\s+)/.exec(lines[parentAt + 1] ?? "")?.[1] ?? "  ";
  lines.splice(last + 1, 0, `${indent}${nested}: ${render(value)}`);
  return lines.join("\n");
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
 * Replace one value.
 *
 * A list is written as a flow sequence, which is what every `links:` entry in this bundle already
 * uses; `CST.setScalarValue` then quotes and escapes whatever needs it.
 */
function write(item: Item, value: FieldValue): void {
  const target = item.value;
  if (target === undefined || target === null) {
    throw new OkfEditError("cannot set a key that has no value token");
  }

  // `setScalarValue` does its own quoting, so a scalar is handed over raw; only a sequence has to
  // arrive already written as source.
  const text = Array.isArray(value) ? render(value) : String(value);

  // A sequence has to be written as raw source: it is not a scalar, and `setScalarValue` would quote
  // the brackets into a string.
  if (Array.isArray(value)) {
    if ("source" in target) {
      target.source = text;
      if (target.type !== "scalar") (target as { type: string }).type = "scalar";
      return;
    }
    // The existing value is a block sequence or a mapping: replace it wholesale with a flow one.
    const replacement = CST.createScalarToken(text, { indent: 0 });
    replacement.source = text;
    item.value = replacement;
    return;
  }

  if (!("source" in target)) {
    throw new OkfEditError("cannot set a key whose value is not a scalar");
  }
  CST.setScalarValue(target, text);
}

/**
 * Keep a directory index in step with the artifact it lists (RQ-0005#AC-10).
 *
 * An index is navigation, hand-maintained, and the validator insists every artifact appears in one
 * (conventions §8). Saving a state change without touching the index leaves the record disagreeing
 * with itself — the artifact says `built`, the table still says `draft`.
 *
 * The row is found by the artifact's own link and edited in place: its title and state cells, and
 * nothing else. Every other row, and the row's own trailing cells, are left exactly as they were.
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
      if (!line.startsWith("|") || !line.includes(link)) return line;

      // `| ID | Title | State | …` — split on the pipes, keeping the leading and trailing empties so
      // the row rebuilds exactly as it was apart from the cells being set.
      const cells = line.split("|");
      if (cells.length < 5) return line;

      if (values.title !== undefined) cells[2] = ` ${values.title} `;
      if (values.state !== undefined) cells[3] = ` ${values.state} `;
      return cells.join("|");
    })
    .join("\n");
}
