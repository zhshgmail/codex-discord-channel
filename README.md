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

Queue completion is committed only after structured acceptance **and** a
read-back of the stable client message id from the exact target thread. A
positive RPC response without that persisted user item is not success: replay
is blocked and the FIFO head remains available for reconciliation. See the
[Structured Delivery Contract](docs/structured-delivery.md) and
[Known Issues And Operational Boundaries](docs/known-issues.md).

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
   STATE_DIR="${DISCORD_CONFIG_DIR:-$HOME/.codex/channels/discord/codex01}"
   SOCKET="$STATE_DIR/app-server.sock"
   mkdir -p "$STATE_DIR"
   DISCORD_INSTANCE=codex01 DISCORD_CONFIG_DIR="$STATE_DIR" \
     codex-discord-channel app-server
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

Prerequisites:

- Node.js 22 or newer;
- a Discord bot with Message Content intent enabled;
- one private token file per instance; and
- one shared Codex app-server used by both the gateway and visible TUI.

```bash
codex plugin marketplace add zhshgmail/codex-discord-channel --ref main
codex plugin add codex-discord-channel@personal
```

Use a new Codex thread after installation so the MCP server is loaded.

For a review branch or pinned deployment, replace `main` with the exact branch,
tag, or commit approved for that deployment. Do not assume an open MCP
transport has hot-loaded a replaced plugin.

## Configure An Instance

The default instance is `default`. Select a named instance with
`DISCORD_INSTANCE`; the examples below use `codex01`.

### Isolate The OpenAI Account And Discord Bot

Multiple instances require two independent boundaries. `CODEX_HOME` owns the
OpenAI login, Codex configuration, and session store. `DISCORD_CONFIG_DIR`
owns the Discord bot token, bot id, access policy, delivery queue, and shared
app-server socket. Do not rely on `CODEX_HOME` to select both.

Create an account file beside each instance's Discord files:

```text
$HOME/.codex/channels/discord/codex01/account.env
$HOME/.codex/channels/discord/codex02/account.env
```

For example:

```env
# codex01/account.env
CODEX_HOME=/home/USER/.codex-account-01
CODEX_BIN=/absolute/path/to/@openai/codex/bin/codex.js
NODE_BIN=/absolute/path/to/node
CODEX_DISCORD_CHANNEL_BIN=/absolute/path/to/codex-discord-channel
```

```env
# codex02/account.env
CODEX_HOME=/home/USER/.codex-account-02
CODEX_BIN=/absolute/path/to/@openai/codex/bin/codex.js
NODE_BIN=/absolute/path/to/node
CODEX_DISCORD_CHANNEL_BIN=/absolute/path/to/codex-discord-channel
```

Each instance still has its own `.env` containing a different
`DISCORD_BOT_TOKEN` and `DISCORD_BOT_USER_ID`. The plugin loads `account.env`
before `.env` and pins the selected Discord state directory before applying
`CODEX_HOME`, so changing accounts cannot silently move the bot state.
`account.env` is strict: only `CODEX_HOME`, `CODEX_BIN`, `NODE_BIN`, and
`CODEX_DISCORD_CHANNEL_BIN` are accepted. Put proxy and CA variables in the
optional instance-local `app-server-network.env`; unknown keys fail closed.

Bind MCP discovery to the same instance even when a launcher does not preserve
Discord environment variables. Create `$CODEX_HOME/discord-instance.env`:

```env
DISCORD_INSTANCE=codex02
DISCORD_CONFIG_DIR=/home/USER/.codex/channels/discord/codex02
```

This file accepts only those two keys. Explicit command-line service selection
must agree with it, so a stale or edited environment file cannot redirect one
instance onto another instance's bot state.

The account-isolated app-server entry point fails closed when `CODEX_HOME` is
not explicit:

```bash
DISCORD_INSTANCE=codex02 \
DISCORD_CONFIG_DIR="$HOME/.codex/channels/discord/codex02" \
codex-discord-channel app-server
```

Inspect the non-secret effective identity before startup:

```bash
DISCORD_INSTANCE=codex02 \
DISCORD_CONFIG_DIR="$HOME/.codex/channels/discord/codex02" \
codex-discord-channel instance-doctor
```

