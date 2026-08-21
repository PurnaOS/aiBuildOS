---
type: TypeDefinition
defines: Design
abstract: false
prefix: DS
dir: designs
states:
  vocabulary: [draft, review, approved, retired]
  initial: draft
  transitions:
    - { from: draft,    to: review }
    - { from: review,   to: approved }
    - { from: [review, approved], to: draft }
    - { from: "*",      to: retired }
  derived: false
links:
  derived_from: { target: [Requirement], min: 1 }
  related_to:   { target: [Requirement, Design, Decision] }
body:
  sections:
    - { name: "Intent", required: true }
---

# Design

What a requirement should *look like*, decided before anything is built. Lives in
[`docs/designs/`](../designs/README.md).

A Design is proposed by the agent from the requirement it `derived_from`, rendered as a mockup in
the workspace's preview surface, and reviewed beside that requirement. Approving it —
`review → approved` — is what lets planning carry the design into the build. A requirement without
a design plans and builds exactly as before; the phase is per-requirement and optional
([RQ-0048](../requirements/rq-0048.md)).

The body's **Intent** section says what the design shows and why — the mockup source itself is
implementation the story defines, not frontmatter.

**Inbound** (derived): `derives` from the Requirement side.
