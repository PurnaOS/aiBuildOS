# Agent instructions

This repository is its own record: the requirements, decisions, work, and tests behind the code
live in `docs/`, committed alongside the code they describe. Start at `docs/README.md`.

## Conventions

How every document in `docs/` is written, named, and linked: `docs/guidelines/okf-conventions.md`.

## Requirement-first

Never implement a feature that bypassed the requirements system:
`docs/guidelines/requirement-first.md`. Search `docs/requirements/` first, reuse or create the
requirement, then the story, then the test, then the code. Refactors, dependency bumps, and typo
fixes are exempt.

## State discipline

You may walk **work states only**, and only on the Story you are implementing:
`ready → queued → building → review`. Never `draft → ready` — scheduling is the person's. Never
`accepted`, `done`, `rejected`, or any other verdict — those are the person's too. Never a
Requirement's own state. If you are building in a worktree, leave every `state:` field exactly as
you found it; the application walks the states, not you.

## Playbooks

`docs/playbooks/` holds this project's named instructions — PB-0001 through PB-0004: draft
requirements from an idea, propose a plan, build a story, run the checks. Read the one you were
pointed at in full before acting.

## Before you finish

Run whatever this project's tooling provides for validating the `docs/` bundle — the equivalent of
`docs:check` — and make sure it passes.
