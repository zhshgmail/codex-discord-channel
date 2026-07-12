# Task 2 Report: Authorized History Policy And Normalization

## Scope

Implemented Task 2 from `.superpowers/sdd/task-2-brief.md` against
`docs/superpowers/specs/2026-07-12-discord-history-reply-semantics-design.md`.

The implementation adds the pure history policy and service only. It validates
history arguments, reloads current access state per read, authorizes exact guild
channels/threads and DMs, filters returned authors, normalizes bounded metadata,
resolves same-channel references already present in the fetched page, and caps
serialized output at 64 KiB. MCP discovery and dispatch remain out of scope.

Task 1's `repliedToAuthorId` behavior and access-check ordering are unchanged.

## TDD Evidence

### Baseline

Command before Task 2 edits:

```bash
npm test
```

Result: exit 0, 42 passing, 0 failing.

### RED 1

Command after adding the planned policy/service tests and before production
changes:

```bash
node --test tests/unit/history.test.js tests/unit/access-state.test.js
```

Result: exit 1, 12 passing and 5 failing.

- `tests/unit/history.test.js` failed to load with
  `Cannot find module '../../src/history'`.
- Four access policy tests failed because `decideHistoryTarget` and
  `allowHistoryMessage` did not exist.

These were the expected missing-interface failures from the Task 2 brief.

### GREEN 1

Focused command after the minimal production implementation:

```bash
node --test tests/unit/history.test.js tests/unit/access-state.test.js
```

Result: exit 0, 23 passing, 0 failing.

### RED 2

Self-review identified two uncovered boundary cases. The next focused command
was run after adding tests and before changing production code:

```bash
node --test tests/unit/history.test.js
```

Result: exit 1, 6 passing and 2 failing.

- A 20-digit value above the unsigned 64-bit snowflake maximum was accepted.
- A single normalized message with heavily escaped content exhausted the byte
  budget and returned no message.

### GREEN 2

Focused command after the minimal boundary fixes:

```bash
node --test tests/unit/history.test.js tests/unit/access-state.test.js
```

Result: exit 0, 24 passing, 0 failing.

### Final Verification

Focused command from the final implementation state:

```bash
node --test tests/unit/history.test.js tests/unit/access-state.test.js
```

Result: exit 0, 24 passing, 0 failing.

Full suite command from the final implementation state:

```bash
npm test
```

Result: exit 0, 54 passing, 0 failing.

Syntax command:

```bash
npm run syntax
```

Result: exit 0.

`git diff --check` also passed before the implementation commit.

## Files Changed And Committed

- `plugins/codex-discord-channel/src/access-state.js`
  - Adds exact target authorization and per-message history filtering while
    preserving the existing inbound access function unchanged.
- `plugins/codex-discord-channel/src/history.js`
  - Adds strict argument validation, one bounded `limit + 1` fetch, newest-first
    pagination, bounded normalization, same-page reference resolution, stable
    sanitized errors, and the 64 KiB output budget.
- `plugins/codex-discord-channel/tests/unit/access-state.test.js`
  - Covers exact guild/thread authorization, supported channel types, DM
    open/allowlist behavior, own-bot inclusion, and guild sender/bot filtering.
- `plugins/codex-discord-channel/tests/unit/history.test.js`
  - Covers validation, pagination, filtering, references, metadata caps,
    serialized byte limits, progress under truncation, and sanitized failures.

Implementation commit:
`e1c42515db9f9b4dcfbec14bec18d2baf345b2e7 Add authorized Discord history service`

## Self-Review

- Confirmed the implementation touches no MCP or Discord gateway wiring.
- Confirmed guild authorization uses the exact target ID and does not inherit a
  thread parent's authorization.
- Confirmed active-bot messages remain visible before guild `allowBots` and
  `allowFrom` filtering, while other bots and denied senders remain filtered.
- Confirmed `requireMention` does not filter authorized history.
- Confirmed one channel fetch and one `limit + 1` message fetch per read.
- Confirmed raw errors and message content are not logged or returned in errors.
- Confirmed Task 1's `decideAccess` gate order and reply predicate were not
  modified.

## Concerns

No Task 2 implementation concerns. The service is intentionally not reachable
through MCP until Task 3 wires the adapter, default-channel resolution, tool
schema, and MCP error mapping.
