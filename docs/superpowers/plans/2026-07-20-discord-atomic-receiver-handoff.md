# Discord Atomic Receiver Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make receiver takeover atomic and preserve sole-gateway Discord admission while the app-server target is unavailable.

**Architecture:** Store current generation and fallback incumbent in one atomically replaced `session-gateway.pid` JSON record. Prepare login, queue persistence, target readiness when taking over, and the listener before a compare-and-swap authority commit; skip target readiness only when no live incumbent exists.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, synchronous atomic filesystem renames, existing persistent delivery queue lock.

## Global Constraints

- Work only in `codex-discord-channel`; do not affect NPU Autoport or iQuest.
- Do not deploy, enable, start, restart, or signal a live service/gateway.
- Do not read or write live `~/.codex` configuration/state.
- Preserve structured app-server delivery and keep every terminal injection path absent.
- `owner.json` must remain non-authoritative for per-message reception.
- Do not claim the findings fixed; fresh C0/I0 review remains required.

---

### Task 1: Atomic Receiver Authority

**Files:**
- Modify: `plugins/codex-discord-channel/src/receiver-state.js`
- Modify: `plugins/codex-discord-channel/src/discord-client.js`
- Test: `plugins/codex-discord-channel/tests/unit/receiver-state.test.js`
- Test: `plugins/codex-discord-channel/tests/unit/discord-client.test.js`

**Interfaces:**
- Consumes: `config.paths.gatewayPidPath`, legacy integer PID and `.generation` records.
- Produces: atomic authority snapshot/claim/release helpers and generation-aware active checks.

- [ ] Add failing tests proving one authoritative record, fallback after post-commit successor death, crash safety at each handoff phase, and compare-and-swap race rejection.
- [ ] Run `node --test tests/unit/receiver-state.test.js tests/unit/discord-client.test.js` and confirm failures describe A6 split-state/startup behavior.
- [ ] Implement atomic record parsing, candidate creation, compare-and-swap commit, exact-generation release, and listener-before-commit startup.
- [ ] Re-run the focused tests and confirm they pass without changing access or payload behavior.
- [ ] Commit the green receiver handoff checkpoint.

### Task 2: Sole Receiver Target-Down Persistence

**Files:**
- Modify: `plugins/codex-discord-channel/src/delivery.js`
- Modify: `plugins/codex-discord-channel/src/discord-client.js`
- Test: `plugins/codex-discord-channel/tests/unit/discord-client.test.js`

**Interfaces:**
- Consumes: `delivery.ensurePersistenceReady()`, reconnect-triggered queue drain, Discord message handler.
- Produces: first-receiver startup that admits durably without requiring `ensureReady()`.

- [ ] Add a failing test that starts a sole gateway with target unavailable, persists one allowed event, restarts against a ready target, and observes one `turn/start`.
- [ ] Run the named test and confirm A6 rejects startup before listener/ownership creation.
- [ ] Add `ensurePersistenceReady()` using the existing cross-process queue lock and branch startup readiness on whether a live incumbent exists.
- [ ] Re-run the named and focused tests and confirm queue depth and delivery identity are exact.
- [ ] Commit the green target-down checkpoint.

### Task 3: Cleanup, Contract, And Verification

**Files:**
- Modify: `plugins/codex-discord-channel/bin/codex-discord-channel`
- Modify: `README.md`
- Modify: `plugins/codex-discord-channel/README.md`
- Modify: `docs/structured-delivery.md`

**Interfaces:**
- Consumes: exact claimed ownership returned by `startDiscordClient()`.
- Produces: graceful generation-safe release and documented single-record semantics.

- [ ] Update gateway shutdown to destroy reception and release only its exact generation without touching owner metadata semantics.
- [ ] Update receiver contract documentation and remove the obsolete two-file authority description.
- [ ] Run focused tests, `npm run check`, isolated `npm pack --dry-run`, plugin validation with isolated `HOME`/`CODEX_HOME`/`XDG_*`, and standalone smoke.
- [ ] Inspect `git diff --check`, forbidden terminal/legacy patterns, changed-file scope, and commits since exact A6 SHA.
- [ ] Commit documentation/verification cleanup and push `codex/discord-structured-recovery-20260720-a7`.
