import type { Tab } from "../workspace/TabStrip.js";

/**
 * The plan: everything at `draft`, gathered for review and approval (RQ-0014, ST-0027).
 *
 * A placeholder until ST-0027 lands — wired into the tab switch now so the plan and review lanes
 * never edit the same files.
 */
export function PlanTab(_props: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  return <p className="p-6 text-sm text-neutral-500">Nothing is waiting for approval.</p>;
}
