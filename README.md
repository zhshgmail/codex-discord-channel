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
