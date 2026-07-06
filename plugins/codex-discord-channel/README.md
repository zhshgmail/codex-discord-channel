# Codex Discord Channel Plugin

This package is the Codex plugin payload for `codex-discord-channel`.

It mirrors the Claude Code Discord plugin ownership model as closely as Codex currently allows: the MCP server claims one Discord bot instance for the current session, keeps ownership in `owner.json`, and refuses to use TTY injection.

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

Inbound Discord messages are normalized, access-checked, and handed to the delivery boundary. Codex does not currently provide a Claude-style host notification API, so the plugin does not promise automatic Discord-to-transcript delivery.
