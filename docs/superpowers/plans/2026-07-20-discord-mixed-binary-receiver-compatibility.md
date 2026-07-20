# Discord Mixed-Binary Receiver Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an actual running A6 receiver eligible after an A7 successor commits and then crashes or releases gracefully.

**Architecture:** Leave A6's integer PID and version-1 generation files unchanged while atomically storing the A7 generation-fenced CAS record at `session-gateway.pid.v2`. A7 prefers the staged record; graceful A7 release removes it, while A6 shutdown can remove only its own legacy view.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, Git object extraction, synchronous atomic filesystem rename.

## Global Constraints

- Start from `codex/discord-structured-recovery-20260720-a7` at `d600f6da76aeb6a27d12b137796e48df0e5f2d56`.
- Do not deploy, restart services, touch live `~/.codex` state, or access a TTY.
- Preserve A7 atomic receiver CAS and every listed structured-delivery regression behavior.
- Keep TTY, `TIOCSTI`, control-key, bracketed-paste, and child-process injection paths absent.
- Fresh review remains required; repository self-tests do not authorize deployment.

---

### Task 1: Actual-A6 Mixed-Binary Regression

**Files:**
- Create: `plugins/codex-discord-channel/tests/unit/receiver-state-mixed-binary.test.js`

**Interfaces:**
- Consumes: exact A6 Git object `plugins/codex-discord-channel/src/receiver-state.js`, current A7 receiver-state exports.
- Produces: two regression cases for post-commit death and graceful release.

- [x] Add a CommonJS test loader for the SHA-256-guarded, byte-identical receiver-state fixture from exact A6 commit `c09749a018253e79ac939be1e2a5809756209437`.
- [x] Create a legacy integer authority plus version-1 `.generation` record, commit a version-2 successor through current `createReceiverOwnership()` and `commitReceiverOwnership()`, then assert historical A6 reports `gateway_pid_match` after the successor is considered dead.
- [x] Repeat the setup, call current `releaseReceiverOwnership()`, and assert historical A6 reports `gateway_pid_match` after graceful release.
- [x] Run `node --test tests/unit/receiver-state-mixed-binary.test.js` and confirm both assertions fail with `gateway_pid_missing` before production edits.
- [x] Commit and push the red regression checkpoint.

### Task 2: Staged Atomic Authority

**Files:**
- Modify: `plugins/codex-discord-channel/src/receiver-state.js`
- Modify: `plugins/codex-discord-channel/tests/unit/receiver-state.test.js`
- Modify: `plugins/codex-discord-channel/tests/fixtures/receiver-handoff-crash.js`

**Interfaces:**
- Consumes: version-1 fallback identity already produced by `readReceiverAuthoritySnapshot()`.
- Produces: staged authority selection, conditional CAS path selection, and version-aware graceful release.

- [x] Prefer a valid `session-gateway.pid.v2` staged record and fail closed if it is malformed.
- [x] Commit a candidate with a version-1 fallback to the staged path without replacing A6's PID or generation files.
- [x] Remove staged authority on graceful release to A6; retain version-2 JSON promotion for all-A7 fallback.
- [x] Update the crash fixture to recognize commits to either the canonical or staged authority path.
- [x] Run the mixed-binary and receiver-state tests and confirm the historical A6 cases and malformed staged-state fail-closed cases pass.
- [x] Commit and push the green implementation checkpoint.

### Task 3: Contract And Verification

**Files:**
- Modify: `docs/structured-delivery.md`
- Modify: `README.md`
- Modify: `plugins/codex-discord-channel/README.md`

**Interfaces:**
- Consumes: the staged compatibility authority behavior.
- Produces: explicit staged-upgrade and mixed-version dedupe contract documentation.

- [x] Document the mixed A6/A7 authority views, overlap semantics, and graceful release without changing state-directory or owner metadata authority.
- [x] Run focused mixed-binary tests and all receiver/delivery regression tests.
- [x] Run `npm run check`, `npm pack --dry-run`, the forbidden-path scan, and `git diff --check`.
- [x] Inspect the branch diff from exact A7, request an independent code review, address all critical/important findings, and rerun affected gates.
- [x] Commit and push the verified documentation checkpoint.
