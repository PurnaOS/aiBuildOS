import type { ChannelResponse } from "@aibuildos/ipc";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { eyebrow, focusRing, mono } from "../ui.js";
import { NewArtifact } from "./NewArtifact.js";
import { useRevision } from "./revision.js";
import type { Tab } from "./TabStrip.js";

/**
 * The record rail (ST-0012).
 *
 * The rail that makes this aiBuildOS rather than a front end for an agent: the left of the workspace
 * is what the work is *for*. It shows what implements a requirement and what verifies it by
 * **deriving** the reverse of links stored one direction only — a written backlink is a second source
 * of truth that drifts, which is why the record never contains one.
 */
type Record_ = ChannelResponse<"project:record">;
type Artifact = NonNullable<Record_["artifacts"]>[number];

/**
 * Traceability order, not alphabetical: a requirement comes before the work that implements it.
 * `Playbook` sits last — it traces to nothing (DC-0019), so there is no chain to place it inside.
 */
const ORDER = [
  "Requirement",
  "Epic",
  "Story",
  "TestCase",
  "Bug",
  "Decision",
  "Architecture",
  "Playbook",
];

/** What the reverse of each stored link is called when it is read the other way (okf-conventions §4). */
const DERIVED: Record<string, string> = {
  implements: "implemented by",
  verifies: "verified by",
  affects: "affected by",
  parent: "children",
  constrains: "constrained by",
  fixed_by: "fixes",
  derived_from: "derives",
  supersedes: "superseded by",
  depends_on: "depended on by",
  related_to: "related to",
};

