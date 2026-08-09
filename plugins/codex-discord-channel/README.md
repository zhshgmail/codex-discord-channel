# Codex Discord Channel Plugin

This directory is the plugin payload for `codex-discord-channel`.

For installation, instance configuration, alias-owned worker startup,
access-policy examples, and the troubleshooting matrix, start with
the repository [README](../../README.md).

Multi-account deployments use one `account.env` per Discord instance. The
repository README documents the independent `CODEX_HOME` and
`DISCORD_CONFIG_DIR` boundaries and the fail-closed worker commands. The
interactive `codex-discord-instance` launcher
can bootstrap a missing isolated OpenAI login only when attached to a TTY;
noninteractive worker paths never prompt and remain fail-closed.

The generic `CODEX_APP_SERVER_URL` is ignored for instance routing. Only the
plugin-specific endpoint or the socket under that instance state directory may
select the Discord delivery target.

## Gateway Message Content Intent

The gateway requests Discord's privileged Message Content intent by default,
preserving existing instances such as `codex01`. For a bot whose Developer
Portal configuration does not enable that intent, set this in the instance
`.env`:

```env
DISCORD_MESSAGE_CONTENT_INTENT=false
```

This omits only `GatewayIntentBits.MessageContent`; Direct Messages, Guilds,
and Guild Messages remain enabled. It does not relax sender, bot, channel,
thread, or mention access checks. Use this mode for guild channel and thread
policies with `requireMention: true`: Discord can expose mention-directed
messages without the privileged intent, while unmentioned guild messages are
still denied by the plugin and must not be expected to provide usable content.

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

The gateway dynamically resolves the current top-level loaded TUI thread and
tracks thread rotation plus active turn identity. It sends at most one FIFO item
per drain: `turn/start` for an idle target or a top-level target whose previous
turn ended in `systemError`, or `turn/steer` with an exact active turn
precondition when a goal continuation or other turn is already running.
Unknown active-turn identity remains `thread_busy`. Turn payloads omit model,
reasoning effort, service tier, personality, cwd, sandbox, and approval
overrides; Discord metadata is carried only in the sanitized text envelope.
Every positive acknowledgement is read back from the exact thread by the
echoed client user message id before completion. A response without a persisted
user item remains `structured_ack_uncertain`, so the gateway does not report a
false completion. The item moves to a visible fail-closed reconciliation lane; later FIFO
items continue. Expiry schedules another exact proof check but never authorizes
another `turn/start` call.

`pending-delivery.json` uses a durable activation id and timestamp. The id
defaults to the real installed plugin root. A new versioned install archives
legacy, mismatched, pre-activation queued, and delayed pre-activation Discord
events before target resolution, retaining only their Discord identity and
timestamps for deduplication. A restart of the same installed runtime may
recover matching post-activation items. `CODEX_DISCORD_DELIVERY_ACTIVATION_ID`
can set an explicit activation boundary for standalone workers when deployment
paths are not versioned. The alias-owned launcher instead pins every channel
and TUI child to the real root of its own installed plugin, so a stale instance
`.env` override cannot preserve an older activation across a marketplace
upgrade.

The standalone gateway checks the durable queue periodically as well as on
app-server recovery events. A nonempty blocked queue retries with exponential
backoff from 1 second to a 30-second maximum, and each tick re-verifies the
durable PID/generation receiver authority before resolving the structured
target. `owner.json` and volatile thread/session ids never gate these retries.
The bounds are configurable with `CODEX_DISCORD_QUEUE_DRAIN_INTERVAL_MS` and
`CODEX_DISCORD_QUEUE_DRAIN_MAX_BACKOFF_MS`. Uncertain-item proof rechecks use
`CODEX_DISCORD_UNCERTAIN_RETRY_BASE_MS` and
`CODEX_DISCORD_UNCERTAIN_RETRY_MAX_MS` (5 seconds and 5 minutes by default).
These legacy-named settings never authorize replaying `turn/start`.
`CODEX_DISCORD_GATEWAY_HEALTH_STALE_MS` controls the receiver heartbeat expiry
(3 minutes by default).

If the shared endpoint or exact current thread is unavailable, the queue stays
persisted and status reports a stable reason such as
`shared_app_server_socket_missing`, `shared_app_server_no_loaded_thread`, or
`shared_app_server_thread_ambiguous`. There is no terminal fallback.

The receiver atomically writes `gateway-health.json`. Status verifies its
PID/generation against `session-gateway.pid` and reports MCP-local Discord login
separately, so an auxiliary MCP process cannot be mistaken for the active
receiver. Queue health is explicit as `idle`, `queued`, `blocked`, `degraded`,
or `unreadable`; degraded status includes the oldest uncertain message id,
attempt count, and retry time without exposing message content.

When no live receiver exists, Discord login, durable queue readiness, and an
armed listener are sufficient to claim reception; target delivery reconnects
later. A live-receiver takeover also requires target readiness before its one
atomic authority commit.

The legacy and current listeners can both remain eligible during that staged
handoff. Queue locking and Discord identity deduplication are therefore the
exactly-once boundary until every running gateway uses the current format. The
current reader prefers `.v2`, so legacy cleanup cannot remove successor
authority.

The visible TUI must be relaunched through
`codex-discord-instance INSTANCE resume --last`, which starts the matching
app-server, gateway, and remote TUI from one installed cache generation. A
direct `codex ... resume` process cannot be verified from this plugin. See the repository
[Structured Delivery Contract](../../docs/structured-delivery.md) for the full
migration and acceptance boundary. User-visible failure signatures and
diagnostic steps are recorded in
[Known Issues And Operational Boundaries](../../docs/known-issues.md).

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
