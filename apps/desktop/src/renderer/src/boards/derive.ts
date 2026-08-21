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

/** `project:record`'s own derived-inverse shape (okf-conventions §4): who links to this artifact,
 * and by which relationship. */
export interface InboundEdge {
  readonly relationship: string;
  readonly id: string;
}

/**
 * Which sprint(s) a story or bug belongs to (RQ-0035, DC-0025): the reverse index of a Sprint's own
 * `contains` reaches it as an inbound `contains` edge — the derived inverse keeps the stored
 * relationship's name (`graph.ts`), so no separate "contained_by" lookup exists to fall out of sync
 * with it. A card can carry more than one, though the UI only ever starts a sprint with cards that
 * carry none yet.
 */
export function sprintsOf(inbound: readonly InboundEdge[]): string[] {
  return inbound.filter((edge) => edge.relationship === "contains").map((edge) => edge.id);
}

/** `all | backlog | <sprint id>` — the Work header's sprint selector (RQ-0035#AC-5). */
export type SprintFilter = "all" | "backlog" | (string & {});

/**
 * The board's cards, narrowed to one sprint filter — a filter, not swimlanes (RQ-0035#AC-5): `all`
 * changes nothing, `backlog` is every card no sprint's `contains` reaches, and a sprint id is only
 * the cards that sprint reaches.
 */
export function filterBySprint<T extends { readonly id: string }>(
  cards: readonly T[],
  membership: ReadonlyMap<string, readonly string[]>,
  filter: SprintFilter,
): T[] {
  if (filter === "all") return [...cards];
  return cards.filter((card) => {
    const sprints = membership.get(card.id) ?? [];
    return filter === "backlog" ? sprints.length === 0 : sprints.includes(filter);
  });
}

/** "3/5 accepted" (RQ-0035#AC-5) — counted over whatever the caller already narrowed to. */
export function sprintProgress(cards: readonly { readonly state: string }[]): {
  readonly accepted: number;
  readonly total: number;
} {
  return { accepted: cards.filter((c) => c.state === "accepted").length, total: cards.length };
}
