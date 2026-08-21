/**
 * A changed requirement's blast radius (RQ-0024, ST-0036, TC-0064): its inbound `implements` and
 * `verifies` edges, told apart by what they mean rather than left as one flat list.
 *
 * Pure — reads what `project:record` already returned, nothing fetched here. The record's own
 * `inbound` array is who points *at* an artifact; this walks one requirement's inbound once and
 * sorts what it finds into three groups: work already done, work still moving, and what verifies it.
 * "What implements and verifies it" is a read of the graph the record already is, not a bookkeeping
 * duty (RQ-0024's own framing) — there is no separate impact index to fall out of sync.
 */

/** One artifact named in a group: enough to show it, nothing this module invented. */
export interface ImpactRow {
  readonly id: string;
  readonly title: string;
  readonly state: string;
}

export interface Impact {
  readonly done: readonly ImpactRow[];
  readonly inFlight: readonly ImpactRow[];
  readonly verification: readonly ImpactRow[];
}

/**
 * The slice of a record row this module reads. Structural, not `ChannelResponse<"project:record">`
 * itself — the same reasoning `playbooks.ts`'s `RecordEntry` follows: a narrower type is what lets a
 * test build one without inventing the record's own derived-links machinery.
 */
export interface RecordEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state: string;
  readonly inbound: readonly { relationship: string; id: string }[];
}

const DONE_STATES = new Set(["accepted", "done"]);

/**
 * A requirement's implementers and verifiers, told apart as done, in flight, and verification
 * (RQ-0024#AC-1, AC-2).
 *
 * An Epic can also `implements` a requirement, but an epic is grouping, not work — it is excluded
 * here on purpose, `Story`/`Bug` are what count as implementers. Anything short of `accepted`/`done`
 * groups as in flight, deliberately including a state the profile never declared: "still moving" is
 * the honest bucket for a state nobody named yet.
 */
export function deriveImpact(artifacts: readonly RecordEntry[], requirementId: string): Impact {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const inbound = byId.get(requirementId)?.inbound ?? [];

  const done: ImpactRow[] = [];
  const inFlight: ImpactRow[] = [];
  const verification: ImpactRow[] = [];

  for (const edge of inbound) {
    const row = byId.get(edge.id);
    if (row === undefined) continue;
    const entry: ImpactRow = { id: row.id, title: row.title, state: row.state };

    if (edge.relationship === "implements" && (row.type === "Story" || row.type === "Bug")) {
      (DONE_STATES.has(row.state) ? done : inFlight).push(entry);
    } else if (edge.relationship === "verifies" && row.type === "TestCase") {
      verification.push(entry);
    }
  }

  return { done, inFlight, verification };
}
