# Requirement-first development

**The core project rule.** Every feature and every meaningful behaviour change enters this repository
through the requirements system first.

> Never implement a feature that has bypassed the requirements system.

See also: [OKF conventions](okf-conventions.md) · [docs/README.md](../README.md)

---

## Why

This repository is the system of record for the whole software lifecycle, not just for source code.
Code that exists without a requirement behind it is code nobody can trace, verify, or safely change:
there is no statement of what it was supposed to do, so there is nothing for a test to verify against
and nothing for a bug to be filed against.

## The flow

When asked for a new feature or a meaningful behaviour change:

1. **Search first.** Grep [`docs/requirements/`](../requirements/README.md) and read its index before
   writing anything. Most requests touch something that already exists.
2. **Reuse.** If a requirement already covers the behaviour, use it. Do not mint a near-duplicate.
3. **Otherwise create the requirement first.** Mint the next `RQ-NNNN`, write the acceptance criteria
   as `[AC-n]` items, and set `state: draft`.
4. **Establish relationships.** Add `depends_on` for requirements this one needs, `derived_from` if it
   refines another, `related_to` for context. Move to `state: ready` only once the criteria and the
   dependencies are settled — flipping to `ready` is the scheduling act.
5. **Create or update the epic / user story.** The Story carries `implements: [RQ-…]` and
   `parent: [EP-…]`.
6. **Define the verification.** Write the TestCases with `verifies: [RQ-…]` (or `[RQ-…#AC-n]` for a
   single criterion); the Story carries `verified_by: [TC-…]`.
7. **Only then implement.**

## When implementation proves the requirement wrong

It will happen. The rule is that the requirement changes **deliberately and visibly**, never by the
code quietly drifting away from it:

- If the requirement was incomplete, edit it and add the missing criteria. Existing `[AC-n]` numbers
  keep their meaning; new criteria append.
- If it was wrong, write the replacement and link the new one `supersedes: [RQ-old]`, then move the
  old one to `retired`.
- Either way the trace survives: the story still implements a requirement, the tests still verify one.

## Bugs

A bug is the same discipline running backwards. `BG-NNNN` carries `affects: [RQ-…]` — which
requirement is not being met — and `fixed_by: [ST-…]`. The regression TestCase carries
`verifies: [BG-…, RQ-…]`, so the requirement gains permanent coverage against that failure returning.

## What this rule does not cover

Refactors with no behaviour change, dependency bumps, typo fixes, and documentation edits do not need
a requirement. If you cannot tell whether a change is behavioural, it is.
