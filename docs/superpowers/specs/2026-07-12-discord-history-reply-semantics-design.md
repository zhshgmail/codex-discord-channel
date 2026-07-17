# Discord History And Reply Semantics Design

## Goal

Bring the Codex Discord plugin in line with the expected Claude Code behavior:

1. A guild reply satisfies `requireMention` for every bot in the union of the referenced message author, bots mentioned by the referenced message, and bots explicitly mentioned by the current message.
2. Codex can read bounded recent history from an authorized guild channel or DM through a read-only MCP tool.

## Constraints

- Existing channel, sender, and bot allowlists remain authoritative.
- Reply propagation must target only the referenced author, agents mentioned by the referenced message, and agents explicitly mentioned by the current message.
- Discord content is untrusted input and must never be logged by the history path.
- Tokens, proxy values, authorization headers, and raw Discord error objects must not cross the MCP boundary.
- The old `discord-codex-bridge` remains disabled.
- The live `codex01` instance remains bound by its state path and `session-gateway.pid`, not by a per-message session-id gate.

## Chosen Architecture

### Reply As An Implicit Mention

For an enabled guild channel, the Discord client resolves the referenced message through discord.js. `normalizeDiscordMessage()` records the referenced author's ID and content only when that lookup succeeds. `decideAccess()` considers the active bot mentioned when any of these predicates is true:

1. The current message text or configured mention patterns mention the active bot.
2. The referenced message author ID equals the active bot ID.
3. The referenced message text or configured mention patterns mention the active bot.

This is evaluated independently by every bot instance. For example, when Agent A writes one message mentioning the user, Codex, and Agent B, a user reply to that message is delivered to Agent A as the referenced author and to Codex/Agent B as referenced-message mention targets. Additional agents explicitly mentioned in the reply also receive it.

The existing decision order remains unchanged:

1. Exact guild channel must be enabled.
2. Bot-authored messages require `allowBots`.
3. `allowFrom` must permit the sender.
4. `requireMention` is satisfied by either a textual/configured mention or a proven reply to the active bot.

Missing, deleted, or inaccessible references do not contribute an implicit audience. The current message's explicit mentions still work, while reference-derived delivery fails closed.

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
2. A reply to a peer-authored message that mentioned Codex reaches Codex without a new explicit mention.
3. A reply to a peer-authored message that did not mention Codex remains rejected unless the current reply explicitly mentions Codex.
4. Authorized guild history is readable.
5. An inaccessible guild channel returns a sanitized error.
6. DM history is readable after obtaining a real DM channel ID.

MCP tool discovery may require a fresh Codex session after deployment because the current host cannot hot-reload a closed MCP transport. Gateway reply behavior can be verified immediately after restarting `codex-discord-channel@codex01.service`.
