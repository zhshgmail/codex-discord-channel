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
$HOME/.codex/channels/discord/<instance>/gateway-health.json
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

Inspect `runtimeStatusSource`, `gatewayLive`, `deliveryState`,
`deliveryQueueDepth`, `deliveryUncertainCount`, `deliveryDegradedReason`, and
`sharedAppServerReason` before making delivery claims. Stable unavailable
reasons include a missing endpoint/socket, no loaded thread, an ambiguous
thread, a busy thread, and uncertain structured acknowledgement.
Top-level receiver and structured-delivery status comes only from the durable
gateway health record. MCP-local Discord login is a separate diagnostic and is
never receiver-health evidence.

## Alias-Owned Runtime Boundary

A direct `codex ... resume` TUI has a private embedded app-server and cannot be
joined by the gateway. Exact-console delivery requires one operator-approved
whole-alias relaunch:

1. Install the released plugin through that account's configured marketplace.
2. Verify the account binding and alias point at the same versioned cache.
3. Exit only that alias and relaunch it with
   `codex-discord-instance INSTANCE resume --last`.
4. Verify an allowed Discord-origin turn in the exact visible TUI, then repeat
   after `/clear`.

The launcher owns the matching app-server, gateway, and TUI as one generation.
Do not start workers separately, register systemd units, copy a development
checkout, or claim live ownership without exact-console evidence. Repository
tests prove the delivery contract, not the live process migration.

## Delivery Contract

The gateway resolves the current thread for each queued item. A fresh endpoint
must expose one provable top-level loaded thread. The latest top-level
`thread/started` notification replaces it after thread rotation. Subagents are
never targets.

Each drain accepts at most one ready FIFO head. Idle targets and proven top-level
`systemError` targets use `turn/start`; active targets use `turn/steer` only with
an exact turn id observed from app-server notifications or recovered from
`thread/read` during startup and reconnect.
Unknown or ambiguous active-turn identity remains `thread_busy`, while a new
`turn/started` notification wakes the serialized drain. Requests omit model,
reasoning effort, service tier, personality, cwd, sandbox, permissions,
collaboration mode, and approval overrides.

Every positive acknowledgement is read back from the exact target thread. A
positive RPC response without that user item moves into the visible uncertain
reconciliation lane and must not be described as delivered. Later ready items
continue, but expiry only schedules another proof check; it never authorizes a
second `turn/start` call.

The exact top-level thread binding is durable across idle and active gateway
restarts, but active turn ids are never persisted. Restart recovery rereads the
bound thread before choosing start versus steer. `gateway-health.json` is the
receiver truth; MCP-local login state is diagnostic only.

## History Reads

`discord_channel_read_history` accepts an optional exact `channelId`, an
exclusive `before` message cursor, and `limit` from 1 to 25. Results are newest
first. Guild history requires the exact enabled channel or thread; DM history
requires the configured DM policy. The tool returns sanitized stable errors and
bounded output.

## Reply Once

For a Discord-origin request, send through `discord_channel_send` with the exact
source `channelId` and `replyTo`. The sender does not infer either identity from
`last-inbound.json`. Before the network send it fsyncs a recoverable `in_flight`
receipt keyed by that source identity under a per-source cross-process lock.
The request uses a deterministic enforced nonce. Success is terminal only after
any nonce in the create-message response matches and the returned message id is
read back with that exact id, channel, source reply, content, and bot identity.
Discord may omit nonce from the later GET.
If the response returns an id with a conflicting nonce, the receipt preserves
that id as permanently uncertain and suppresses both reconciliation and replay.

An interrupted send is reconciled by recorded message id or any available
stable nonce identity. A same-nonce retry is allowed only when no message id was
returned and the bounded enforcement window is still open; nonce enforcement
must deduplicate that replay. Otherwise uncertainty remains fail-closed.
Confirmed replies suppress later automatic continuations. Use `followup: true`
only when a second Discord message is intentionally required.

Do not answer a Discord-origin request through a generic Discord MCP sender.
That path does not share this plugin's reply receipt and bypasses the one-source
one-reply guard. A new inbound Discord message gets a new receipt identity.

## Guild Reply Audience

With `requireMention: true`, an otherwise-authorized guild message is accepted
only when the current message directly mentions the bot, Discord marks the
current message as `@everyone` or `@here`, or the current message directly
replies to that bot's own message. A reply to a peer does not inherit mentions
from the referenced message. Literal broadcast lookalikes do not count as
Discord broadcast metadata. With `requireMention: false`, mention and reply
audience do not gate otherwise-authorized guild messages.