Use the instance launcher for the visible TUI. It validates the account login
and bot configuration, enables and starts both systemd units, waits for the
instance socket, and only then replaces itself with the matching Codex client:

```bash
codex-discord-instance codex02
```

An alias may select the instance, but it is not the isolation or startup
boundary:

```bash
alias codex02='codex-discord-instance codex02'
```

`CODEX_BIN` is the Codex JavaScript entry point executed by `NODE_BIN`, not a
shell launcher or alias. The bundled templates under
`plugins/codex-discord-channel/systemd/` start one
app-server and one gateway per `%i`. They consume absolute executable paths
from `account.env`; this avoids relying on an interactive `nvm` PATH. Copy both
templates to `$HOME/.config/systemd/user/` and enable the same instance name
for both units. Keep `account.env` mode `0600`. The visible TUI must use the
matching account and socket. Prefer the launcher above; the equivalent
low-level command is:

```bash
CODEX_HOME="$HOME/.codex-account-02" \
DISCORD_INSTANCE=codex02 \
DISCORD_CONFIG_DIR="$HOME/.codex/channels/discord/codex02" \
codex --remote "unix://$HOME/.codex/channels/discord/codex02/app-server.sock"
```

The plugin MCP manifest intentionally does not hardcode `codex01`; it inherits
the instance variables from the selected Codex process and falls back to that
account's `discord-instance.env` binding.

Create `$HOME/.codex/channels/discord/codex01/.env` locally:

```env
DISCORD_INSTANCE=codex01
DISCORD_BOT_TOKEN=replace-locally
DISCORD_BOT_USER_ID=replace-with-the-bot-user-id
# Only when the host requires them:
# DISCORD_PROXY_URL=http://proxy.example:8080
# DISCORD_INSECURE_TLS=true
```

Never commit this file, paste it into an issue, or print it while collecting
diagnostics.

Create `access.json` in the same directory. This minimal example accepts an
allowlisted sender in one guild channel only when the bot is mentioned:

```json
{
  "version": 1,
  "dmPolicy": "pairing",
  "allowFrom": ["USER_ID"],
  "groups": {
    "CHANNEL_ID": {
      "requireMention": true,
      "allowFrom": ["USER_ID"],
      "allowBots": false
    }
  },
  "pendingPairings": {},
  "mentionPatterns": ["<@BOT_USER_ID>"],
  "ackReaction": "",
  "replyToMode": "first",
  "textChunkLimit": 2000,
  "chunkMode": "newline",
  "threads": {}
}
```

Use current Discord snowflake ids. Role mentions and user mentions are
different strings. If messages from peer bots are expected, set
`allowBots: true`, allowlist their author ids, and include every intended bot
or role mention pattern.

Enabling a guild text channel also enables every public, private, or
announcement thread below it. Threads inherit the parent channel's
`requireMention`, `allowFrom`, and `allowBots` policy while replies remain in
the actual thread. Add an exact thread id only when that thread needs an
explicit policy override.

`access.json` is the receive-policy authority. A legacy `state.json` may remain
after migration, but editing it does not update current access policy.

## Start The Shared Runtime

Use one socket per instance:

```bash
STATE_DIR="${DISCORD_CONFIG_DIR:-$HOME/.codex/channels/discord/codex01}"
SOCKET="$STATE_DIR/app-server.sock"
mkdir -p "$STATE_DIR"
DISCORD_INSTANCE=codex01 DISCORD_CONFIG_DIR="$STATE_DIR" \
  codex-discord-channel app-server
codex --remote "unix://$SOCKET" resume <THREAD_ID>
```

Run exactly one gateway for that state directory:

```bash
DISCORD_INSTANCE=codex01 \
DISCORD_CONFIG_DIR="$STATE_DIR" \
codex-discord-channel gateway
```

For a user systemd service, use an absolute Node path in `ExecStart`. User
services do not reliably inherit an interactive `nvm` shell:

```ini
[Service]
Environment=DISCORD_INSTANCE=codex01
Environment=DISCORD_CONFIG_DIR=%h/.codex/channels/discord/codex01
ExecStart=/absolute/path/to/node /absolute/path/to/codex-discord-channel gateway
Restart=always
RestartSec=5
```

