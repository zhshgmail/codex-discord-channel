---
name: repair-codex-discord-delivery
description: Diagnose and repair Codex Discord startup, inbound delivery, gateway restart, queue, duplicate-reply, and visible-TUI faults. Use when an alias starts but later messages disappear, the gateway exits, an app-server/socket generation is stale, resume history looks missing, or Codex01/Codex02 needs live recovery. Do not use for routine channel configuration.
---

# Repair Codex Discord Delivery

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
3. Snapshot only that alias:

   ```bash
   python3 scripts/inspect_discord_delivery.py --instance codex02
   python3 scripts/recover_startup_generation.py --instance codex02
   ```

4. Apply the recovery helper only when it identifies one exact stale alias
   generation:

   ```bash
   python3 scripts/recover_startup_generation.py --instance codex02 --apply
   ```

5. If it refuses, inspect the manifest, `/proc` environment, parent chain,
   process group, socket inode, and cache path. Terminate only processes proven
   to belong to that exact alias. Never broad-`pkill`; never touch DS, Scan,
   Kimi, K301, or another alias.
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
  archive or discard pre-activation items.
- On every drain, resolve the current loaded top-level TUI through the app
  server. Use returned thread/turn ids only for that RPC.
- A definitive stale-route rejection permits one rediscovery and retry of the
  same stable Discord client id.
- A lost/uncertain RPC response leaves the source in the ordinary FIFO. The
  next drain uses the same stable Discord client id against the current route.
  Do not create a thread-bound uncertainty lane.
- A gateway exit while the TUI remains alive restarts the gateway in place. It
  must not terminate the TUI or invent `resume <thread-id>`.
- App-server loss may require whole-alias relaunch, but the launcher must not
  synthesize or capture a session/thread identity.
- Gateway process PID/generation is only a single-receiver lock inside the
  state directory; it is not Discord account or message identity.

## Repair and tests

Make the smallest repair at the first broken boundary. Add known-bad causal
tests for:

1. stale persisted thread/session data cannot redirect delivery;
2. a restarted host follows the live app-server target;
3. three sequential sources reach one visible TUI;
4. response loss retries the same Discord source after route rotation;
5. activation/version change preserves queued sources;
6. v4 `structured_ack_uncertain` records migrate to the ordinary FIFO;
7. killing only the gateway preserves the TUI PID, restarts the gateway, and a
   later source reaches that same visible TUI;
8. two state directories cannot read or mutate each other's queues.

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

Use a temporary test instance and a repairer-owned Codex TUI. Do not occupy the
user's Codex01/Codex02 slot for testing.

1. Install the exact built version into an isolated cache/state directory.
2. Start it through `codex-discord-instance`.
3. Send at least three sequential uniquely identified sources and verify each
   appears in the visible TUI, not merely in logs or queue state.
4. Kill only the test gateway. Verify the TUI PID remains unchanged and a new
   gateway PID appears.
5. Send a fourth source and verify it reaches the same visible TUI.
6. Verify pending queue and reply-receipt accounting, then exit the validation
   TUI and prove all test-instance processes and socket are gone.

## Deploy one alias at a time

Deployment requires the user's alias window. Snapshot queue/receipts, stop only
the selected alias, install the versioned cache, update only its activation
metadata, and relaunch the whole alias. Never install over a running generation.

Repeat live acceptance independently for Codex01 and Codex02. One alias's GREEN
does not transfer to the other.

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

