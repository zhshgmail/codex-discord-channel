# Task 3 Report: Discord History MCP Surface

## Scope

Implemented Task 3 from `.superpowers/sdd/task-3-brief.md` against
`docs/superpowers/specs/2026-07-12-discord-history-reply-semantics-design.md`.

The MCP server now discovers and dispatches
`discord_channel_read_history`, defaults an omitted `channelId` from the last
accepted inbound context, and delegates directly to Task 2's bounded history
service. No REST fetch logic was duplicated. The reviewed multi-agent reply
resolution in `discord-client.js` was not changed.

## TDD Evidence

### RED

Command, run after adding the focused MCP tests and before production changes:

```bash
node --test tests/unit/discord-client.test.js tests/unit/mcp-server.test.js
```

Result: exit 1, 8 passing and 4 failing tests.

- Tool discovery returned `undefined` for
  `discord_channel_read_history`.
- Explicit history calls failed with
  `Unknown tool: discord_channel_read_history`.
- Last-inbound default-channel calls failed with the same missing-tool error.
- Sanitized permission/general failure coverage failed because dispatch did
  not exist.

### GREEN

Focused command after the minimal production changes:

```bash
node --test tests/unit/discord-client.test.js tests/unit/mcp-server.test.js
```

Result: exit 0, 12 passing, 0 failing.

Full suite:

```bash
npm test
```

Result: exit 0, 70 passing, 0 failing.

Syntax gate:

```bash
npm run syntax
```

Result: exit 0.

Repository gate:

```bash
npm run check
```

Result: exit 0; syntax passed, 70 tests passed, and smoke passed.

`git diff --check` also passed before the implementation commit.

## Files And Commit

- `plugins/codex-discord-channel/src/mcp-server.js`
  - Adds the strict history tool schema and read-only, non-destructive,
    idempotent, open-world annotations.
  - Resolves a missing channel from `last-inbound.json` before calling
    `readDiscordHistory` with the authenticated client.
  - Returns matching text and structured MCP content.
- `plugins/codex-discord-channel/src/history.js`
  - Classifies Discord 403, status-code 403, and missing-permission code 50013
    message-fetch failures as `history_channel_inaccessible` while discarding
    raw error details.
  - Keeps other message-fetch failures sanitized as `history_fetch_failed`.
- `plugins/codex-discord-channel/tests/unit/mcp-server.test.js`
  - Covers discovery, strict schema bounds, annotations, explicit calls,
    default-channel calls, bounded fetch delegation, structured output, and
    sanitized permission/general failures without fixture-secret leakage.

Implementation commit:
`1f672b59293459e3fee8bf526c32d8438da20724`

## Self-Review

- Confirmed the MCP path performs no direct channel or message fetches.
- Confirmed Task 2 remains the only history REST implementation and still
  performs one channel fetch plus one `limit + 1` message fetch.
- Confirmed the runtime validator and advertised schema both limit reads to
  1-25 messages and reject unknown properties.
- Confirmed raw Discord errors and secret fixtures do not cross the MCP
  boundary.
- Confirmed `discord-client.js` is unchanged and all six focused reply
  resolution tests remain green.

## Concerns

No implementation blocker or known Task 3 defect. An optional independent
review process could not run temp-file tests in its read-only sandbox and was
stopped at the user's checkpoint; the requested self-review and all local
verification gates completed successfully.
