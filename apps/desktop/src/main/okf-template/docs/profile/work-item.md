---
type: TypeDefinition
defines: WorkItem
abstract: true
fields:
  priority: { kind: enum, values: [p1, p2, p3], required: false }
  estimate: { kind: number, required: false }
links:
  depends_on: { target: [WorkItem], cycles: forbid }
  related_to: { target: [WorkItem] }
---

# WorkItem (abstract)

The shared base for everything that is *worked on* rather than *decided* or *stated*: [Epic](epic.md),
[Story](story.md), [Bug](bug.md).

Abstract types have no `prefix`, no `dir` and no `states` — they are never instantiated directly.
They exist so that a link can declare `target: [WorkItem]` and accept any of the concrete subtypes
(see [polymorphism](../guidelines/okf-conventions.md#polymorphism)).
