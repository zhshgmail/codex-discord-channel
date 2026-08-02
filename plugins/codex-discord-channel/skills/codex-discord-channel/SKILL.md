---
name: codex-discord-channel
description: Use when inspecting or managing the Discord channel plugin, its persistent inbound queue, owner metadata, gateway receiver, or structured app-server delivery.
---

# Codex Discord Channel

## Runtime Model

- One Discord instance uses one state directory under
  `$HOME/.codex/channels/discord/<instance>`.
- The live receiver is selected by that state directory and
  `session-gateway.pid`.
- `owner.json` is status and handoff metadata only. Never use its owner or
  thread id as a per-message receive gate.
- Accepted events are persisted in a cross-process locked FIFO and deduplicated
  by Discord channel and message id.
- Inbound delivery uses only a shared app-server endpoint and a dynamically
  resolved current top-level thread: `turn/start` while idle, or `turn/steer`
  with an exact active turn precondition.
- There is no terminal-input fallback. Missing or ambiguous structured state is
  unavailable and leaves the FIFO queued.

## Local State

```text
$HOME/.codex/channels/discord/<instance>/.env
$HOME/.codex/channels/discord/<instance>/access.json
$HOME/.codex/channels/discord/<instance>/owner.json
$HOME/.codex/channels/discord/<instance>/session-gateway.pid
$HOME/.codex/channels/discord/<instance>/pending-delivery.json
$HOME/.codex/channels/discord/<instance>/reply-receipts/
$HOME/.codex/channels/discord/<instance>/app-server.sock
```

Do not print Discord tokens, proxy values, queued message text, or raw Discord
errors. Do not commit `.env`.

## Status

Use these MCP tools when available:

- `discord_channel_status`
- `discord_channel_read_owner`
- `discord_channel_claim_owner`
- `discord_channel_read_history`
- `discord_channel_send`

Healthy structured delivery requires:

```json
{
  "deliveryMode": "app-server",
  "deliverySafety": "structured_only",
  "structuredDeliveryState": "available",
  "sharedAppServerAvailable": true,
  "discordStarted": true
}
```

Inspect `deliveryQueueDepth`, `deliveryBlockedReason`, and
`sharedAppServerReason` before making delivery claims. Stable unavailable
reasons include a missing endpoint/socket, no loaded thread, an ambiguous
thread, a busy thread, and uncertain structured acknowledgement.

## Shared Endpoint Boundary

A direct `codex ... resume` TUI has a private embedded app-server and cannot be
joined by the gateway. Exact-console delivery requires an operator-approved
relaunch:

1. Start one persistent app-server at the instance endpoint.
2. Relaunch the visible TUI with `codex --remote <same-endpoint> ...`.
3. Run the released gateway against that same endpoint.
4. Verify an allowed Discord-origin turn in the exact visible TUI, then repeat
   after `/clear`.

Do not restart services or claim live ownership without explicit user
authorization. Repository tests prove the delivery contract, not the live
process migration.

## Delivery Contract

The gateway resolves the current thread for each queued item. A fresh endpoint
must expose one provable top-level loaded thread. The latest top-level
`thread/started` notification replaces it after thread rotation. Subagents are
never targets.

Each drain accepts at most one FIFO head. Idle targets and proven top-level
`systemError` targets use `turn/start`; active targets use `turn/steer` only with
an exact turn id observed from app-server notifications or recovered from
`thread/read` during startup and reconnect.
Unknown or ambiguous active-turn identity remains `thread_busy`, while a new
`turn/started` notification wakes the serialized drain. Requests omit model,
reasoning effort, service tier, personality, cwd, sandbox, permissions,
collaboration mode, and approval overrides.

Every positive acknowledgement is read back from the exact target thread.
Automatic replay stops unless reconciliation proves that the echoed stable
client user message id exists there. A positive RPC response without that user
item remains `structured_ack_uncertain` and must not be described as delivered.

## History Reads

`discord_channel_read_history` accepts an optional exact `channelId`, an
exclusive `before` message cursor, and `limit` from 1 to 25. Results are newest
first. Guild history requires the exact enabled channel or thread; DM history
requires the configured DM policy. The tool returns sanitized stable errors and
bounded output.

## Reply Once

For a Discord-origin request, send through `discord_channel_send`. The first
send creates a durable receipt keyed by the source channel and source message
id. Later automatic continuations for the same source are suppressed even when
they pass the channel explicitly. Use `followup: true` only when a second
Discord message is intentionally required.

Do not answer a Discord-origin request through a generic Discord MCP sender.
That path does not share this plugin's reply receipt and bypasses the one-source
one-reply guard. A new inbound Discord message gets a new receipt identity.

## Guild Reply Audience

With `requireMention: true`, a reply reaches the union of the referenced
author, agents mentioned in the referenced message, and agents explicitly
mentioned in the new reply. Every bot evaluates that union independently after
normal authorization. With `requireMention: false`, mention and reply audience
do not gate otherwise-authorized group messages.
