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
