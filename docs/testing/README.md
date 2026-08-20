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
| [TC-0046](tc-0046.md) | Approval flips what it may, and refuses what the record's rules refuse | active | [RQ-0014](../requirements/rq-0014.md)#AC-3, #AC-5, #AC-6 |
| [TC-0047](tc-0047.md) | A proposal lands as drafts, is shaped, and approval schedules it | active | [RQ-0014](../requirements/rq-0014.md)#AC-1, #AC-2, #AC-4, #AC-5, #AC-7 |
| [TC-0048](tc-0048.md) | The build walk and the send-back are record edits, and survive a restart | active | [RQ-0015](../requirements/rq-0015.md)#AC-1, #AC-4, #AC-6 |
| [TC-0049](tc-0049.md) | A story is built, reviewed beside its criteria, and accepted | active | [RQ-0015](../requirements/rq-0015.md)#AC-1 through #AC-5 |
| [TC-0050](tc-0050.md) | A column orders by priority before ID, live | active | [BG-0005](../bugs/bg-0005.md), [RQ-0011](../requirements/rq-0011.md)#AC-5 |
| [TC-0051](tc-0051.md) | A question fence becomes a card, and a broken one becomes text | active | [RQ-0016](../requirements/rq-0016.md)#AC-1, #AC-5 |
| [TC-0052](tc-0052.md) | A tap answers the agent, and typing answers it too | active | [RQ-0016](../requirements/rq-0016.md)#AC-1 through #AC-4 |
| [TC-0053](tc-0053.md) | The interview drafts requirements as it settles them | active | [RQ-0017](../requirements/rq-0017.md)#AC-1, #AC-2, #AC-3, #AC-6 |
| [TC-0054](tc-0054.md) | An abandoned interview keeps its drafts, as drafts | active | [RQ-0017](../requirements/rq-0017.md)#AC-4, #AC-5 |
| [TC-0055](tc-0055.md) | Stage, unstage and commit run the user's own Git | active | [RQ-0018](../requirements/rq-0018.md)#AC-1, #AC-2, #AC-3, #AC-6 |
| [TC-0056](tc-0056.md) | The Git tab commits, and accepting a story offers to | active | [RQ-0018](../requirements/rq-0018.md)#AC-1, #AC-2, #AC-4, #AC-5 |
| [TC-0057](tc-0057.md) | Fenced check commands run, stream, and answer by exit code | active | [RQ-0019](../requirements/rq-0019.md)#AC-1, #AC-2, #AC-3, #AC-5 |
| [TC-0058](tc-0058.md) | The checks run beside the review, and a failure goes to the agent | active | [RQ-0019](../requirements/rq-0019.md)#AC-1 through #AC-4 |
| [TC-0059](tc-0059.md) | The whole loop, in one sitting | active | [RQ-0014](../requirements/rq-0014.md), [RQ-0015](../requirements/rq-0015.md) |
| [TC-0060](tc-0060.md) | The supervision policy answers what it may, and only that | active | [RQ-0022](../requirements/rq-0022.md)#AC-2, #AC-3, #AC-5 |
| [TC-0061](tc-0061.md) | Hands-off is visible, and asks still wait for a person | active | [RQ-0022](../requirements/rq-0022.md)#AC-1, #AC-3, #AC-4 |
| [TC-0062](tc-0062.md) | A TestCase takes the walk's outcome through the guarded save | active | [RQ-0023](../requirements/rq-0023.md)#AC-2, #AC-4 |
| [TC-0063](tc-0063.md) | The checklist is walked from the review, and the outcome lands | active | [RQ-0023](../requirements/rq-0023.md)#AC-1, #AC-2, #AC-3 |
| [TC-0064](tc-0064.md) | Impact is a read of the graph, grouped by what it means | active | [RQ-0024](../requirements/rq-0024.md)#AC-1, #AC-2 |
| [TC-0065](tc-0065.md) | A changed requirement offers the impact, and the re-plan | active | [RQ-0024](../requirements/rq-0024.md)#AC-1, #AC-3, #AC-4 |
| [TC-0066](tc-0066.md) | Worktree verbs create, checkpoint, merge and reconcile | active | [RQ-0020](../requirements/rq-0020.md)#AC-1, #AC-3, #AC-4, #AC-5 |
| [TC-0067](tc-0067.md) | A worktree build leaves the workspace free, and lands on accept | active | [RQ-0020](../requirements/rq-0020.md)#AC-1, #AC-2, #AC-4, #AC-6 |
| [TC-0068](tc-0068.md) | Now derives from the sessions and the record, and counts what waits | active | [RQ-0021](../requirements/rq-0021.md)#AC-2, #AC-3 |
| [TC-0069](tc-0069.md) | Two builds at once; cancelling one leaves the other | active | [RQ-0021](../requirements/rq-0021.md)#AC-1, #AC-2, #AC-4 |
| [TC-0070](tc-0070.md) | The run fence starts a server, and nothing outlives its review | active | [RQ-0025](../requirements/rq-0025.md)#AC-1, #AC-3, #AC-4 |
| [TC-0071](tc-0071.md) | The preview renders beside the review, and closes with it | active | [RQ-0025](../requirements/rq-0025.md)#AC-1, #AC-2 |
| [TC-0072](tc-0072.md) | A rejected read at turn end still lands on screen | draft | [BG-0006](../bugs/bg-0006.md), [RQ-0015](../requirements/rq-0015.md) |
| [TC-0073](tc-0073.md) | The flip lands in the build's own project, whatever is on screen | draft | [BG-0007](../bugs/bg-0007.md), [RQ-0021](../requirements/rq-0021.md) |
| [TC-0074](tc-0074.md) | A build's stream shows the tool call that ran | draft | [BG-0008](../bugs/bg-0008.md), [RQ-0021](../requirements/rq-0021.md) |
| [TC-0075](tc-0075.md) | The watcher debounces, filters, and caches | draft | [RQ-0026](../requirements/rq-0026.md)#AC-4, #AC-6, #AC-7 |
| [TC-0076](tc-0076.md) | What anything writes, the workspace shows, with no turn ending | draft | [RQ-0026](../requirements/rq-0026.md)#AC-1, #AC-2, #AC-3, #AC-5 |
| [TC-0077](tc-0077.md) | The rail's walk and the board's walk are one walk | draft | [RQ-0027](../requirements/rq-0027.md)#AC-1, #AC-2 |
| [TC-0078](tc-0078.md) | Talking a story into work lands it in review | draft | [RQ-0027](../requirements/rq-0027.md)#AC-1, #AC-4 |
| [TC-0079](tc-0079.md) | The scaffold seeds the instructions, and the seeder never overwrites | draft | [RQ-0028](../requirements/rq-0028.md)#AC-1, #AC-2, #AC-3 |
| [TC-0080](tc-0080.md) | A fresh project's instructions are on disk where agents look | draft | [RQ-0028](../requirements/rq-0028.md)#AC-1 |
| [TC-0081](tc-0081.md) | The rail folds and counts; the chrome asks in its own voice | draft | [RQ-0029](../requirements/rq-0029.md)#AC-1, #AC-2, #AC-3 |
| [TC-0082](tc-0082.md) | Streaming shows on the tab, and what changed says so | draft | [RQ-0030](../requirements/rq-0030.md)#AC-1 through #AC-4 |
| [TC-0083](tc-0083.md) | The card reads the wire: command, chunks, outcome | draft | [RQ-0031](../requirements/rq-0031.md)#AC-1, #AC-2, #AC-5, #AC-6 |
| [TC-0084](tc-0084.md) | A command streams into the transcript and folds when long | draft | [RQ-0031](../requirements/rq-0031.md)#AC-1 through #AC-4 |
