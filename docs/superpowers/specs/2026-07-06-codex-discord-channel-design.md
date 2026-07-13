# Codex Discord Channel Design

> Safety update (2026-07-13): automatic TTY injection is superseded by the fail-closed queue described in [`docs/tty-delivery-safety.md`](../../tty-delivery-safety.md).

## Goal

Build a new Codex plugin project that matches the user-visible behavior of the Claude Code Discord channel plugin: a running console session owns a Discord bot, accepted Discord messages are delivered into that active session, and a newly started session can take over the bot's responsibility.

## Non-Goals

- Do not run as a long-lived background systemd bridge by default.
- Do not replace Codex host internals or assume Codex supports Claude's experimental `claude/channel` notification extension.
- Do not print, commit, or copy Discord bot tokens into docs or logs.

## Architecture

Codex does not currently expose a confirmed `--channels` host API equivalent to Claude Code's Discord plugin. The plugin therefore provides a session-local MCP server plus session owner state. The MCP server connects to Discord Gateway, filters access using a Claude-compatible `access.json`, records a single active owner for the selected bot instance, and persistently queues accepted inbound messages while no verifiable delivery API exists.

The delivery adapter is a bounded interface so a future native Codex channel API can replace the current TTY delivery path without rewriting Discord or access logic.

## Project Layout

```text
codex-discord-channel/
├── .agents/plugins/marketplace.json
├── docs/superpowers/specs/2026-07-06-codex-discord-channel-design.md
├── docs/superpowers/plans/2026-07-06-codex-discord-channel.md
└── plugins/codex-discord-channel/
    ├── .codex-plugin/plugin.json
    ├── .mcp.json
    ├── package.json
    ├── README.md
    ├── bin/codex-discord-channel
    ├── scripts/smoke.js
    ├── skills/codex-discord-channel/SKILL.md
    ├── src/
    │   ├── access-state.js
    │   ├── config.js
    │   ├── discord-client.js
    │   ├── delivery.js
    │   ├── mcp-server.js
    │   ├── owner-state.js
    │   └── paths.js
    └── tests/unit/
        ├── access-state.test.js
        ├── config.test.js
        ├── delivery.test.js
        └── owner-state.test.js
```

## Behavior

Each bot instance stores local state under `$HOME/.codex/channels/discord/<instance>` unless `DISCORD_STATE_DIR` is set. The state directory contains `.env`, `access.json`, and `owner.json`. `.env` stores local runtime configuration and is never required to be committed. `access.json` follows Claude's model: DMs are pair/allowlisted, guild channels must be enabled, and guild messages require a mention unless disabled per channel.

When the MCP server starts, it claims the selected instance by writing `owner.json` with the process id, host, project cwd, and startup time. A later session using the same instance overwrites that owner file. The server checks ownership before processing inbound messages; stale processes stop accepting work once another process owns the instance.

Inbound Discord messages are normalized into a `<channel source="discord">` envelope. The delivery boundary returns an explicit `delivered`, `queued`, `failed`, or `unsupported` result. The legacy TTY adapter remains behind that boundary, but the shipping runtime has no verifiable composer-ready signal and therefore keeps accepted messages queued rather than inserting raw keystrokes.

## Error Handling

Missing Discord token fails fast with a clear message pointing at the instance `.env` path. Invalid `access.json` fails closed. If ownership cannot be written, startup fails. If another active owner supersedes this process, inbound messages are ignored and the server exits cleanly when possible.

## Tests

Unit tests cover access decisions, path/config resolution, owner claim and supersede logic, TTY detection, and delivery envelope/TTY prompt formatting. The smoke check validates plugin manifest shape, MCP config, executable entrypoint, and syntax.