export function RecordRail({
  projectId,
  onOpen,
  onWorkOn,
  onCreated,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** Attach this artifact to the conversation, with everything it says (ST-0012#AC-4). */
  onWorkOn: (artifact: { id: string; file: string }) => void;
  /** A newly minted artifact: opened straight away rather than left to be found (RQ-0006#AC-5). */
  onCreated: (artifactId: string) => void;
}): React.JSX.Element {
  const [record, setRecord] = useState<Record_ | null>(null);
  // Re-read when the project has moved underneath this. What is expanded and what is filtered are
  // this rail's own state and survive it, so a refresh does not throw away where the user was.
  const revision = useRevision();
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // `revision` is not read in here — it *is* the trigger. It moves when the project's files may
  // have changed underneath what is on screen, and re-reading is the whole point of depending on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void window.aibuildos
      .invoke("project:record", { id: projectId })
      .then((next) => {
        if (live) setRecord(next);
      })
      .catch(() => {
        if (live) setRecord({ artifacts: null, problem: "The record could not be read." });
      });
    return () => {
      live = false;
    };
  }, [projectId, revision]);

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const groups = useMemo(() => {
    const artifacts = record?.artifacts ?? [];
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? artifacts.filter(
          (a) => a.id.toLowerCase().includes(needle) || a.title.toLowerCase().includes(needle),
        )
      : artifacts;

    const byType = new Map<string, Artifact[]>();
    for (const artifact of matching) {
      byType.set(artifact.type, [...(byType.get(artifact.type) ?? []), artifact]);
    }
    return [...byType.entries()].sort(
      ([a], [b]) =>
        (ORDER.indexOf(a) + 1 || ORDER.length + 1) - (ORDER.indexOf(b) + 1 || ORDER.length + 1),
    );
  }, [record, filter]);

  return (
    <div data-testid="record-rail" className="relative flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className={`flex-1 ${eyebrow}`}>The record</span>
        <span className={`text-[11px] text-neutral-500 ${mono}`}>
          {record?.artifacts?.length ?? ""}
        </span>
        <NewArtifact projectId={projectId} onCreated={onCreated} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {record === null ? (
          <p className="px-2 py-1 text-xs text-neutral-500">Loading…</p>
        ) : record.problem ? (
          <p data-testid="record-problem" className="px-2 py-1 text-xs text-red-600">
            {record.problem}
          </p>
        ) : record.artifacts === null ? (
          <p data-testid="record-none" className="px-2 py-1 text-xs text-neutral-500">
            No OKF bundle in this project.
          </p>
        ) : record.artifacts.length === 0 ? (
          <p data-testid="record-empty" className="px-2 py-1 text-xs text-neutral-500">
            No artifacts yet — the first requirement goes here.
          </p>
        ) : (
          groups.map(([type, artifacts]) => (
            <div key={type} className="mb-2">
              <p className={`px-2 pt-1 pb-0.5 ${eyebrow}`}>{type}</p>
              {artifacts.map((artifact) => (
                <Row
                  key={artifact.id}
                  artifact={artifact}
                  expanded={expanded.has(artifact.id)}
                  onToggle={() => toggle(artifact.id)}
                  onOpen={onOpen}
                  onWorkOn={onWorkOn}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <input
          data-testid="record-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="filter"
          className={`w-full bg-transparent text-xs outline-none placeholder:text-neutral-500 ${focusRing}`}
        />
      </div>
    </div>
  );
}

function Row({
  artifact,
  expanded,
  onToggle,
  onOpen,
  onWorkOn,
}: {
  artifact: Artifact;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  onWorkOn: (artifact: { id: string; file: string }) => void;
}): React.JSX.Element {
  const hasInbound = artifact.inbound.length > 0;

  return (
    <div data-testid="record-row">
      <div className="flex items-baseline gap-1.5 rounded px-1 hover:bg-neutral-50 dark:hover:bg-neutral-900">
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? `Collapse ${artifact.id}` : `Expand ${artifact.id}`}
          className={`shrink-0 py-1 text-neutral-400 ${focusRing}`}
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>

        <button
          type="button"
          data-testid={`record-open-${artifact.id}`}
          onClick={() =>
            onOpen({ id: artifact.id, kind: "artifact", title: artifact.id }, { preview: true })
          }
          onDoubleClick={() =>
            onOpen({ id: artifact.id, kind: "artifact", title: artifact.id }, { preview: false })
          }
          className={`flex min-w-0 flex-1 items-baseline gap-2 py-1 text-left ${focusRing}`}
        >
          <span className={`shrink-0 text-xs ${mono}`}>{artifact.id}</span>
          <span className="min-w-0 flex-1 truncate text-xs">{artifact.title}</span>
          <span className={`shrink-0 text-[10px] text-neutral-500 ${mono}`}>{artifact.state}</span>
          {/* Words carry the signal, not the colour (RQ-0012#AC-1). A clean artifact renders nothing
              here — no zero-count badge (RQ-0012#AC-4). */}
          {(artifact.problems.errors > 0 || artifact.problems.warnings > 0) && (
            <span
              data-testid={`record-problems-${artifact.id}`}
              className={`shrink-0 text-[10px] ${mono}`}
            >
              {artifact.problems.errors > 0 && (
                <span className="text-red-600">{plural(artifact.problems.errors, "error")}</span>
              )}
              {artifact.problems.errors > 0 && artifact.problems.warnings > 0 && ", "}
              {artifact.problems.warnings > 0 && (
                <span className="text-amber-700">
                  {plural(artifact.problems.warnings, "warning")}
                </span>
              )}
            </span>
          )}
        </button>
      </div>

      {expanded && (
        <div className="mb-1 pl-6">
          <button
            type="button"
            data-testid={`work-on-${artifact.id}`}
            onClick={() => onWorkOn({ id: artifact.id, file: artifact.file })}
            className={`my-1 rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 ${focusRing}`}
          >
            Work on this
          </button>
          {hasInbound &&
            group(artifact.inbound).map(([relationship, ids]) => (
              <div key={relationship}>
                <p className={`pt-1 pb-0.5 ${eyebrow} text-[9px]`}>
                  {DERIVED[relationship] ?? relationship}
                </p>
                {ids.map((id) => (
                  <p key={id} className={`py-0.5 text-[11px] text-neutral-500 ${mono}`}>
                    {id}
                  </p>
                ))}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function group(inbound: Artifact["inbound"]): [string, string[]][] {
  const byRelationship = new Map<string, string[]>();
  for (const edge of inbound) {
    byRelationship.set(edge.relationship, [
      ...(byRelationship.get(edge.relationship) ?? []),
      edge.id,
    ]);
  }
  return [...byRelationship.entries()];
}
