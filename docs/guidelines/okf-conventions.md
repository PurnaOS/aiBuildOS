# OKF conventions

The normative specification for how every lifecycle artifact in this repository is written, named,
and linked. If a document and this file disagree, **this file wins**.

See also: [requirement-first.md](requirement-first.md) · [docs/README.md](../README.md) ·
[the type profile](../profile/README.md)

---

## 1. What OKF is

**OKF — Open Knowledge Format.** A *bundle* (a directory) of *concepts*: UTF-8, LF-only Markdown files
with YAML frontmatter carrying a required `type`, cross-linked, and **permissively consumable** —
a reader tolerates unknown types, unknown fields, and broken links rather than rejecting the bundle.

aiBuildOS **adopts OKF v0.2 as-is and does not fork it.** Staying conformant means any other OKF
consumer can read this repository without translation. What aiBuildOS adds is one layer on top: an
**SDLC profile** — the lifecycle taxonomy and the typed traceability vocabulary that OKF deliberately
leaves undefined, expressed as data (see [§6](#6-the-profile--types-are-data)) rather than as code.

The bundle root is **`docs/`**.

---

## 2. Common frontmatter

Every artifact opens with a `---` delimited YAML block on line 1. Required keys:

| Key | Form | Notes |
| --- | --- | --- |
| `type` | string | must match a `TypeDefinition`'s `defines` |
| `id` | `<PREFIX>-<NNNN>` | canonical uppercase |
| `title` | string | free text; **not** part of identity |
| `state` | string | must be in the type's `states.vocabulary` |
| `owner` | string | git handle (see [§7](#7-deliberate-deviations)) |
| `provenance` | `human \| agent \| imported \| backfilled` | coarse origin, one word, filterable |
| `created` | `YYYY-MM-DD` | set once, never updated |

Optional keys: `links` (map — [§4](#4-relationships)), `tags` (string list), `sources` (list of origin
material), `priority` (`p1 \| p2 \| p3`), plus the per-type fields each profile declares.

`generated` (`{ by, at }`) is **required whenever the artifact was authored or revised by an agent**;
`by` is the agent identity string, `at` is ISO-8601 UTC.

```yaml
---
type: Decision
id: DC-0001
title: "Bun workspaces as the monorepo package manager"
state: accepted
owner: srini
provenance: agent
created: 2026-08-18
generated: { by: "claude-code", at: 2026-08-18T00:00:00Z }
tags: [monorepo, tooling]
links:
  constrains: [AR-0002]
---
```

### `state`, never `status`

Workflow lifecycle uses the **`state`** key. OKF v0.2 reserves `status` for its own vocabulary
(`draft | stable | deprecated`, absent ⇒ `stable`); this project does not write `status` at all.

### Encoding

UTF-8, **LF line endings only**. A parser encountering CRLF reports it rather than silently
normalising — normalising is itself a formatting change nobody asked for.

---

## 3. IDs and file layout

**Grammar:** `<PREFIX>-<NNNN>` — an uppercase prefix, a hyphen, and a zero-padded 4-digit number
(which expands to 5+ digits past 9999 without re-padding existing IDs). Numbers are **per-prefix,
append-only, and never reused**. Case-insensitive on input, canonical uppercase on write.

**Filename = the ID, lowercased. No slug.** `dc-0001.md`, not `dc-0001-bun-workspaces.md`. OKF defines
a concept's identity by its path and titles change; ID-only names make renames rare and identity
stable. The title lives in frontmatter.

| Prefix | Type | Directory |
| --- | --- | --- |
| `RQ` | Requirement | [`docs/requirements/`](../requirements/README.md) |
| `EP` | Epic | [`docs/epics/`](../epics/README.md) |
| `ST` | Story | [`docs/user-stories/`](../user-stories/README.md) |
| `TC` | TestCase | [`docs/testing/`](../testing/README.md) |
| `BG` | Bug | [`docs/bugs/`](../bugs/README.md) |
| `DC` | Decision (ADR) | [`docs/decisions/`](../decisions/README.md) |
| `AR` | Architecture | [`docs/architecture/`](../architecture/README.md) |

Two consequences of adopting OKF's frozen prefix table that surprise people:

- **There is no `ADR-` prefix.** Architecture decision records are `Decision` artifacts, prefix `DC`.
- **There is no separate `NFR-` prefix.** Functional and non-functional requirements are both `RQ`,
  discriminated by the Requirement `kind` field (`functional | nonfunctional`).

`AR` is currently **ID-reserved only**: `ar-*.md` documents carry valid common frontmatter, but
Architecture is not one of the six profiled types yet, so no `TypeDefinition` stands behind it. This
is deliberate, not an omission — the profile grows when a requirement asks it to.

### Acceptance criteria

Acceptance criteria are list items in a required body section, each carrying an inline ID `[AC-n]`
unique within the artifact. Criterion IDs are **append-only**: deleting a criterion retires its
number. External reference syntax is `RQ-0007#AC-2`, and a TestCase may `verifies` a single criterion
rather than a whole artifact.

```markdown
## Acceptance criteria
- [AC-1] The validator reports `id/format` for any ID not matching the grammar.
- [AC-2] The validator exits non-zero when any error-severity finding is present.
```

---

## 4. Relationships

### How they are written

Typed relationships live in the frontmatter **`links:`** map. Values are **always arrays of IDs** —
never paths, never bare scalars — even when there is a single entry.

```yaml
links:
  implements: [RQ-0007]
  depends_on: [RQ-0003]
  verified_by: [TC-0031, TC-0032]
```

Bodies may *additionally* contain ordinary Markdown links for human and agent navigation, and they
should: that is what makes this bundle a wiki rather than a database dump. But **only frontmatter
links are validated**. Body links are navigation; frontmatter links are the graph.

### One direction is stored; the inverse is derived

An artifact declares its own outbound edges. The reverse index is computed. **Never hand-write both
sides of a relationship** — a hand-written backlink is a second source of truth that will drift.

| Relationship | Stored on | Target | Constraint |
| --- | --- | --- | --- |
| `implements` | Epic, Story | Requirement | `min: 1` on Story |
| `depends_on` | Requirement, Story | same type | `cycles: forbid` |
| `related_to` | any | any | symmetric, advisory |
| `derived_from` | Requirement | Requirement | |
| `verified_by` | Requirement, Story | TestCase | `min: 1` for a Story at `ready` |
| `verifies` | TestCase | Requirement, Story, Bug (or `ID#AC-n`) | |
| `supersedes` | Requirement, Decision | same type | |
| `affects` | Bug | Requirement, Story | |
| `fixed_by` | Bug | Story | |
| `constrains` | Decision | Requirement, Story, Architecture | |
| `parent` | Story | Epic | `max: 1` |

**Derived — never stored, resolved by reverse index:**

| Derived name | Inverse of |
| --- | --- |
| `implemented_by` | `implements` |
| `verified_by` (on a Requirement reached from a test) | `verifies` |
| **`affected_by`** | `affects` |
| `derives` | `derived_from` |
| `superseded_by` | `supersedes` |
| `children` | `parent` |
| `constrained_by` | `constrains` |
| `fixes` | `fixed_by` |

`related_to` is symmetric: declare it on whichever end is more natural and read it from both.

### Polymorphism

A link satisfies `target: X` if the document it points at has type `X` **or any type that extends
`X`**. `depends_on: { target: [WorkItem] }` therefore accepts a Story or a Bug.

---

## 5. States

| Type | `states.vocabulary` | initial |
| --- | --- | --- |
| Requirement | `draft, ready, building, built, verified, retired` | `draft` |
| Epic | `draft, ready, active, done, retired` | `draft` |
| Story | `draft, ready, queued, building, review, accepted, done, rejected, retired` | `draft` |
| Bug | `draft, ready, queued, building, review, accepted, done, rejected, retired` | `draft` |
| TestCase | `draft, active, retired` | `draft` |
| Decision | `draft, proposed, accepted, rejected, superseded, retired` | `draft` |

Transitions are declared as explicit `from → to` pairs in the profile. **An absent pair is an illegal
transition.** Every type carries the wildcard `{ from: "*", to: retired }`.

Flipping a requirement from `draft` to `ready` **is** the scheduling act. A draft backlog yields an
empty queue on purpose.

---

## 6. The profile — types are data

The project's SDLC schema is itself a set of OKF documents, in [`docs/profile/`](../profile/README.md):
one frontmatter-only Markdown file per type, where the body is documentation for humans and the
frontmatter is what a validator reads. The engine hardcodes only the meta-format. Editing a profile
changes what is enforced; nothing about the types is compiled in.

`docs/profile/` is **excluded from artifact walking** — it holds the type dialect, not artifacts.

### Dialect keys

| Key | Meaning |
| --- | --- |
| `defines` | the type name artifacts put in their `type:` |
| `extends` | inherit fields/links/states; **overrides merge by key, child wins** |
| `abstract` | `true` forbids direct use |
| `prefix` | the two-letter ID prefix ([§3](#3-ids-and-file-layout)); abstract types omit it |
| `dir` | the bundle directory the type lives in |
| `fields` | map of key → `{ kind, required, values?, pattern? }` |
| `states` | `{ vocabulary, initial, transitions, derived }` |
| `links` | map of relationship → `{ target, min?, max?, cycles? }` |
| `body.sections` | required body sections; `items: AC` marks a criteria section |
| `json_schema` | escape hatch: inline JSON Schema applied to the frontmatter |

`kind` ∈ `string | number | boolean | date | enum | id | list<string> | list<id>`.

**`json_schema` is the Ajv escape hatch.** It is declared in the dialect now and honoured by the
validator when the knowledge engine grows to need it — it covers whatever the friendly dialect
cannot express, so the dialect never has to become a general-purpose schema language.

The manifest [`docs/profile/profile.md`](../profile/profile.md) records `{ name, version, formats }`.

---

## 7. Deliberate deviations

This project inherits OKF and its SDLC profile from the predecessor project `iBuildOS`. Four things
differ on purpose:

1. **`owner` is a git handle string**, not a `US-####` User artifact ID. There is no `docs/team/`
   bundle in this project yet; introducing one to satisfy a single field would be ceremony. When
   team artifacts become necessary, `owner` narrows to an ID and this line goes away.
2. **`related_to`, `derived_from` and `affected_by` are named explicitly.** `related_to` and
   `derived_from` are stored links this project adds; `affected_by` is the *derived* inverse of
   `affects`, not a stored key. The upstream vocabulary spells the brief-tracing variant of
   `derived_from` as `traces_to`; this project uses `derived_from` for requirement-to-requirement
   derivation.
3. **Requirement `states.derived` is `false`.** Upstream computes a requirement's post-`ready` state
   from its implementing work. Until the engine can do that here, those states are set by hand.
4. **No provisional IDs, no gate compositions, no merge queue.** Those belong to the knowledge engine,
   not to the documentation conventions. Each arrives with its own requirement.

---

## 8. Index files

Every directory carries a `README.md` that is **plain Markdown with no frontmatter** — indexes are
navigation, not artifacts, and the validator skips them as artifacts while checking that every
artifact is listed in one.

An index is a table: the ID linked to its file, the title, the state, and the artifact's key
relationships rendered as links. That table is how **inbound** navigation works without
hand-maintained backlinks: an artifact stores its outbound links, and its directory index shows what
points at it.

---

## 9. Writing for retrieval

`docs/` is an internal wiki optimised for **just-in-time retrieval**, not for being loaded whole.

- One artifact, one subject. Keep documents short.
- **Never duplicate content across documents.** Repeat IDs and links instead.
- Link every artifact to its neighbours so an agent can walk the graph rather than search it.
- The intended access pattern is: [`docs/README.md`](../README.md) → a directory index → one artifact
  → follow its links. An agent should never need to read the whole corpus to answer a question.
