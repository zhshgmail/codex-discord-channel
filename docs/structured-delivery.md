# Structured Delivery Contract

For the v0.3.18 durable-identity, gateway supervision, resource-budget, slow
shutdown, and stale-state recovery invariants, see
[`runtime-lifecycle-design.md`](runtime-lifecycle-design.md). That document is
normative where older session/thread or receiver-generation wording on this
page describes historical implementations.

## Boundary

Inbound Discord delivery is valid only when the gateway and visible TUI share
one externally reachable Codex app-server. A direct TUI process with an
embedded server cannot satisfy this contract. Repository tests cannot cross
that process boundary, and release-time verification requires relaunching the
TUI with `--remote` against the shared endpoint.

The runtime contains no terminal-input adapter and does not start a private
app-server. Missing, disconnected, or ambiguous shared state is reported as
unavailable while accepted messages remain persisted.

## Receiver Identity

The stable receiver identity is:

1. the normalized Discord instance and its state directory; and
2. the PID and generation in the atomically replaced authority record at
   `session-gateway.pid`.

The record is replaced by one atomic rename. A live incumbent remains the
effective receiver until a logged-in successor has proved durable queue and
target readiness, armed its listener, and committed that replacement. The new
record retains the incumbent as fallback, so an A7 incumbent becomes effective
again if the committed successor process dies.

Pure compatible handoffs store one-line version-2 JSON in
`session-gateway.pid` and may retain a live fallback. Compatibility binds both
the queue-lock protocol and the normalized persistent lock pathname. A change
to either is different: the successor refuses to log in or touch the queue
while an incompatible incumbent is live. The operator must stop and verify the
old gateway before starting the successor. This quiesced transition is
mandatory because independently configurable authority and queue paths could
otherwise let two live gateways lock different inodes while sharing one
authority record. The record carries both `deliveryQueueLockProtocol` and
`deliveryQueueLockIdentity`; a missing legacy identity is incompatible rather
than guessed from the successor's configuration.

When no live incumbent exists, target readiness is not a receive-startup gate.
The first gateway logs in, proves queue persistence, arms its listener, and
claims authority so accepted events can remain durable until app-server
reconnection or restart delivery.

`owner.json` remains useful for session status and handoff, but it never decides
whether an individual gateway event is accepted. Thread and session ids may
rotate while the same state directory, bot, and gateway continue operating.

The standalone gateway's periodic drain loop verifies this durable receiver
authority on every nonempty-queue tick. A superseded receiver keeps checking
with bounded backoff so it can recover if it becomes the effective fallback,
but it cannot resolve a target or submit a turn while another generation is
effective.

## Target Resolution

The app-server connection is initialized once and never supplies thread
settings. Before a turn, the gateway reads the complete bounded
`thread/loaded/list` inventory. Without a previously proven inventory, it reads
every loaded thread without turns and rejects malformed, cyclic, or orphaned
lineage before selecting a top-level current thread. Malformed pages, more than
32 unique threads, or more than 32 pages fail closed.

On a fresh endpoint without a same-connection selection notification, exactly
one top-level loaded thread is required. The gateway then records that thread
as current. A later top-level `thread/started` notification replaces it,
allowing `/clear`, compaction, or other thread rotation to move delivery even
when an older gateway-subscribed thread remains loaded. That selected root is
still verified against the complete bounded inventory before use. Subagent
threads are never selected. Without a provable current thread, delivery fails
closed.

One exact top-level thread selection is checkpointed across a gateway process
restart. The version-2 checkpoint stores only the stable thread id and its
proven loaded-thread inventory; it never persists an active turn id. After a
restart the gateway rereads that exact thread and recovers its current idle,
active, or system-error state before choosing `turn/start` or `turn/steer`.
The checkpoint remains usable only while its target thread is still loaded.
Removed non-target threads do not invalidate that target. After either a
restart or a same-runtime topology change, newly
loaded threads are read without turns and must have an acyclic parent chain
anchored in the previously proven inventory; self-parent, orphan, malformed,
and cyclic lineage fail closed. A newly loaded top-level thread observed only
after restart invalidates the checkpoint so an offline `/clear` cannot steer
back into the old root. Candidate loaded-thread state is not made durable until
every added thread passes this proof. Thread start/close notifications
invalidate the inventory proof; notification state alone can never create or
refresh a checkpoint. The next checkpoint therefore requires another complete
bounded inventory read. Topology revisions during one resolution share a hard
budget of four restarts; the budget is not reset by retry recursion. An empty
loaded set, a missing target thread, an exhausted revision budget, or a
rejected exact turn also clears or rejects the candidate and returns to fresh
top-level resolution.

