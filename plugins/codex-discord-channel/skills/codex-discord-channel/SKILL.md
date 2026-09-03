---
name: repair-codex-discord-delivery
description: Use for every request delivered in a <channel source="discord" ...> envelope that requires a reply, and to diagnose or repair Codex Discord startup, inbound delivery, gateway restart, queue, duplicate-reply, and visible-TUI faults. Do not use for routine channel configuration.
---

# Repair Codex Discord Delivery

## Discord-origin reply gate (always)

For every request delivered in a `<channel source="discord" ...
reply="required">` envelope, this gate applies even when no delivery fault is
being diagnosed.

1. If the source or a newer owner instruction says to finish a read, handover,
   verification, or other explicit no-reply gate first, send **zero** Discord
   messages until that gate is complete. Continue all separable assigned work.
2. After the gate, reply exactly once to that source with the current instance's
   `mcp__codex_discord_channel__discord_channel_send` tool and these exact
   fields: `{channelId: <channel_id>, replyTo: <message_id>, content: <reply>}`.
   Never use a generic Discord sender, another alias, a webhook, or
   `{followup: true}` for the required source reply.
3. Retain the returned stable outbound message id. Then use this instance's
   `mcp__codex_discord_channel__discord_channel_read_history` for the same
   `channelId` and verify the outbound id, exact channel, reply parent, content,
   and current bot author identity. Console output, an accepted send call,
   queue state, or a receipt alone is not delivery.
4. If readback is absent, uncertain, or mismatched, do not silently claim
   success and do not send a duplicate. Preserve the source/outbound ids and
   diagnose the first missing proof boundary.

This reply workflow never authorizes installing or upgrading the plugin, or
restarting, killing, or replacing its gateway, app server, or TUI.

## Non-negotiable identity model

`DISCORD_STATE_DIR` (normally selected by the instance configuration) is the
only durable Discord bot identity.

- Token, access policy, inbound FIFO, reply receipts, gateway authority,
  health, and app-server socket all live under that state directory.
- Codex session, thread, turn, rollout, launcher nonce, and TUI lease ids are
  transient transport coordinates only. Never persist or compare them as
  ownership, authentication, receive, replay, or restart gates.
- `/clear`, resume, TUI replacement, gateway replacement, and thread rotation
  must not change which Discord queue the instance consumes.
- `owner.json` is status/handover metadata only. It cannot admit or reject a
  message.
- Completed inbound records persist only Discord source identity and the stable
  client message id. Never persist Codex thread, turn, session, or lease ids in
  the delivery queue.
- Do not add a session/thread binding to make a test pass. A test requiring one
  is a legacy-contract test and must be replaced by a state-directory causal
  test.

This follows the official Claude Code Discord plugin shape: the state directory
owns configuration and inbox, while an admitted Discord event is forwarded to
the current host. Codex needs an app-server RPC coordinate, but must discover it
at delivery time and forget it as identity.

## Fast startup recovery

For `already has an app-server socket`, stale generation, wrong socket inode,
or process-group mismatch:

1. Stop repeated alias launches.
2. Resolve the alias (`type -a codex01` / `codex02`) and the exact instance state
   directory. Inspect the installed cache named by the active command line; do
   not infer live bytes from a checkout.
3. Run the installed, read-only doctor for that exact alias:

   ```bash
   <installed-plugin>/bin/codex-discord-channel instance-doctor \
     --instance codex02 --state-dir ~/.codex/channels/discord/codex02
   ```

4. If startup refuses, inspect the manifest, `/proc` environment, parent chain,
   process group, socket inode, and cache path. Terminate only processes proven
   to belong to that exact alias. Never broad-`pkill`; never touch DS, Scan,
   Kimi, K301, or another alias.
5. Do not treat inherited `CODEX_DISCORD_LAUNCH_*` environment variables as
   process ownership. Commands launched through the app server inherit them.
   An independent process group whose leader argv is not a Discord role is not
   part of the Discord generation and must neither be killed nor block reclaim.
6. Preserve `pending-delivery.json`, reply receipts, access policy, account
   binding, and `sessions/` bytes. A resume picker hiding old sessions is not
   deletion evidence; use `resume --all --include-non-interactive` for history
   discovery when needed.
7. Launch the whole instance once:

   ```bash
   codex-discord-instance codex02 --dangerously-bypass-approvals-and-sandbox resume --last
   ```

Never start gateway/app-server/TUI workers separately.

## Diagnose delivery

Read the exact installed skill and runtime first. For the target state directory
record, without printing message text or tokens:

