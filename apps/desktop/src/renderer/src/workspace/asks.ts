/**
 * A completed assistant message, split into prose and question fences (ST-0030, DC-0020, TC-0051).
 *
 * The fence — info string `aibuildos-question`, JSON body `{ question, options: [{ id, label }],
 * allowFreeText }` — is a convention a model can get wrong in every way there is: bad JSON, missing
 * fields, an ordinary code fence, a fence with no closing line. Every one of those stays exactly the
 * prose it already was (RQ-0016#AC-5) — this never throws and never drops a character.
 */

export interface QuestionOption {
  readonly id: string;
  readonly label: string;
}

export interface QuestionSegment {
  readonly kind: "question";
  readonly question: string;
  readonly options: readonly QuestionOption[];
  readonly allowFreeText: boolean;
}

export interface ProseSegment {
  readonly kind: "prose";
  readonly text: string;
}

export type Segment = ProseSegment | QuestionSegment;

// Fence markers on their own line, as `fencedQuestion` in the stub agent writes them. An unterminated
// opening never matches, so the text from there to the end of the message falls through as prose.
const FENCE = /^```aibuildos-question\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

export function splitAsks(content: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  FENCE.lastIndex = 0;
  let match = FENCE.exec(content);
  while (match !== null) {
    const question = parseQuestion(match[1] ?? "");
    if (question === null) {
      // Not well-formed: leave the fence where it is, keep scanning past it for another one.
      match = FENCE.exec(content);
      continue;
    }

    if (match.index > cursor)
      segments.push({ kind: "prose", text: content.slice(cursor, match.index) });
    segments.push(question);
    cursor = match.index + match[0].length;
    match = FENCE.exec(content);
  }

  if (cursor < content.length) segments.push({ kind: "prose", text: content.slice(cursor) });
  return segments;
}

function parseQuestion(raw: string): QuestionSegment | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;

  const { question, options, allowFreeText } = data as Record<string, unknown>;
  if (typeof question !== "string" || question.trim() === "") return null;
  if (!Array.isArray(options) || options.length === 0) return null;

  const parsedOptions: QuestionOption[] = [];
  for (const option of options) {
    if (typeof option !== "object" || option === null) return null;
    const { id, label } = option as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string") return null;
    parsedOptions.push({ id, label });
  }

  return {
    kind: "question",
    question,
    options: parsedOptions,
    allowFreeText: allowFreeText !== false,
  };
}
