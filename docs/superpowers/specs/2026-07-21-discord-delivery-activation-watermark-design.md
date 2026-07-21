# Discord Delivery Activation Watermark Design

## Problem

The durable queue currently treats every persisted item as eligible after a
gateway restart. Deploying active-turn recovery therefore replayed historical
messages into the visible TUI. Receiver authority prevents duplicate gateways,
but it does not distinguish current-runtime pending input from stale backlog.

## Design

The queue gains a durable activation record and an identity-only archive. The
activation id defaults to the real installed plugin root and may be overridden
with `CODEX_DISCORD_DELIVERY_ACTIVATION_ID`. Versioned runtime installs therefore
rotate activation automatically, while restarts of the same installed runtime
retain the same activation.

Before a receiver can claim authority or resolve a structured target, queue
activation runs under the existing cross-process lock. A missing or changed
activation archives every pending item and clears its delivery block. An item
is eligible only when its stamped activation id exactly matches the current
queue activation. Legacy, missing, or mismatched stamps are archived before
target resolution.

Archived entries retain only channel id, message id, original queue time,
archive time, and disposition. Their message content is removed. Admission
checks pending, completed, and archived identities, so a stale Discord event
cannot re-enter the queue after archival.

New messages are stamped with the active id when atomically enqueued. A crash or
restart in the same runtime may recover those items. A new runtime cannot
deliver them unless an operator explicitly reuses the old activation override.

## Failure Behavior

- Queue activation or archival persistence failure prevents receiver startup.
- Missing or malformed legacy activation metadata is stale, not eligible.
- Archival performs no app-server request and cannot call `turn/start` or
  `turn/steer`.
- TTY and terminal-input delivery remain absent.

## Verification

Tests must prove that startup archives a legacy backlog without host requests,
that a new message admitted after activation uses the normal structured path,
that archived identities deduplicate, and that a same-runtime restart still
recovers a matching pending item. The full package check and plugin validator
remain required before commit and push.
