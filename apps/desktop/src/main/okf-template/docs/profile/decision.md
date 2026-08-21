---
type: TypeDefinition
defines: Decision
abstract: false
prefix: DC
dir: decisions
states:
  vocabulary: [draft, proposed, accepted, rejected, superseded, retired]
  initial: draft
  transitions:
    - { from: draft,    to: proposed }
    - { from: proposed, to: accepted }
    - { from: proposed, to: rejected }
    - { from: accepted, to: superseded }
    - { from: "*",      to: retired }
  derived: false
links:
  supersedes: { target: [Decision] }
  constrains: { target: [Requirement, Story, Architecture] }
  related_to: { target: [Decision, Requirement, Architecture] }
body:
  sections:
    - { name: "Context", required: true }
    - { name: "Decision", required: true }
    - { name: "Consequences", required: true }
---

# Decision

An architecture decision record. Lives in [`docs/decisions/`](../decisions/README.md).

Note the prefix: decisions are `DC`, **not** `ADR`. "ADR" is the common name for the genre; `Decision`
is the type and `DC` is the frozen OKF prefix.

A decision is never edited into a different decision. When it stops being true, write a new one with
`supersedes: [DC-…]` — moving the old one to `superseded` is the person's move, and the `supersedes`
link is what tells them to make it. The record of *what we used to think* is the point.

**Inbound** (derived): `constrained_by` on whatever the decision constrains; `superseded_by`.
