# Discord Periodic Structured Drain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the standalone Discord gateway retry a durable structured-delivery queue without a new Discord event or TUI notification.

**Architecture:** Add a gateway-owned recursive timer around the existing serialized `delivery.flush()` operation. Each tick reads only the queue under the configured Discord state directory, verifies the durable PID/generation receiver authority, and uses the existing app-server host for dynamic top-level thread resolution; `owner.json` and volatile thread/session ids remain outside the receive gate. Existing queue locks, in-progress leases, stable client message ids, and acknowledgement reconciliation remain the exactly-once boundary.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, fake app-server host, manually driven timers.

## Global Constraints

- Start from exact commit `06e1c2a14be5a1f71125f45c452ec4531852410c` in branch `codex/discord-structured-recovery-20260720-a9-loop`.
- Do not deploy, restart systemd, alter `~/.codex`, or modify the live A8 checkout.
- Structured app-server delivery is the only inbound path; terminal input and key emulation remain forbidden.
- Persisted items are removed only after `turn/start` acceptance or existing stable-id reconciliation.
- Keep the implementation to one bounded slice and at most one targeted correction.

---

### Task 1: Gateway-Owned Periodic Recovery Loop

**Files:**
- Create: `plugins/codex-discord-channel/src/gateway-drain-loop.js`
- Create: `plugins/codex-discord-channel/tests/unit/gateway-drain-loop.test.js`
- Modify: `plugins/codex-discord-channel/src/config.js`
- Modify: `plugins/codex-discord-channel/tests/unit/config.test.js`
- Modify: `plugins/codex-discord-channel/bin/codex-discord-channel`
- Modify: `plugins/codex-discord-channel/tests/unit/delivery.test.js`
- Modify: `docs/structured-delivery.md`
- Modify: `README.md`
- Modify: `plugins/codex-discord-channel/README.md`

**Interfaces:**
- Consumes: `delivery.flush()`, `readDeliveryQueueStatus(config)`, and `isCurrentReceiverOwnership(config, expected, deps)`.
- Produces: `startGatewayDrainLoop({ config, delivery, receiverOwnership, logger, deps })`, returning `{ stop(): Promise<void> }`.

- [x] **Step 1: Write failing time-driven tests**

Add tests proving an unavailable target retains the queue through bounded backoff, later availability drains without external traffic, duplicate callback invocation cannot duplicate `turn/start`, a restarted loop resumes persisted work, and `stop()` clears the timer and prevents later delivery. Use the real durable queue and structured delivery implementation with a fake host.

- [x] **Step 2: Run the focused tests and verify RED**

Run: `node --test tests/unit/gateway-drain-loop.test.js tests/unit/config.test.js tests/unit/delivery.test.js`

Expected: failure because the gateway loop module and drain interval configuration do not exist.

- [x] **Step 3: Implement the minimal loop and gateway lifecycle wiring**

Implement a recursive `setTimeout` loop with a generation token and one in-flight promise. Poll at the configured base interval when empty, exponentially back off pending failures to the configured maximum, verify current durable receiver authority before flushing, and expose an async idempotent stop that cancels future ticks and awaits the active tick. Start it only after the standalone gateway has committed receiver authority; stop it before authority release and Discord client teardown.

- [x] **Step 4: Keep terminal injection mechanically forbidden**

Extend the source scan to reject TTY device selection, ioctl injection, bracketed paste, auto-submit, carriage-return submission, escape-key submission, and terminal keypress primitives while allowing printable control escaping and the explicit REST send command's stdin payload.

- [x] **Step 5: Run focused and full verification**

Run: `node --test tests/unit/gateway-drain-loop.test.js tests/unit/config.test.js tests/unit/delivery.test.js`

Run: `npm run check`

Run: `python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .`

Expected: all commands pass with no live service or user configuration changes.

- [ ] **Step 6: Commit and push**

Review `git diff --check`, changed-file scope, and source scans; commit the bounded slice and push `codex/discord-structured-recovery-20260720-a9-loop` to `origin`.
