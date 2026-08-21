---
name: aibuildos-default
version: 0.2.0
formats: 1
---

# aibuildos-default profile

The SDLC profile for this repository: the artifact types the validator understands, expressed as data.
See [OKF conventions §6](../guidelines/okf-conventions.md#6-the-profile--types-are-data) for the
dialect, and [the profile index](README.md) for the type list.

Nine files, eight concrete types plus one abstract base — the minimum that supports the
traceability chains in [docs/README.md](../README.md), plus the `Playbook` type
[DC-0019](../decisions/dc-0019.md) asked for and the `Sprint` type
[RQ-0035](../requirements/rq-0035.md) asked for. The profile grows when a requirement asks it to,
not before.
