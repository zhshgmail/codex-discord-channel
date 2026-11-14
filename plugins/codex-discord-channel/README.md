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

## Codex 0.154 remote resume

The instance launcher preserves `resume --last` as a resume. With an explicit
`--dangerously-bypass-approvals-and-sandbox` (or `--yolo`), it applies that policy
to the native TUI's first successful thread start, resume, or fork request.
This avoids Codex 0.154's rejection of permission flags on a remote resume.
The native TUI still selects the session; the plugin neither selects a second
session nor stores its ID. At most one request can carry the override while its
reply is pending, across all relay connections. Concurrent requests pass through
with their own settings. Success consumes the override; only an explicit error
for that same request and connection permits another attempt, including a retry
that reuses the client RPC ID. Each override attempt has a one-use backend wire
ID; the current reply restores the client ID, and retired replies are dropped.
A request that duplicates a pending client ID or collides with that connection's
private wire-ID namespace closes the connection pair as ambiguous. Server
requests, notifications and client replies retain their original IDs. An ambiguous
disconnect keeps it consumed for the rest of the invocation. Later permission
changes and reconnects retain the user's current settings. Gateway requests
pass through unchanged.
App-server configuration defaults remain unchanged. An invocation without a
YOLO flag explicitly disables this forwarding, including when the shell carries
a marker from an earlier invocation; Discord or account files cannot enable it.

Only invocations requesting YOLO use this Unix-socket relay. Both relay and
native app server remain in the launcher's existing app process group, with
bounded shutdown and preservation of a replaced public socket.
The relay limits its connecting queue and each open socket's buffered sends to
16 MiB. Exceeding the limit closes the affected connection pair and clears its
queue; other clients remain connected.

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
Compatible current-version handoffs use JSON and bind both the queue-lock
protocol and normalized persistent lock pathname. A live record with a missing
or different binding must be quiesced before its successor logs in or accesses
the queue. `owner.json` is status and handoff metadata; it is not a per-message
receive gate and may change after `/clear` without replacing the gateway.

Access-approved Discord messages are atomically persisted to
`pending-delivery.json`, cross-process locked, and deduplicated by Discord
channel and message id. Inbound delivery uses only a shared app-server endpoint.
The default is `unix://<state-dir>/app-server.sock`; an explicit
`CODEX_DISCORD_APP_SERVER_URL` may use `unix://`, `ws://`, or `wss://`.

`DISCORD_STATE_DIR` is the durable bot identity. On every delivery the gateway
asks the state-directory-owned app-server for its current loaded top-level TUI
and uses the returned thread/turn only as a transient RPC coordinate. It never
persists a session/thread/turn as ownership, authentication, receive, replay, or
restart authority. `/clear`, resume, TUI replacement, and gateway replacement
therefore do not change which Discord queue the instance owns.

The gateway sends at most one FIFO item per drain: `turn/start` for an idle or
`systemError` target, or `turn/steer` for an active target. If the app-server
definitively rejects a stale transient coordinate, the gateway rediscovers the
current route once and retries the same Discord source id. Turn payloads omit model,
reasoning effort, service tier, personality, cwd, sandbox, and approval
overrides; Discord metadata is carried only in the sanitized text envelope.
One top-level turn owns at most one automatic Discord reply. If multiple exact
Discord sources enter the same `(threadId, turnId)`, the first durably bound
source owns the final even when acknowledgement uncertainty reorders completion.
Later source records are durably marked suppressed with that owner identity.
Restart reconciliation treats all same-turn receipts as one send gate: a
confirmed or legacy-sent receipt is the already-visible reply, a pending receipt
must reconcile before any new POST, and an unreadable or wrong-identity receipt
fails the whole turn closed. The durable owner may POST only after every other
same-turn source is proven to have no receipt. Separate turns retain separate
per-source reply rights. The receipt barrier does not trust the queue's current
outbound status: a pending receipt on a previously suppressed sibling is
restored to guarded reconciliation before the owner becomes eligible. This
recovery is reconciliation-only: an existing remote reply is confirmed, while
proven absence releases the stale receipt and keeps the sibling suppressed so
only the durable owner can POST. It never retries the POST as the sibling.
An accepted app-server response commits the queue item. If the response is lost
or transport outcome is uncertain, the item stays in the ordinary ready FIFO
with the stable `discord:<channel>:<message>` client id; the next drain resolves
the then-current route and retries. There is no thread-bound uncertainty lane.
Queue format v5 migrates v4 uncertainty records back into that FIFO.

`pending-delivery.json` retains queued Discord sources across plugin activation
and version changes. Activation metadata is diagnostic only: it never archives,
drops, authenticates, or deduplicates an inbound message. Durable deduplication
uses only Discord channel plus message id.

The standalone gateway checks the durable queue periodically as well as on
app-server recovery events. A nonempty queue retries with exponential
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

Set `CODEX_DISCORD_AUTOMATIC_OUTBOUND_ENABLED=false` for inbound-only emergency
operation. The gateway continues to persist and inject inbound Discord messages
and refresh the exact TUI target, but it does not inspect or send automatic
assistant-final replies. Guarded explicit sends remain available through the MCP
send tool.

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

Legacy and current listeners must not overlap across an incompatible lock
binding. Stop and verify the old gateway, audit any legacy lock directory, and
only then start the successor. Same-binding current receivers can use the
atomic live-fallback handoff.

Launch the visible TUI through `codex-discord-instance INSTANCE ...`, which
starts the matching app-server, gateway, and remote TUI from one installed cache
generation. The launcher does not capture or invent an exact resume thread. If
the gateway exits while the TUI is alive, it restarts only the gateway and keeps
the TUI running. See the repository
[Structured Delivery Contract](../../docs/structured-delivery.md) for the full
migration and acceptance boundary. User-visible failure signatures and
diagnostic steps are recorded in
[Known Issues And Operational Boundaries](../../docs/known-issues.md).

The launcher owns an atomic `instance-generation.json` beside its alias lock.
It is process-cleanup metadata, not Discord identity. Instance paths and process
groups are checked before cleanup so one alias cannot kill another. It is never
used to choose, authenticate, or resume a Codex session/thread.

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
