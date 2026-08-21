---
type: TypeDefinition
defines: Story
extends: WorkItem
abstract: false
prefix: ST
dir: user-stories
states:
  vocabulary: [draft, ready, queued, building, review, accepted, done, rejected, retired]
  initial: draft
  transitions:
    - { from: draft,    to: ready }
    - { from: ready,    to: draft }
    - { from: ready,    to: queued }
    - { from: queued,   to: building }
    - { from: building, to: review }
    - { from: review,   to: accepted }
    - { from: review,   to: building }
    - { from: review,   to: rejected }
    - { from: accepted, to: done }
    - { from: [accepted, done], to: review }
    - { from: "*",      to: retired }
  derived: false
links:
  implements:  { target: [Requirement], min: 1 }
  verified_by: { target: [TestCase], min: 1 }
  depends_on:  { target: [WorkItem], cycles: forbid }
  parent:      { target: [Epic], max: 1 }
  related_to:  { target: [Requirement, Epic, Story, Decision] }
body:
  sections:
    - { name: "Acceptance criteria", required: true, items: AC }
---

# Story

A user-facing slice of work, small enough to finish and verify. Lives in
[`docs/user-stories/`](../user-stories/README.md).

The two `min: 1` constraints are the load-bearing part of the traceability model: a Story cannot reach
`ready` without saying which [Requirement](requirement.md) it implements and which
[TestCase](test-case.md) verifies it. That is what makes
[requirement → implementation → verification](../README.md#traceability) an unbroken chain rather than
an aspiration.
