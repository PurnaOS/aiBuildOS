import { mono } from "../ui.js";

/**
 * A unified diff, computed here from the two sides the agent sent.
 *
 * A whole-line comparison rather than a real diff algorithm: what a transcript shows is a small edit
 * to one file, and the honest ceiling is stated rather than hidden.
 *
 * ponytail: line-by-line, so a large rewrite renders as one big removal and one big addition. Reach
 * for a real diff when a case appears where that reads badly.
 */
export function Diff({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}): React.JSX.Element {
  const before = oldText === "" ? [] : oldText.split("\n");
  const after = newText.split("\n");

  // Trim the common head and tail so an edit shows its neighbourhood, not the whole file.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const removed = before.slice(head, before.length - tail);
  const added = after.slice(head, after.length - tail);

  // Keyed up front: two identical lines in one diff are still two lines, so position is the only
  // identity a diff row has.
  const rows = [
    ...removed.map((line, index) => ({ key: `-${index}`, line, added: false })),
    ...added.map((line, index) => ({ key: `+${index}`, line, added: true })),
  ];

  return (
    <div className="border-t border-neutral-200 dark:border-neutral-800">
      <div className="flex items-baseline gap-2 px-2.5 py-1">
        <span className={`min-w-0 flex-1 truncate text-[11px] text-neutral-500 ${mono}`}>
          {path}
        </span>
        <span className={`shrink-0 text-[11px] text-neutral-500 ${mono}`}>
          +{added.length} −{removed.length}
        </span>
      </div>
      <div className={`max-h-56 overflow-auto pb-1.5 text-[11px] leading-relaxed ${mono}`}>
        {rows.map((row) => (
          <div
            key={row.key}
            className={
              row.added
                ? "bg-emerald-50 px-2.5 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                : "bg-red-50 px-2.5 text-red-800 dark:bg-red-950/40 dark:text-red-300"
            }
          >
            {row.added ? "+" : "−"} {row.line}
          </div>
        ))}
      </div>
    </div>
  );
}
