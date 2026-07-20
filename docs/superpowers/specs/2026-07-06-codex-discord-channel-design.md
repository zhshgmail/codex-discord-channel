# Initial Discord Channel Design

> Historical record. The inbound delivery design is superseded by
> [Structured Delivery Contract](../../structured-delivery.md). Current runtime
> code has no terminal-input delivery path.

## Retained Architecture

The repository packages one Discord plugin with separate modules for instance
paths, access policy, receiver state, owner metadata, delivery, history, the
Discord client, and the MCP server. Local state is private to one normalized
instance directory. Access-approved messages are normalized before crossing
the delivery boundary, and outbound replies use explicit MCP or CLI commands.

The stable receiver is the instance state path plus `session-gateway.pid`.
`owner.json` remains informational and is not a per-message gate.

## Current Delivery Source Of Truth

`docs/structured-delivery.md` defines the shared app-server endpoint, dynamic
top-level thread resolution, FIFO behavior, turn payload restrictions,
uncertain acknowledgement handling, and release-time exact-console migration.
