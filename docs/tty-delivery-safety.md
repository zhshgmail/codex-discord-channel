# TTY Delivery Safety Boundary

## Incident

The legacy TTY adapter sends raw bytes with `TIOCSTI`. Those bytes are handled by whichever Codex TUI widget currently owns keyboard input. If the model or reasoning-effort popup is active, Discord text and the submit key can change its selection instead of reaching the composer.

Sending Escape first is not safe. It mutates TUI state, can dismiss unrelated user work, and still provides no proof that the following bytes will reach the composer. The plugin must never readjust a model or effort baseline because the user's current selection is authoritative.

## Fail-Closed Behavior

The shipping runtime now has no automatic raw-key injection path:

- An access-approved Discord message is atomically persisted to `pending-delivery.json` before any delivery attempt. The file is mode `0600` and survives process restarts.
- Queue mutations use a cross-process lock, and pending plus completed items are deduplicated by Discord channel and message id. Concurrent fallback receivers cannot overwrite or replay an accepted event.
- Queue drain checks readiness again before every item. A positive result must come from a code-level host adapter and include both a source and evidence. A bare boolean is not enough.
- Before any TTY write, the queue head is durably marked `delivery_in_progress`. A partial injector failure, process interruption, or post-injection queue-commit failure leaves the FIFO blocked as `delivery_outcome_uncertain`; that item is never replayed automatically, and later items stay queued behind it.
- The current runtime supplies no readiness adapter, so it performs no `TIOCSTI` writes. It logs an `ERROR`, returns `status: "queued"`, and records the blocked reason instead of silently stalling.
- `discord_channel_status` reports `deliverySafety`, `composerReadinessSignal`, `deliveryQueueDepth`, `deliveryBlockedReason`, `deliveryBlockedAt`, `deliveryQueuePath`, and a sanitized queue read error without exposing queued content. Non-TTY modes report `persistence_disabled` rather than claiming queue safety.
- No Escape byte is prepended. No model, reasoning-effort, or service-tier value is read or changed.

The receiver only persists and reports the queue; it never calls the drain seam or waits on a readiness provider. The code-level drain seam exists for a future host-owned readiness adapter and for deterministic tests. It is not exposed as an environment switch, MCP tool, or CLI command.

When a host-owned adapter does invoke that seam after verified readiness, each sanitized prompt is wrapped as one terminal bracketed-paste frame and its configured submit key is appended in the same injector invocation. The previous two-process sequence (plain prompt bytes, a timing delay, then `CR`) could leave Codex's paste-burst detector treating Enter as pasted text and also exposed an interleaving window between messages. Atomic framing removes those two defects, but it does not prove focus, draft state, or delivery acknowledgement; the fail-closed readiness and uncertain-outcome rules still apply.

Persistent storage is a hard dependency. If the queue file or its parent filesystem cannot be written, the receiver logs `ERROR`, returns `delivery_queue_persist_failed`, and performs no injection; no implementation can promise durable acceptance when its storage has failed. The queue also grows while no structured consumer exists, so operators must monitor queue depth and filesystem capacity rather than treating queue-only mode as a permanent transport.

## Codex 0.144.1 Boundary

Codex CLI 0.144.1 has the required state internally: the TUI's `BottomPane` can distinguish the regular composer from active modal views and popups through `no_modal_or_popup_active()`. That predicate is private in-process state; it is not exported through the terminal, session owner metadata, or app-server protocol.

References for the installed version:

- [`BottomPane::no_modal_or_popup_active`](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/tui/src/bottom_pane/mod.rs#L1349-L1356)
- [TUI embedded versus remote app-server selection](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/tui/src/lib.rs#L394-L476)
- [App-server thread and turn API](https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/app-server/README.md#L77-L80)

TTY identity, process state, cursor position, terminal output, timing delays, and probe keystrokes do not prove which widget will consume the next input byte. Even a point-in-time external focus observation could race with the user opening a popup before injection completes. Therefore the current TUI provides no verifiable condition that this plugin can use to auto-flush raw keystrokes.

## Structured Delivery Migration

The durable solution is to remove keyboard emulation from inbound delivery:

1. Run the visible TUI against a persistent app-server endpoint instead of its private embedded server, and prove the TUI and plugin are connected to the same endpoint.
2. Bind delivery to the exact owned thread id. Reject or retain queued items when that binding cannot be proved.
3. Submit each queued Discord item through `turn/start` or the appropriate active-turn API. Omit `model`, reasoning-effort, service-tier, and other settings overrides so the user's current thread choices remain unchanged.
4. Correlate the request with the Discord channel and message id, remove the queue head only after structured acceptance, and continue FIFO. On active-turn rejection, disconnection, or uncertain acknowledgement, leave the item persisted and expose the error. Reconcile any `delivery_outcome_uncertain` head explicitly; never replay it speculatively.
5. Drive visible transcript updates and completion from app-server notifications. Do not send TTY control or text bytes.

An embedded TUI app-server has no external endpoint for the plugin to join. Until the host exposes one or the session uses a shared persistent endpoint, inbound messages must remain queued.