## FIFO And Active Turns

Every accepted Discord event is persisted before target resolution. Queue
mutations use a process-safe lock and deduplicate pending, completed, and
archived Discord identities.

Ordinary ready FIFO items are state-directory scoped and survive plugin/cache,
launcher, gateway, and TUI generation changes. A version change is not replay
authority and is not a reason to archive or discard them. The stable Discord
source identity and exact durable UserMessage proof remain the delivery and
deduplication boundary.

Legacy v4 `structured_ack_uncertain` records are different: the older runtime
cannot prove whether its former TUI accepted them, so they are retained in a
visible legacy archive and never automatically replayed. This migration rule
does not apply to ordinary ready FIFO sources. Tests pin that an activation
change preserves every ordinary queued Discord source.

Each drain may accept only the queue head. A proven idle target uses
`turn/start`. A proven top-level `systemError` target also uses `turn/start` to
begin the next turn after the failed one; an active subagent never becomes the
target. A target with an exact active turn uses `turn/steer` and supplies that
turn id as `expectedTurnId`; the precondition rejects a stale continuation
without attaching input to another turn. Notifications track live turn changes,
while startup and reconnect recover exactly one `inProgress` turn id from
`thread/read` with turns included. Active targets whose turn identity is absent
or ambiguous record `thread_busy`. `turn/started` wakes the serialized drain, so
a goal continuation that wins an idle-boundary race becomes the bounded delivery
target instead of starving the FIFO. The active turn id is a request precondition
only, not receiver ownership or session binding.

A local app-server may reject `turn/steer` while naming both the exact expected
turn and a different current canonical turn. The gateway trusts that identity
only from the fully anchored local error form and only when its expected id is
the id actually submitted. Before using the replacement it rechecks the same
connection generation, thread-selection revision, top-level root, and fresh TUI
lease, then retries the same logical delivery exactly once. A second such
rejection retains the newly named active turn for the next drain but makes no
third call and reports `thread_busy`. Generic, malformed, mismatched, and remote
errors never establish a turn id; a known rejected request clears only the
unproven active id so the stable root and checkpoint can be reread. A disconnect
or any uncertain acknowledgement never authorizes this retry.

A delayed duplicate `thread/started` for the already proven root under the same
TUI lease does not erase its checkpoint or active-turn proof. A different root
or lease still invalidates that binding.

After either structured request is acknowledged, the gateway requires an exact
durable user-item proof from the target thread. On a local app-server, the
gateway first locates one rollout JSONL whose filename and first
`session_meta.payload.id` exactly match the target thread. It reads only a
bounded recent tail and accepts only an exact structured
`event_msg` in one of two forms: the legacy `payload.type=user_message` record
must carry the stable `payload.client_id`; the current rollout
`payload.type=item_completed` record must carry the exact target
`payload.thread_id` plus an object `payload.item` whose type is exactly
`UserMessage` and whose `client_id` is the same stable client id. A wrong root,
client id, item type or record shape is not proof.
`item/started` and `item/completed` lifecycle notifications are wake-up signals
that start strictly bounded verifier retries; they are never proof themselves.
Startup, reconnect,
and missed-notification recovery perform the same local check without requiring
a prior signal. If bounded local proof is unavailable, reconciliation reads the
exact target thread and accepts only the same structured user item. A positive
response without either durable proof is treated as acknowledgement
uncertainty. That item moves into a visible reconciliation lane with its exact
target, stable client id, attempt count, and next proof-check time. It no longer
blocks unrelated later FIFO items. The gateway may check again for exact durable
proof, but elapsed time is never permission to call `turn/start` again. If the
app-server accepted the first request but neither proof path can observe it, the
item remains fail-closed instead of risking a duplicate turn.

