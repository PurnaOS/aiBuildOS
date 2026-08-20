/**
 * The shared class strings.
 *
 * There is no design-token layer and no component library here: Tailwind utilities inline, plus these
 * few repeated strings (DC-0004). They live in one module rather than at the top of whichever file
 * needed them first.
 *
 * The rule the project UI follows: **every fact Git owns is set in monospace, every word the app says
 * is set in sans.** Paths, branch names, hashes and counts are data; labels and prose are voice.
 */

export const field =
  "w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";

export const button =
  "rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

/** The one emphasised action on a page. Used for "New project" and nothing else so far. */
export const primary =
  "rounded bg-neutral-900 px-3 py-1 text-sm text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300";

/** Section eyebrow: the smallest thing on the page, and the only uppercase one. */
export const eyebrow = "text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-500";

/** Anything Git said. Tabular so columns of counts and hashes line up down the page. */
export const mono = "font-mono tabular-nums";

export const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-100";

/** A board card (ST-0024): bordered and draggable, never coloured by state — the column it sits in
 * already says that. */
export const card =
  "w-full rounded border border-neutral-300 bg-white px-2.5 py-1.5 text-left text-sm shadow-sm dark:border-neutral-700 dark:bg-neutral-900";

/**
 * The status rail — a 2px rule down the left edge of a project row, coloured by working-tree state.
 *
 * Colour is never the only signal: every caller prints the same fact as text beside it, because a rail
 * alone is unreadable to anyone who cannot separate amber from grey.
 */
export function rail(state: "clean" | "dirty" | "missing"): string {
  if (state === "missing") return "bg-red-600";
  if (state === "dirty") return "bg-amber-500";
  return "bg-neutral-200 dark:bg-neutral-800";
}

/**
 * Shorten a path from the middle. The tail is what identifies a project — two folders called `web`
 * are told apart by what is above them and by nothing at the end — so truncating the end is the one
 * thing that must not happen.
 */
export function middleTruncate(path: string, max = 52): string {
  if (path.length <= max) return path;
  const keep = Math.floor((max - 1) / 2);
  return `${path.slice(0, keep)}…${path.slice(-keep)}`;
}

/** "2 minutes ago". Coarse on purpose: the exact second is never the question being asked. */
export function relativeTime(iso: string | null): string {
  if (iso === null) return "never opened";

  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never opened";

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  // Each pair is "divide by this, and the result is in *that* unit". Labelling them with the unit
  // being divided *from* is the off-by-one that renders a week-old commit as "7 minutes ago".
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "minute"],
    [60, "hour"],
    [24, "day"],
    [7, "week"],
    [4.35, "month"],
    [12, "year"],
  ];

  let value = seconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  for (const [size, next] of units) {
    if (Math.abs(value) < size) break;
    value = Math.round(value / size);
    unit = next;
  }

  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-value, unit);
}
