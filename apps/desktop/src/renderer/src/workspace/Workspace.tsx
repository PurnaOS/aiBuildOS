import { useCallback, useState } from "react";
import { Group, type Layout, Panel, Separator } from "react-resizable-panels";
import { useSession } from "../session/useSession.js";
import { Chat } from "./Chat.js";
import { DiffTab } from "./DiffTab.js";
import { FilesRail } from "./FilesRail.js";
import { RecordRail } from "./RecordRail.js";
import { TabStrip, useTabs } from "./TabStrip.js";

/**
 * The project workspace (ST-0011): the record on the left, the conversation in the centre, the
 * project's files on the right.
 *
 * The ordering is the product's argument rather than a preference — the left rail is what the work
 * is *for*, the right is where it *lands*, and the conversation that connects them sits between
 * them.
 */
const LAYOUT_KEY = "aibuildos.workspace.layout";

/**
 * Pane widths, remembered between runs (ST-0011#AC-2).
 *
 * `localStorage` rather than the Zustand store or the main process: this is a property of this
 * window on this screen, it is not domain state, and nothing else needs to read it (DC-0005).
 */
function readLayout(): Layout | undefined {
  try {
    const stored = window.localStorage.getItem(LAYOUT_KEY);
    return stored ? (JSON.parse(stored) as Layout) : undefined;
  } catch {
    // A layout that will not parse is one the user resized once; it is not worth a broken window.
    return undefined;
  }
}

export function Workspace({ projectId }: { projectId: string }): React.JSX.Element {
  const session = useSession(projectId);
  const tabs = useTabs();
  const [defaultLayout] = useState<Layout | undefined>(readLayout);
  /**
   * A message the record rail wants sent.
   *
   * The rail sits outside CopilotKit's provider, so it cannot send one itself. It hands the text up
   * here and the conversation sends it — which keeps the message in the transcript, where a message
   * belongs, rather than slipping it to the agent behind the conversation's back.
   */
  const [pending, setPending] = useState<string | null>(null);

  const workOn = useCallback(
    async (artifactId: string) => {
      const { markdown } = await window.aibuildos.invoke("project:artifact", {
        id: projectId,
        artifactId,
      });
      setPending(
        markdown === null
          ? `Work on ${artifactId}.`
          : `Work on ${artifactId}. This is what it says:\n\n${markdown}`,
      );
    },
    [projectId],
  );

  const remember = useCallback((layout: Layout) => {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Storage full or blocked. The panes still work; they just forget.
    }
  }, []);

  return (
    <Group
      orientation="horizontal"
      id="workspace"
      className="flex-1"
      data-testid="workspace"
      {...(defaultLayout ? { defaultLayout } : {})}
      onLayoutChanged={remember}
    >
      <Panel id="record" defaultSize={20} minSize={12} collapsible collapsedSize={0}>
        <RecordRail projectId={projectId} onOpen={tabs.open} onWorkOn={(id) => void workOn(id)} />
      </Panel>
      <Handle />

      <Panel id="centre" defaultSize={55} minSize={30}>
        <div className="flex h-full flex-col">
          <TabStrip {...tabs} />
          <div className="min-h-0 flex-1">
            {tabs.active === "chat" ? (
              <Chat
                projectId={projectId}
                session={session}
                pending={pending}
                onSent={() => setPending(null)}
              />
            ) : tabs.activeTab?.kind === "diff" ? (
              <DiffTab projectId={projectId} path={tabs.active.replace(/^diff:/, "")} />
            ) : (
              <Placeholder tab={tabs.activeTab} />
            )}
          </div>
        </div>
      </Panel>
      <Handle />

      <Panel id="files" defaultSize={25} minSize={14} collapsible collapsedSize={0}>
        <FilesRail projectId={projectId} onOpen={tabs.open} />
      </Panel>
    </Group>
  );
}

function Handle(): React.JSX.Element {
  return (
    <Separator className="w-px bg-neutral-200 transition-colors hover:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600" />
  );
}

/**
 * A tab whose editor has not been built yet.
 *
 * Says what it is rather than pretending — editing files and artifacts is
 * [RQ-0005](../../../../../docs/requirements/rq-0005.md), and a blank panel would read as a bug.
 */
function Placeholder({
  tab,
}: {
  tab: { kind: string; title: string } | undefined;
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center">
      <div>
        <p className="font-mono text-sm">{tab?.title}</p>
        <p className="mt-2 text-xs text-neutral-500">
          {tab?.kind === "artifact" ? "Artifact" : "File"} editing arrives with RQ-0005.
        </p>
      </div>
    </div>
  );
}
