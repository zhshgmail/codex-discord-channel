# Discord History And Reply Semantics Design

## Goal

Bring the Codex Discord plugin in line with the expected Claude Code behavior:

1. A guild message that directly replies to a message authored by the active bot satisfies `requireMention`, even when the content has no visible mention.
2. Codex can read bounded recent history from an authorized guild channel or DM through a read-only MCP tool.

## Constraints

- Existing channel, sender, and bot allowlists remain authoritative.
- Reply semantics must not accept replies to another user or another bot.
- Discord content is untrusted input and must never be logged by the history path.
- Tokens, proxy values, authorization headers, and raw Discord error objects must not cross the MCP boundary.
- The old `discord-codex-bridge` remains disabled.
- The live `codex01` instance remains bound by its state path and `session-gateway.pid`, not by a per-message session-id gate.

## Chosen Architecture

### Reply As An Implicit Mention

`normalizeDiscordMessage()` records `repliedToAuthorId` only when Discord supplies both a message reference and the referenced author's identity. `decideAccess()` treats the reply as an implicit mention only when that value equals `botUserId`.

The existing decision order remains unchanged:

1. Exact guild channel must be enabled.
2. Bot-authored messages require `allowBots`.
3. `allowFrom` must permit the sender.
4. `requireMention` is satisfied by either a textual/configured mention or a proven reply to the active bot.

Missing/deleted references and replies to any other author fail closed.

### Read-Only History MCP Tool

Add `discord_channel_read_history` with this input:

```json
{
  "channelId": "optional Discord snowflake; defaults to last accepted inbound channel",
  "before": "optional exclusive message snowflake",
  "limit": "optional integer; default 20; range 1-25"
}
```

The tool uses the already authenticated discord.js client. It performs one channel fetch and one bounded message fetch, returns messages newest first, and exposes `nextBefore` plus `hasMore` for pagination. It does not create a local history database.

Authorization is evaluated on every call using the current `access.json`:

- Guild channels and threads require an exact enabled channel ID in `groups`; parent authorization is not inherited.
- DM history is available only when `dmPolicy` is `open` or the counterparty is in global `allowFrom`.
- Guild `allowFrom` and `allowBots` filter returned messages; the active bot's own messages remain visible so conversations are intelligible.
- `requireMention` controls inbound triggering, not which authorized history messages are returned.

Supported targets are DMs, guild text/announcement channels, and explicitly authorized threads. Group DMs, categories, voice channels, and forum containers are rejected.

Results omit embeds, components, reactions, and downloaded attachment bodies. Attachment metadata is bounded. Serialized output is capped at 64 KiB. Stable sanitized errors are:

- `history_target_not_allowed`
- `history_channel_inaccessible`
- `history_fetch_failed`

## Alternatives Rejected

1. **Persist every inbound message locally.** This misses guild messages that never triggered the bot and creates an unnecessary local archive of Discord content.
2. **Add separate raw REST implementations to both MCP and CLI.** This duplicates authentication, retry, and rate-limit handling. The first version is MCP-only and reuses discord.js.
3. **Treat every Discord reply as a mention.** This would allow replies to unrelated users to trigger the bot and violates the channel's mention policy.

## Verification

Automated tests cover reply normalization, access ordering, target authorization, DM policy, pagination, output limits, reference handling, and sanitized failures.

Live `codex01` verification must prove:

1. A direct guild reply to a bot-authored message reaches the current visible Codex console without an explicit mention.
2. A reply to another author remains rejected.
3. Authorized guild history is readable.
4. An inaccessible guild channel returns a sanitized error.
5. DM history is readable after obtaining a real DM channel ID.

MCP tool discovery may require a fresh Codex session after deployment because the current host cannot hot-reload a closed MCP transport. Gateway reply behavior can be verified immediately after restarting `codex-discord-channel@codex01.service`.
