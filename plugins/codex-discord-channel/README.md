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
