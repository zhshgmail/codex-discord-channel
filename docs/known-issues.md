# Known Issues And Operational Boundaries

This page records user-visible failures that can otherwise look successful in
gateway logs. It deliberately separates transport acceptance, durable thread
delivery, and model behavior.

## Acknowledged Turn Missing From The Visible Thread

### Symptom

The gateway logs both:

```text
Accepted queued Discord message through the shared app-server
Discord message delivery result {"status":"delivered","reason":"turn_accepted"}
```

and `pending-delivery.json` moves the Discord identity into `completed`, but the
message is absent from the exact target thread's rollout and the visible TUI.
The owner sees no response even though the queue is empty.

### Cause

Releases through `0.2.0+git.9b74c5c20047` treated a successful
`turn/start` or `turn/steer` response as the final completion boundary. The
stable `clientUserMessageId` read-back check was used only when the request
acknowledgement was uncertain. A positive response followed by a missing user
item therefore produced a false completed record and suppressed replay.

This is an acknowledgement-boundary defect. It is not an access-policy,
mention, Discord login, or FIFO persistence failure.

### Observed Stale-Runtime Recurrence

On 2026-07-30/31, a user-reported missing Discord message was investigated
after the fix was already present in the repository at `508c340`. The active
`codex01` systemd unit was still executing the older affected runtime
`0.2.0+git.9b74c5c20047`, and that process had started before the fix was
published. The queue continued to record positive `turn_accepted` results.

This establishes a deployment-identity gap: a fixed checkout does not repair
an already-running gateway. It does not, by itself, attribute a particular
missing message when that message's Discord id is unavailable. For an exact
incident verdict, apply the four diagnosis steps below to that id.

### Fixed Behavior

After a positive structured response, the gateway now requires an exact
`userMessage` proof from the exact target thread with the same stable
`clientUserMessageId`. On a local app-server, one exact rollout filename,
matching `session_meta` identity, and exact structured user-message JSONL record
supplies bounded durable proof. `item/started` and `item/completed` lifecycle
notifications only wake that verifier and are not proof. Startup, reconnect,
or a missed notification performs the same local verification before using the
existing structured `thread/read` recovery path. Only a durable rollout record
or exact readback can move the Discord identity into `completed`.

If the user item is not observable, the item remains durable and status reports
`deliveryState=degraded`, `structured_ack_uncertain`, its stable message id,
attempt count, and retry time. Periodic reconciliation checks for the stable
client id and completes without a second request once the item appears. If it
does not appear, the item remains fail-closed while later FIFO items continue;
timeout never authorizes a second request, and one uncertain item no longer
freezes all inbound delivery.

### Diagnosis

1. Find the message id in `last-inbound.json`.
2. Find the same identity in `pending-delivery.json`.
3. Check `session-gateway.log` for the access-policy and delivery result.
4. Inspect the exact current thread rollout, not merely the newest rollout.

The failure is present when the identity is in `completed`, the gateway reports
`turn_accepted`, and the exact rollout has no matching Discord envelope.

### Remaining Boundary

Read-back proves that the user item is durably attached to the intended Codex
thread. It does not prove that the model understood every instruction, produced
a reply, or completed the requested work. Those are application-level
acceptance conditions and must be verified separately.

## Full Thread Read Exceeds The Acknowledgement Timeout

### Observed Incident

On 2026-07-31, target thread
`019f3763-d308-7871-bedc-e6489b02190e` contained 754 turns. The exact Discord
client id `discord:1532907289823154277:1532923072833781810` was present in that
thread's rollout as a structured `event_msg.payload.type=user_message` record.
A live `thread/read` with `includeTurns:true` took 62.289 seconds, while the
gateway request timeout was 30 seconds. The read timed out and the FIFO remained
blocked at `structured_ack_uncertain` even though the user item was durable.

The operational mitigation raised
`CODEX_DISCORD_APP_SERVER_REQUEST_TIMEOUT_MS` to 120000. That allowed the full
read to finish and the queue was cleared only after exact rollout proof. This
is a timeout accommodation, not a source fix: recovery still scales with total
thread history and can exceed a larger timeout as the thread grows.

### Source-Level Fix

