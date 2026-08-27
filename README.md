# Codex Discord Channel

Standalone Codex plugin project for Discord session delivery. The plugin lives
at `plugins/codex-discord-channel` and is exposed through the repository
marketplace at `.agents/plugins/marketplace.json`.

## v0.3.8 Team Install And Upgrade

Team release: [v0.3.8](https://github.com/zhshgmail/codex-discord-channel/releases/tag/v0.3.8).

This is the current team-host rollout, not a claim of cross-host portability.
The marketplace MCP manifest in v0.3.8 still pins the team's absolute Node
path; a host with a different Node path needs a later manifest fix.

One instance is one launcher-owned process tree: launcher, app-server, Discord
gateway, and visible Codex TUI. The plugin installs no systemd unit. Normal
install or upgrade needs no Linux restart, `systemctl`, `pkill`, or `killall`.

### First Install

Choose an instance and its isolated Codex account:

```bash
INSTANCE=codex02
ACCOUNT_HOME="$HOME/.codex-account-02"
STATE_DIR="$HOME/.codex/channels/discord/$INSTANCE"
mkdir -p "$ACCOUNT_HOME" "$STATE_DIR"
chmod 700 "$ACCOUNT_HOME" "$STATE_DIR"
```

Create `$STATE_DIR/account.env` with absolute paths:

```env
CODEX_HOME=/home/USER/.codex-account-02
CODEX_BIN=/absolute/path/to/@openai/codex/bin/codex.js
NODE_BIN=/absolute/path/to/node
```

Create `$ACCOUNT_HOME/discord-instance.env`:

```env
DISCORD_INSTANCE=codex02
DISCORD_CONFIG_DIR=/home/USER/.codex/channels/discord/codex02
```

Create mode-`0600` `$STATE_DIR/.env` and the
[`access.json`](#configure-an-instance) receive policy. Never print or commit
the token file.

```env
DISCORD_INSTANCE=codex02
DISCORD_BOT_TOKEN=replace-locally
DISCORD_BOT_USER_ID=replace-with-the-bot-user-id
```

Install the pinned tag from an ordinary shell:

```bash
CODEX_HOME="$ACCOUNT_HOME" codex plugin marketplace add \
  zhshgmail/codex-discord-channel --ref v0.3.8
CODEX_HOME="$ACCOUNT_HOME" codex plugin add codex-discord-channel@personal

PLUGIN_ROOT="$ACCOUNT_HOME/plugins/cache/personal/codex-discord-channel/0.3.8+codex.alias-isolated-runtime"
test -x "$PLUGIN_ROOT/bin/codex-discord-instance"
```

Start a new session with no trailing arguments, or resume an existing one.
Everything after the instance name is passed to Codex:

```bash
"$PLUGIN_ROOT/bin/codex-discord-instance" "$INSTANCE"
"$PLUGIN_ROOT/bin/codex-discord-instance" "$INSTANCE" -C /absolute/workspace/path
"$PLUGIN_ROOT/bin/codex-discord-instance" "$INSTANCE" \
  -C /absolute/workspace/path resume --last
"$PLUGIN_ROOT/bin/codex-discord-instance" "$INSTANCE" --profile PROFILE resume --last
```

Use `-C /absolute/workspace/path` to pin the Codex working context. Model,
profile, sandbox, and other Codex settings still come from that account's
`config.toml` or normal Codex arguments. The first interactive launch may run
`codex login` for `ACCOUNT_HOME`. Do not
start `app-server`, `gateway`, a bare `codex --remote`, or a new systemd unit
separately. The launcher supplies the correct `CODEX_HOME`, instance, state
directory, socket, and installed activation root to every child.

### Upgrade To v0.3.8

Upgrade one alias at a time:

1. Finish or hand over its active turn, then exit that alias's visible TUI
   normally. The launcher stops only its own three children.
2. In an ordinary shell, confirm that exact alias is gone and its state socket
   is absent. Never use a box-wide process count as proof.
3. Inspect the configured marketplace/plugin names, replace the cache, and
   update the shell alias to the new versioned launcher path.
4. Relaunch the whole alias and run the live checks below.

```bash
CODEX_HOME="$ACCOUNT_HOME" codex plugin marketplace list --json
CODEX_HOME="$ACCOUNT_HOME" codex plugin list --json
CODEX_HOME="$ACCOUNT_HOME" codex plugin remove codex-discord-channel@personal
CODEX_HOME="$ACCOUNT_HOME" codex plugin marketplace remove personal
CODEX_HOME="$ACCOUNT_HOME" codex plugin marketplace add \
  zhshgmail/codex-discord-channel --ref v0.3.8
CODEX_HOME="$ACCOUNT_HOME" codex plugin add codex-discord-channel@personal

PLUGIN_ROOT="$ACCOUNT_HOME/plugins/cache/personal/codex-discord-channel/0.3.8+codex.alias-isolated-runtime"
test -x "$PLUGIN_ROOT/bin/codex-discord-instance"
"$PLUGIN_ROOT/bin/codex-discord-instance" "$INSTANCE" resume --last
```

If the marketplace already points at `v0.3.8`, use
`codex plugin marketplace upgrade personal` instead of replacing it. Never
install over a running alias: the installer may remove files used by that
generation, and an open MCP transport cannot hot-reload the replacement.

### Stop And Recovery Rules

- Normal stop is exiting the selected TUI.
- An upgrade is an operator-controlled maintenance action, not a task that the
  running Codex should schedule for itself. Finish or hand over the current
  turn, choose the maintenance window explicitly, and only then exit the TUI.
- The plugin and `codex-discord-instance` do not start or require `tmux`. Do
  not put an upgrade behind a detached `tmux`, background waiter, or script
  that waits indefinitely for the active TUI to disappear. That hides the new
  TUI and makes launcher ownership ambiguous.
- If its launcher is stuck, verify the exact absolute launcher path, instance,
  PID, start time, children, and state directory; send `TERM` only to that
  launcher PID and let its cleanup trap stop its children.
- v0.3.6 and later also record one atomic alias-local launch generation.
  If the launcher dies abnormally, an immediate same-alias relaunch may reclaim
  only that exact dead generation: launcher and process-group identities,
  generation environment, command lines, and the Unix-socket inode must all
  still match. A missing, malformed, live, reused, or changed identity remains
  fail-closed with status 73 and is left untouched.
- Never use `pkill codex`, `pkill node`, `killall`, an unresolved stale PID,
  or another alias's process, socket, config, or queue.
- The only relevant `systemctl --user disable --now` command is for a retired
  `discord-codex-bridge@INSTANCE.service` that actually exists. v0.3.6 itself
  has no service.
- Never edit, delete, or replay `pending-delivery.json` during an upgrade.

### Upgrade Recovery: Old Alias And Active Launcher

An interactive shell that was open before an upgrade keeps the alias value it
already loaded. If the old cache was removed, that shell can still try to run
the old path:

```text
-bash: .../0.3.4+codex.alias-isolated-runtime/bin/codex-discord-instance:
No such file or directory
```

Refresh and inspect the shell definition before retrying. `source` reloads the
alias; `hash -r` only clears Bash's executable lookup cache.

```bash
source ~/.bashrc
hash -r
alias codex02
type -a codex02
```

The alias must name the intended installed version. If the retry instead says:

```text
Discord instance codex02 already has an active launcher
```

the launcher has failed its nonblocking lock acquisition and exits with status
73. This normally means another process still owns that instance; the lock
file's mere existence is not the proof. Do not delete the lock, socket, queue,
or PID files, and do not start a second receiver.

v0.3.6 and later distinguish this live-lock case from an exact orphan
left by an abnormally killed launcher. Under the alias lock, the latter is
stopped as one isolated process group with a bounded TERM-to-KILL sequence; the
socket is unlinked only if its device and inode still match the atomic
generation manifest. The relaunch then continues normally. Legacy sockets with
no manifest and any PID, PGID, command, environment, listener-count, or inode
mismatch still produce the existing status-73 refusal and are never deleted or
signalled automatically.

```bash
INSTANCE=codex02
STATE_DIR="$HOME/.codex/channels/discord/$INSTANCE"

ps -eo pid,ppid,sid,tty,lstart,args | \
  grep "[c]odex-discord-instance $INSTANCE"
lsof "$STATE_DIR/instance-launcher.lock"
```

- If the existing TUI is visible, return to it instead of launching another
  generation.
- If an operator deliberately started that TUI inside `tmux`, attach to the
  exact live session. `tmux` is external supervision, not plugin behavior or a
  required installation step.
- If the existing TUI is no longer reachable, first finish or hand over any
  active work. Verify the exact launcher PID, start time, command, children,
  state directory, and lock ownership. Then send `TERM` only to that launcher
  PID and wait for its owned children and socket to disappear. Start the new
  generation in the terminal where the user expects to see the TUI.

Never solve either error by `pkill`, `killall`, removing the state directory,
or launching from a detached upgrade waiter. A fresh install or upgrade on
another machine must work without `tmux`.

### Minimum Live Acceptance

In the exact visible TUI, require `discord_channel_status` to report the
intended instance/state directory, live gateway, available shared app-server,
available structured delivery, and Discord started. Then prove a fresh direct
mention appears automatically with its original `created_at` and stable
Discord client id. Repeat once after `/clear`. A positive RPC response or an
empty queue alone is not delivery proof.

If old messages, a stale socket, `structured_ack_uncertain`, `thread_busy`,
or a wrong visible TUI remains, stop at RED and use
[Known Issues And Operational Boundaries](docs/known-issues.md). Do not repair
those symptoms by replaying the queue or killing unrelated processes.

## What It Does

- Reuses one Discord bot instance and state directory per configured instance.
- Uses one atomically replaced structured authority record in
  `session-gateway.pid` as the active receive gate. During a staged takeover
  from a legacy gateway, its unchanged PID/generation files remain intact and
  the current receiver CAS lives in `session-gateway.pid.v2`.
- Keeps `owner.json` version 2 for stable instance and process metadata only.
  Its diagnostic fingerprint comes from the normalized alias, canonical Codex
  account home, and canonical private state directory; Codex owner, thread, and
  session ids neither identify the instance nor gate messages.
- Persists accepted messages in a cross-process locked, deduplicated ready FIFO
  plus a visible fail-closed reconciliation lane for uncertain acknowledgements.
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

Those thread and turn ids are transient app-server routing addresses. They are
never account, instance, receiver, owner, process-generation, or restart
authority. After an app-server socket replacement, the launcher retains the
same stable alias/account/state and original workspace options and uses
`resume --last`; it never resumes a checkpointed thread id.

Each drain admits at most one FIFO item. An idle target uses `turn/start`; an
active target with a notification-proven current turn uses `turn/steer` with an
exact turn-id precondition. Active turns whose identity is not known remain
`thread_busy`. Turn-start and active-turn notifications wake another serialized
drain, so automatic goal continuations cannot indefinitely win every idle
boundary. Requests include a stable Discord client message id and untrusted
Discord context, but omit model, reasoning effort, service tier, personality,
sandbox, cwd, and approval overrides.

One top-level turn owns at most one automatic Discord reply. When several
Discord source envelopes are accepted into the same exact `(threadId, turnId)`,
the first exact source durably bound to that turn owns its final response even
if an earlier uncertain acknowledgement makes it complete later. Later sources
remain durably completed but their automatic outbound work is suppressed with
the owning source identity. Restart reconciliation preserves confirmed,
uncertain, in-flight, and legacy-sent per-source receipt facts as a turn-wide
gate: a confirmed or sent receipt is the already-visible reply, a pending
receipt is reconciled before any new POST, and an unreadable or wrong-identity
receipt fails the whole turn closed. The durable owner may POST only after every
other same-turn source is proven to have no receipt. Sources accepted into
separate top-level turns keep independent per-source reply rights. Receipt
inspection is independent of the queue's current outbound status: a pending
receipt on a previously suppressed sibling is restored to guarded
reconciliation instead of letting the owner send around it. That recovery is
reconciliation-only: finding the remote reply confirms it; proving absence
releases the stale receipt while the sibling remains suppressed, then the
durable owner becomes the sole source allowed to POST. Recovery never POSTs as
the sibling.

If the trusted local app-server rejects a steer with an exact canonical
expected-to-current turn mismatch, the gateway rechecks the same connection,
thread revision, root, and TUI lease before retrying that one logical delivery
once. A second mismatch records the newest active turn for the next drain and
returns `thread_busy` without a third submission. Other rejected steer errors
clear only the unproven turn id and force a fresh read while preserving the
proven root; disconnects and uncertain acknowledgements never retry.

Queue completion is committed only after structured acceptance **and** a
read-back of the stable client message id from the exact target thread. A
positive RPC response without that persisted user item is not success. The item
moves to the uncertain reconciliation lane, where only exact durable proof can
complete it and automatic `turn/start` replay is forbidden; later ready items
continue. See the
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
`CODEX_DISCORD_DELIVERY_ACTIVATION_ID` for standalone workers. The alias-owned
launcher always overlays its real installed plugin root for every channel and
TUI child, so an older value retained in the instance `.env` cannot bridge two
marketplace revisions.

The standalone gateway also owns a periodic durable-queue check. A nonempty
queue is retried without new Discord traffic or TUI activity, while unavailable
targets back off from 1 second to a 30-second maximum. Every tick verifies the
gateway's durable PID/generation authority under the configured Discord state
directory; `owner.json` and thread/session ids are not receive gates. The
interval bounds may be changed with
`CODEX_DISCORD_QUEUE_DRAIN_INTERVAL_MS` and
`CODEX_DISCORD_QUEUE_DRAIN_MAX_BACKOFF_MS`.
Uncertain proof rechecks use `CODEX_DISCORD_UNCERTAIN_RETRY_BASE_MS` and
`CODEX_DISCORD_UNCERTAIN_RETRY_MAX_MS`. These legacy-named settings never
authorize replaying `turn/start`.
Gateway heartbeat expiry uses `CODEX_DISCORD_GATEWAY_HEALTH_STALE_MS` and
defaults to 3 minutes.

The unique gateway writes `gateway-health.json` atomically. MCP status verifies
that record against receiver PID/generation authority and reports MCP-local
Discord login separately. Queue state is explicit as `idle`, `queued`,
`blocked`, `degraded`, or `unreadable`; a degraded queue exposes the oldest
uncertain message id, attempts, and retry time without message content.

## Required Live Migration

A direct `codex ... resume` TUI uses a private embedded app-server and cannot be
attached after startup. Exit the selected alias first at an operator-approved
time. From an ordinary shell, install the released marketplace artifact and
then relaunch it through `codex-discord-instance INSTANCE resume --last`. That
one launcher owns the matching app-server, gateway, and TUI as child processes
from the same installed cache directory. It registers no systemd unit and
requires no Linux restart.

After relaunch, require `discord_channel_status` to report the intended
`instance`, `stateDir`, `accountBindingLoaded: true`,
`legacyInstanceFallbackUsed: false`, `sharedAppServerAvailable: true`, and
`discordStarted: true`. Then send controlled direct-mention, `@here`, and
`@everyone` probes from an independent identity and confirm each stable source
message ID plus original `created_at` appears in that exact visible TUI.

Until those live checks pass for that consumer, report only repository/test
readiness or queued unavailability. A passing consumer does not make another
alias green.

## Remote Marketplace Install

Prerequisites:

- Node.js 22.15.0 or newer;
- a Discord bot with Message Content intent enabled;
- one private token file per instance; and
- one isolated `CODEX_HOME` and Discord state directory per alias.

```bash
codex plugin marketplace add zhshgmail/codex-discord-channel --ref v0.3.8
codex plugin add codex-discord-channel@personal
```

Use a new Codex thread after installation so the MCP server is loaded.

Marketplace installation copies the plugin into the Codex cache but does not
run `npm install` or package lifecycle hooks. Both the MCP entrypoint and the
gateway/app-server worker therefore use committed self-contained bundles:
`runtime/mcp-server.cjs` and `runtime/channel.cjs`. `npm ci` and
`npm run build:runtime` are development steps, not installation requirements.

For a review branch or pinned deployment, replace `v0.3.8` with the exact
branch, tag, or commit approved for that deployment. Do not assume an open MCP
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
```

```env
# codex02/account.env
CODEX_HOME=/home/USER/.codex-account-02
CODEX_BIN=/absolute/path/to/@openai/codex/bin/codex.js
NODE_BIN=/absolute/path/to/node
```

Each instance still has its own `.env` containing a different
`DISCORD_BOT_TOKEN` and `DISCORD_BOT_USER_ID`. The plugin loads `account.env`
before `.env` and pins the selected Discord state directory before applying
`CODEX_HOME`, so changing accounts cannot silently move the bot state.
`account.env` is strict: `CODEX_HOME`, `CODEX_BIN`, and `NODE_BIN` select the
account runtime. The legacy `CODEX_DISCORD_CHANNEL_BIN` key is accepted for
rollback compatibility but ignored by the current launcher. Put proxy and CA
variables in the optional instance-local `app-server-network.env`; unknown keys
fail closed.

Bind MCP discovery to the same instance even when a launcher does not preserve
Discord environment variables. Create `$CODEX_HOME/discord-instance.env`:

```env
DISCORD_INSTANCE=codex02
DISCORD_CONFIG_DIR=/home/USER/.codex/channels/discord/codex02
```

This file accepts only those two keys. Explicit command-line worker selection
must agree with it, so a stale or edited environment file cannot redirect one
instance onto another instance's bot state.

The low-level `app-server` and `gateway` entry points are internal worker
commands. Do not start them directly for an interactive installation; the
instance launcher supplies and owns their complete account identity.

Instance routing ignores the generic `CODEX_APP_SERVER_URL`; an inherited
endpoint from another Codex process must not redirect this bot. Only
`CODEX_DISCORD_APP_SERVER_URL` or the instance-local socket default selects the
Discord delivery endpoint. The instance launcher clears both inherited values
before loading instance state.

Inspect the non-secret effective identity before startup:

```bash
DISCORD_INSTANCE=codex02 \
DISCORD_CONFIG_DIR="$HOME/.codex/channels/discord/codex02" \
codex-discord-channel instance-doctor
```

Use the instance launcher for the visible TUI. It validates the account login
and bot configuration, takes a nonblocking instance lock, starts the app-server
and gateway as its own children, waits for the instance socket, and then starts
the matching Codex client:

```bash
codex-discord-instance codex02
```

The launcher always resolves `runtime/channel.cjs` beside its own marketplace
install, so a stale path in `account.env` cannot mix worker versions. Its child
workers are stopped when that TUI exits; there is no user or system service and
no box-wide singleton. Two aliases can run different installed versions because
each launcher owns only its own account, state directory, lock, socket, and
children. A crashed app-server ends the attached remote TUI; relaunch the alias
to start one coherent generation.

On the first interactive launch, if the Discord instance configuration is
valid and only the isolated OpenAI account login is missing, the launcher runs
the configured `NODE_BIN` and `CODEX_BIN` as `codex login` with that instance's
`CODEX_HOME`. It retries readiness only after login exits successfully. This
bootstrap requires both stdin and stdout to be TTYs; cancellation, login
failure, or a noninteractive invocation exits before either worker or the Codex
TUI starts. Noninteractive worker entry points never attempt account login and
remain fail-closed. Discord credentials are not passed to the login process.

An alias may select the instance, but it is not the isolation or startup
boundary:

```bash
alias codex02='codex-discord-instance codex02'
```

`CODEX_BIN` is the Codex JavaScript entry point executed by `NODE_BIN`, not a
shell launcher or alias. Keep `account.env` mode `0600`. Do not launch a bare
`codex --remote` client: it bypasses the alias-owned lifecycle and cannot prove
that the gateway, app-server, and visible TUI are one coherent generation.

### Runtime Updates

Exit the selected alias first. From an ordinary shell, replace its marketplace
revision and install the new plugin, update any version-pinned alias path, then
relaunch that alias. The Codex CLI may remove the previous installed cache while
installing the replacement, so installing before exit can strand a running old
launcher without its helper files. No Linux restart, systemd reload, global
service restart, or external runtime copy is required. Upgrade aliases
independently and canary one before the next.

The plugin MCP manifest intentionally does not hardcode `codex01`. When Codex
preserves the selected instance variables, the MCP uses them directly. When
Codex starts a marketplace MCP with those variables stripped, the MCP derives
its own `CODEX_HOME` only from its physical
`$CODEX_HOME/plugins/cache/...` working directory and loads that account's
mode-`0600` `discord-instance.env`. It does not search another account or use a
box-wide singleton.

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

## Start One Alias-Owned Runtime

Start or resume the selected instance only through its installed launcher:

```bash
codex-discord-instance INSTANCE resume --last
```

That one process owns the matching app-server, gateway, and visible TUI. Do not
start worker commands separately and do not register systemd units. Keep any
retired `discord-codex-bridge` service disabled; two receivers sharing one bot
make diagnosis ambiguous even when queue deduplication prevents some duplicates.

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
  "runtimeStatusSource": "gateway_health",
  "gatewayLive": true,
  "structuredDeliveryState": "available",
  "sharedAppServerAvailable": true,
  "discordStarted": true
}
```

The top-level `discordStarted` and shared app-server fields always describe the
durable gateway receiver. An MCP process may log in independently for tools;
its diagnostics are reported only as `mcpDiscordClientStarted` and
`mcpDiscordClientReason` and never substitute for missing gateway health.

The command-line sender reads message text from standard input:

```bash
printf '%s' 'status update' |
  DISCORD_INSTANCE=codex01 codex-discord-channel send \
    --channel CHANNEL_ID --reply-to SOURCE_MESSAGE_ID
```

Guarded replies require the exact source `--channel` and `--reply-to` values.
The sender never infers reply identity from mutable `last-inbound.json`. Use
`--followup` with an exact channel only for a deliberate additional message.

Before the first network send for a source Discord message, the sender fsyncs an
`in_flight` receipt under `reply-receipts/` while holding that source's
cross-process lock. The Discord request carries a deterministic nonce with
nonce enforcement. When the create-message response includes that nonce, it
must match. Its returned message id is the durable anchor and becomes terminal
only after an exact read-back proves the same message id, channel, source reply,
content, and bot author; Discord may omit nonce from that later GET.
If the response returns an id with a conflicting nonce, the receipt preserves
that id as permanently uncertain and suppresses both reconciliation and replay.

If a process or network acknowledgement is lost, a later process first
reconciles the recorded message id or any available stable nonce identity. A
request may be repeated with the same enforced nonce only when no message id was
returned and the bounded replay window is still open; Discord nonce enforcement
then returns the original message instead of creating another one. Otherwise it
remains fail-closed. A confirmed receipt suppresses every later automatic
continuation. Discord-origin replies must use this plugin's sender; a generic
Discord MCP sender bypasses the receipt guard.

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

Status also reports queue state, ready and uncertain counts, the current
blocked or degraded reason, and the oldest uncertain retry metadata without
exposing queued message content, tokens, or proxy values.

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
$HOME/.codex/channels/discord/codex01/gateway-health.json
$HOME/.codex/channels/discord/codex01/pending-delivery.json
$HOME/.codex/channels/discord/codex01/reply-receipts/
$HOME/.codex/channels/discord/codex01/app-server.sock
```

Do not commit `.env` or print Discord tokens.

## Operations And Troubleshooting

Useful non-secret checks:

```bash
jq '{blocked,ready:(.items|length),uncertain:(.uncertain|length),completed:(.completed|length)}' \
  "$HOME/.codex/channels/discord/codex01/pending-delivery.json"
cat "$HOME/.codex/channels/discord/codex01/gateway-health.json"
cat "$HOME/.codex/channels/discord/codex01/session-gateway.pid"
```

Do not use `grep -c ... || echo 0` for these checks. A missing file and a clean
file both reach the fallback; inspect the command exit code separately.

| Symptom | Check | Corrective action |
|---|---|---|
| `node: command not found` in a noninteractive shell | `NODE_BIN` in `account.env` | Use an absolute Node 22+ path. |
| An old versioned launcher path reports `No such file or directory` immediately after upgrade | `alias INSTANCE` and `type -a INSTANCE` in the current shell | Reload the shell configuration with `source ~/.bashrc`; verify the alias names the installed version before retrying. Do not reinstall merely to repair an in-memory alias. |
| `Discord instance INSTANCE already has an active launcher` | Exact launcher process plus the holder of `instance-launcher.lock` | Return to the existing visible TUI. If it is unreachable, establish a safe maintenance boundary, `TERM` only the verified launcher PID, wait for its children/socket to disappear, then relaunch in the intended visible terminal. Never delete the lock or start a second receiver. |
| Plugin code changed but tools/behavior did not | Age of the Codex thread and installed runtime path | Exit the selected alias first; from an ordinary shell install the intended revision, update its alias path, then relaunch it with `codex-discord-instance INSTANCE resume --last`. A closed MCP transport cannot hot-reload. |
| `guild_mention_required` | `access.json` `requireMention`, bot user id, `mentionPatterns`, and reply audience | Correct the exact user/role mention pattern. Do not edit `owner.json` or legacy `state.json` as a workaround. |
| `guild_channel_not_enabled` in a thread | Runtime revision, thread parent id, and the parent entry in `access.json` | Upgrade past `0.2.1+git.92d5d37cc13b` and enable the parent channel. New threads inherit parent policy automatically. |
| Peer bot messages are absent | Group `allowFrom`, `allowBots`, current group id, and mention pattern | Allowlist the peer bot and set `allowBots: true` only for the intended group. |
| Gateway says connected but the visible TUI receives nothing | Confirm the launcher, gateway, app-server, and TUI belong to the same alias and installed revision | Exit and relaunch the complete alias with `codex-discord-instance INSTANCE resume --last`; do not attach a bare remote TUI. |
| Queue is stuck at `thread_busy` | Exact current thread and active turn identity | Let the current turn advance; do not start a second receiver or inject terminal input. |
| Queue is degraded by `structured_ack_uncertain` | `deliveryOldestUncertainMessageId`, proof-check time, and exact target read-back | Preserve the item. The gateway completes it only from exact durable proof, never from timeout or automatic `turn/start` replay, while continuing later ready items. |
| One Discord question receives repeated answers | Reply receipt for the exact source channel and message id | Use `discord_channel_send` with exact `channelId` and `replyTo`; automatic repeats are suppressed. Use `followup` only deliberately and do not bypass the guard with a generic Discord sender. |
| Messages reappear after deployment | Runtime path and delivery activation id | Use versioned install paths. Do not reuse an old activation id across incompatible releases. |
| Discord login or send fails behind a corporate network | Status booleans for proxy/TLS and worker environment | Configure `DISCORD_PROXY_URL`; use `DISCORD_INSECURE_TLS` only where the local trust boundary explicitly requires it. Never log the values. |
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
