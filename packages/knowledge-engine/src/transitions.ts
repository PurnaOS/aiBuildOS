import type { TypeDef } from "./profile.js";

/**
 * State legality at the one place it can be checked (RQ-0010, ST-0023).
 *
 * `docs/profile/` declares `from -> to` pairs, but a validator sees one commit and cannot know what a
 * state was before it (RQ-0003). The application's save path can: it reads the file before it writes
 * it, so the previous state is already in its hand. This module is the pure computation over the
 * profile that path calls; it has no opinion about where the previous state came from.
 */

const CRITERION = /^\s*[-*]\s*\[AC-(\d+)\]/gm;

/**
 * Every state `current` may move to, per this type's declared transitions. Retirement's `{ from: "*",
 * to: retired }` matches from anywhere, including a `current` outside the vocabulary — that state has
 * no declared pair of its own, so the wildcard is the only one that matches, and retirement is all
 * that comes back (AC-3, AC-5).
 */
export function legalNextStates(def: TypeDef, current: string): string[] {
  const targets = new Set<string>();
  for (const transition of def.states?.transitions ?? []) {
    const from = Array.isArray(transition.from) ? transition.from : [transition.from];
    if (from.includes(current) || from.includes("*")) targets.add(transition.to);
  }
  return [...targets];
}

/** Whether `from -> to` is one of the pairs this type declares. */
export function legalTransition(def: TypeDef, from: string, to: string): boolean {
  return legalNextStates(def, from).includes(to);
}

/** A save's state change, refused in words naming the pair — or `null` when it is a declared one. */
export function transitionRefusal(
  def: TypeDef,
  type: string,
  from: string,
  to: string,
): string | null {
  if (legalTransition(def, from, to)) return null;
  return `${type} has no transition from "${from}" to "${to}"`;
}

/** The `[AC-n]` numbers used anywhere in a body, in the order they appear. */
function criteriaNumbers(body: string): number[] {
  return [...body.matchAll(CRITERION)].map((match) => Number(match[1]));
}

/**
 * A criteria edit, refused in words — or `null` when it is legal.
 *
 * Compares one save's before and after: a number the old body did not carry may only join the new one
 * if it is greater than the old body's highest, because a retired number is at or below that highest
 * and must never come back (AC-4). A number repeated within the new body is refused outright, whatever
 * it is — that is a duplicate whether or not it is fresh.
 */
export function criteriaRefusal(oldBody: string, newBody: string): string | null {
  const before = new Set(criteriaNumbers(oldBody));
  const max = before.size === 0 ? 0 : Math.max(...before);

  const seen = new Set<number>();
  for (const number of criteriaNumbers(newBody)) {
    if (seen.has(number)) {
      return `[AC-${number}] is used more than once — criterion numbers are unique per artifact`;
    }
    seen.add(number);
    if (!before.has(number) && number <= max) {
      return `[AC-${number}] was already used and cannot come back — new criteria append after AC-${max}`;
    }
  }
  return null;
}
