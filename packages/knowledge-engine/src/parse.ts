import { parse as parseYaml } from "yaml";

export interface OkfDocument {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
  /** 1-based source line of each top-level frontmatter key, for findings that point at a line. */
  readonly keyLines: ReadonlyMap<string, number>;
}

export class OkfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkfParseError";
  }
}

const DELIMITER = "---";

/**
 * Split an OKF document into frontmatter and body.
 *
 * CRLF is reported rather than silently normalised: normalising is itself a formatting change the
 * caller did not ask for, and this repository mandates LF (okf-conventions §2).
 *
 * Round-trip-preserving *editing* is deliberately not here yet. When it arrives it must operate on
 * the `yaml` package's CST layer rather than its `Document` API, which reformats tokens it never
 * touched — see DC-0009.
 */
export function parseOkfDocument(raw: string): OkfDocument {
  if (raw.includes("\r\n")) {
    throw new OkfParseError("OKF documents must use LF line endings, found CRLF");
  }

  const lines = raw.split("\n");
  if (lines[0] !== DELIMITER) {
    throw new OkfParseError("OKF document must open with a `---` frontmatter delimiter");
  }

  const closing = lines.indexOf(DELIMITER, 1);
  if (closing === -1) {
    throw new OkfParseError("OKF document has no closing `---` frontmatter delimiter");
  }

  const frontmatterLines = lines.slice(1, closing);
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterLines.join("\n"));
  } catch (cause) {
    throw new OkfParseError(`frontmatter is not valid YAML: ${(cause as Error).message}`);
  }

  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new OkfParseError("frontmatter must be a YAML mapping");
  }

  const keyLines = new Map<string, number>();
  frontmatterLines.forEach((line, index) => {
    const match = /^([A-Za-z_][\w-]*):/.exec(line);
    if (match?.[1] && !keyLines.has(match[1])) keyLines.set(match[1], index + 2);
  });

  return {
    frontmatter: (parsed ?? {}) as Record<string, unknown>,
    body: lines.slice(closing + 1).join("\n"),
    keyLines,
  };
}

/** True when a file looks like an OKF artifact at all. Permissive consumption: skip, do not throw. */
export function hasFrontmatter(raw: string): boolean {
  return raw.startsWith(`${DELIMITER}\n`);
}
