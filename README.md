# Codex Discord Channel

Standalone Codex plugin project for Claude-style Discord session ownership.

The plugin lives at `plugins/codex-discord-channel` and is exposed through the repo-local marketplace at `.agents/plugins/marketplace.json`.

## What It Does

- Claims one active owner for a Discord bot instance when the MCP server starts.
- Stores local state under `$HOME/.codex/channels/discord/<instance>` by default.
- Uses a Claude-compatible access model for DMs and guild channels.
- Avoids TTY injection entirely.
- Exposes MCP tools for status, owner claim/read, and Discord send.

Codex does not currently expose a confirmed Claude-style host channel notification API. Until that exists, inbound Discord messages are normalized at the delivery boundary and reported as `unsupported` instead of being silently injected into a terminal.

## Local Install

```bash
codex plugin marketplace add /home/zheng/workspace/a5/a5_codex/codex-discord-channel
codex plugin add codex-discord-channel@personal
```

Use a new Codex thread after installing so the plugin MCP server is loaded.

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
  "discordStarted": true
}
```

Send a message through the owned bot:

```text
Use $codex-discord-channel to send "..." to channel <discord-channel-id>.
```

If `discordStarted` is false, check `discordReason`, `envLoaded`, `proxyConfigured`, and `insecureTls` in the status output. The status intentionally reports only booleans and paths, never token or proxy values.

Current limitation: inbound Discord messages can be filtered and normalized by the plugin, but Codex does not yet provide a host API that lets an MCP server push those messages into the active transcript. This means Discord-to-console auto delivery is not the same as Claude Code's channel integration yet.

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
