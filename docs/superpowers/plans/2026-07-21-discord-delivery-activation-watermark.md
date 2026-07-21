# Discord Delivery Activation Watermark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a newly deployed gateway from replaying stale Discord backlog while preserving same-runtime recovery for newly admitted pending messages.

**Architecture:** Store a runtime activation id and time in the existing locked queue. Stamp new items with that id, preserve Discord source creation time, keep takeover readiness read-only, then archive legacy, mismatched, or pre-activation items after authority transfer and before target resolution. Deduplicate archived identities and write schema v2 so rollback fails closed.

**Tech Stack:** Node.js 22, CommonJS, `node:test`, atomic JSON replacement, existing cross-process queue lock.

## Global Constraints

- Keep delivery structured-only; add no TTY or terminal-input path.
- Do not resolve a target or call `turn/start` or `turn/steer` for stale items.
- Preserve same-runtime crash/restart recovery.
- Make no Autoport or old bridge changes.

---

### Task 1: Runtime Activation Identity

**Files:**
- Modify: `plugins/codex-discord-channel/src/config.js`
- Test: `plugins/codex-discord-channel/tests/unit/config.test.js`

**Interfaces:**
- Produces: `config.deliveryActivationId: string`

- [x] **Step 1: Write the failing configuration tests**

Assert that `loadConfig()` defaults the activation id to the real plugin root and that `CODEX_DISCORD_DELIVERY_ACTIVATION_ID=release-a` overrides it.

- [x] **Step 2: Run the focused tests and verify RED**

```bash
PATH=/home/zheng/.nvm/versions/node/v22.22.2/bin:$PATH \
  node --test tests/unit/config.test.js
```

Expected: failure because `deliveryActivationId` is absent.

- [x] **Step 3: Add the minimal configuration field**

Resolve the default with `fs.realpathSync(path.resolve(__dirname, '..'))` and use a nonblank explicit environment value when present.

- [x] **Step 4: Re-run the focused tests and verify GREEN**

Expected: all configuration tests pass.

### Task 2: Queue Activation And Stale Archive

**Files:**
- Modify: `plugins/codex-discord-channel/src/delivery.js`
- Test: `plugins/codex-discord-channel/tests/unit/delivery.test.js`

**Interfaces:**
- Consumes: `config.deliveryActivationId`
- Produces: queue fields `activation`, `archived`, and item field `activationId`

- [x] **Step 1: Write failing stale-backlog and fresh-message tests**

Create a legacy queue with one item, activate the receiver, and assert zero host requests plus one identity-only archive entry. Cover a matching-id item queued before activation and a delayed Discord event created before activation. Then enqueue a new item and assert exactly one structured request. Re-enqueue the stale identity and assert archived deduplication.

- [x] **Step 2: Run only the new tests and verify RED**

```bash
PATH=/home/zheng/.nvm/versions/node/v22.22.2/bin:$PATH \
  node --test --test-name-pattern='activation archives|archived Discord identity' tests/unit/delivery.test.js
```

Expected: stale input is currently submitted or archive fields are absent.

- [x] **Step 3: Implement minimal locked activation logic**

Normalize optional queue metadata, rotate activation under the queue lock, move stale items to identity-only `archived` entries, clear stale blocks, stamp new items, preserve metadata in completion, and check archived identities during admission.

- [x] **Step 4: Guard every flush before target resolution**

Apply activation pruning during the first locked queue inspection so legacy or injected mismatched items cannot reach `host.resolveTarget()`.

- [x] **Step 5: Re-run the focused tests and verify GREEN**

Expected: stale items archive without host calls; the post-activation item is delivered once.

### Task 3: Same-Runtime Recovery And Documentation

**Files:**
- Modify: `plugins/codex-discord-channel/tests/unit/delivery.test.js`
- Modify: `plugins/codex-discord-channel/tests/unit/gateway-drain-loop.test.js`
- Modify: `plugins/codex-discord-channel/tests/unit/discord-client.test.js`
- Modify: `README.md`
- Modify: `plugins/codex-discord-channel/README.md`
- Modify: `docs/structured-delivery.md`

**Interfaces:**
- Consumes: queue activation and stamped pending item semantics from Task 2

- [x] **Step 1: Update recovery fixtures to declare a matching activation**

Legacy fixtures that intentionally model same-runtime recovery must include the same activation id on the queue and item. Keep one explicit legacy fixture for stale archival.

- [x] **Step 2: Add or retain a same-runtime restart assertion**

Assert that an item admitted under activation `runtime-a` is delivered after recreating the delivery object with activation `runtime-a`.

- [x] **Step 3: Run delivery, gateway-loop, and Discord-client tests**

```bash
PATH=/home/zheng/.nvm/versions/node/v22.22.2/bin:$PATH \
  node --test tests/unit/delivery.test.js tests/unit/gateway-drain-loop.test.js tests/unit/discord-client.test.js
```

Expected: all focused suites pass.

- [x] **Step 4: Document the activation boundary**

State that a new versioned runtime archives old pending identities before target resolution, same-runtime restarts recover stamped pending items, and operators can explicitly set the activation id.

### Task 4: Verify, Commit, And Push

**Files:**
- Verify all changed files from Tasks 1-3

- [x] **Step 1: Run full validation**

```bash
(cd plugins/codex-discord-channel && \
  PATH=/home/zheng/.nvm/versions/node/v22.22.2/bin:$PATH npm run check && \
  python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/plugin-creator/scripts/validate_plugin.py" .)
git diff --check
```

Expected: all tests, package smoke, plugin validation, and whitespace checks pass.

- [x] **Step 2: Confirm scope and terminal safety**

Verify only plugin repository files changed and production `src`/`bin` contains no TIOCSTI, terminal device, child-process, or bracketed-paste injection path.

- [ ] **Step 3: Commit and push the existing feature branch**

```bash
git add README.md docs/structured-delivery.md \
  docs/superpowers/specs/2026-07-21-discord-delivery-activation-watermark-design.md \
  docs/superpowers/plans/2026-07-21-discord-delivery-activation-watermark.md \
  plugins/codex-discord-channel
git commit -m "fix: fence stale delivery backlog"
git push origin codex/discord-structured-delivery-20260720-sol-xhigh-a2
```

- [ ] **Step 4: Leave live receiver fenced**

Do not redeploy or restart during this repair. Report that the new commit requires a new versioned runtime install and one restart after operator approval.
