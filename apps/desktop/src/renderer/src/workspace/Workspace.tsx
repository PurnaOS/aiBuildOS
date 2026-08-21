import { useCallback, useEffect, useState } from "react";
import { Group, type Layout, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { PlanSurface } from "../boards/PlanSurface.js";
import { WorkBoard } from "../boards/WorkBoard.js";
import { ActivityDock } from "../dock/ActivityDock.js";
import { setMainStreaming } from "../dock/motion.js";
import { SessionTab } from "../dock/SessionTab.js";
import { ReviewTab } from "../review/ReviewTab.js";
import { useTurnEnd } from "../review/useTurnEnd.js";
import { useSession } from "../session/useSession.js";
import { focusRing } from "../ui.js";
import { ArtifactTab } from "./ArtifactTab.js";
import { Chat } from "./Chat.js";
import { DiffTab } from "./DiffTab.js";
import { FilesRail } from "./FilesRail.js";
import { FileTab } from "./FileTab.js";
import { RecordRail } from "./RecordRail.js";
import { BumpContext, RevisionContext, useWorkspaceRevision } from "./revision.js";
import { TabStrip, useTabs } from "./TabStrip.js";
import { useToolCallStream } from "./toolCall.js";
import { shouldWalk, workOn as workOnArtifact } from "./workOn.js";

/** PB-0003, the build playbook — the same artifact WorkBoard's Build reads (RQ-0027#AC-1). */
const PLAYBOOK_ID = "PB-0003";

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
  // What tells the rails the project has moved: the watcher's `project:changed`, and the user's
  // own saves (DC-0022).
  const { revision, bump, streaming } = useWorkspaceRevision(
    projectId,
    session.state.status === "ready" ? session.state.sessionId : null,
  );
  // The one line this lane owns here (RQ-0030#AC-1): everything else about showing it lives in
  // `dock/motion.ts` and `TabStrip.tsx`.
  useEffect(() => setMainStreaming(streaming), [streaming]);
  /**
   * A turn-end read or flip that failed (BG-0006, ST-0040#AC-2), or "Work on this" hitting a
   * refusal or a rejected read of its own (RQ-0027#AC-1). Nothing on disk changed either way, so
   * the watcher has nothing to tell the rails — this is the one thing only the failing call itself
   * can say, and the smallest honest place to say it: a dismissible line above the tab strip, not a
   * toast that outlives its own relevance or a rail-specific surface that only half the workspace
   * would see. Named for what it now covers, not only the turn-end walk that first needed it.
   */
  const [workspaceProblem, setWorkspaceProblem] = useState<string | null>(null);
  // Every session's tool calls, kept whether or not anything is looking (BG-0008).
  useToolCallStream();
  useTurnEnd(
    projectId,
    session.state.status === "ready" ? session.state.sessionId : null,
    setWorkspaceProblem,
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
    // The rail already knows where the artifact lives, but not its type or state — `onWorkOn`
    // hands over only `{ id, file }` — so this reads the artifact first to decide, the same read
    // WorkBoard's Build already does. Only a Story at ready/queued goes on to fetch the requirement
    // it implements and PB-0003; everything else reads the one file it always did.
    async (artifact: { id: string; file: string }) => {
      setWorkspaceProblem(null);
      try {
        const detail = await window.aibuildos.invoke("project:artifact", {
          id: projectId,
          artifactId: artifact.id,
        });
        const type = typeof detail.frontmatter.type === "string" ? detail.frontmatter.type : "";
        const state = typeof detail.frontmatter.state === "string" ? detail.frontmatter.state : "";
        const walking = shouldWalk({ type, state });

        const result = await workOnArtifact(
          (artifactId, frontmatter) =>
            window.aibuildos.invoke("project:artifact-save", {
              id: projectId,
              artifactId,
              frontmatter,
            }),
          { id: artifact.id, type, state },
          async () => {
            const implementsLink = detail.links.find((link) => link.relationship === "implements");
            const requirementId = implementsLink?.current[0];
            if (requirementId === undefined) return null;
            const playbook = await window.aibuildos.invoke("project:artifact", {
              id: projectId,
              artifactId: PLAYBOOK_ID,
            });
            return {
              storyId: artifact.id,
              storyTitle:
                typeof detail.frontmatter.title === "string"
                  ? detail.frontmatter.title
                  : artifact.id,
              requirementId,
              requirementTitle:
                implementsLink?.candidates.find((c) => c.id === requirementId)?.title ??
                requirementId,
              playbookBody: playbook.body,
            };
          },
          async () => {
            const { text } = await window.aibuildos.invoke("project:file", {
              id: projectId,
              path: artifact.file,
            });
            return text;
          },
        );

        if (result.problem !== null) {
          setWorkspaceProblem(result.problem);
          return;
        }
        if (walking) bump();
        if (result.prompt !== null) setPending(result.prompt);
      } catch (cause) {
        setWorkspaceProblem(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [projectId, bump],
  );

  const remember = useCallback((layout: Layout) => {
    // Fire and forget: a layout that cannot be written is worth no interruption, and the panes still
    // work. What it must not do is throw into an event handler.
    void window.aibuildos.invoke("settings:set-chrome", { layout }).catch(() => undefined);
  }, []);

  /**
   * The activity dock's own resizable panel (RQ-0044#AC-1): collapsed it is a 28px strip, expanded it
   * is user-resizable — both against the *same* `Panel`, never a remount, so a turn in flight never
   * loses its subscriptions when someone drags or clicks. `collapsed` mirrors the panel's own size
   * (via `onResize`) so `ActivityDock` knows which chrome to draw; the panel's imperative handle is
   * what a click on its own toggle drives.
   */
  const dockPanelRef = usePanelRef();
  const [dockCollapsed, setDockCollapsed] = useState(true);
  const toggleDock = useCallback(() => {
    if (dockPanelRef.current?.isCollapsed()) dockPanelRef.current.expand();
    else dockPanelRef.current?.collapse();
  }, [dockPanelRef]);

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
            {/* The activity dock sits under every surface (RQ-0044, DC-0027) — a second, vertical
            Group nested in this Panel, so dragging or toggling it never touches the horizontal split
            beside it. */}
            <Group orientation="vertical" id="centre-vertical" className="flex h-full flex-col">
              <Panel id="centre-tabs" minSize={120}>
                <div className="flex h-full flex-col">
                  {workspaceProblem !== null && (
                    <div
                      data-testid="turn-end-problem"
                      className="flex shrink-0 items-center justify-between gap-2 border-b border-neutral-200 px-3 py-1.5 text-xs text-red-600 dark:border-neutral-800"
                    >
                      <span>{workspaceProblem}</span>
                      <button
                        type="button"
                        aria-label="Dismiss"
                        onClick={() => setWorkspaceProblem(null)}
                        className={`text-red-600 hover:text-red-700 ${focusRing}`}
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <TabStrip {...tabs} />
                  {/* Every open tab stays mounted; only the focused one is shown. Unmounting would
                  throw away an editor's unsaved work the moment someone glanced at the conversation,
                  and would drop the conversation's own scrollback on the way back. */}
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
                          onOpen={tabs.open}
                        />
                      ) : tab.kind === "plan" ? (
                        <PlanSurface
                          projectId={projectId}
                          onOpen={tabs.open}
                          onPrompt={setPending}
                        />
                      ) : tab.kind === "work" ? (
                        <WorkBoard projectId={projectId} onOpen={tabs.open} onPrompt={setPending} />
                      ) : tab.kind === "session" ? (
                        <SessionTab
                          projectId={projectId}
                          sessionId={tab.id.replace(/^session:/, "")}
                        />
                      ) : tab.kind === "review" ? (
                        <ReviewTab
                          projectId={projectId}
                          storyId={tab.id.replace(/^review:/, "")}
                          onPrompt={setPending}
                        />
                      ) : tab.kind === "diff" ? (
                        <DiffTab projectId={projectId} path={tab.id.replace(/^diff:/, "")} />
                      ) : tab.kind === "file" ? (
                        <FileTab
                          projectId={projectId}
                          path={tab.id}
                          sessionId={
                            session.state.status === "ready" ? session.state.sessionId : null
                          }
                          streaming={streaming}
                          onDirtyChange={(dirty) => tabs.setDirty(tab.id, dirty)}
                        />
                      ) : tab.kind === "artifact" ? (
                        <ArtifactTab
                          projectId={projectId}
                          artifactId={tab.id}
                          sessionId={
                            session.state.status === "ready" ? session.state.sessionId : null
                          }
                          streaming={streaming}
                          onSaved={bump}
                          onDirtyChange={(dirty) => tabs.setDirty(tab.id, dirty)}
                          onPrompt={setPending}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              </Panel>
              <Separator className="h-px cursor-row-resize bg-neutral-200 transition-colors hover:bg-neutral-400 dark:bg-neutral-800 dark:hover:bg-neutral-600" />
              <Panel
                id="dock"
                defaultSize={28}
                minSize={160}
                maxSize={420}
                collapsedSize={28}
                collapsible
                panelRef={dockPanelRef}
                onResize={(size) => setDockCollapsed(size.inPixels <= 32)}
              >
                <ActivityDock
                  projectId={projectId}
                  onOpen={tabs.open}
                  collapsed={dockCollapsed}
                  onToggle={toggleDock}
                />
              </Panel>
            </Group>
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
