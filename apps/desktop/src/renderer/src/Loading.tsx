/**
 * One shared "nothing to show yet" line (RQ-0029#AC-4).
 *
 * The rail, the board and the plan each used to spell "Loading…" on their own — five near-identical
 * strings that read as five different states rather than one. A quiet pulse instead of a spinner:
 * nothing here waits long enough to earn real motion. `className` carries only the call site's own
 * layout (padding, text size) — colour and the pulse are the one treatment, not something each caller
 * can drift from.
 */
export function Loading({ className = "" }: { className?: string }): React.JSX.Element {
  return (
    <p data-testid="loading" className={`animate-pulse text-neutral-500 ${className}`}>
      Loading…
    </p>
  );
}
