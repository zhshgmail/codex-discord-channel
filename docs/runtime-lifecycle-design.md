# Runtime Identity, Delivery, And Gateway Lifecycle

Status: v0.3.18 architecture contract.

This document defines the stable design behind alias startup, Discord inbound
delivery, gateway restart, resource bounds, shutdown, and stale-state recovery.
It is normative for new runtime and launcher changes. `structured-delivery.md`
contains the detailed FIFO and app-server protocol.

## One durable identity

An instance is identified by its normalized `DISCORD_STATE_DIR`. The directory
owns the bot configuration, queue, receiver record, socket, generation runtime,
health, and diagnostics.

Session, thread, turn, rollout, PID, process group, executable path, cache path,
and launcher nonce are transient observations. They may address a current RPC
or prove that a process is still the one previously inspected. They MUST NOT be
used as authentication, instance ownership, inbound admission, replay
authority, restart authority, or durable identity.

Consequences:

- `/clear`, compaction, native resume, and a new top-level TUI do not change the
  Discord instance.
- `owner.json` is status and handoff metadata, never a per-message receive gate.
- a PID is accepted for signalling only when Linux start ticks, role, state
  directory, and command shape still match the inspected process.
- a versioned cache path is activation metadata, not instance identity.

## Delivery completion is durable visibility

Every accepted Discord source is persisted before app-server delivery and has
one stable `clientUserMessageId` derived from channel and message identity.

`turn/start` or `turn/steer` success proves only RPC acceptance. It does not
prove that the input reached the visible TUI. The FIFO item can become completed
only after the exact target rollout or an exact structured thread read contains
a `UserMessage` with the matching stable client id.

If proof is absent, the original source stays in the ordinary FIFO. It is not
silently dequeued, reclassified as delivered, or blindly resubmitted. This rule
prevents both loss and duplicate turns.

Target selection is dynamic. Explicit top-level `threadSource=system` threads
are ineligible because title/background work can accept RPCs without being the
visible user TUI. Thread and active-turn ids are used only for the current RPC;
they are not durable receiver state.

## One gateway per state directory

Codex01 and Codex02 have separate state directories and therefore separate
gateways, sockets, queues, and recovery domains. There is no host-global
gateway.

`session-gateway.pid` is a diagnostic/coordination record. It contains PID,
Linux start ticks, role, state directory, and generation. A live record whose
process still matches is protected. A dead, reused, or mismatched record is
stale, not an authority barrier.

A successor may replace a stale record only after Discord login, durable queue
readiness, receiver-listener readiness, and atomic compare/revalidation of the
observed record. Replacement emits an explicit warning with the stale identity,
reason, state path, and action. This makes the safe automatic repair visible
without forcing an operator to delete files.

The Unix socket follows the same rule where ownership is unambiguous. A real
live listener blocks a duplicate launcher with an actionable diagnostic. A
socket with no manifest and no listener is revalidated by inode and removed
automatically with a warning. A malformed or ambiguous manifest fails closed
and preserves the socket for diagnosis.

## Gateway supervision

The alias launcher owns one native app-server, one gateway supervisor, and one
visible TUI generation. If only the gateway exits, the supervisor restarts only
the gateway and prints a visible TUI warning. It never kills the TUI and never
synthesizes a session/thread resume command.

Repeated gateway creation remains state-directory scoped. Two simultaneous
launchers cannot both become the live receiver: the live matching record and
socket listener win; the other launch exits with the exact state directory and
stop/retry guidance.

## Resource budget

The gateway is long-lived and must not retain unbounded Discord.js caches:

- messages: 5 per channel;
- reactions: 0;
- members: 8 per guild;
- presences: 0;
- voice states: 0;
- thread members: 0;
- users: 32;
- message sweeper: every 60 seconds, 120-second lifetime;
- thread sweeper: every 300 seconds, 900-second lifetime.

Health records RSS, heap total/used, external memory, array buffers, host total
memory, and cache counts. The effective restart limit is the smaller of the
configured limit (2 GiB by default) and the host-relative cap, where that cap
is 25% of host RAM with a 256 MiB floor. Three consecutive over-limit samples
at 30-second intervals cause a gateway-only graceful restart. One below-limit
sample resets the streak. A single spike is not a restart signal.

These limits protect the TUI and product workers from a gateway that once grew
to a majority of host memory, while avoiding a host-global process killer.

## Bounded shutdown and handoff

Gateway-internal shutdown is bounded to 20 seconds total:

- Discord client close: 5 seconds;
- queue/drain stop: 5 seconds;
- receiver release: 3 seconds.

The launcher grants 30 seconds by default, configurable from 1 to 120 seconds,
then signals only the still-matching gateway process group. Polling uses bounded
250 ms intervals, with at most 120 external `sleep` calls at the default grace,
instead of the former 50 ms shape that could launch 600. Process identity is
revalidated on every interval; scheduler pressure cannot grant authority to a
reused PID, and the interval count remains bounded.

If a wedged process requires forced termination, stale PID/socket/generation
artifacts are recoverable inputs for the next start. The next launcher performs
the guarded automatic repairs above. Handoff therefore does not depend on the
old gateway completing cleanup.

## Acceptance gates

A release is not accepted from unit tests or health alone. It requires:

1. source and installed-cache byte identity;
2. three rapid Discord sources visible as three ordered UserMessages in the
   same real TUI, with exact outbound reply readback;
3. exact gateway termination followed by gateway-only restart while the TUI and
   native app-server remain alive;
4. a post-restart message visible in that same TUI;
5. a wedged-gateway test proving bounded cleanup and a subsequent launch proving
   stale-record/socket automatic recovery;
6. resource health showing bounded caches and current RSS/heap telemetry;
7. a known-bad where RPC success without durable UserMessage proof does not
   complete the queue item.

## Change discipline

New safety checks must protect a stable object. Do not introduce an ephemeral id
as a new durable gate. Prefer diagnosis plus automatic repair for a state that
can be proven stale. Fail closed only where ambiguity could duplicate or lose a
Discord source; do not turn diagnostic metadata into authorization.
