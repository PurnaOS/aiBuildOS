/**
 * The plan view's pure half (RQ-0014, ST-0027, TC-0046): every draft Story and TestCase, gathered
 * from a loaded record and grouped by the Requirement each story implements.
 *
 * Nothing here talks to `window.aibuildos` or React — `PlanTab.tsx` fetches the record and renders
 * what this returns. The plan holds no state of its own (RQ-0014#AC-2): the same record, read twice,
 * derives the same groups both times.
 */

/** The slice of a record row this module reads — the same fields `project:record` already returns. */
export interface RecordEntry {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly state: string;
  readonly problems: { errors: number; warnings: number };
  readonly inbound: readonly { relationship: string; id: string }[];
}

/** One draft — a Story or a TestCase — as a plan row needs it. */
export interface PlanDraft {
  readonly id: string;
  readonly title: string;
  /** The validator already flags this draft (RQ-0014#AC-7): its flip is refused before it is even
   * attempted, not after. */
  readonly rejected: boolean;
}

export interface PlanStory extends PlanDraft {
  /** Draft tests verifying this story — by their own `verifies`, or by the story's `verified_by`
   * pointing at them; either is "a draft TC verifying a draft story rides with it" (ST-0027). */
  readonly tests: readonly PlanDraft[];
}

export interface PlanGroup {
  readonly requirementId: string;
  readonly requirementTitle: string;
  readonly stories: readonly PlanStory[];
  /** Draft tests verifying the requirement directly — not claimed by any story under it. */
  readonly tests: readonly PlanDraft[];
}

function toDraft(entry: RecordEntry): PlanDraft {
  return { id: entry.id, title: entry.title, rejected: entry.problems.errors > 0 };
}

/**
 * Dependency-then-ID order (RQ-0014#AC-3, TC-0046 step 1): a prerequisite renders before whatever
 * `depends_on` it, ties broken by ID so the order is otherwise deterministic. Reads dependency edges
 * off each entry's own `inbound` — `depends_on` is stored on the dependent, so it shows up as an
 * inbound edge on the prerequisite (okf-conventions §4).
 */
function orderByDependency<T extends RecordEntry>(entries: readonly T[]): T[] {
  const byId = (a: T, b: T): number => a.id.localeCompare(b.id);
  const ids = new Set(entries.map((e) => e.id));
  const remaining = new Map(entries.map((e) => [e.id, 0]));
  const dependents = new Map<string, string[]>();

  for (const entry of entries) {
    for (const edge of entry.inbound) {
      if (edge.relationship !== "depends_on" || !ids.has(edge.id)) continue;
      // `edge.id` depends_on `entry.id`, so `entry.id` must be ordered first.
      const list = dependents.get(entry.id);
      if (list) list.push(edge.id);
      else dependents.set(entry.id, [edge.id]);
      remaining.set(edge.id, (remaining.get(edge.id) ?? 0) + 1);
    }
  }

  const queue = entries
    .filter((e) => remaining.get(e.id) === 0)
    .slice()
    .sort(byId);
  const ordered: T[] = [];
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: the length check above guarantees an element
    const next = queue.shift()!;
    ordered.push(next);
    for (const dependentId of dependents.get(next.id) ?? []) {
      const left = (remaining.get(dependentId) ?? 1) - 1;
      remaining.set(dependentId, left);
      if (left !== 0) continue;
      // biome-ignore lint/style/noNonNullAssertion: dependentId came from this same entries array
      const item = entries.find((e) => e.id === dependentId)!;
      const at = queue.findIndex((q) => q.id.localeCompare(item.id) > 0);
      if (at === -1) queue.push(item);
      else queue.splice(at, 0, item);
    }
  }

  // A cycle is the profile's `cycles: forbid` to catch, not this view's — but a cycle that slipped
  // through still has to render, appended by ID rather than dropped from the plan.
  if (ordered.length < entries.length) {
    const seen = new Set(ordered.map((e) => e.id));
    ordered.push(...entries.filter((e) => !seen.has(e.id)).sort(byId));
  }
  return ordered;
}

/**
 * Every draft Story and TestCase, grouped by the Requirement each story `implements`, in build order.
 *
 * A story's tests are found two ways, because both directions are stored in this project (the link
 * table in okf-conventions §4): a TestCase's own `verifies` pointing at the story, or the story's own
 * `verified_by` pointing at the TestCase — the plan-writer playbook uses the latter. A test claimed by
 * no story rides under the requirement it verifies directly.
 */
export function derivePlan(artifacts: readonly RecordEntry[]): PlanGroup[] {
  const draftStories = artifacts.filter((a) => a.type === "Story" && a.state === "draft");
  const draftTests = artifacts.filter((a) => a.type === "TestCase" && a.state === "draft");
  const requirements = artifacts.filter((a) => a.type === "Requirement");
  const testIds = new Set(draftTests.map((t) => t.id));
  const storyIds = new Set(draftStories.map((s) => s.id));
  const storyById = new Map(draftStories.map((s) => [s.id, s]));
  const testById = new Map(draftTests.map((t) => [t.id, t]));

  const claimed = new Set<string>();
  const testsFor = new Map<string, PlanDraft[]>();
  for (const story of draftStories) {
    const direct = story.inbound
      .filter((edge) => edge.relationship === "verifies" && testIds.has(edge.id))
      .map((edge) => edge.id);
    const viaVerifiedBy = draftTests
      .filter((test) =>
        test.inbound.some((edge) => edge.relationship === "verified_by" && edge.id === story.id),
      )
      .map((test) => test.id);
    const ids = [...new Set([...direct, ...viaVerifiedBy])].sort();
    for (const id of ids) claimed.add(id);
    testsFor.set(
      story.id,
      ids.flatMap((id) => {
        const test = testById.get(id);
        return test ? [toDraft(test)] : [];
      }),
    );
  }

  const candidates = requirements.filter((requirement) => {
    const hasStory = requirement.inbound.some(
      (edge) => edge.relationship === "implements" && storyIds.has(edge.id),
    );
    const hasTest = requirement.inbound.some(
      (edge) => edge.relationship === "verifies" && testIds.has(edge.id) && !claimed.has(edge.id),
    );
    return hasStory || hasTest;
  });

  return orderByDependency(candidates).map((requirement) => {
    const stories = orderByDependency(
      requirement.inbound
        .filter((edge) => edge.relationship === "implements" && storyIds.has(edge.id))
        .flatMap((edge) => {
          const story = storyById.get(edge.id);
          return story ? [story] : [];
        }),
    );
    const tests = requirement.inbound
      .filter(
        (edge) => edge.relationship === "verifies" && testIds.has(edge.id) && !claimed.has(edge.id),
      )
      .flatMap((edge) => {
        const test = testById.get(edge.id);
        return test ? [toDraft(test)] : [];
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    return {
      requirementId: requirement.id,
      requirementTitle: requirement.title,
      stories: stories.map((story) => ({
        ...toDraft(story),
        tests: testsFor.get(story.id) ?? [],
      })),
      tests,
    };
  });
}
