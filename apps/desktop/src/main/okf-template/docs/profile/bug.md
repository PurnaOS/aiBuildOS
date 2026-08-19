---
type: TypeDefinition
defines: Bug
extends: WorkItem
abstract: false
prefix: BG
dir: bugs
fields:
  severity: { kind: enum, values: [blocker, major, minor], required: true }
states:
  vocabulary: [draft, ready, queued, building, review, accepted, done, rejected, retired]
  initial: draft
  transitions:
    - { from: draft,    to: ready }
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
  affects:     { target: [Requirement, Story], min: 1 }
  fixed_by:    { target: [Story] }
  verified_by: { target: [TestCase] }
  related_to:  { target: [Bug, Requirement, Story] }
body:
  sections:
    - { name: "Reproduction", required: true }
---

# Bug

A defect: a place where the product does not meet a [Requirement](requirement.md). Lives in
[`docs/bugs/`](../bugs/README.md).

`affects` is required — a bug that names no requirement is either a feature request (write a
requirement) or noise. The closing move is a regression [TestCase](test-case.md) that
`verifies: [BG-…, RQ-…]`, so the requirement gains permanent coverage against the failure returning.

This is the second traceability chain:
`Requirement → TestCase → Bug → Fix → Regression Test`.
