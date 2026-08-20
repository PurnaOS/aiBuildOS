import type { PlanGroup } from "./derive.js";

/**
 * The approval walk's pure half (RQ-0014#AC-5 to AC-7, TC-0046): what a plan's drafts flip to, and
 * the walk that attempts each flip one at a time.
 *
 * Nothing here calls `window.aibuildos` — `PlanTab.tsx` supplies a `SaveFn` that does, so this module
 * can be driven against a fake in a test without a project on disk.
 */

export interface Finding {
  readonly severity: string;
  readonly message: string;
}

export interface SaveResult {
  readonly problem: string | null;
  readonly findings: readonly Finding[];
}

/** A single guarded save: flip one artifact to one state. */
export type SaveFn = (artifactId: string, state: string) => Promise<SaveResult>;

export interface DraftFlip {
  readonly id: string;
  readonly toState: string;
  /** Set when `project:record` already reports validator errors on this draft — the flip is skipped,
   * never attempted (RQ-0014#AC-7). */
  readonly rejected: boolean;
}

export interface FlipOutcome {
  readonly id: string;
  readonly flipped: boolean;
  /** The record's own words for why not, or `null` when the flip landed. */
  readonly refusal: string | null;
}

/** Every draft in a plan, as the flip approving it attempts: stories to `ready`, tests to `active`. */
export function flipsFor(groups: readonly PlanGroup[]): DraftFlip[] {
  const flips: DraftFlip[] = [];
  for (const group of groups) {
    for (const story of group.stories) {
      flips.push({ id: story.id, toState: "ready", rejected: story.rejected });
      for (const test of story.tests) {
        flips.push({ id: test.id, toState: "active", rejected: test.rejected });
      }
    }
    for (const test of group.tests) {
      flips.push({ id: test.id, toState: "active", rejected: test.rejected });
    }
  }
  return flips;
}

const ALREADY_REJECTED = "The validator already flags this draft; fix it before approving.";

/**
 * One guarded save per artifact, sequentially, never held up by another artifact's refusal
 * (RQ-0014#AC-5, AC-6). A save that lands but carries an error finding is reverted rather than left
 * half-approved — the refusal is the record's own rule refusing the flip, not a check this walk
 * invents (RQ-0014's whole thesis).
 */
export async function approve(flips: readonly DraftFlip[], save: SaveFn): Promise<FlipOutcome[]> {
  const outcomes: FlipOutcome[] = [];

  for (const flip of flips) {
    if (flip.rejected) {
      outcomes.push({ id: flip.id, flipped: false, refusal: ALREADY_REJECTED });
      continue;
    }

    const result = await save(flip.id, flip.toState);
    if (result.problem !== null) {
      outcomes.push({ id: flip.id, flipped: false, refusal: result.problem });
      continue;
    }

    const error = result.findings.find((finding) => finding.severity === "error");
    if (error !== undefined) {
      await save(flip.id, "draft");
      outcomes.push({ id: flip.id, flipped: false, refusal: error.message });
      continue;
    }

    outcomes.push({ id: flip.id, flipped: true, refusal: null });
  }

  return outcomes;
}

/** The sentence a press promises before anything happens. */
export function describeApproval(flips: readonly DraftFlip[]): string {
  const stories = flips.filter((flip) => flip.toState === "ready").length;
  const tests = flips.filter((flip) => flip.toState === "active").length;
  return `Marks ${stories} ${stories === 1 ? "story" : "stories"} ready and ${tests} ${
    tests === 1 ? "test" : "tests"
  } active.`;
}
