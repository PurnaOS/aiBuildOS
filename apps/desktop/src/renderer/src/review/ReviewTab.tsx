import type { Tab } from "../workspace/TabStrip.js";

/**
 * A story under review: its criteria beside the working tree's changes (RQ-0015, ST-0028).
 *
 * A placeholder until ST-0028 lands — wired into the tab switch now so the plan and review lanes
 * never edit the same files. The tab id is `review:<story-id>`.
 */
export function ReviewTab(_props: {
  projectId: string;
  storyId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  onPrompt: (text: string) => void;
}): React.JSX.Element {
  return <p className="p-6 text-sm text-neutral-500">Nothing is under review here yet.</p>;
}