- gateway PID/generation and its live command line;
- app-server PID, Unix socket path and inode;
- launcher/TUI PIDs and exact installed cache path;
- queue schema, depth, FIFO Discord `(channelId,messageId)`, and last reason;
- account binding and access-policy paths;
- plugin version and runtime digest.

Compare `last-inbound.json` mtime with `gateway-health.json`. A fresh health
heartbeat plus a stale last inbound is a silent-receiver symptom, not proof of
health. Inspect the exact gateway's sockets (`ss -tpn`) and recent log before
restarting it. `SYN-SENT`, a proxy 403, or repeated gateway process creation is
the first broken boundary. Freeze or stop only that exact gateway if it is
spamming the TUI; preserve the app server and product processes.

Then trace one source:

```text
Discord (channelId,messageId)
  -> state-dir FIFO
  -> current app-server route discovered now
  -> visible TUI user item
  -> assistant final
  -> state-dir reply receipt
  -> Discord outbound id
  -> exact-destination readback
```

Stop at the first missing arrow. Service health, queue removal, RPC acceptance,
or a console final is not visible-TUI or outbound proof.

## Required runtime behavior

- Every admitted source is persisted before injection and deduplicated only by
  Discord channel plus message id.
- Plugin activation/version changes preserve all queued sources. They do not
  archive or discard ready FIFO items. Legacy `structured_ack_uncertain`
  entries are the exception: preserve their full Discord source in the archive
  with reason `legacy_ack_uncertain_no_auto_replay`, but never execute them
  automatically because the old sender could not prove whether Codex accepted
  them.
- On every drain, resolve the current loaded top-level TUI through the app
  server. Use returned thread/turn ids only for that RPC.
- Ignore app-server threads whose explicit `threadSource` is `system`. Title
  generation and other background system work can be top-level and active, but
  it is not a visible user TUI and must never replace the delivery target.
  Select a current non-system top-level user thread at drain time; do not
  persist its thread id after the RPC.
- A definitive stale-route rejection permits one rediscovery and retry of the
  same stable Discord client id.
- A lost/uncertain RPC response leaves the source in the ordinary FIFO. The
  next drain uses the same stable Discord client id against the current route.
  Do not create a thread-bound uncertainty lane.
- A gateway exit while the TUI remains alive retries autonomously without
  terminating the TUI, inventing `resume <thread-id>`, or writing restart text
  into the TUI terminal. Repeated startup failures must wait between attempts;
  they must not form a tight process-creation loop.
- App-server loss may require whole-alias relaunch, but the launcher must not
  synthesize or capture a session/thread identity.
- Gateway process PID/generation is only a single-receiver lock inside the
  state directory; it is not Discord account or message identity.
- Automatic assistant-final mapping is disabled. Outbound Discord replies use
  the explicit receipt-aware sender with exact `(channelId,messageId)` source;
  no persisted Codex thread/turn may select an outbound reply.
- Before app-server or gateway start, the launcher copies the generation helper
  and channel runtime to `DISCORD_STATE_DIR/generation-runtime/current`. Worker
  restart and cleanup use that durable snapshot so a marketplace cache refresh
  cannot strand the live generation.

## Gateway resource and shutdown contract

- Discord.js caches are transient accelerators, not evidence. Keep message,
  member, user, reaction, presence, voice, and thread-member caches tightly
  bounded; the state-dir FIFO and receipts are the durable store.
- Persist queue state before injection. Memory pressure, TERM, timeout, crash,
  or gateway replacement must leave the same FIFO source recoverable.
- Publish gateway RSS, heap use, cache counts, and current retry state in
  `gateway-health.json`. Diagnose the exact gateway process; do not attribute
  app-server or TUI RSS to it.
- Sustained high RSS may exit only the exact gateway so the launcher can retry
  it. Require multiple consecutive samples; never act on one spike and never
  kill the TUI or app-server for gateway memory pressure.
- Shutdown order is receiver fence, Discord client close, drain settlement,
  receiver release, then exit. Every network/queue step is bounded. The alias
  launcher gives a high-RSS gateway a longer grace period, then escalates only
  the state-dir and process-start-time verified gateway group.
- A slow or wedged gateway cannot hold handoff indefinitely. Exceeding the
  total grace produces a precise diagnostic and exits; the successor recovers
  the already durable FIFO. Launcher polling must not use hundreds of tiny
  external sleeps whose fork overhead expands the advertised grace under
  memory pressure. PID alone is never sufficient cleanup authority.
