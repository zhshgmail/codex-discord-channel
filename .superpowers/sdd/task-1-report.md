# Task 1 Report: Reply-To-Bot Implicit Mention

## Scope

Implemented Task 1 from `.superpowers/sdd/task-1-brief.md` against
`docs/superpowers/specs/2026-07-12-discord-history-reply-semantics-design.md`.

The implementation records a normalized `repliedToAuthorId` only for a message
with `reference.messageId`, and accepts that reply as an implicit mention only
when it matches the active bot ID. Channel, bot, and sender gates remain ahead
of the mention predicate.

## TDD Evidence

### RED

Command, run before production changes:

```bash
node --test tests/unit/delivery.test.js tests/unit/access-state.test.js
```

Result: exit 1, 18 passing and 2 failing tests.

- `guild reply to the active bot satisfies the mention requirement` failed with
  `false !== true`, because the existing mention predicate returned
  `guild_mention_required`.
- `normalizeDiscordMessage records replied author only for a message reference`
  failed with `undefined !== 'bot'`, because the normalized field did not yet
  exist.

The unrelated-author and sender-gate denial cases were already passing, which
confirmed their expected fail-closed behavior before the production change.

### GREEN

Focused command after the minimal production change:

```bash
node --test tests/unit/delivery.test.js tests/unit/access-state.test.js
```

Result: exit 0, 20 passing, 0 failing.

Full suite command after the focused GREEN run:

```bash
npm test
```

Result: exit 0, 40 passing, 0 failing.

## Files Changed And Committed

- `plugins/codex-discord-channel/src/delivery.js`
  - Derives `repliedToAuthorId` as a string only when
    `message.reference.messageId` exists.
- `plugins/codex-discord-channel/src/access-state.js`
  - Extends only the `requireMention` predicate with a matching reply author;
    existing channel, `allowBots`, and `allowFrom` checks remain ordered first.
- `plugins/codex-discord-channel/tests/unit/delivery.test.js`
  - Covers referenced versus unreferenced reply identity normalization.
- `plugins/codex-discord-channel/tests/unit/access-state.test.js`
  - Covers active-bot reply acceptance, another-author denial, and bot replies
    denied by `allowBots` and `allowFrom`.

Commit: `c6a3545 Support Discord replies to the active bot`

## Self-Review

`git diff --check` passed. An independent Codex review found no actionable
issues and confirmed that reference identity fails closed and the access gate
order is unchanged.

## Concerns

No unit-test concerns. Live Discord gateway verification was not run because
Task 1 requires only the unit-test implementation and no live instance restart
or test-guild interaction was requested.

## Review Follow-Up

Added focused regression coverage for referenced replies where
`mentions.repliedUser` is absent or null. Both cases normalize to an empty
`repliedToAuthorId`, and the access regression confirms that the empty value
still returns `guild_mention_required`.

### Exact Verification

Command:

```bash
node --test tests/unit/delivery.test.js tests/unit/access-state.test.js
```

Result: exit 0, 22 passing, 0 failing.

### Files

- `plugins/codex-discord-channel/tests/unit/delivery.test.js`
- `plugins/codex-discord-channel/tests/unit/access-state.test.js`

### Commit

Test-fix commit: `48e906c2d429d1b5d04dce46d02cadcb86a78149`

### Concerns

No new concerns. The regression tests exposed no production defect, so no
production behavior was changed.
