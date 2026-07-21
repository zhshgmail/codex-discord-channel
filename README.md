# Codex Discord Channel

Standalone Codex plugin project for Discord session delivery. The plugin lives
at `plugins/codex-discord-channel` and is exposed through the repository
marketplace at `.agents/plugins/marketplace.json`.

## What It Does

- Reuses one Discord bot instance and state directory per configured instance.
- Uses one atomically replaced structured authority record in
  `session-gateway.pid` as the active receive gate. During a staged takeover
  from a legacy gateway, its unchanged PID/generation files remain intact and
  the current receiver CAS lives in `session-gateway.pid.v2`.
- Keeps `owner.json` for status and handoff metadata only; thread or session ids
  never gate individual Discord messages.
- Persists accepted messages in a cross-process locked, deduplicated FIFO.
- Sends one queued message at a time through `turn/start` when idle or
  `turn/steer` when an exact active turn is known on the shared Codex app-server
  used by the visible TUI.
- Exposes MCP tools for status, owner metadata, bounded history, and replies.

There is no terminal-input delivery path. If the visible TUI is not attached to
the same shared app-server, the endpoint is unavailable, or the current thread
cannot be proved, accepted messages remain queued. The gateway never falls back
to keyboard emulation.

A first or sole gateway logs in and starts durable Discord admission even when
the app-server target is unavailable. A takeover of a live receiver additionally
requires target readiness, arms the successor listener, and then transfers
authority with one atomic record replacement.

During a staged legacy-to-current takeover, both gateway listeners can remain
eligible because the legacy binary cannot react to successor process death.
The cross-process queue lock and Discord identity deduplication keep that
compatibility overlap to one persisted event and one structured turn. Current
receivers prefer the staged authority, so legacy shutdown cannot clear their
generation.

## Structured Delivery

The default endpoint for instance `codex01` is:

```text
$CODEX_HOME/channels/discord/codex01/app-server.sock
```

When `CODEX_HOME` is unset, `$HOME/.codex` is used. Set
`CODEX_DISCORD_APP_SERVER_URL` only when the shared endpoint uses another
`unix://`, `ws://`, or `wss://` address.

For every delivery attempt, the gateway asks the shared server for loaded
threads and reads the current top-level thread status. A fresh endpoint must
have one provable top-level TUI thread. After `/clear` or another thread
rotation, the latest top-level `thread/started` notification becomes the
current target even while an older subscribed thread is still loaded.

Each drain admits at most one FIFO item. An idle target uses `turn/start`; an
active target with a notification-proven current turn uses `turn/steer` with an
exact turn-id precondition. Active turns whose identity is not known remain
`thread_busy`. Turn-start and active-turn notifications wake another serialized
drain, so automatic goal continuations cannot indefinitely win every idle
boundary. Requests include a stable Discord client message id and untrusted
Discord context, but omit model, reasoning effort, service tier, personality,
sandbox, cwd, and approval overrides.

Queue completion is committed only after structured acceptance. If an
acknowledgement is lost, replay is blocked. The gateway reconciles the stable
client message id against the thread before it can mark that item complete.
See [Structured Delivery Contract](docs/structured-delivery.md).

The queue also carries a durable delivery activation id and timestamp. The id
defaults to the real installed plugin root, so a newly installed version
archives pending items from an older runtime before resolving a target. Items
queued before the activation timestamp and delayed Discord events created
before it are stale as well. The archive retains only Discord identity and
timestamps for deduplication; message content is removed. Restarts of the same
installed runtime retain and recover only items stamped within that activation.
Operators may set an explicit stable boundary with
`CODEX_DISCORD_DELIVERY_ACTIVATION_ID`.

The standalone gateway also owns a periodic durable-queue check. A nonempty
queue is retried without new Discord traffic or TUI activity, while unavailable
targets back off from 1 second to a 30-second maximum. Every tick verifies the
gateway's durable PID/generation authority under the configured Discord state
directory; `owner.json` and thread/session ids are not receive gates. The
interval bounds may be changed with
`CODEX_DISCORD_QUEUE_DRAIN_INTERVAL_MS` and
`CODEX_DISCORD_QUEUE_DRAIN_MAX_BACKOFF_MS`.

## Required Live Migration

A TUI started as a direct `codex ... resume` process uses a private embedded
app-server. This repository change cannot attach to that private server. Live
exact-console verification therefore requires a release/install plus process
migration:

1. End the direct TUI process at an operator-approved time.
2. Start a persistent app-server on the instance socket:

   ```bash
   STATE_DIR="${CODEX_HOME:-$HOME/.codex}/channels/discord/codex01"
   SOCKET="$STATE_DIR/app-server.sock"
   mkdir -p "$STATE_DIR"
   codex app-server --listen "unix://$SOCKET"
   ```

3. Relaunch the visible TUI against that same endpoint:

   ```bash
   codex --remote "unix://$SOCKET" resume <THREAD_ID>
   ```

4. Install the released plugin and restart the `codex01` gateway under normal
   operator change control so it runs the released code.
5. Verify `discord_channel_status` reports `deliverySafety:
   "structured_only"`, `sharedAppServerAvailable: true`, and
   `discordStarted: true`.
6. Send a controlled allowed Discord message and confirm that its structured
   turn appears in that exact visible TUI. Repeat after `/clear` to verify
   thread rotation.

Until every step is complete, report only repository/test readiness or queued
unavailability. Do not claim passive or exact-console success.

## Remote Marketplace Install

```bash
codex plugin marketplace add zhshgmail/codex-discord-channel --ref main
codex plugin add codex-discord-channel@personal
```

Use a new Codex thread after installation so the MCP server is loaded.

## Status

Expected fail-closed status before the shared endpoint exists:

```json
{
  "instance": "codex01",
  "deliveryMode": "app-server",
  "deliverySafety": "structured_only",
  "structuredDeliveryState": "unavailable",
  "sharedAppServerAvailable": false,
  "sharedAppServerReason": "shared_app_server_socket_missing"
}
```

Status also reports queue depth and the current blocked reason without exposing
queued message content, tokens, or proxy values.

## Guild Reply Audience

For an enabled guild channel with `requireMention: true`, a reply is an
implicit mention for the union of the referenced author, agents mentioned by
the referenced message, and agents explicitly mentioned by the new reply.
Every bot applies that union independently after normal channel, sender, and
bot checks. When `requireMention: false`, otherwise-authorized group messages
do not require a mention or reply audience.

## Bounded History

`discord_channel_read_history` reads sanitized recent history without creating
a local archive. It supports `channelId`, an exclusive `before` cursor, and a
`limit` from 1 to 25. Guild reads require the exact enabled channel or thread;
DM reads require the configured DM policy. Results are newest first, bounded to
64 KiB, and omit attachment bodies, embeds, components, and reactions.

## Instance State

```text
$HOME/.codex/channels/discord/codex01/.env
$HOME/.codex/channels/discord/codex01/access.json
$HOME/.codex/channels/discord/codex01/owner.json
$HOME/.codex/channels/discord/codex01/session-gateway.pid
$HOME/.codex/channels/discord/codex01/pending-delivery.json
$HOME/.codex/channels/discord/codex01/app-server.sock
```

Do not commit `.env` or print Discord tokens.

## Validation

```bash
cd plugins/codex-discord-channel
npm install
npm run check
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

## Import Existing Bridge State

```bash
cd plugins/codex-discord-channel
npm run import:bridge -- --instance codex01 --fetch-bot-id
```

The import reuses the existing `.env`, converts access state, and never prints
the bot token.
