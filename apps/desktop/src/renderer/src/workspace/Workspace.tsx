import { useCallback, useState } from "react";
import { Group, type Layout, Panel, Separator } from "react-resizable-panels";
import { useSession } from "../session/useSession.js";
import { ArtifactTab } from "./ArtifactTab.js";
import { Chat } from "./Chat.js";
import { DiffTab } from "./DiffTab.js";
import { FilesRail } from "./FilesRail.js";
import { FileTab } from "./FileTab.js";
import { RecordRail } from "./RecordRail.js";
import { RevisionContext, useWorkspaceRevision } from "./revision.js";
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
  // What tells the rails the project has moved: the agent's turns ending, and the user's own saves.
  const { revision, bump } = useWorkspaceRevision(
    session.state.status === "ready" ? session.state.sessionId : null,
  );
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
    // The rail already knows where the artifact lives, so this reads the one file rather than
    // loading and validating the whole bundle to arrive at the same text.
    async (artifact: { id: string; file: string }) => {
      const { text } = await window.aibuildos.invoke("project:file", {
        id: projectId,
        path: artifact.file,
      });
      setPending(
        text === null
          ? `Work on ${artifact.id}.`
          : `Work on ${artifact.id}. This is what it says:\n\n${text}`,
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
    <RevisionContext value={revision}>
      <Group
        orientation="horizontal"
        id="workspace"
        className="flex-1"
        data-testid="workspace"
        {...(defaultLayout ? { defaultLayout } : {})}
        onLayoutChanged={remember}
      >
        <Panel id="record" defaultSize={20} minSize={12} collapsible collapsedSize={0}>
          <RecordRail
            projectId={projectId}
            onOpen={tabs.open}
            onWorkOn={(artifact) => void workOn(artifact)}
            onCreated={(artifactId) => {
              bump();
              tabs.open({ id: artifactId, kind: "artifact", title: artifactId });
            }}
          />
        </Panel>
        <Handle />

        <Panel id="centre" defaultSize={55} minSize={30}>
          <div className="flex h-full flex-col">
            <TabStrip {...tabs} />
            {/* Every open tab stays mounted; only the focused one is shown. Unmounting would throw
              away an editor's unsaved work the moment someone glanced at the conversation, and would
              drop the conversation's own scrollback on the way back. */}
            {tabs.tabs.map((tab) => (
              <div
                key={tab.id}
                className={tab.id === tabs.active ? "min-h-0 flex-1" : "hidden"}
                aria-hidden={tab.id !== tabs.active}
              >
                {tab.kind === "chat" ? (
                  <Chat
                    projectId={projectId}
                    session={session}
                    pending={pending}
                    onSent={() => setPending(null)}
                  />
                ) : tab.kind === "diff" ? (
                  <DiffTab projectId={projectId} path={tab.id.replace(/^diff:/, "")} />
                ) : tab.kind === "file" ? (
                  <FileTab
                    projectId={projectId}
                    path={tab.id}
                    sessionId={session.state.status === "ready" ? session.state.sessionId : null}
                    onDirtyChange={(dirty) => tabs.setDirty(tab.id, dirty)}
                  />
                ) : tab.kind === "artifact" ? (
                  <ArtifactTab
                    projectId={projectId}
                    artifactId={tab.id}
                    sessionId={session.state.status === "ready" ? session.state.sessionId : null}
                    onSaved={bump}
                    onDirtyChange={(dirty) => tabs.setDirty(tab.id, dirty)}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </Panel>
        <Handle />

        <Panel id="files" defaultSize={25} minSize={14} collapsible collapsedSize={0}>
          <FilesRail
            projectId={projectId}
            onOpen={tabs.open}
            onCreated={(path) => {
              bump();
              tabs.open({ id: path, kind: "file", title: path.split("/").pop() ?? path });
            }}
          />
        </Panel>
      </Group>
    </RevisionContext>
  );
}

function Handle(): React.JSX.Element {
  return (
    <Separator className="w-px bg-neutral-200 transition-colors hover:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600" />
  );
}
