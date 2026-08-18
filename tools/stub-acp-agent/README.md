# @aibuildos/stub-acp-agent

A scripted ACP agent: a real JSON-RPC-over-stdio binary that replays canned responses
([DC-0013](../../docs/decisions/dc-0013.md)).

It exists so agent behaviour can be tested without calling a live model — **no live model is ever
called in CI**. Because it is spawned as a child process exactly like a real agent, the spawn path and
the wire handling are genuinely exercised rather than mocked.

Node-compatible on purpose: it stands in for an agent binary, and agent binaries are not Bun
([AR-0001](../../docs/architecture/ar-0001.md)).
