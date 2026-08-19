# Test cases

`TC-NNNN` — the verifications that decide whether a requirement is actually met.
Files are named for their ID: `tc-0001.md`.

Conventions: [OKF conventions](../guidelines/okf-conventions.md) · [the TestCase profile](../profile/test-case.md) ·
back to [docs/README.md](../README.md)

| ID | Title | State | Verifies |
| ---- | ------- | ------- | ------ |
| [TC-0001](tc-0001.md) | Harness store persists, upserts and survives a bad file | active | [RQ-0001](../requirements/rq-0001.md)#AC-1, #AC-2, #AC-9 |
| [TC-0002](tc-0002.md) | ACP probe completes a round trip against the stub agent | active | [RQ-0001](../requirements/rq-0001.md)#AC-5, #AC-6 |
| [TC-0003](tc-0003.md) | ACP probe reports each failure stage and always reaps the child | active | [RQ-0001](../requirements/rq-0001.md)#AC-7, #AC-8 |
| [TC-0004](tc-0004.md) | First launch with no harness prompts the user to attach one | active | [RQ-0001](../requirements/rq-0001.md)#AC-3, #AC-4, #AC-10 |
| [TC-0005](tc-0005.md) | Project registry persists, dedupes by path and refuses to overwrite a bad file | active | [RQ-0002](../requirements/rq-0002.md)#AC-1, #AC-9, #AC-12 |
| [TC-0006](tc-0006.md) | A created project is a repository with one commit and a valid empty OKF bundle | active | [RQ-0002](../requirements/rq-0002.md)#AC-3, #AC-4 |
| [TC-0007](tc-0007.md) | Git reads branch, working-tree counts and commits, and names its own failures | active | [RQ-0002](../requirements/rq-0002.md)#AC-5, #AC-7, #AC-11 |
| [TC-0008](tc-0008.md) | A project is created, listed, opened and closed from the launch page | active | [RQ-0002](../requirements/rq-0002.md)#AC-2, #AC-6, #AC-10 |
| [TC-0009](tc-0009.md) | The bundle loader walks a bundle permissively and summarises it by type and state | active | [RQ-0002](../requirements/rq-0002.md)#AC-8 |
| [TC-0014](tc-0014.md) | The event channel validates both ends, delivers to subscribers and unsubscribes | active | [RQ-0004](../requirements/rq-0004.md)#AC-3, #AC-18 |
| [TC-0015](tc-0015.md) | A session stays open across prompts, streams every update kind, and cancels cleanly | active | [RQ-0004](../requirements/rq-0004.md)#AC-4, #AC-11, #AC-17 |
| [TC-0016](tc-0016.md) | Every ACP session update maps onto AG-UI events | active | [RQ-0004](../requirements/rq-0004.md)#AC-5, #AC-6, #AC-7, #AC-8 |
| [TC-0017](tc-0017.md) | Permission, authentication and session controls are the agent's, not ours | active | [RQ-0004](../requirements/rq-0004.md)#AC-9, #AC-10, #AC-12, #AC-13 |
| [TC-0018](tc-0018.md) | The workspace lays out three panes with a tabbed centre and streams a turn | active | [RQ-0004](../requirements/rq-0004.md)#AC-1, #AC-2, #AC-3 |
| [TC-0019](tc-0019.md) | The rails list the record with derived links, and the working tree as Git sees it | active | [RQ-0004](../requirements/rq-0004.md)#AC-14, #AC-15, #AC-16 |
| [TC-0020](tc-0020.md) | A live session's narration crosses the real boundary into a real renderer | active | [RQ-0004](../requirements/rq-0004.md)#AC-3, #AC-11, #AC-18 |