The gateway also inspects the durable queue periodically. Missing endpoints,
missing loaded threads, busy threads, and stale receiver authority retain the
head and retry with exponential backoff from the configured base interval to a
configured maximum. The defaults are 1 second and 30 seconds. Timer, app-server
event, and restart drains all use the same serialized queue lock, in-progress
lease, and acknowledgement boundary. The current lock is a persistent regular
file. A one-shot `flock(1)` child locks an inherited descriptor and exits; the
parent retains the same open file description, so the kernel keeps the
`flock(2)` lock for the complete operation. Release closes the parent
descriptor; it never removes the shared lock pathname, so owner-write rollback
and release have no pathname check/delete ABA window or long-lived
helper-process failure window.
The writer compares the descriptor and pathname device/inode/link identity
both when opening the persistent file and again after `flock(2)` succeeds,
before running the protected operation. Replacement in that interval closes
the descriptor and fails the operation instead of allowing writers to lock two
different inodes.
Acquisition timeout and release failure are surfaced as operation errors. A
legacy directory at the lock pathname is a fail-closed migration error and may
be removed only after the gateway is quiesced and the exact path has been
audited.

## Turn Payload

The request contains only:

- `threadId`
- one sanitized text input containing the Discord envelope
- a stable `clientUserMessageId`
- `expectedTurnId` only for `turn/steer`

Network text controls are represented as printable escape text. The request
does not contain model, reasoning effort, summary, service tier, personality,
cwd, sandbox, permissions, collaboration mode, or approval overrides. Existing
thread settings remain authoritative.

## Acknowledgement And Deduplication

A successful `turn/start` or `turn/steer` response is not by itself the
completion boundary. The gateway must also prove a `userMessage` carrying the
stable client user message id on the exact target thread, either through the
exact local rollout record or the structured recovery read. Lifecycle signals,
unrelated client ids, non-user items, malformed recovery responses, and items
from a different thread are not proof. If the request is known to be rejected
or was not sent, the queue head remains retryable. If the connection, timeout,
or post-ack proof makes acceptance uncertain, the item enters the fail-closed
reconciliation lane as `structured_ack_uncertain`.

The stable client user message id is echoed by the app-server on the persisted
user item. When checking an uncertain item, the gateway reuses only a cached
durable proof or verifies the local rollout again; remote endpoints and local
records outside the bounded tail use the exact target-thread read. A found
proof commits completion without a second structured submission. Otherwise the
item remains visible as degraded while later ready items continue. Neither its
proof-check timestamp nor elapsed time permits a second structured submission.

## Runtime Health

The unique receiver writes `gateway-health.json` atomically with its exact
PID/generation, Discord connection state, app-server state, queue counts, and
last drain result. MCP status reads that record and verifies it against
`session-gateway.pid`; an MCP-local Discord login is reported separately and
cannot impersonate receiver health. Missing, malformed, superseded, or dead
gateway health is explicit.

The instance launcher owns the app-server and gateway as children of one TUI
generation. Exiting the TUI stops both workers. No user service or global
supervisor survives the alias, so a later marketplace launch cannot retain old
business logic in an external process.

## Live Acceptance

After release installation and operator-approved process migration:

1. confirm the gateway and TUI use the same endpoint;
2. confirm status reports structured availability and Discord startup;
3. send one allowed Discord message and observe its structured turn in the
   exact visible TUI;
4. start `/goal`, send while its continuation is active, and confirm
   `turn/steer` attaches the FIFO head to that exact turn before it becomes idle;
5. rotate the thread with `/clear` and confirm the next message targets the new
   visible thread; and
6. confirm no model or reasoning setting changes.

Until those checks are observed, the valid claim is repository readiness plus
the explicit live relaunch boundary, not passive or exact-console success.