Positive delivery now uses bounded local rollout verification. The verifier
selects one exact rollout filename, validates the target thread id from the
first JSONL record, and scans only a bounded recent tail for the exact
structured user-message client id. It does not read the full rollout. An exact
`item/started` or `item/completed` notification starts a strictly bounded set of
verifier retries so event-before-append ordering is covered, but the event
cannot complete the queue without that durable record. Unrelated ids,
non-user items, malformed JSON, substring matches in command or tool text, and
other threads cannot complete the queue head.

Startup, reconnect, and missed-notification recovery also check the local
rollout. The full `thread/read` remains the supported fail-closed fallback for
remote app-servers, unavailable or ambiguous files, malformed identity, and
records older than the bounded tail. The returned thread id and structured item
shape must match exactly. A timeout, unsupported request, malformed response,
wrong thread, or missing client id remains `structured_ack_uncertain`; none is
converted into delivered. It is visible in the reconciliation lane instead of
becoming a permanent global queue block, and timeout never authorizes another
`turn/start` call.

This behavior is repository source behavior until the parent-owned deployment,
restart, Discord send, and exact read-back checks have completed. The 120-second
setting may remain useful operationally for fallback recovery, but it is not
required when bounded local rollout proof succeeds.

## Mentioned Guild Message Is Not Accepted

Check `access.json`, not `owner.json`:

- the guild parent channel or an exact thread override must exist under `groups`;
- the sender must be allowed;
- bot senders require `allowBots: true`;
- with `requireMention: true`, the message must match the current bot user id,
  a configured `mentionPatterns` entry, `@everyone`, or the documented reply
  audience rules.

`owner.json` records status and handoff metadata only. It must never gate an
individual inbound message because `/clear` can rotate thread identity while
the same Discord state path remains active.

## Thread Message Is Denied Although Its Parent Channel Is Enabled

### Symptom

The Discord gateway remains connected and logs current events, but a message
inside a newly created thread is denied with `guild_channel_not_enabled`. The
same mentioned sender is accepted in the parent channel.

### Cause

Releases through `0.2.1+git.92d5d37cc13b` looked up guild policy only by the
message's exact `channelId`. Discord threads have their own channel IDs, so an
enabled parent channel did not authorize any thread created below it. History
lookup encoded the same incorrect exact-ID requirement in a unit test.

### Fixed Behavior

An exact thread policy remains an optional override. Otherwise, public,
private, and announcement threads inherit `requireMention`, `allowFrom`, and
`allowBots` from an enabled parent channel. The actual thread ID remains the
delivery and reply destination. Ordinary text channels do not inherit policy
from category parents, and threads below unknown parents remain fail-closed.

This matches the Claude Code Discord plugin's access boundary: policy is keyed
by `thread.parentId`, while replies continue to use the thread's own ID.

## A Local Codex Reply Is Not Visible In Discord

### Symptom

A Discord-origin message is present in the active Codex transcript and Codex
produces `commentary` or a final response locally, but the Discord thread shows
no bot reply. The operator can see progress in the console while the Discord
user has no status at all.

### Cause

Inbound structured delivery and outbound Discord delivery are separate
transports. The source envelope proves where a request came from; it does not
make ordinary Codex response items into Discord messages. In particular,
working `commentary` is local progress output. A local final response is also
not a Discord delivery receipt unless an outbound Discord send path actually
returns a message identity.

This failure was reproduced on 2026-07-31 in thread
`1532884892159836281`: multiple local responses existed while the owner saw no
Discord reply. Explicit outbound send produced message
`1532897832485523738`, which was then read back from that exact thread.

### Required Behavior

For every reply-required Discord-origin turn:

1. send the user-facing response explicitly to the source channel or thread;
2. retain the returned stable Discord message ID;
3. read that exact ID back from the exact destination; and
4. only then claim that the user can see the response in Discord.

Do not use local console visibility, a completed inbound queue item, model turn
completion, or a successful send call without exact read-back as evidence of
outbound delivery.

## One Discord Question Receives Repeated Answers

### Observed Incident

On 2026-08-02, source message `1533449151742869614` appeared once in Discord
and once in the durable inbound queue. The queue moved it to `completed`, but
Codex01 posted ten answers over later automatic continuations. Only the first
answer referenced the source message; the other nine were ordinary channel
messages.

### Cause

