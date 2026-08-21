---
type: TypeDefinition
defines: TestCase
abstract: false
prefix: TC
dir: testing
fields:
  kind: { kind: enum, values: [manual, automated], required: true }
  binding: { kind: string, required: false }
  last_result: { kind: enum, values: [passed, failed], required: false }
  last_run: { kind: string, required: false }
  last_run_by: { kind: string, required: false }
states:
  vocabulary: [draft, active, retired]
  initial: draft
  transitions:
    - { from: draft, to: active }
    - { from: active, to: draft }
    - { from: "*",   to: retired }
  derived: false
links:
  verifies:   { target: [Requirement, Story, Bug], min: 1 }
  related_to: { target: [TestCase, Requirement, Story] }
body:
  sections:
    - { name: "Steps", required: true }
---

# TestCase

A verification: the thing that decides whether a [Requirement](requirement.md) is actually met. Lives
in [`docs/testing/`](../testing/README.md).

`verifies` may target a whole artifact or a single acceptance criterion (`RQ-0007#AC-2`), which is how
a large requirement gets covered by several focused tests.

`binding` names the automated test that realises this case — a repo-relative test file path, optionally
with a name filter. Manual cases leave it unset and rely on the `Steps` section.

`last_result`, `last_run` and `last_run_by` are a manual case's outcome: pass or fail, when, and by
whom, written by the guarded save once a person walks its `Steps` from a story's review. All three are
absent until then — absence means the case has never been walked, not that it failed (RQ-0023#AC-4).

**Inbound** (derived): `verified_by` on the Requirement or Story this case verifies.
