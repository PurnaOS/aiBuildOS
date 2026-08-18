---
type: TypeDefinition
defines: Requirement
abstract: false
prefix: RQ
dir: requirements
fields:
  kind: { kind: enum, values: [functional, nonfunctional], required: true }
  priority: { kind: enum, values: [p1, p2, p3], required: false }
states:
  vocabulary: [draft, ready, building, built, verified, retired]
  initial: draft
  transitions:
    - { from: draft,    to: ready }
    - { from: ready,    to: building }
    - { from: building, to: built }
    - { from: built,    to: verified }
    - { from: [ready, building, built, verified], to: draft }
    - { from: "*",      to: retired }
  derived: false
links:
  depends_on:   { target: [Requirement], cycles: forbid }
  derived_from: { target: [Requirement] }
  related_to:   { target: [Requirement, Epic, Decision] }
  supersedes:   { target: [Requirement] }
  verified_by:  { target: [TestCase] }
body:
  sections:
    - { name: "Acceptance criteria", required: true, items: AC }
json_schema: null
---

# Requirement

The canonical statement of *what the product must do*. [`docs/requirements/`](../requirements/README.md)
is the source of truth for product requirements, and
[requirement-first development](../guidelines/requirement-first.md) is how artifacts get here.

Functional and non-functional requirements are both `RQ`; the `kind` field discriminates them. There is
no separate `NFR` prefix.

`states.derived` is `false`: the post-`ready` states are set by hand until the knowledge engine can
compute them from implementing work. See
[deviation 3](../guidelines/okf-conventions.md#7-deliberate-deviations).

**Inbound** (derived, not stored here): `implemented_by` from [Epic](epic.md)/[Story](story.md)
`implements`, `verifies` from [TestCase](test-case.md), `affected_by` from [Bug](bug.md) `affects`,
`constrained_by` from [Decision](decision.md) `constrains`.