Inbound completion and outbound reply completion were separate facts. The
plugin deduplicated `(channelId, messageId)` on ingress, but had no durable
record saying that source message had already received its answer. A later
continuation could therefore send again. Inferring a reply from mutable
`last-inbound.json` is also unsafe: a stale continuation can be rebound to a
newer same-channel question. A generic Discord MCP sender made the gap larger
because it did not share any plugin state.

This is an outbound reply-lifecycle defect. It is not evidence that the inbound
FIFO replayed the source message: in the observed incident, ingress completed
once.

### Fixed Behavior

The plugin sender now requires the exact source channel and message id and
fsyncs a versioned state receipt for that identity before the network send. It
never derives a guarded reply identity from `last-inbound.json`. Receipt
transitions are serialized by a per-source cross-process lock: `in_flight` is
leased and recoverable after process death, `uncertain` must reconcile by exact
outbound message id or, before an id is known, deterministic Discord nonce, and
`confirmed` is terminal.

Every guarded send uses the same source-derived nonce with Discord nonce
enforcement. The create-message response nonce, when present, must match. Its
returned message id is not confirmed until an exact GET matches that id,
channel, source reply, content, and bot author; Discord may omit nonce from the
GET. A response id paired with a conflicting nonce is preserved in a permanently
uncertain receipt that suppresses both reconciliation and replay. When the
network fails before acknowledgement, a retry first reconciles any durable
identity available. If no match is found and no Discord message id was returned,
the same enforced nonce may be retried only inside a bounded window, allowing
Discord to return the original message without duplicating it. A returned
message id and stale uncertainty remain fail-closed. This repairs the case where
an ordinary network error created no message but the old pre-send claim
permanently consumed the source reply right, without turning uncertain sends
into blind replays.

Deterministic preflight failures do not consume the reply. A deliberate
additional message requires the explicit `followup` flag.

Discord-origin replies must use `discord_channel_send` or the plugin CLI. A
generic Discord MCP sender cannot participate in this receipt protocol and is
therefore not a valid reply path for a reply-required turn.

## Gateway Is Healthy But Messages Go To No Visible Console

The gateway and visible TUI must share the same externally reachable Codex
app-server. Exit only the affected alias and relaunch it with
`codex-discord-instance INSTANCE resume --last`; a direct TUI uses a private
embedded server that this gateway cannot prove or target. Do not start a bare
remote TUI or either worker independently.

Verify `session-gateway.pid` before investigating model behavior. Exactly one
effective receiver generation may accept Discord events. Keep the retired
`discord-codex-bridge` service disabled so it cannot compete for the bot.

## Abnormal Launcher Death Leaves A Socket That Blocks Relaunch

### Symptom

After the visible TUI or its launcher is killed abnormally, the shell launcher
has released its flock but a Node wrapper or native app-server listener remains.
An immediate same-alias launch then reports `already has an app-server socket`.

### Source-Level Recovery

v0.3.6 and later persist one atomic alias-local generation manifest.
It binds a nonce to the instance, state directory, account home, installed
plugin root, launcher PID/start ticks, isolated app process-group
PID/start-ticks/PGID, and ready socket device/inode. Long-lived children close
the launcher flock descriptor, so a new launcher can acquire the lock after an
abnormal launcher death.

While holding that lock, a relaunch automatically reclaims only an exact dead
generation whose live group members still match the recorded generation,
roles, command lines, environment, endpoint, and single listener. Teardown is
TERM, bounded wait, then KILL of the exact isolated groups. Socket unlink and
manifest removal use identity checks so a replaced socket cannot be deleted.
Normal cleanup masks repeated INT, TERM, and HUP before stopping the same groups.

Missing or malformed manifests, a live or reused launcher PID, a wrong or
reused app identity, a foreign group member or listener, multiple listeners,
and socket-inode replacement all retain status 73 and touch nothing. Do not
turn those refusals into manual socket deletion; verify the exact owner first.

## Installed Plugin Changes Do Not Appear In An Existing Session

An already-open MCP transport does not hot-load replaced plugin code. Exit the
selected alias first, then use an ordinary shell to install the new plugin
version through that account's marketplace, update its version-pinned alias
path, and relaunch the complete alias. The installer may remove the old cache;
never replace it under a running launcher. The alias-owned launcher starts its
matching gateway, app-server, and TUI from one versioned cache generation; do
not migrate one worker independently. The versioned runtime directory also
keeps the durable delivery activation boundary from replaying an old backlog.
