---
type: TypeDefinition
defines: Sprint
abstract: false
prefix: SP
dir: sprints
states:
  vocabulary: [draft, active, done, retired]
  initial: draft
  transitions:
    - { from: draft,  to: active }
    - { from: active, to: done }
    - { from: "*",    to: retired }
  derived: false
links:
  contains: { target: [WorkItem] }
---

# Sprint

A batch of work taken together in a window of time. Lives in [`docs/sprints/`](../sprints/README.md).

A Sprint is not an [Epic](epic.md): an Epic groups stories by *scope* — what they are for — while a
Sprint groups them by *when they are being built*. The same story belongs to one epic for its whole
life and to a sprint only while that batch runs.

The sprint's git binding is a branch (`aibuildos/sp-0001`): starting the sprint creates it, story
builds branch from it, and finishing the sprint merges it. `contains` is stored on the Sprint; the
inverse is derived like every other backlink.
