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
| [TC-0006](tc-0006.md) | A created project is a repository with one commit and a valid OKF bundle | active | [RQ-0002](../requirements/rq-0002.md)#AC-3, #AC-4 |
| [TC-0007](tc-0007.md) | Git reads branch, working-tree counts and commits, and names its own failures | active | [RQ-0002](../requirements/rq-0002.md)#AC-5, #AC-7, #AC-11 |
| [TC-0008](tc-0008.md) | A project is created, listed, opened and closed from the launch page | active | [RQ-0002](../requirements/rq-0002.md)#AC-2, #AC-6, #AC-10 |
| [TC-0009](tc-0009.md) | The bundle loader walks a bundle permissively and summarises it by type and state | active | [RQ-0002](../requirements/rq-0002.md)#AC-8 |
| [TC-0010](tc-0010.md) | The type profile loads from disk and resolves extends by merging child over parent | active | [RQ-0003](../requirements/rq-0003.md)#AC-1, #AC-14 |
| [TC-0011](tc-0011.md) | Frontmatter rules check type, prefix, directory, fields, state and provenance | active | [RQ-0003](../requirements/rq-0003.md)#AC-2 … #AC-7 |
| [TC-0012](tc-0012.md) | Link rules check declared relationships, target types, cardinality and cycles | active | [RQ-0003](../requirements/rq-0003.md)#AC-8 … #AC-11 |
| [TC-0013](tc-0013.md) | Body rules check required sections, acceptance criteria and criterion links | active | [RQ-0003](../requirements/rq-0003.md)#AC-12, #AC-13 |
| [TC-0014](tc-0014.md) | The event channel validates both ends, delivers to subscribers and unsubscribes | active | [RQ-0004](../requirements/rq-0004.md)#AC-3, #AC-18 |
| [TC-0015](tc-0015.md) | A session stays open across prompts, streams every update kind, and cancels cleanly | active | [RQ-0004](../requirements/rq-0004.md)#AC-4, #AC-11, #AC-17 |
| [TC-0016](tc-0016.md) | Every ACP session update maps onto AG-UI events | active | [RQ-0004](../requirements/rq-0004.md)#AC-5, #AC-6, #AC-7, #AC-8 |
| [TC-0017](tc-0017.md) | Permission, authentication and session controls are the agent's, not ours | active | [RQ-0004](../requirements/rq-0004.md)#AC-9, #AC-10, #AC-12, #AC-13 |
| [TC-0018](tc-0018.md) | The workspace lays out three panes with a tabbed centre and streams a turn | active | [RQ-0004](../requirements/rq-0004.md)#AC-1, #AC-2, #AC-3 |
| [TC-0019](tc-0019.md) | The rails list the record with derived links, and the working tree as Git sees it | active | [RQ-0004](../requirements/rq-0004.md)#AC-14, #AC-15, #AC-16 |
| [TC-0020](tc-0020.md) | A live session's narration crosses the real boundary into a real renderer | active | [RQ-0004](../requirements/rq-0004.md)#AC-3, #AC-11, #AC-18 |
| [TC-0021](tc-0021.md) | Session controls come from the agent, and follow the agent when it changes them | active | [RQ-0004](../requirements/rq-0004.md)#AC-12, #AC-13 |
| [TC-0022](tc-0022.md) | A file is edited and saved unchanged, and a collision with the agent loses nothing | active | [RQ-0005](../requirements/rq-0005.md)#AC-1, #AC-2, #AC-3, #AC-4 |
| [TC-0023](tc-0023.md) | A path from the renderer never reaches outside the project | active | [RQ-0005](../requirements/rq-0005.md)#AC-11, [RQ-0004](../requirements/rq-0004.md)#AC-18 |
| [TC-0024](tc-0024.md) | Saving an artifact rewrites only what changed, and the index with it | active | [RQ-0005](../requirements/rq-0005.md)#AC-8, #AC-10 |
| [TC-0025](tc-0025.md) | An artifact's body survives being edited | active | [RQ-0005](../requirements/rq-0005.md)#AC-7, #AC-8 |
| [TC-0026](tc-0026.md) | An artifact is authored as its own shape, from the profile | active | [RQ-0005](../requirements/rq-0005.md)#AC-3 through #AC-10 |
| [TC-0027](tc-0027.md) | The rails show what the agent and the user just changed | active | [BG-0001](../bugs/bg-0001.md), [RQ-0004](../requirements/rq-0004.md)#AC-14, #AC-15 |
| [TC-0028](tc-0028.md) | The conversation is drawn in the application's palette | active | [BG-0002](../bugs/bg-0002.md), [RQ-0004](../requirements/rq-0004.md)#AC-1 |
| [TC-0029](tc-0029.md) | A minted artifact is what its type says it is | active | [RQ-0006](../requirements/rq-0006.md)#AC-2, #AC-3, #AC-4 |
| [TC-0030](tc-0030.md) | A file and an artifact are started from the workspace | active | [RQ-0006](../requirements/rq-0006.md)#AC-1, #AC-5, #AC-6, #AC-7, #AC-8 |
| [TC-0031](tc-0031.md) | The editors follow the window's appearance | active | [BG-0003](../bugs/bg-0003.md), [RQ-0004](../requirements/rq-0004.md)#AC-1 |
| [TC-0032](tc-0032.md) | The chosen appearance is in force, and survives a restart | active | [RQ-0007](../requirements/rq-0007.md)#AC-1 through #AC-6 |
| [TC-0033](tc-0033.md) | A file is made from the tree, in the directory pointed at | active | [RQ-0006](../requirements/rq-0006.md)#AC-9 |
| [TC-0034](tc-0034.md) | Editing saves itself, except when something else has a claim on the file | active | [RQ-0008](../requirements/rq-0008.md)#AC-1 through #AC-5, #AC-7, #AC-8 |
| [TC-0035](tc-0035.md) | The sidebar collapses, comes back, and is remembered | active | [RQ-0009](../requirements/rq-0009.md)#AC-1, #AC-2, #AC-3 |
| [TC-0036](tc-0036.md) | A failed save keeps the work and names the failure | active | [RQ-0008](../requirements/rq-0008.md)#AC-6 |
| [TC-0037](tc-0037.md) | Collapsing the chrome leaves the panes as the user sized them | active | [RQ-0009](../requirements/rq-0009.md)#AC-4 |
| [TC-0038](tc-0038.md) | The engine knows which states may follow, and refuses the rest | active | [RQ-0010](../requirements/rq-0010.md)#AC-1 through #AC-4 |
| [TC-0039](tc-0039.md) | The editor offers only the legal next states, and the record follows | active | [RQ-0010](../requirements/rq-0010.md)#AC-1, #AC-5, #AC-6 |
| [TC-0040](tc-0040.md) | A board is a derivation of the record, and nothing else | active | [RQ-0011](../requirements/rq-0011.md)#AC-1, #AC-5, #AC-8 |
| [TC-0041](tc-0041.md) | Moving a card is the state change, and an illegal drop is a refusal | active | [RQ-0011](../requirements/rq-0011.md)#AC-2, #AC-3, #AC-4, #AC-6, #AC-7 |
| [TC-0042](tc-0042.md) | Findings ride the record read, per artifact | active | [RQ-0012](../requirements/rq-0012.md)#AC-1, #AC-3 |
| [TC-0043](tc-0043.md) | A problem is marked where the artifact is listed, and a clean record is silent | active | [RQ-0012](../requirements/rq-0012.md)#AC-1, #AC-2, #AC-4 |
| [TC-0044](tc-0044.md) | Playbooks are discovered from the record and composed with their context | active | [RQ-0013](../requirements/rq-0013.md)#AC-1, #AC-2, #AC-6 |
| [TC-0045](tc-0045.md) | A pressed playbook says exactly what it sent, in the transcript | active | [RQ-0013](../requirements/rq-0013.md)#AC-2 through #AC-5 |
| [TC-0046](tc-0046.md) | Approval flips what it may, and refuses what the record's rules refuse | draft | [RQ-0014](../requirements/rq-0014.md)#AC-3, #AC-5, #AC-6 |
| [TC-0047](tc-0047.md) | A proposal lands as drafts, is shaped, and approval schedules it | draft | [RQ-0014](../requirements/rq-0014.md)#AC-1, #AC-2, #AC-4, #AC-5, #AC-7 |
| [TC-0048](tc-0048.md) | The build walk and the send-back are record edits, and survive a restart | draft | [RQ-0015](../requirements/rq-0015.md)#AC-1, #AC-4, #AC-6 |
| [TC-0049](tc-0049.md) | A story is built, reviewed beside its criteria, and accepted | draft | [RQ-0015](../requirements/rq-0015.md)#AC-1 through #AC-5 |
