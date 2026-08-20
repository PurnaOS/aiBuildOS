# aiBuildOS knowledge base

This directory is the **system of record for the entire software lifecycle** — requirements,
decisions, work, tests, and defects, versioned in Git alongside the code they describe
([DC-0015](decisions/dc-0015.md)).

It is an internal wiki and a knowledge graph, not a folder of Markdown files. Artifacts are short,
single-subject, and linked. Nothing is duplicated: **repeat IDs and links, never content.**

## Start here

| If you want to… | Read |
| --- | --- |
| know where the product is headed | [How aiBuildOS works](HowItWorks.md) — the vision, in plain terms |
| know how documents are written | [OKF conventions](guidelines/okf-conventions.md) |
| add a feature | [Requirement-first development](guidelines/requirement-first.md) |
| know why the stack is what it is | [Decisions](decisions/README.md) |
| know how the system is shaped | [Architecture](architecture/README.md) |
| know what types exist | [Type profile](profile/README.md) |

## The bundle

| Directory | Prefix | Contents |
| --- | --- | --- |
| [guidelines/](guidelines/README.md) | — | the rules everything else follows |
| [profile/](profile/README.md) | — | type definitions — the schema, as data |
| [requirements/](requirements/README.md) | `RQ` | **the canonical source of truth for product requirements** |
| [epics/](epics/README.md) | `EP` | bodies of work grouping stories |
| [user-stories/](user-stories/README.md) | `ST` | user-facing slices of work |
| [testing/](testing/README.md) | `TC` | test cases — the verifications |
| [bugs/](bugs/README.md) | `BG` | defects |
| [decisions/](decisions/README.md) | `DC` | architecture decision records |
| [architecture/](architecture/README.md) | `AR` | system shape |
| [playbooks/](playbooks/README.md) | `PB` | named instructions shown as buttons |

## Traceability

Two chains, both walkable in either direction. Solid arrows are **stored** links (frontmatter
`links:`); the reverse direction is **derived** by reverse index and shown in directory indexes.

```
                     ┌──────────── implements ────────────┐
                     │                                    │
   Epic ─ implements ─▶ Requirement ◀─ verifies ─ TestCase │
    ▲                   ▲   ▲  ▲                     ▲     │
    │ parent            │   │  └─ affects ─ Bug      │     │
   Story ───────────────┘   │                │       │    Story
    └──── verified_by ──────┼────────────────┼───────┘
                            │                └─ fixed_by ─▶ Story
        Requirement ─ depends_on ─▶ Requirement
        Requirement ─ derived_from ─▶ Requirement
        Decision ─ constrains ─▶ Requirement · Story · Architecture
```

**`Epic → Requirement → User Story → Implementation → Test Case → Verification`**
An Epic `implements` Requirements. A Story `implements` a Requirement, sits under an Epic via
`parent`, and names its `verified_by` TestCases. Implementation is the code the Story produced. A
TestCase `verifies` the Requirement — or a single acceptance criterion of it, `RQ-0007#AC-2`.

**`Requirement → Test Case → Bug → Fix → Regression Test`**
A Bug `affects` the Requirement it violates and is `fixed_by` a Story. The regression TestCase
`verifies` both the Bug and the Requirement, so the requirement keeps permanent coverage against that
failure returning.

**Requirements may depend on other requirements** — `depends_on` (cycles forbidden) for prerequisites,
`derived_from` for refinement, `supersedes` for replacement.

### Walking the graph

Starting from any requirement you can reach everything and get back:

- forward: `depends_on`, `derived_from`, `verified_by`
- backward (derived, read from the directory index): `implemented_by` from epics and stories,
  `verifies` from test cases, `affected_by` from bugs, `constrained_by` from decisions

Full relationship table:
[OKF conventions §4](guidelines/okf-conventions.md#4-relationships).

## How to read this bundle

Load an index, then the one artifact you need, then follow its links. **Do not load the corpus.**
Every document here is written to be retrievable on its own and to point at its neighbours — that is
the whole design.
