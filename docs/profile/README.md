# Type profile

The SDLC schema for this repository, expressed as data rather than code. One frontmatter-only file per
type; the body is documentation, the frontmatter is what the validator reads.

This directory is **excluded from artifact walking** — these are type definitions, not artifacts.
The dialect is specified in
[OKF conventions §6](../guidelines/okf-conventions.md#6-the-profile--types-are-data).

| Type | Prefix | Directory | Definition |
| --- | --- | --- | --- |
| `WorkItem` | — (abstract) | — | [work-item.md](work-item.md) |
| `Requirement` | `RQ` | [requirements/](../requirements/README.md) | [requirement.md](requirement.md) |
| `Epic` | `EP` | [epics/](../epics/README.md) | [epic.md](epic.md) |
| `Story` | `ST` | [user-stories/](../user-stories/README.md) | [story.md](story.md) |
| `TestCase` | `TC` | [testing/](../testing/README.md) | [test-case.md](test-case.md) |
| `Bug` | `BG` | [bugs/](../bugs/README.md) | [bug.md](bug.md) |
| `Decision` | `DC` | [decisions/](../decisions/README.md) | [decision.md](decision.md) |
| `Playbook` | `PB` | [playbooks/](../playbooks/README.md) | [playbook.md](playbook.md) |
| `Sprint` | `SP` | [sprints/](../sprints/README.md) | [sprint.md](sprint.md) |

Manifest: [profile.md](profile.md) — `aibuildos-default@0.2.0`, `formats: 1`.

`Architecture` (`AR`) is ID-reserved but not yet profiled — see
[OKF conventions §3](../guidelines/okf-conventions.md#3-ids-and-file-layout).