- A forced gateway kill may leave `session-gateway.pid` behind. On the next
  alias start, diagnose the exact stale PID and authority path, then replace it
  automatically only after Discord login and durable queue readiness. A live
  PID/start-time match remains a duplicate-receiver error, not cleanup fuel.

## Repair and tests

Make the smallest repair at the first broken boundary. Add known-bad causal
tests for:

1. stale persisted thread/session data cannot redirect delivery;
2. a restarted host follows the live app-server target;
3. three sequential sources reach one visible TUI;
4. response loss retries the same Discord source after route rotation;
5. activation/version change preserves queued sources;
6. v4 `structured_ack_uncertain` records retain full source bytes in the
   archive and never auto-replay, while ordinary ready FIFO entries still drain;
7. killing only the gateway preserves the TUI PID, eventually starts a
   replacement, and writes no restart notice into the TUI terminal;
8. two state directories cannot read or mutate each other's queues.
9. deleting the installed marketplace cache while the test TUI is active does
   not prevent gateway retry or exact generation cleanup.
10. a newer top-level `threadSource=system` background thread cannot replace an
    older visible user TUI as the delivery target.
11. two state directories sharing one `CODEX_HOME` cannot use each other's
    rollout UserMessage as delivery proof.
12. a no-manifest orphan socket that changes inode before unlink is preserved
    and startup fails with an actionable diagnostic.
13. sustained gateway memory pressure triggers gateway-only retry without a
   tight restart loop or terminal spam.
14. a hung drain or Discord close cannot exceed the configured handoff grace,
    and the persistent FIFO remains available to the successor.
15. a `SIGSTOP`ed gateway is force-killed within the configured launcher bound,
    while a dead receiver file is replaced at next start with an actionable
    warning and a live receiver remains untouched.

Legacy tests that require durable session/thread/turn/lease identity must be
explicitly labeled retired. Do not silently weaken unrelated access, queue,
concurrency, receiver-lock, receipt, or exact-outbound tests.

Run the focused tests, then:

```bash
npm run build
npm run check
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .
```

Report pass/fail/cancel/skip counts. Skips must be an enumerated retired
contract, never incidental cancellation.

## Isolated live acceptance before deployment

Use only the owner-designated test alias and a repairer-owned Codex TUI. Do not
occupy Codex01/Codex02 unless the owner explicitly selected that alias for live
experiments; when Codex02 is selected, launch it from its own workspace and
account home, never from the Codex01 checkout.

1. Install the exact built version into an isolated cache/state directory.
2. Start it through `codex-discord-instance`.
3. Send at least three sequential uniquely identified sources and verify each
   appears in the visible TUI, not merely in logs or queue state.
4. Kill only the test gateway. Verify the TUI PID remains unchanged, a new
   gateway PID eventually appears, and no restart notice is written to the TUI
   terminal.
5. Send a fourth source and verify it reaches the same visible TUI.
6. Verify pending queue and reply-receipt accounting, then exit the validation
   TUI and prove all test-instance processes and socket are gone.
7. For shutdown/resource repairs, `SIGSTOP` the exact PID/start-time-verified
   test gateway, exit the TUI normally, and measure bounded cleanup. Relaunch
   once to prove the stale receiver record is warned about and atomically
   replaced, then leave the test alias stopped.

## Deploy one alias at a time

Deployment requires the user's alias window. Snapshot queue/receipts, stop only
the selected alias, install the versioned cache, update only its activation
metadata, and relaunch the whole alias. Never install over a running generation.

Repeat live acceptance independently for Codex01 and Codex02. One alias's GREEN
does not transfer to the other.

## Alias-Owned Runtime Boundary

Exit only the selected alias before changing its installed marketplace bytes.
Then install the released plugin, update that alias's marketplace revision, and
launch the whole instance once. The running generation itself uses its durable
state-directory runtime snapshot, but deployment must still be one alias at a
time so acceptance remains attributable.

## Outbound acceptance

For one reply-required source, require one durable per-source receipt, one
stable outbound Discord id, and exact channel/thread readback showing the right
reply reference, bot identity, and content. Use the plugin's receipt-aware MCP
sender or released CLI; never a generic webhook as proof.

## Stop conditions

- Stop destructive cleanup if exact alias/process ownership is ambiguous.
- Stop deployment if queues/receipts drift without explanation.
- Do not expose tokens or commit `.env`.
- Do not leave a repairer-launched TUI holding the user's alias slot.
- Never claim fixed from tests alone; label source, installed, component-health,
  visible-TUI, and outbound-readback evidence separately.
