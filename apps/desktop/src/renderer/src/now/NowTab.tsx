import type { Tab } from "../workspace/TabStrip.js";

/**
 * Now: every running build, live, and what waits on a person (RQ-0021, ST-0038).
 *
 * A placeholder until ST-0038 lands — pinned and wired now so the lane building it never edits
 * the shared files.
 */
export function NowTab(_props: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  return <p className="p-6 text-sm text-neutral-500">Nothing is building right now.</p>;
}
