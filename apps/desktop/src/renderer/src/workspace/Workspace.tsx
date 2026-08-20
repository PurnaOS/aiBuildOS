import { useCallback, useEffect, useState } from "react";
import { Group, type Layout, Panel, Separator } from "react-resizable-panels";
import { BoardTab } from "../boards/BoardTab.js";
import { PlanTab } from "../plan/PlanTab.js";
import { ReviewTab } from "../review/ReviewTab.js";
import { useSession } from "../session/useSession.js";
import { ArtifactTab } from "./ArtifactTab.js";
import { Chat } from "./Chat.js";
import { DiffTab } from "./DiffTab.js";
import { FilesRail } from "./FilesRail.js";
import { FileTab } from "./FileTab.js";
import { RecordRail } from "./RecordRail.js";
import { BumpContext, RevisionContext, useWorkspaceRevision } from "./revision.js";
import { TabStrip, useTabs } from "./TabStrip.js";

/**
 * The project workspace (ST-0011): the record on the left, the conversation in the centre, the
 * project's files on the right.
 *
 * The ordering is the product's argument rather than a preference — the left rail is what the work
 * is *for*, the right is where it *lands*, and the conversation that connects them sits between
 * them.
 */
export function Workspace({ projectId }: { projectId: string }): React.JSX.Element {
  const session = useSession(projectId);
  const tabs = useTabs();
  // What tells the rails the project has moved: the agent's turns ending, and the user's own saves.
  const { revision, bump, streaming } = useWorkspaceRevision(
    session.state.status === "ready" ? session.state.sessionId : null,
  );
  /**
   * Pane widths, remembered between runs (ST-0011#AC-2, BG-0004).
   *
   * Read from the installation's settings rather than `localStorage`, where they were written for
   * months and never survived a restart: Chromium flushes local storage on its own schedule, and an
   * exit that does not wait loses whatever had not been written. Still not domain state (DC-0005) —
   * it is a property of this window, kept somewhere that lasts.
   *
   * `undefined` until the settings answer; the panes take their default sizes until then.
   */
  const [defaultLayout, setDefaultLayout] = useState<Layout | undefined>(undefined);
  const [layoutRead, setLayoutRead] = useState(false);

  useEffect(() => {
    let live = true;
    void window.aibuildos
      .invoke("settings:get", {})
      .then((settings) => {
        if (!live) return;
        // Whatever shape the panel library gives back, kept and handed straight back to it.
        if (settings.layout !== null && typeof settings.layout === "object") {
          setDefaultLayout(settings.layout as Layout);
        }
        setLayoutRead(true);
      })
      .catch(() => {
        if (live) setLayoutRead(true);
      });
    return () => {
      live = false;
    };
  }, []);
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
    // Fire and forget: a layout that cannot be written is worth no interruption, and the panes still
    // work. What it must not do is throw into an event handler.
    void window.aibuildos.invoke("settings:set-chrome", { layout }).catch(() => undefined);
  }, []);

  // Mounted only once the stored layout is known: `defaultLayout` is read at mount by the panel
  // group, so handing it over later would have no effect at all.
  if (!layoutRead) return <div data-testid="workspace-loading" className="flex-1" />;

  return (
    <RevisionContext value={revision}>
      <BumpContext value={bump}>
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
                  ) : tab.kind === "board" ? (
                    <BoardTab projectId={projectId} onOpen={tabs.open} onPrompt={setPending} />
                  ) : tab.kind === "plan" ? (
                    <PlanTab projectId={projectId} onOpen={tabs.open} onPrompt={setPending} />
                  ) : tab.kind === "review" ? (
                    <ReviewTab
                      projectId={projectId}
                      storyId={tab.id.replace(/^review:/, "")}
                      onOpen={tabs.open}
                      onPrompt={setPending}
                    />
                  ) : tab.kind === "diff" ? (
                    <DiffTab projectId={projectId} path={tab.id.replace(/^diff:/, "")} />
                  ) : tab.kind === "file" ? (
                    <FileTab
                      projectId={projectId}
                      path={tab.id}
                      sessionId={session.state.status === "ready" ? session.state.sessionId : null}
                      streaming={streaming}
                      onDirtyChange={(dirty) => tabs.setDirty(tab.id, dirty)}
                    />
                  ) : tab.kind === "artifact" ? (
                    <ArtifactTab
                      projectId={projectId}
                      artifactId={tab.id}
                      sessionId={session.state.status === "ready" ? session.state.sessionId : null}
                      streaming={streaming}
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
      </BumpContext>
    </RevisionContext>
  );
}

function Handle(): React.JSX.Element {
  return (
    <Separator className="w-px bg-neutral-200 transition-colors hover:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600" />
  );
}
