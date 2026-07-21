# Codex Discord Channel Plugin

This directory is the plugin payload for `codex-discord-channel`.

## Runtime Contract

The Discord gateway is identified by the configured instance state directory
and one atomic PID-plus-generation authority record in `session-gateway.pid`.
Pure current-version handoffs use JSON. A staged takeover from a legacy gateway
leaves that gateway's PID and `.generation` files unchanged and stores the
current receiver CAS in `session-gateway.pid.v2`. `owner.json` is status and
handoff metadata; it is not a per-message receive gate and may change after
`/clear` without replacing the gateway.

Access-approved Discord messages are atomically persisted to
`pending-delivery.json`, cross-process locked, and deduplicated by Discord
channel and message id. Inbound delivery uses only a shared app-server endpoint.
The default is `unix://<state-dir>/app-server.sock`; an explicit
`CODEX_DISCORD_APP_SERVER_URL` may use `unix://`, `ws://`, or `wss://`.

The gateway dynamically resolves the current top-level loaded TUI thread,
tracks `thread/started` rotation, queues while the thread is active, and sends
at most one FIFO item per drain that proves the thread idle with `turn/start`.
Turn payloads omit model, reasoning effort, service tier, personality, cwd,
sandbox, and approval overrides; Discord metadata is carried only in the
sanitized text envelope. Lost acknowledgements are reconciled by the echoed
client user message id before completion, so the gateway does not replay
speculatively.

The standalone gateway checks the durable queue periodically as well as on
app-server recovery events. A nonempty blocked queue retries with exponential
backoff from 1 second to a 30-second maximum, and each tick re-verifies the
durable PID/generation receiver authority before resolving the structured
target. `owner.json` and volatile thread/session ids never gate these retries.
The bounds are configurable with `CODEX_DISCORD_QUEUE_DRAIN_INTERVAL_MS` and
`CODEX_DISCORD_QUEUE_DRAIN_MAX_BACKOFF_MS`.

If the shared endpoint or exact current thread is unavailable, the queue stays
persisted and status reports a stable reason such as
`shared_app_server_socket_missing`, `shared_app_server_no_loaded_thread`, or
`shared_app_server_thread_ambiguous`. There is no terminal fallback.

When no live receiver exists, Discord login, durable queue readiness, and an
armed listener are sufficient to claim reception; target delivery reconnects
later. A live-receiver takeover also requires target readiness before its one
atomic authority commit.

The legacy and current listeners can both remain eligible during that staged
handoff. Queue locking and Discord identity deduplication are therefore the
exactly-once boundary until every running gateway uses the current format. The
current reader prefers `.v2`, so legacy cleanup cannot remove successor
authority.

The installed `codex-discord-session` shim starts or reuses the state-path
app-server and launches the future visible TUI with `--remote` against that
same endpoint. It does not hot-adopt a currently running TUI, and a direct
`codex ... resume` process cannot be verified from this plugin. See the repository
[Structured Delivery Contract](../../docs/structured-delivery.md) for the full
migration and acceptance boundary.

## Installed Runtime

`.mcp.json` invokes `node ./runtime/mcp-server.cjs` from the installed plugin
root and asks Codex to pass through `CODEX_HOME`, `DISCORD_INSTANCE`, and
`DISCORD_STATE_DIR` from the gateway/session environment. The executable shims
are dependency-free loaders for `runtime/channel-cli.cjs`. Both committed
bundles include `ws`, `discord.js`, and `undici`; only `node:*` modules remain
external. `THIRD_PARTY_NOTICES.txt` retains their required license notices.

Marketplace installation copies those files directly. It runs no `npm install`
and no lifecycle hooks, and the installed cache contains no `node_modules`.
`npm` and esbuild are required only to change and regenerate the committed
runtime during development.

To start or resume a future shared session:

```bash
DISCORD_INSTANCE=codex01 codex-discord-session resume <THREAD_ID>
```

For an isolated state path, `codex-discord-channel gateway-probe` performs a
bounded `thread/loaded/list` and `thread/read` check. The explicit
`--exercise-turn` option also calls `turn/start`; it is intended for isolated
acceptance environments, not passive live diagnostics.

## Checks

```bash
npm ci
npm run build:runtime
npm run check
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

`npm run build:check` fails when either committed bundle is stale or retains a
non-`node:*` external import.

## Import Existing Bridge State

```bash
npm run import:bridge -- --instance codex01 --fetch-bot-id
```

The import reuses the existing `.env` and converts access state without
printing token values.
