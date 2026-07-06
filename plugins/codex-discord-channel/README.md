# Codex Discord Channel Plugin

This package is the Codex plugin payload for `codex-discord-channel`.

It mirrors the Claude Code Discord plugin ownership model for local Codex TUI sessions: the MCP server claims one Discord bot instance for the current session, keeps ownership in `owner.json`, and delivers accepted inbound Discord messages into the owning terminal session.

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

Inbound Discord messages are normalized, access-checked, and handed to the delivery boundary. The default `tty` delivery mode injects a prompt into the active Codex terminal. If Codex later exposes a native channel notification API, that can replace the TTY delivery adapter without changing Discord access or ownership logic.

Useful local `.env` delivery keys:

```env
CODEX_DISCORD_DELIVERY_MODE=tty
# Optional explicit target. If unset, the plugin uses the parent Codex process TTY.
# CODEX_DISCORD_TTY=/dev/pts/7
CODEX_DISCORD_TTY_USE_SUDO=true
CODEX_DISCORD_TTY_PROMPT_FORMAT=minimal
```
