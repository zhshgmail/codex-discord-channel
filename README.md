# Codex Discord Channel

Standalone Codex plugin project for Claude-style Discord session ownership.

The plugin lives at `plugins/codex-discord-channel` and is exposed through the repo-local marketplace at `.agents/plugins/marketplace.json`.

## What It Does

- Claims one active owner for a Discord bot instance when the MCP server starts.
- Stores local state under `$HOME/.codex/channels/discord/<instance>` by default.
- Uses a Claude-compatible access model for DMs and guild channels.
- Delivers accepted Discord messages into the owning interactive Codex session terminal.
- Exposes MCP tools for status, owner claim/read, bounded history reads, and Discord send.

### Guild Reply Audience

For an enabled guild channel with `requireMention: true`, a reply is an
implicit mention only for the union of: the referenced message author, bot
agents explicitly mentioned in the referenced message, and bot agents
explicitly mentioned in the new reply. Each agent evaluates that union
independently. Therefore a reply to a peer's message reaches `codex01` only
when the peer's message mentioned `codex01` or the new reply explicitly
mentions it. Missing, deleted, or inaccessible references add no implicit
audience. Existing channel, sender, and bot checks still apply. When
`requireMention: false`, reply-audience and mention checks do not gate delivery;
all otherwise-authorized group messages are accepted.

### Bounded History

`discord_channel_read_history` is a read-only, idempotent MCP tool that reads
recent messages from the authenticated Discord client without creating a local
archive. Its strict input is:

```json
{
  "channelId": "optional Discord channel snowflake; defaults to last accepted inbound channel",
  "before": "optional exclusive message snowflake cursor",
  "limit": "optional integer from 1 to 25; defaults to 20"
}
```

Messages are newest first. Use `nextBefore` with `before` when `hasMore` is
true. Guild history requires the exact channel or thread ID in `groups`; parent
authorization is never inherited. DM history requires `dmPolicy: "open"` or
an allowlisted counterparty. Guild `allowFrom` and `allowBots` filter returned
messages, while the active bot's own messages remain visible. `requireMention`
does not filter history. Group DMs, categories, voice channels, and forum
containers are rejected. Results omit embeds, components, reactions, and
attachment bodies; output is bounded to 64 KiB. Stable sanitized errors include
`invalid_history_args`, `history_target_not_allowed`,
`history_channel_inaccessible`, and `history_fetch_failed`; raw Discord errors
are not exposed.

Codex does not currently expose a confirmed Claude-style host channel notification API. Until that exists, this plugin uses a session-local TTY delivery path so the active terminal session receives accepted DM messages and guild messages according to the configured group access policy.

## Local Install

```bash
codex plugin marketplace add /home/zheng/workspace/a5/a5_codex/codex-discord-channel
codex plugin add codex-discord-channel@personal
```

Use a new Codex thread after installing so the plugin MCP server is loaded.

## Fresh-Session Handoff And Smoke

This is a release-time procedure, not a request to deploy or restart anything
from this checkout. Keep the same `codex01` bot and state path
`$HOME/.codex/channels/discord/codex01`. Leave
`codex-discord-channel@codex01.service` active; do not create a second gateway,
change `DISCORD_INSTANCE`, or restart the gateway merely to open the new
session.

1. Install the released plugin, then close the current Codex thread and start a
   **new** Codex session. A closed MCP transport cannot discover the new tool in
   place.
2. In that new session, call `discord_channel_claim_owner`, then
   `discord_channel_read_owner`, and confirm the reported owner is the new
   session while its instance and state path remain `codex01`.
3. Call `discord_channel_status`; confirm `deliveryMode: "tty"`, a configured
   TTY, and `discordStarted: true`. The systemd gateway must still be active.
4. In a real allowed DM, send a message and confirm it reaches the visible new
   Codex console. In an allowed guild channel with `requireMention: true`,
   verify a direct reply to a `codex01` message reaches that console without a
   new mention.
5. With `requireMention: true`, verify an inherited reply: reply to a peer
   message that mentioned `codex01` and confirm delivery. Also confirm a reply
   to a peer message that did not mention `codex01` is rejected unless the
   reply explicitly mentions it. In an allowed group with `requireMention:
   false`, verify that all otherwise-authorized group messages are accepted,
   including one with no mention or reply audience.
6. Call `discord_channel_read_history` for an authorized guild channel and a
   real DM channel. Verify cursor pagination using `nextBefore`, and verify an
   inaccessible channel returns only its stable sanitized error.

Record non-secret evidence only, such as tool names, message IDs, the owner
instance, and status booleans. Never record `.env` values, tokens, proxy URLs,
or raw Discord errors.

## Usage

After starting a new Codex session, ask for the channel status:

```text
Use $codex-discord-channel to show status.
```

Expected healthy status:

```json
{
  "instance": "codex01",
  "tokenConfigured": true,
  "proxyConfigured": true,
  "deliveryMode": "tty",
  "discordStarted": true
}
```

Send a message through the owned bot:

```text
Use $codex-discord-channel to send "..." to channel <discord-channel-id>.
```

If `discordStarted` is false, check `discordReason`, `envLoaded`, `proxyConfigured`, and `insecureTls` in the status output. The status intentionally reports only booleans and paths, never token or proxy values.

Inbound delivery requires an interactive Codex terminal. The status output reports `deliveryMode`, `ttyConfigured`, `ttyPidConfigured`, `ttyUseSudo`, and `ttyPromptFormat` so routing failures are visible without printing secrets.

## Instance Config

Default instance state:

```text
$HOME/.codex/channels/discord/default/.env
$HOME/.codex/channels/discord/default/access.json
$HOME/.codex/channels/discord/default/owner.json
```

Example `.env`:

```env
DISCORD_INSTANCE=codex01
DISCORD_BOT_TOKEN=replace-with-local-token
DISCORD_BOT_USER_ID=replace-with-bot-user-id
DISCORD_PROXY_URL=http://127.0.0.1:8080
DISCORD_INSECURE_TLS=true
CODEX_DISCORD_DELIVERY_MODE=tty
# Optional explicit route; normally the plugin uses the parent Codex process TTY.
# CODEX_DISCORD_TTY=/dev/pts/7
```

Do not commit `.env`.

## Validation

```bash
cd plugins/codex-discord-channel
npm install
npm run check
python3 /home/zheng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

## Import Existing Bridge State

After the package checks pass, import an existing `discord-codex-bridge` instance:

```bash
cd plugins/codex-discord-channel
npm run import:bridge -- --instance codex01 --fetch-bot-id
```

This reuses the existing `.env`, converts `state.json` into `access.json`, and writes `DISCORD_BOT_USER_ID` when Discord confirms the bot identity. The script never prints the token.
