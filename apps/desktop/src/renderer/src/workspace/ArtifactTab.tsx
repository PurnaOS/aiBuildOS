import type { ChannelResponse } from "@aibuildos/ipc";
import { AlertTriangle, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { button, eyebrow, field, focusRing, mono, primary } from "../ui.js";

/**
 * An artifact, edited as its own shape (RQ-0005#AC-5 to AC-10).
 *
 * Not a text box. An artifact has a type, a state vocabulary, links with legal targets, and
 * acceptance criteria whose numbers are append-only — and all of that comes from the profile rather
 * than from anything this component believes. The states offered are the ones the type declares; the
 * artifacts offered for a link are the ones its target types allow.
 *
 * Saving rewrites only what changed. That is the whole point of the writer behind it: `docs/` is
 * committed, and a diff full of reformatting is a diff nobody can review.
 */
type Artifact = ChannelResponse<"project:artifact">;
type Finding = Artifact["findings"][number];

/** One acceptance criterion, as it appears in the body. */
interface Criterion {
  readonly number: number;
  readonly text: string;
}

const CRITERIA_HEADING = "## Acceptance criteria";

export function ArtifactTab({
  projectId,
  artifactId,
  onDirtyChange,
}: {
  projectId: string;
  artifactId: string;
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Artifact | null>(null);
  const [title, setTitle] = useState("");
  const [state, setState] = useState("");
  const [links, setLinks] = useState<Record<string, string[]>>({});
  const [criteria, setCriteria] = useState<Criterion[]>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);

  const baseline = useRef("");
  /** What was loaded, so a save can send the difference rather than the whole form. */
  const original = useRef<{ title: string; state: string; links: Record<string, string[]> }>({
    title: "",
    state: "",
    links: {},
  });
  const snapshot = JSON.stringify({ title, state, links, criteria });
  const dirty = loaded !== null && snapshot !== baseline.current;

  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  useEffect(() => {
    report.current?.(dirty);
  }, [dirty]);

  const load = useCallback(async () => {
    const next = await window.aibuildos.invoke("project:artifact", { id: projectId, artifactId });
    setLoaded(next);
    setProblem(next.problem);
    setFindings(next.findings);
    if (next.markdown === null) return;

    const nextTitle = String((next.frontmatter as { title?: unknown }).title ?? "");
    const nextState = String((next.frontmatter as { state?: unknown }).state ?? "");
    const nextLinks = Object.fromEntries(
      next.links.map((link) => [link.relationship, link.current]),
    );
    const nextCriteria = readCriteria(next.body);

    setTitle(nextTitle);
    setState(nextState);
    setLinks(nextLinks);
    setCriteria(nextCriteria);
    original.current = { title: nextTitle, state: nextState, links: nextLinks };
    baseline.current = JSON.stringify({
      title: nextTitle,
      state: nextState,
      links: nextLinks,
      criteria: nextCriteria,
    });
  }, [projectId, artifactId]);

  useEffect(() => {
    void load();
  }, [load]);

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
        body: writeCriteria(loaded.body, criteria),
      });
      setProblem(result.problem);
      setFindings(result.findings);
      if (result.problem === null) {
        original.current = { title, state, links };
        baseline.current = snapshot;
      }
    } finally {
      setSaving(false);
    }
  };

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
        {dirty && (
          <span data-testid="artifact-dirty" className={eyebrow}>
            unsaved
          </span>
        )}
        <button
          type="button"
          data-testid="artifact-save"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className={`${button} ${focusRing}`}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {problem !== null && (
        <p data-testid="artifact-save-problem" className="px-3 py-2 text-xs text-red-600">
          {problem}
        </p>
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
              {/* This type's own vocabulary, from the profile. */}
              {loaded.states.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          )}
        </Field>

        {loaded.links.map((link) => (
          <Field key={link.relationship} label={link.relationship} findings={against("links")}>
            <LinkPicker
              relationship={link.relationship}
              candidates={link.candidates}
              value={links[link.relationship] ?? []}
              onChange={(ids) => setLinks((current) => ({ ...current, [link.relationship]: ids }))}
            />
          </Field>
        ))}

        <Criteria criteria={criteria} onChange={setCriteria} />

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
      </div>
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
  onChange,
}: {
  criteria: Criterion[];
  onChange: (criteria: Criterion[]) => void;
}): React.JSX.Element {
  const next = criteria.reduce((highest, criterion) => Math.max(highest, criterion.number), 0) + 1;

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
        onClick={() => onChange([...criteria, { number: next, text: "" }])}
        className={`mt-1 flex items-center gap-1.5 ${primary} ${focusRing}`}
      >
        <Plus size={11} aria-hidden />
        Add AC-{next}
      </button>
    </div>
  );
}

/** Read `- [AC-n] …` items, joining the continuation lines a wrapped criterion is written across. */
export function readCriteria(body: string): Criterion[] {
  const section = body.split(CRITERIA_HEADING)[1];
  if (section === undefined) return [];

  const upToNextHeading = section.split(/\n## /)[0] ?? "";
  const criteria: Criterion[] = [];

  for (const line of upToNextHeading.split("\n")) {
    const start = /^- \[AC-(\d+)\]\s?(.*)$/.exec(line);
    if (start) {
      criteria.push({ number: Number(start[1]), text: start[2] ?? "" });
      continue;
    }
    // A wrapped criterion continues on an indented line.
    const last = criteria[criteria.length - 1];
    if (last && /^\s+\S/.test(line)) {
      criteria[criteria.length - 1] = { ...last, text: `${last.text} ${line.trim()}` };
    }
  }
  return criteria;
}

/** Write the criteria back, leaving every other part of the body exactly as it was. */
export function writeCriteria(body: string, criteria: Criterion[]): string {
  const rendered = criteria
    .map((criterion) => `- [AC-${criterion.number}] ${criterion.text}`)
    .join("\n");
  const at = body.indexOf(CRITERIA_HEADING);
  if (at === -1) return body;

  const after = body.slice(at + CRITERIA_HEADING.length);
  const nextHeading = after.search(/\n## /);
  const tail = nextHeading === -1 ? "" : after.slice(nextHeading);

  return `${body.slice(0, at)}${CRITERIA_HEADING}\n\n${rendered}\n${tail}`;
}
