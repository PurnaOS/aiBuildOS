/**
 * A board is a derivation of the record, and nothing else (RQ-0011#AC-1, AC-5, AC-8; ST-0024).
 *
 * Column membership *is* the artifact's state; order inside a column is priority then ID. Neither is
 * stored anywhere — both are recomputed from `artifacts` and `vocabulary` on every call, which is what
 * makes two boards over the same files unable to disagree.
 */

/** The shape a board needs from an artifact — a subset of `project:record`'s response. */
export interface BoardArtifact {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state: string;
  /** A card without one sorts after every prioritised one (BG-0005). */
  readonly priority?: string | undefined;
}

export interface BoardColumn {
  readonly state: string;
  readonly cards: readonly BoardArtifact[];
}

const PRIORITY_RANK: Record<string, number> = { p1: 0, p2: 1, p3: 2 };

function byPriorityThenId(a: BoardArtifact, b: BoardArtifact): number {
  const diff = (PRIORITY_RANK[a.priority ?? ""] ?? 3) - (PRIORITY_RANK[b.priority ?? ""] ?? 3);
  return diff !== 0 ? diff : a.id.localeCompare(b.id);
}

/**
 * One column per vocabulary state, in vocabulary order. A state on an artifact but not in the
 * vocabulary still gets a column, appended after — the honest answer for a record the profile does
 * not fully explain, rather than dropping the artifact (TC-0040 step 3).
 */
export function deriveBoard(
  artifacts: readonly BoardArtifact[],
  vocabulary: readonly string[],
): BoardColumn[] {
  const known = new Set(vocabulary);
  const stray = [...new Set(artifacts.map((a) => a.state).filter((s) => !known.has(s)))].sort();

  return [...vocabulary, ...stray].map((state) => ({
    state,
    cards: artifacts.filter((a) => a.state === state).sort(byPriorityThenId),
  }));
}

/** Story and Bug declare the same vocabulary today; if they diverge, the Work board still shows every
 * state either names, Story's order first. Vocabularies arrive over `project:artifact-types` — the
 * engine resolves the profile in main; nothing in the renderer parses `docs/` (AR-0002). */
export function mergeVocabularies(a: readonly string[], b: readonly string[]): string[] {
  return [...a, ...b.filter((s) => !a.includes(s))];
}
