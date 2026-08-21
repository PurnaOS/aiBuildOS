import type { ChannelResponse } from "@aibuildos/ipc";
import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { AlertTriangle, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { darkEditor, useDarkAppearance } from "../appearance.js";
import { button, eyebrow, field, focusRing, mono, primary } from "../ui.js";
import { useAutoSave } from "./autosave.js";
import { Diff } from "./Diff.js";
import { deriveImpact, type Impact } from "./impact.js";
import { compose } from "./playbooks.js";

/**
 * An artifact, edited as its own shape (RQ-0005#AC-5 to AC-10).
 *
 * Not a text box. An artifact has a type, a state that may only move along the paths its type
 * declares, links with legal targets, and acceptance criteria whose numbers are append-only — and all
 * of that comes from the profile rather than from anything this component believes. The states
 * offered are the current one plus exactly its legal next states, never the whole vocabulary
 * (RQ-0010#AC-1); the artifacts offered for a link are the ones its target types allow.
 *
 * Saving rewrites only what changed. That is the whole point of the writer behind it: `docs/` is
 * committed, and a diff full of reformatting is a diff nobody can review.
 */
type Artifact = ChannelResponse<"project:artifact">;
type Finding = Artifact["findings"][number];
type RecordArtifact = NonNullable<ChannelResponse<"project:record">["artifacts"]>[number];

/** The plan playbook a "Plan the follow-up" press starts (RQ-0024#AC-3): the same rule
 * `findPlanPlaybook` in `boards/BacklogBoard.tsx` uses for its own button, copied rather than
 * imported — this file does not reach into board internals for one small lookup. */
function findPlanPlaybook(artifacts: readonly RecordArtifact[]): RecordArtifact | undefined {
  const playbooks = artifacts.filter((a) => a.type === "Playbook" && a.state === "active");
  return (
    playbooks.find((p) => p.title === "Propose a plan") ?? playbooks.find((p) => p.id === "PB-0002")
  );
}

/** One acceptance criterion, as it appears in the body. */
interface Criterion {
  readonly number: number;
  readonly text: string;
  /** The text as it was read, so an untouched criterion can be written back as it was found. */
  readonly original: string;
  /** The exact lines this criterion was read from, wrapping and all. */
  readonly source: string;
}

const CRITERIA_HEADING = "## Acceptance criteria";

export function ArtifactTab({
  projectId,
  artifactId,
  sessionId,
  streaming,
  onSaved,
  onDirtyChange,
  onPrompt,
}: {
  projectId: string;
  artifactId: string;
  /** Watched so a finished turn triggers a re-read: `docs/` is the agent's work too, not only ours. */
  sessionId: string | null;
  /** Whether a turn is in flight. Owned by the workspace, which outlives every tab and so cannot
   * miss a turn that began before this opened. */
  streaming: boolean;
  /** Told when a save lands, so the rails stop showing the state this artifact used to have. */
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Sends text into the conversation (RQ-0024#AC-3) — the same door `BacklogBoard`'s picking lane
   * uses, handed down from the workspace rather than reached for directly. */
  onPrompt?: (text: string) => void;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Artifact | null>(null);
  const [title, setTitle] = useState("");
  const [state, setState] = useState("");
  const [links, setLinks] = useState<Record<string, string[]>>({});
  const [parts, setParts] = useState<BodyParts>({
    head: "",
    criteria: [],
    tail: "",
    hasCriteria: false,
  });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  /** Set when the agent rewrote this artifact under unsaved edits; neither side is discarded. */
  const [collision, setCollision] = useState(false);
  /** The agent's version, held only so the difference can be shown before anything is chosen. */
  const [theirs, setTheirs] = useState("");
  /** A changed requirement's blast radius (RQ-0024#AC-1, AC-2). `null` until a save lands on a
   * Requirement past `ready` — opening one nobody touched this sitting shows nothing, because the
   * view is what a save produces, not a standing readout (ST-0036). */
  const [impact, setImpact] = useState<Impact | null>(null);
  const [planning, setPlanning] = useState(false);

  const baseline = useRef("");
  /** What was loaded, so a save can send the difference rather than the whole form. */
  const original = useRef<{
    title: string;
    state: string;
    links: Record<string, string[]>;
    body: string;
  }>({ title: "", state: "", links: {}, body: "" });
  /**
   * The highest criterion number this artifact has shown since it was opened.
   *
   * A deleted criterion retires its number — `RQ-0007#AC-2` is how one is referred to from elsewhere
   * (conventions §3) — so the next one appends above the high-water mark rather than filling the gap.
   *
   * ponytail: within the sitting. Once a deletion is saved the number is gone from the file, so a
   * reopened artifact starts counting from what is left; recovering it would mean recording retired
   * numbers somewhere, which is a field the profile does not have.
   */
  const highest = useRef(0);
  /** The artifact as it was last read, so a change made elsewhere can be recognised as one. */
  const onDisk = useRef("");
  const body = joinBody(parts);
  const snapshot = JSON.stringify({ title, state, links, body });
  const dirty = loaded !== null && snapshot !== baseline.current;

  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // Reported as "waiting on something", not merely "not written yet". An 800ms gap between a
  // keystroke and its write is not worth a mark on a tab; a write being *held* is, and it is the same
  // condition under which closing the tab still asks (RQ-0008#AC-8).
  const held = dirty && (streaming || collision);
  useEffect(() => {
    report.current?.(held);
  }, [held]);

  const load = useCallback(async () => {
    const next = await window.aibuildos.invoke("project:artifact", { id: projectId, artifactId });
    setLoaded(next);
    setCollision(false);
    setProblem(next.problem);
    setFindings(next.findings);
    setImpact(null);
    if (next.markdown === null) return;

    const nextTitle = String((next.frontmatter as { title?: unknown }).title ?? "");
    const nextState = String((next.frontmatter as { state?: unknown }).state ?? "");
    const nextLinks = Object.fromEntries(
      next.links.map((link) => [link.relationship, link.current]),
    );
    setTitle(nextTitle);
    setState(nextState);
    setLinks(nextLinks);
    const nextParts = splitBody(next.body);
    setParts(nextParts);
    highest.current = nextParts.criteria.reduce(
      (top, criterion) => Math.max(top, criterion.number),
      0,
    );
    onDisk.current = next.markdown;
    original.current = { title: nextTitle, state: nextState, links: nextLinks, body: next.body };
    baseline.current = JSON.stringify({
      title: nextTitle,
      state: nextState,
      links: nextLinks,
      body: next.body,
    });
  }, [projectId, artifactId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The agent edits `docs/` as part of its work, so an artifact open here while it writes is a real
  // collision. When a turn ends it has stopped changing things, which is the moment to look.
  useEffect(() => {
    if (sessionId === null) return;

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const type = (payload.event as { type: string }).type;
      if (type !== "RUN_FINISHED" && type !== "RUN_ERROR") return;

      void window.aibuildos
        .invoke("project:artifact", { id: projectId, artifactId })
        .then((next) => {
          if (next.markdown === null || next.markdown === onDisk.current) return;
          // Nothing edited here: take the agent's and say so. Edited here: keep both until someone
          // chooses, because silently discarding either side is the outcome nobody can defend.
          if (dirtyRef.current) {
            setTheirs(next.markdown);
            setCollision(true);
          } else void load();
        })
        .catch(() => undefined);
    });
  }, [projectId, artifactId, sessionId, load]);

  const save = async (): Promise<void> => {
    if (loaded?.markdown == null) return;

    setSaving(true);
    try {
      const result = await window.aibuildos.invoke("project:artifact-save", {
        id: projectId,
        artifactId,
        // Only what actually changed is sent. An artifact is not obliged to carry every field this
        // editor can show, and rewriting one that was never touched is exactly what AC-8 forbids.
        frontmatter: {
          ...(title === original.current.title ? {} : { title }),
          ...(state === original.current.state ? {} : { state }),
          ...Object.fromEntries(
            Object.entries(links)
              .filter(([key, ids]) => ids.join() !== (original.current.links[key] ?? []).join())
              .map(([key, ids]) => [`links.${key}`, ids]),
          ),
        },
        // Left out entirely when nothing in the body moved, so that a state change does not rewrite
        // the prose it never touched.
        ...(body === original.current.body ? {} : { body }),
      });
      setProblem(result.problem);
      setFindings(result.findings);
      if (result.problem === null) {
        // What is on disk is now this save, not what was read. Without that, the next turn to end
        // would read back the user's own writing and report the agent as having changed it.
        if (result.markdown !== null) onDisk.current = result.markdown;
        original.current = { title, state, links, body };
        baseline.current = snapshot;
        onSaved?.();

        // RQ-0024#AC-1, AC-2: a Requirement past `ready` shows what implements and verifies it the
        // moment a save lands. Everything else — draft/ready, or any other type — shows nothing.
        const type = String((loaded.frontmatter as { type?: unknown }).type ?? "");
        if (type === "Requirement" && state !== "draft" && state !== "ready") {
          void window.aibuildos
            .invoke("project:record", { id: projectId })
            .then((record) => setImpact(deriveImpact(record.artifacts ?? [], artifactId)))
            .catch(() => undefined);
        } else {
          setImpact(null);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const planFollowUp = async (): Promise<void> => {
    if (onPrompt === undefined) return;
    setPlanning(true);
    try {
      const record = await window.aibuildos.invoke("project:record", { id: projectId });
      const playbook = findPlanPlaybook(record.artifacts ?? []);
      if (playbook === undefined) return;

      const playbookArtifact = await window.aibuildos.invoke("project:artifact", {
        id: projectId,
        artifactId: playbook.id,
      });
      onPrompt(compose(playbookArtifact.body, [{ id: artifactId, title }]));
    } finally {
      setPlanning(false);
    }
  };

  // Held back while the agent is mid-turn or a choice is being asked (RQ-0008#AC-3, AC-4).
  useAutoSave({
    dirty,
    content: snapshot,
    blocked: streaming || collision || saving,
    save,
  });

  if (loaded === null) return <p className="p-6 text-sm text-neutral-500">Loading…</p>;
  if (loaded.markdown === null) {
    return (
      <p data-testid="artifact-problem" className="p-6 text-sm text-red-600">
        {loaded.problem ?? "That artifact could not be read."}
      </p>
    );
  }

  const against = (key: string): Finding[] => findings.filter((finding) => finding.key === key);

  return (
    <div data-testid="artifact-tab" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <span className={`text-xs font-medium ${mono}`}>{artifactId}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-500">
          {String((loaded.frontmatter as { type?: unknown }).type ?? "")}
        </span>
        {/* What is happening, not what to press (RQ-0008#AC-5). */}
        <span data-testid="artifact-saved" className={eyebrow}>
          {saving ? "saving…" : dirty ? "unsaved" : "saved"}
        </span>
      </div>

      {problem !== null && (
        <p data-testid="artifact-save-problem" className="px-3 py-2 text-xs text-red-600">
          {problem}
        </p>
      )}

      {collision && (
        <div
          data-testid="artifact-conflict"
          className="border-b border-neutral-200 bg-amber-50 px-3 py-2.5 dark:border-neutral-800 dark:bg-amber-950/30"
        >
          <p className="text-xs text-amber-800 dark:text-amber-300">
            The agent changed this artifact while you were editing it. Nothing has been overwritten.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="artifact-conflict-keep-mine"
              onClick={() => setCollision(false)}
              className={`${primary} ${focusRing}`}
            >
              Keep mine
            </button>
            <button
              type="button"
              data-testid="artifact-conflict-take-theirs"
              onClick={() => void load()}
              className={`${button} ${focusRing}`}
            >
              Take the agent's
            </button>
          </div>
          <div className="mt-2">
            {/* What the choice is between: this artifact as it was read, and as it is now on disk. */}
            <Diff path={artifactId} oldText={onDisk.current} newText={theirs} />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Field label="title" findings={against("title")}>
          <input
            data-testid="artifact-title"
            className={field}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <Field label="state" findings={against("state")}>
          {loaded.states.length === 0 ? (
            // No profile describes this type, so there is no vocabulary to offer and nothing is
            // invented — the value is shown as it is.
            <input
              data-testid="artifact-state"
              className={field}
              value={state}
              onChange={(event) => setState(event.target.value)}
            />
          ) : (
            <select
              data-testid="artifact-state"
              className={field}
              value={state}
              onChange={(event) => setState(event.target.value)}
            >
              {/* The current state first — so a value outside the vocabulary is shown as found rather
                  than corrected, since it would otherwise be missing from the options the select can
                  actually render — followed by exactly its legal next states. A state with no
                  declared transition of its own still offers retirement, which matches every state
                  (RQ-0010#AC-1, AC-3, AC-5). */}
              {loaded.states.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate === "" ? "(none)" : candidate}
                </option>
              ))}
            </select>
          )}
        </Field>

        {/* Reported once. The validator names `links` as the field, not one relationship inside it. */}
        {against("links").map((finding) => (
          <Note key={`${finding.rule}-${finding.message}`} finding={finding} />
        ))}

        {loaded.links.map((link) => (
          <Field key={link.relationship} label={link.relationship} findings={[]}>
            <LinkPicker
              relationship={link.relationship}
              candidates={link.candidates}
              value={links[link.relationship] ?? []}
              onChange={(ids) => setLinks((current) => ({ ...current, [link.relationship]: ids }))}
            />
          </Field>
        ))}

        {/* The body in the order the document has it: prose, criteria, whatever follows them. */}
        <Markdown
          testId="artifact-body"
          label={parts.hasCriteria ? "body" : "body (no acceptance criteria section)"}
          value={parts.head}
          onChange={(head) => setParts((current) => ({ ...current, head }))}
        />

        {parts.hasCriteria && (
          <Criteria
            criteria={parts.criteria}
            highest={highest.current}
            onChange={(criteria) => setParts((current) => ({ ...current, criteria }))}
          />
        )}

        {parts.tail !== "" && (
          <Markdown
            testId="artifact-body-tail"
            label="after the criteria"
            value={parts.tail}
            onChange={(tail) => setParts((current) => ({ ...current, tail }))}
          />
        )}

        {findings.filter((finding) => finding.key === null).length > 0 && (
          <div className="mt-5">
            <p className={eyebrow}>About this artifact</p>
            {findings
              .filter((finding) => finding.key === null)
              .map((finding) => (
                <Note key={`${finding.rule}-${finding.message}`} finding={finding} />
              ))}
          </div>
        )}

        {impact !== null && (
          <ImpactSection
            impact={impact}
            planning={planning}
            onPlan={onPrompt === undefined ? undefined : () => void planFollowUp()}
          />
        )}
      </div>
    </div>
  );
}

/** A changed requirement's blast radius, beneath the editor once a save has produced one
 * (RQ-0024#AC-1, AC-2, AC-3). */
function ImpactSection({
  impact,
  planning,
  onPlan,
}: {
  impact: Impact;
  planning: boolean;
  /** `undefined` when nobody above can send a prompt — the button is then not worth showing. */
  onPlan: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <div
      data-testid="artifact-impact"
      className="mt-6 border-t border-neutral-200 pt-4 dark:border-neutral-800"
    >
      <p className={eyebrow}>Impact</p>
      <ImpactGroup testId="impact-done" label="Done" rows={impact.done} />
      <ImpactGroup testId="impact-in-flight" label="In flight" rows={impact.inFlight} />
      <ImpactGroup testId="impact-verification" label="Verification" rows={impact.verification} />

      {onPlan !== undefined && (
        <button
          type="button"
          data-testid="impact-plan"
          disabled={planning}
          onClick={onPlan}
          className={`mt-2 ${primary} px-2 py-0.5 text-[11px]`}
        >
          {planning ? "Sending…" : "Plan the follow-up"}
        </button>
      )}
    </div>
  );
}

/** One of the three impact groups: nothing shown for an empty one — an honest empty answer is silence,
 * not a "none" placeholder beside two others that do have something to say. */
function ImpactGroup({
  testId,
  label,
  rows,
}: {
  testId: string;
  label: string;
  rows: readonly { id: string; title: string; state: string }[];
}): React.JSX.Element | null {
  if (rows.length === 0) return null;

  return (
    <div data-testid={testId} className="mt-2">
      <p className="text-xs text-neutral-500">{label}</p>
      {rows.map((row) => (
        <p key={row.id} data-testid={`impact-row-${row.id}`} className="text-xs">
          <span className={mono}>{row.id}</span> — {row.title}{" "}
          <span className="text-neutral-500">({row.state})</span>
        </p>
      ))}
    </div>
  );
}

/** The prose parts of the body, as markdown. Nothing here is structured, so nothing pretends to be. */
function Markdown({
  testId,
  label,
  value,
  onChange,
}: {
  testId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const dark = useDarkAppearance();

  return (
    <div className="mt-5">
      <p className={`mb-1.5 ${eyebrow}`}>{label}</p>
      <CodeMirror
        data-testid={testId}
        value={value}
        onChange={onChange}
        theme={dark ? darkEditor : "light"}
        extensions={[markdown()]}
        basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
        className="rounded border border-neutral-300 text-sm dark:border-neutral-700"
      />
    </div>
  );
}

function Field({
  label,
  findings,
  children,
}: {
  label: string;
  findings: Finding[];
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-testid={`field-${label}`} className="mb-3">
      <p className={`mb-1 ${eyebrow}`}>{label}</p>
      {children}
      {/* Reported where the editing happens, not in a list somewhere else (AC-9). */}
      {findings.map((finding) => (
        <Note key={`${finding.rule}-${finding.message}`} finding={finding} />
      ))}
    </div>
  );
}

function Note({ finding }: { finding: Finding }): React.JSX.Element {
  const bad = finding.severity === "error";
  return (
    <p
      data-testid="artifact-finding"
      className={`mt-1 flex items-start gap-1.5 text-[11px] ${bad ? "text-red-600" : "text-amber-600"}`}
    >
      <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        {finding.message} <span className={`text-neutral-500 ${mono}`}>({finding.rule})</span>
      </span>
    </p>
  );
}

function LinkPicker({
  relationship,
  candidates,
  value,
  onChange,
}: {
  relationship: string;
  candidates: { id: string; title: string; type: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}): React.JSX.Element {
  const remaining = candidates.filter((candidate) => !value.includes(candidate.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-neutral-300 px-1.5 py-1 dark:border-neutral-700">
      {value.map((id) => (
        <span
          key={id}
          data-testid={`link-${relationship}-${id}`}
          className={`flex items-center gap-1 rounded border border-neutral-200 px-1.5 py-0.5 text-[11px] dark:border-neutral-800 ${mono}`}
        >
          {id}
          <button
            type="button"
            aria-label={`Remove ${id}`}
            onClick={() => onChange(value.filter((kept) => kept !== id))}
            className={`text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
          >
            <X size={9} aria-hidden />
          </button>
        </span>
      ))}

      {/* Only the artifacts this relationship's target types allow (AC-6). */}
      <select
        data-testid={`link-add-${relationship}`}
        value=""
        onChange={(event) => {
          if (event.target.value !== "") onChange([...value, event.target.value]);
        }}
        className="bg-transparent text-[11px] text-neutral-500 outline-none"
      >
        <option value="">{remaining.length === 0 ? "nothing eligible" : "+ add"}</option>
        {remaining.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.id} — {candidate.title}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The acceptance criteria, with **append-only** numbering (AC-7).
 *
 * Removing a criterion retires its number: the ones after it keep theirs, because a criterion is
 * referred to from elsewhere as `RQ-0007#AC-2` and renumbering would silently repoint every one of
 * those references at different text.
 */
function Criteria({
  criteria,
  highest,
  onChange,
}: {
  criteria: readonly Criterion[];
  /** The highest number this artifact has ever shown, so a deleted one is not handed out again. */
  highest: number;
  onChange: (criteria: Criterion[]) => void;
}): React.JSX.Element {
  const next = criteria.reduce((top, criterion) => Math.max(top, criterion.number), highest) + 1;

  return (
    <div className="mt-5">
      <p className={`mb-1.5 ${eyebrow}`}>Acceptance criteria</p>

      {criteria.map((criterion, index) => (
        <div key={criterion.number} className="mb-1.5 flex items-start gap-2">
          <span className={`w-10 shrink-0 pt-1.5 text-[11px] text-neutral-500 ${mono}`}>
            AC-{criterion.number}
          </span>
          <textarea
            data-testid={`criterion-${criterion.number}`}
            className={`${field} min-h-[3rem] resize-y`}
            value={criterion.text}
            onChange={(event) => {
              const updated = [...criteria];
              updated[index] = { ...criterion, text: event.target.value };
              onChange(updated);
            }}
          />
          <button
            type="button"
            data-testid={`criterion-remove-${criterion.number}`}
            aria-label={`Remove AC-${criterion.number}`}
            onClick={() => onChange(criteria.filter((kept) => kept.number !== criterion.number))}
            className={`mt-1.5 text-neutral-400 hover:text-red-600 ${focusRing}`}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}

      <button
        type="button"
        data-testid="criterion-add"
        onClick={() =>
          onChange([...criteria, { number: next, text: "", original: "", source: "" }])
        }
        className={`mt-1 flex items-center gap-1.5 ${primary} ${focusRing}`}
      >
        <Plus size={11} aria-hidden />
        Add AC-{next}
      </button>
    </div>
  );
}

/**
 * The three parts of an artifact's body: the prose before the criteria, the criteria, and whatever
 * sections follow them.
 *
 * Split rather than edited whole because the criteria are not prose — their numbers are identity —
 * and joined back in place so a document whose criteria are not its last section keeps its order.
 */
export interface BodyParts {
  readonly head: string;
  readonly criteria: readonly Criterion[];
  readonly tail: string;
  /** False when the document has no criteria section; then `head` is the entire body. */
  readonly hasCriteria: boolean;
}

export function splitBody(body: string): BodyParts {
  const at = body.indexOf(CRITERIA_HEADING);
  if (at === -1) return { head: body, criteria: [], tail: "", hasCriteria: false };

  const after = body.slice(at + CRITERIA_HEADING.length);
  const next = after.search(/\n## /);
  const section = next === -1 ? after : after.slice(0, next);

  return {
    head: body.slice(0, at),
    criteria: readCriteria(section),
    tail: next === -1 ? "" : after.slice(next),
    hasCriteria: true,
  };
}

export function joinBody(parts: BodyParts): string {
  if (!parts.hasCriteria) return parts.head;

  const rendered = parts.criteria
    // A criterion nobody edited is written back as the exact lines it was read from. Re-rendering it
    // would unwrap every criterion written across two lines — which is most of them — and turn a
    // one-field edit into a diff over the whole section (AC-8).
    .map((criterion) =>
      // A criterion added here has no source to preserve, even before anything is typed into it.
      criterion.source !== "" && criterion.text === criterion.original
        ? criterion.source
        : `- [AC-${criterion.number}] ${criterion.text}`.trimEnd(),
    )
    .join("\n");

  return `${parts.head}${CRITERIA_HEADING}\n\n${rendered}\n${parts.tail}`;
}

/** Read `- [AC-n] …` items from a criteria section, joining the lines a wrapped one is written across. */
function readCriteria(section: string): Criterion[] {
  const criteria: Criterion[] = [];

  for (const line of section.split("\n")) {
    const start = /^- \[AC-(\d+)\]\s?(.*)$/.exec(line);
    if (start) {
      const text = start[2] ?? "";
      criteria.push({ number: Number(start[1]), text, original: text, source: line });
      continue;
    }
    // A wrapped criterion continues on an indented line.
    const last = criteria[criteria.length - 1];
    if (last && /^\s+\S/.test(line)) {
      const text = `${last.text} ${line.trim()}`;
      criteria[criteria.length - 1] = {
        ...last,
        text,
        original: text,
        source: `${last.source}\n${line}`,
      };
    }
  }
  return criteria;
}
