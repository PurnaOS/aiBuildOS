import type { ChannelResponse } from "@aibuildos/ipc";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loading } from "../Loading.js";
import { eyebrow, focusRing, mono } from "../ui.js";
import { NewArtifact } from "./NewArtifact.js";
import { useRevision } from "./revision.js";
import type { Tab } from "./TabStrip.js";

/**
 * The record rail (ST-0012, ST-0046).
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

/** A transient "changed" mark clears itself even if nobody opens the row (RQ-0030#AC-3). */
const CHANGED_TTL = 15_000;

/** "Story" at one, "Stories" otherwise — the only irregular plural among the profile's types. */
function pluralType(type: string, count: number): string {
  if (count === 1) return type;
  return type.endsWith("y") ? `${type.slice(0, -1)}ies` : `${type}s`;
}

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
  // Re-read when the project has moved underneath this. What is expanded, what is folded and what is
  // filtered are this rail's own state and survive it, so a refresh does not throw away where the
  // user was.
  const revision = useRevision();
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Every type starts unfolded (ST-0046#AC-1) — a `Set` of what has been folded, not what is open.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // Which artifact ids just changed, and when — this rail's own diff of its last two reads, not
  // anything the watcher itself says changed (see the comment on the fetch effect below).
  const [changedAt, setChangedAt] = useState<Map<string, number>>(new Map());
  const previousRead = useRef<{ projectId: string; artifacts: Artifact[] } | null>(null);

  // `revision` is not read in here — it *is* the trigger. It moves when the project's files may
  // have changed underneath what is on screen, and re-reading is the whole point of depending on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void window.aibuildos
      .invoke("project:record", { id: projectId })
      .then((next) => {
        if (!live) return;
        setRecord(next);

        // The "changed" mark (RQ-0030#AC-3): the renderer only ever learns *that* the project moved
        // (`project:changed` carries no paths), so the smallest honest signal is this rail's own
        // before/after — an artifact whose `state` or `title` differs from the last read, or that is
        // new outright, gets marked. A content-only edit to the body is invisible here; that is the
        // corner this cuts, and it is cut on purpose rather than by omission.
        const nextArtifacts = next.artifacts ?? [];
        const previous = previousRead.current;
        if (previous === null || previous.projectId !== projectId) {
          // First read of this project: nothing to diff against yet, so nothing is "changed" — every
          // artifact would otherwise light up the moment the rail first opens.
          setChangedAt(new Map());
        } else {
          const before = new Map(previous.artifacts.map((a) => [a.id, a]));
          const at = Date.now();
          const changed = nextArtifacts.filter((a) => {
            const was = before.get(a.id);
            return was === undefined || was.state !== a.state || was.title !== a.title;
          });
          if (changed.length > 0) {
            setChangedAt((current) => {
              const merged = new Map(current);
              for (const artifact of changed) merged.set(artifact.id, at);
              return merged;
            });
          }
        }
        previousRead.current = { projectId, artifacts: nextArtifacts };
      })
      .catch(() => {
        if (live) setRecord({ artifacts: null, problem: "The record could not be read." });
      });
    return () => {
      live = false;
    };
  }, [projectId, revision]);

  // Sweeps marks older than the TTL so one never outlives its usefulness just because nobody opened
  // that row (RQ-0030#AC-3's "clears... shortly after").
  useEffect(() => {
    const timer = setInterval(() => {
      setChangedAt((current) => {
        const cutoff = Date.now() - CHANGED_TTL;
        const next = new Map([...current].filter(([, at]) => at >= cutoff));
        return next.size === current.size ? current : next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const clearChanged = useCallback((id: string) => {
    setChangedAt((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleFold = useCallback((type: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const needle = filter.trim().toLowerCase();
  const filtering = needle !== "";

  const totalByType = useMemo(() => {
    const map = new Map<string, number>();
    for (const artifact of record?.artifacts ?? []) {
      map.set(artifact.type, (map.get(artifact.type) ?? 0) + 1);
    }
    return map;
  }, [record]);

  const groups = useMemo(() => {
    const artifacts = record?.artifacts ?? [];
    const matching = filtering
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
  }, [record, filtering, needle]);

  const matchCount = filtering
    ? groups.reduce((sum, [, artifacts]) => sum + artifacts.length, 0)
    : 0;

  return (
    <div data-testid="record-rail" className="relative flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className={`flex-1 ${eyebrow}`}>The record</span>
        <span className={`text-[11px] text-neutral-500 ${mono}`}>
          {record?.artifacts?.length ?? ""}
        </span>
        <NewArtifact projectId={projectId} onCreated={onCreated} />
      </div>

      {/* The filter, at the top (ST-0046#AC-2) rather than buried under a long scroll. */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-800">
        <input
          data-testid="record-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="filter"
          className={`min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-neutral-500 ${focusRing}`}
        />
        {filtering && (
          <span
            data-testid="record-filter-count"
            className={`shrink-0 text-[10px] text-neutral-500 ${mono}`}
          >
            {matchCount} match
          </span>
        )}
        {filtering && (
          <button
            type="button"
            data-testid="record-filter-clear"
            aria-label="Clear filter"
            onClick={() => setFilter("")}
            className={`shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
          >
            <X size={11} aria-hidden />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {record === null ? (
          <Loading className="px-2 py-1 text-xs" />
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
          groups.map(([type, artifacts]) => {
            // A filter reaches into every group, folded or not (ST-0046#AC-1): the simplest honest
            // way to say that is to ignore the fold for as long as filtering is in effect, rather than
            // tracking a second "why this is open" reason per type. The fold itself is untouched underneath
            // and resumes the moment the filter clears.
            const isFolded = !filtering && folded.has(type);
            const total = totalByType.get(type) ?? artifacts.length;
            return (
              <div key={type} className="mb-2">
                <button
                  type="button"
                  data-testid={`record-group-${type}`}
                  onClick={() => toggleFold(type)}
                  aria-expanded={!isFolded}
                  aria-label={isFolded ? `Unfold ${type}` : `Fold ${type}`}
                  className={`flex w-full items-center gap-1 rounded px-1.5 pt-1 pb-0.5 hover:bg-neutral-50 dark:hover:bg-neutral-900 ${focusRing}`}
                >
                  {isFolded ? (
                    <ChevronRight size={11} className="shrink-0 text-neutral-400" aria-hidden />
                  ) : (
                    <ChevronDown size={11} className="shrink-0 text-neutral-400" aria-hidden />
                  )}
                  <span className={eyebrow}>
                    {pluralType(type, total)} · {total}
                  </span>
                </button>
                {!isFolded &&
                  artifacts.map((artifact) => (
                    <Row
                      key={artifact.id}
                      artifact={artifact}
                      expanded={expanded.has(artifact.id)}
                      changed={changedAt.has(artifact.id)}
                      onToggle={() => toggle(artifact.id)}
                      onOpen={(tab, options) => {
                        clearChanged(artifact.id);
                        onOpen(tab, options);
                      }}
                      onWorkOn={onWorkOn}
                    />
                  ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function Row({
  artifact,
  expanded,
  changed,
  onToggle,
  onOpen,
  onWorkOn,
}: {
  artifact: Artifact;
  expanded: boolean;
  changed: boolean;
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
          {/* Words carry the signal, not the colour (RQ-0012#AC-1, RQ-0030#AC-3). A transient mark,
              not a badge that lingers past its meaning. */}
          {changed && (
            <span
              data-testid={`record-changed-${artifact.id}`}
              className={`shrink-0 text-[10px] text-amber-700 dark:text-amber-500 ${mono}`}
            >
              changed
            </span>
          )}
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
                  <button
                    key={id}
                    type="button"
                    data-testid={`record-inbound-${id}`}
                    // Same call shape the row's own click uses (RQ-0041#AC-1) — a preview open, not
                    // a pin.
                    onClick={() => onOpen({ id, kind: "artifact", title: id }, { preview: true })}
                    className={`block w-full py-0.5 text-left text-[11px] text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 ${mono} ${focusRing}`}
                  >
                    {id}
                  </button>
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
