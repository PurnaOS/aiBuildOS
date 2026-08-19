# Knowledge base

This directory is the **system of record for the software lifecycle** of this project —
requirements, decisions, work, tests and defects — versioned in Git alongside the code it describes.

It is an internal wiki and a knowledge graph, not a folder of Markdown files. Artifacts are short,
single-subject and linked. Nothing is duplicated: **repeat IDs and links, never content.**

## Start here

| If you want to… | Read |
| --- | --- |
| know how documents are written | [OKF conventions](guidelines/okf-conventions.md) |
| add a feature | [Requirement-first development](guidelines/requirement-first.md) |
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

## Traceability

Two chains, both walkable in either direction. Solid arrows are **stored** links (frontmatter
`links:`); the reverse direction is **derived** by reverse index and shown in directory indexes.

**`Epic → Requirement → User Story → Implementation → Test Case → Verification`**
An Epic `implements` Requirements. A Story `implements` a Requirement, sits under an Epic via
`parent`, and names its `verified_by` TestCases. A TestCase `verifies` the Requirement — or a single
acceptance criterion of it, `RQ-0007#AC-2`.

**`Requirement → Test Case → Bug → Fix → Regression Test`**
A Bug `affects` the Requirement it violates and is `fixed_by` a Story. The regression TestCase
`verifies` both, so the requirement keeps permanent coverage against that failure returning.

Full relationship table: [OKF conventions §4](guidelines/okf-conventions.md#4-relationships).

## How to read this bundle

Load an index, then the one artifact you need, then follow its links. **Do not load the corpus.**
Every document here is written to be retrievable on its own and to point at its neighbours — that is
the whole design.

## This bundle is new

It has no artifacts yet, which is the correct state for a project that has not defined its first
requirement. Start with [requirement-first development](guidelines/requirement-first.md): mint
`RQ-0001`, write its acceptance criteria, and add a row to
[requirements/README.md](requirements/README.md).
