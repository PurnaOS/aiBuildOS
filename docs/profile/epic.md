---
type: TypeDefinition
defines: Epic
extends: WorkItem
abstract: false
prefix: EP
dir: epics
states:
  vocabulary: [draft, ready, active, done, retired]
  initial: draft
  transitions:
    - { from: draft,  to: ready }
    - { from: ready,  to: active }
    - { from: active, to: done }
    - { from: [ready, active, done], to: draft }
    - { from: "*",    to: retired }
  derived: false
links:
  implements: { target: [Requirement], min: 1 }
  related_to: { target: [Requirement, Epic, Decision] }
body:
  sections:
    - { name: "Scope", required: true }
---

# Epic

A body of work large enough to need breaking down, grouping [Stories](story.md) that serve the same
[Requirements](requirement.md). Lives in [`docs/epics/`](../epics/README.md).

An Epic must `implements` at least one Requirement — an epic that traces to nothing is scope nobody
asked for.

**Inbound** (derived): `children` from Story `parent`.
