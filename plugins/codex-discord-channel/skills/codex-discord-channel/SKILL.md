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
- The plugin does not use TTY injection.
- Until Codex exposes a native channel notification API, inbound Discord messages are normalized but not pushed into the active host transcript.

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
```

Do not print Discord tokens. Do not commit `.env`.

## Useful Tools

Use the plugin MCP tools when available:

- `discord_channel_status`
- `discord_channel_read_owner`
- `discord_channel_claim_owner`
- `discord_channel_send`

If the MCP tools are unavailable, inspect the plugin package at `plugins/codex-discord-channel`.
