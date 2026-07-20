# Structured Delivery Contract

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
2. the PID and generation in the atomic JSON authority record at
   `session-gateway.pid`.

The record is replaced by one atomic rename. A live incumbent remains the
effective receiver until a logged-in successor has proved durable queue and
target readiness, armed its listener, and committed that replacement. The new
record retains the incumbent as fallback, so an A7 incumbent becomes effective
again if the committed successor process dies. Legacy integer PID plus
`.generation` state is accepted only as migration input and is never written by
new claims.

When no live incumbent exists, target readiness is not a receive-startup gate.
The first gateway logs in, proves queue persistence, arms its listener, and
claims authority so accepted events can remain durable until app-server
reconnection or restart delivery.

`owner.json` remains useful for session status and handoff, but it never decides
whether an individual gateway event is accepted. Thread and session ids may
rotate while the same state directory, bot, and gateway continue operating.

## Target Resolution

The app-server connection is initialized once and never supplies thread
settings. Before a turn, the gateway paginates `thread/loaded/list` until the
notification-selected current thread is found, then calls `thread/read` to
prove that it is top-level and inspect its status.

On a fresh endpoint, exactly one top-level loaded thread is required. The
gateway then records that thread as current. A later top-level
`thread/started` notification replaces it, allowing `/clear`, compaction, or
other thread rotation to move delivery even when an older gateway-subscribed
thread remains loaded. Subagent threads are never selected. Without a provable
current thread, delivery fails closed.

## FIFO And Busy State

Every accepted Discord event is persisted before target resolution. Queue
mutations use a process-safe lock and deduplicate pending and completed Discord
identities.

An active target records `thread_busy`. An idle transition may accept only the
queue head. Once `turn/start` is acknowledged, that item is committed complete
and the drain stops. A later item waits for the next idle transition, preventing
two turns from racing on one thread.

## Turn Payload

The request contains only:

- `threadId`
- one sanitized text input containing the Discord envelope
- a stable `clientUserMessageId`

Network text controls are represented as printable escape text. The request
does not contain model, reasoning effort, summary, service tier, personality,
cwd, sandbox, permissions, collaboration mode, or approval overrides. Existing
thread settings remain authoritative.

## Acknowledgement And Deduplication

A successful `turn/start` response is the acceptance boundary. If the request
is known to be rejected or was not sent, the queue head remains retryable. If
the connection or timeout makes acceptance uncertain, the FIFO is blocked as
`structured_ack_uncertain`.

The stable client user message id is echoed by the app-server on the persisted
user item. Before clearing an uncertain block, the gateway reads the target
thread and proves that id already exists. It then commits completion without a
second `turn/start`. If proof is unavailable, the block remains.

## Live Acceptance

After release installation and operator-approved process migration:

1. confirm the gateway and TUI use the same endpoint;
2. confirm status reports structured availability and Discord startup;
3. send one allowed Discord message and observe its structured turn in the
   exact visible TUI;
4. send while busy and confirm FIFO delivery after idle;
5. rotate the thread with `/clear` and confirm the next message targets the new
   visible thread; and
6. confirm no model or reasoning setting changes.

Until those checks are observed, the valid claim is repository readiness plus
the explicit live relaunch boundary, not passive or exact-console success.
