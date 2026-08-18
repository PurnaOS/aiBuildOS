# @aibuildos/acp

The boundary between the product and external agent processes
([DC-0007](../../docs/decisions/dc-0007.md)). **ACP is the only door to AI** — nothing else in this
repository may hold a model client.

This package currently defines the agent descriptor vocabulary and the spawn interface only. The live
ACP client over `@agentclientprotocol/sdk` arrives with its own requirement; `tools/stub-acp-agent`
already speaks the wire format so the spawn path can be tested without a model.
