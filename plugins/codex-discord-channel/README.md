# Codex Discord Channel Plugin

This package is the Codex plugin payload for `codex-discord-channel`.

It mirrors the Claude Code Discord plugin ownership model for local Codex TUI sessions: the MCP server claims one Discord bot instance for the current session, keeps ownership in `owner.json`, and persistently queues accepted inbound Discord messages for safe delivery.

## Checks

```bash
npm install
npm run check
python3 /home/zheng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

## Import Existing Bridge State

```bash
npm run import:bridge -- --instance codex01 --fetch-bot-id
```

The import script converts an existing bridge `state.json` to `access.json` and reuses the existing `.env` without printing token values.

## Runtime Notes

Healthy status should report `tokenConfigured: true`, `proxyConfigured: true` when a proxy is needed, and `discordStarted: true`.

The status tool exposes only non-secret diagnostics. It may show `discordReason`, `envLoaded`, `proxyConfigured`, `insecureTls`, and `loginDisabled`, but it must not print token or proxy values.

Inbound Discord messages are normalized, access-checked, and atomically persisted to `pending-delivery.json`. Queue mutations are locked across processes and deduplicated by Discord channel and message id. Codex CLI 0.144.1 does not export a verifiable composer/modal focus signal, so the shipping `tty` runtime is deliberately queue-only and performs no raw-key injection. The receiver never calls or waits on the internal drain seam. It logs blocked delivery at `ERROR` and exposes non-secret queue diagnostics through the status tool. Any ambiguous prior TTY outcome permanently blocks automatic replay until it is explicitly reconciled.

The required migration is structured app-server delivery into the exact owned thread, with model and effort overrides omitted. Until the visible TUI and plugin can prove they share that endpoint and thread, queued messages must remain pending. See the repository's `docs/tty-delivery-safety.md`.

Useful local `.env` delivery keys:

```env
CODEX_DISCORD_DELIVERY_MODE=tty
# Reserved for a future verified-readiness adapter; current runtime remains queue-only.
# CODEX_DISCORD_TTY=/dev/pts/7
CODEX_DISCORD_TTY_USE_SUDO=true
CODEX_DISCORD_TTY_PROMPT_FORMAT=minimal
```

## Reply Audience

In an enabled guild channel with `requireMention: true`, a reply produces an
implicit mention audience that is the union of the referenced message author,
agents mentioned by the referenced message, and agents explicitly mentioned by
the new reply. Each bot evaluates that audience for itself after the normal
channel, sender, and bot gates. A reply to an unrelated peer remains rejected
unless the peer message or the reply itself mentions this bot. A missing,
deleted, or inaccessible reference contributes no implicit audience. When
`requireMention: false`, reply-audience and mention checks do not gate delivery;
all otherwise-authorized group messages are accepted.

## History Tool

`discord_channel_read_history` is read-only and idempotent. It accepts only:

```json
{
  "channelId": "optional channel snowflake; defaults to the last accepted inbound channel",
  "before": "optional exclusive message snowflake",
  "limit": "optional integer 1-25; default 20"
}
```

It returns newest-first messages and `hasMore`/`nextBefore` pagination. Guild
reads require the exact enabled channel or thread ID in `access.json`; a parent
channel does not authorize a thread. DM reads require `dmPolicy: "open"` or an
allowlisted counterparty. Guild `allowFrom` and `allowBots` filter messages,
but this bot's own messages are retained; `requireMention` does not filter
history. Unsupported targets, including group DMs, categories, voice channels,
and forum containers, are rejected. Output excludes embeds, components,
reactions, and attachment bodies and is limited to 64 KiB. Stable sanitized
history errors exposed to MCP clients include `invalid_history_args`,
`history_target_not_allowed`, `history_channel_inaccessible`, and
`history_fetch_failed`.

## Fresh Codex Session Smoke

Run this only after a released package has been installed. Do not deploy,
restart, or alter the live gateway as part of these documentation checks.

1. Preserve the `codex01` bot, `$HOME/.codex/channels/discord/codex01` state
   path, and active `codex-discord-channel@codex01.service` gateway.
2. Start a **new** Codex session, because a closed MCP transport does not
   rediscover tools in the old session.
3. In the new session call `discord_channel_claim_owner`,
   `discord_channel_read_owner`, and `discord_channel_status`. Confirm the
   owner now identifies the new session, `deliveryMode` is `tty`, its TTY is
   configured, and Discord is started.
4. Smoke an allowed DM. In an allowed group with `requireMention: true`, smoke
   an allowed guild message, a direct reply to this bot, and an inherited reply
   to a peer message that mentioned this bot. Confirm each accepted input
   reaches the exact visible new Codex console.
5. With `requireMention: true`, confirm a peer reply that neither references
   nor explicitly mentions this bot stays rejected. In an allowed group with
   `requireMention: false`, confirm all otherwise-authorized group messages are
   accepted, including a message with no mention or reply audience. Read
   authorized guild and DM history, paginate with `nextBefore`, and confirm a
   denied channel returns a sanitized stable error.

Capture only non-secret evidence: message IDs, tool results, owner instance,
and status booleans. Do not expose `.env` values, token values, proxy URLs, or
raw Discord errors.
