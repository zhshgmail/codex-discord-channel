---
name: codex-discord-channel
description: Use when managing the Claude-style Discord channel plugin for Codex sessions, checking ownership, configuring an instance, or sending Discord messages through the session-owned bot.
---

# Codex Discord Channel

Use this skill when the user wants a Discord bot instance to be owned by the current Codex session.

## Model

- This plugin mirrors Claude Code's Discord channel ownership semantics.
- One process owns one Discord instance through `owner.json`.
- A newer session using the same instance overwrites the owner.
- Accepted inbound Discord messages are persisted in a FIFO queue for the owning session.
- Queue mutations are cross-process serialized, with pending and completed Discord identities deduplicated.
- The current Codex TUI exposes no verifiable composer/modal focus signal, so TTY delivery defaults to queue-only and does not inject raw keystrokes.
- `CODEX_DISCORD_TTY_AUTO_SUBMIT_COMPAT=true` is an explicit operator opt-in
  for immediate legacy delivery. It persists and FIFO-claims first, then sends
  one bracketed-paste-plus-submit frame in one injector process. It cannot
  detect popups, focused widgets, or existing drafts. It requires TTY submit to
  be enabled with a non-empty submit sequence.
- An uncertain prior TTY outcome blocks automatic replay and keeps later items queued for explicit reconciliation.
- Structured app-server delivery into the exact owned thread is the required exact-console migration path; it must omit model and effort overrides.
- In enabled guild channels with `requireMention: true`, reply delivery is the
  union of the referenced author, agents mentioned by the referenced message,
  and agents explicitly mentioned by the new reply. Every bot evaluates this
  union independently; normal channel, sender, and bot gates still apply. When
  `requireMention: false`, reply-audience and mention checks do not gate
  delivery; all otherwise-authorized group messages are accepted.

## Local State

Default state lives under:

```text
$HOME/.codex/channels/discord/<instance>/
```

Expected files:

```text
.env
access.json
owner.json
pending-delivery.json
```

Do not print Discord tokens. Do not commit `.env`.

## Useful Tools

Use the plugin MCP tools when available:

- `discord_channel_status`
- `discord_channel_read_owner`
- `discord_channel_claim_owner`
- `discord_channel_read_history`
- `discord_channel_send`

Receiver health should show `discordStarted: true`. Default fail-closed status
reports `deliverySafety: "queue_only"` and `composerReadinessSignal:
"unavailable"`; inspect `deliveryQueueDepth` and `deliveryBlockedReason` rather
than claiming inbound transcript delivery. Explicit compatibility mode reports
`ttyAutoSubmitCompat: true`, `ttyAutoSubmitEffective: true`,
`deliverySafety: "auto_submit_compat"`, and
`composerReadinessSignal: "operator_opt_in_unverified"`. An invalid submit configuration reports
`deliverySafety: "auto_submit_precondition_failed"` and injects nothing. That
status records accepted risk, not verified TUI focus; visible-console
acceptance still requires an observed Discord-origin smoke.

## History Reads

Use `discord_channel_read_history` for bounded, read-only, idempotent history:

```json
{
  "channelId": "optional channel snowflake; defaults to the last accepted inbound channel",
  "before": "optional exclusive message snowflake cursor",
  "limit": "optional integer from 1 to 25; default 20"
}
```

Results are newest first. Continue with `before: nextBefore` only when
`hasMore` is true. Guild history requires the exact enabled channel or thread
ID; parent authorization is not inherited. DM history requires `dmPolicy:
"open"` or an allowlisted counterparty. Guild sender/bot allowlists filter the
result, except the active bot's own messages stay visible; `requireMention`
does not filter history. Group DMs, categories, voice channels, and forum
containers are disallowed. The tool omits embeds, components, reactions, and
attachment bodies; serialized output is capped at 64 KiB. Handle the sanitized
errors `invalid_history_args`, `history_target_not_allowed`,
`history_channel_inaccessible`, and `history_fetch_failed`; never surface raw
Discord errors.

## New-Session Handoff

After a release is installed, retain the same `codex01` bot and state path
`$HOME/.codex/channels/discord/codex01`; leave
`codex-discord-channel@codex01.service` active. Start a **new** Codex session
instead of expecting a closed MCP transport to hot-reload. In that new session:

1. Call `discord_channel_claim_owner`, then `discord_channel_read_owner`, and
   confirm ownership moved to the new session without changing the instance.
2. Call `discord_channel_status` and confirm the exact-console TTY route and
   Discord startup state are healthy. Immediate delivery additionally requires
   the explicit compatibility diagnostics described above.
3. Close popups and account for any composer draft, then smoke an allowed DM.
   In an allowed group with `requireMention: true`, smoke a guild message, a
   direct reply to this bot, and an inherited reply to a peer message that
   mentioned this bot; each accepted event must appear in the exact visible new
   console. In default mode, verify queue persistence instead.
4. With `requireMention: true`, confirm a peer reply that does not mention this
   bot is rejected unless the current reply explicitly mentions it. In an
   allowed group with `requireMention: false`, confirm all otherwise-authorized
   group messages are accepted, including one with no mention or reply
   audience. Read authorized guild and DM history, paginate it, and verify a
   denied channel has a sanitized error.

Do not report or persist `.env` values, tokens, proxy URLs, or raw Discord
errors. This handoff does not itself authorize deployment or service restart.

If the MCP tools are unavailable, inspect the plugin package at `plugins/codex-discord-channel`.
