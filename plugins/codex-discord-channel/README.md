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

The visible TUI must be relaunched with `codex --remote <same-endpoint> ...`
after a shared app-server is started. A direct `codex ... resume` process cannot
be verified from this plugin. See the repository
[Structured Delivery Contract](../../docs/structured-delivery.md) for the full
migration and acceptance boundary.

## Checks

```bash
npm install
npm run check
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

## Import Existing Bridge State

```bash
npm run import:bridge -- --instance codex01 --fetch-bot-id
```

The import reuses the existing `.env` and converts access state without
printing token values.
