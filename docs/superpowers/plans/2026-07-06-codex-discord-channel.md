# Initial Discord Channel Implementation Plan

> Historical record. The inbound delivery portion of this plan is superseded
> by [Structured Delivery Contract](../../structured-delivery.md). Current
> runtime code has no terminal-input delivery path.

## Retained Scope

- Package one Discord channel plugin under `plugins/codex-discord-channel`.
- Keep instance state under `$HOME/.codex/channels/discord/<instance>`.
- Preserve access policy, owner metadata, bounded history, and reply tools.
- Keep Discord receive and delivery logic behind explicit module boundaries.
- Validate the manifest, MCP server, executable entrypoint, and unit tests.

## Superseding Delivery Work

The current implementation persists accepted events in a cross-process locked
FIFO and delivers them through a shared app-server. Target resolution, thread
rotation, busy serialization, acknowledgement reconciliation, and the live
relaunch boundary are defined only in `docs/structured-delivery.md`.