Keep any retired `discord-codex-bridge` service disabled. Two receivers sharing
one bot make diagnosis ambiguous even when queue deduplication prevents some
duplicates.

## Use The Plugin

The MCP tools are:

- `discord_channel_status`
- `discord_channel_read_owner`
- `discord_channel_claim_owner`
- `discord_channel_read_history`
- `discord_channel_send`

Check status before claiming live delivery. The minimum healthy evidence is:

```json
{
  "deliveryMode": "app-server",
  "deliverySafety": "structured_only",
  "structuredDeliveryState": "available",
  "sharedAppServerAvailable": true,
  "discordStarted": true
}
```

The command-line sender reads message text from standard input:

```bash
printf '%s' 'status update' |
  DISCORD_INSTANCE=codex01 codex-discord-channel send \
    --channel CHANNEL_ID
```

Add `--reply-to MESSAGE_ID` for a Discord reply. Omitting `--channel` targets
the channel in `last-inbound.json`; use that shortcut only after checking the
record belongs to the intended conversation.

`discord_channel_read_history` is bounded to 25 sanitized messages per call.
Use its exclusive `before` cursor to page backward. Reading history does not
enqueue or acknowledge those messages.

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

## Operations And Troubleshooting

Useful non-secret checks:

```bash
systemctl --user status codex-discord-channel@codex01.service --no-pager -l
journalctl --user -u codex-discord-channel@codex01.service -n 200 --no-pager
jq '{blocked,itemCount:(.items|length),completed:(.completed|length)}' \
  "$HOME/.codex/channels/discord/codex01/pending-delivery.json"
cat "$HOME/.codex/channels/discord/codex01/session-gateway.pid"
```

Do not use `grep -c ... || echo 0` for these checks. A missing file and a clean
file both reach the fallback; inspect the command exit code separately.

| Symptom | Check | Corrective action |
|---|---|---|
| `node: command not found` under systemd or a noninteractive shell | `ExecStart` and the service environment | Use an absolute Node 22+ path. |
| Plugin code changed but tools/behavior did not | Age of the Codex thread and installed runtime path | Install the intended revision, migrate the gateway, and start a new Codex thread. A closed MCP transport cannot hot-reload. |
| `guild_mention_required` | `access.json` `requireMention`, bot user id, `mentionPatterns`, and reply audience | Correct the exact user/role mention pattern. Do not edit `owner.json` or legacy `state.json` as a workaround. |
| `guild_channel_not_enabled` in a thread | Runtime revision, thread parent id, and the parent entry in `access.json` | Upgrade past `0.2.1+git.92d5d37cc13b` and enable the parent channel. New threads inherit parent policy automatically. |
| Peer bot messages are absent | Group `allowFrom`, `allowBots`, current group id, and mention pattern | Allowlist the peer bot and set `allowBots: true` only for the intended group. |
| Gateway says connected but the visible TUI receives nothing | Confirm both processes use the same `app-server.sock` | Relaunch the TUI with `codex --remote`. A direct TUI has a private embedded server. |
| Queue is stuck at `thread_busy` | Exact current thread and active turn identity | Let the current turn advance; do not start a second receiver or inject terminal input. |
| Queue is stuck at `structured_ack_uncertain` | Exact target thread read-back by stable client id | Preserve the queue. The gateway reconciles without replay when the user item appears. See the known issue below. |
| Messages reappear after deployment | Runtime path and delivery activation id | Use versioned install paths. Do not reuse an old activation id across incompatible releases. |
| Discord login or send fails behind a corporate network | Status booleans for proxy/TLS and service environment | Configure `DISCORD_PROXY_URL`; use `DISCORD_INSECURE_TLS` only where the local trust boundary explicitly requires it. Never log the values. |
| `/clear` is followed by delivery to an old thread | Current runtime version and target checkpoint | Upgrade and verify thread rotation in the exact visible TUI. `owner.json` must not be used as the message receive gate. |

The reproduced false-completion incident and its fixed boundary are documented
in [Known Issues And Operational Boundaries](docs/known-issues.md).

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
