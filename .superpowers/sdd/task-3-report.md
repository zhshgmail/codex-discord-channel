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

## Review Fix: Explicit History Channel Validation

### Finding

`historyArgsWithDefaultChannel` used value truthiness to decide whether to
read `last-inbound.json`. Consequently, explicit malformed `channelId` values
such as `null`, numbers, empty strings, and whitespace-only strings were
silently replaced with the last inbound channel before validation.

### TDD Evidence

RED, after adding MCP regression tests with a valid last-inbound fixture:

```bash
node --test tests/unit/mcp-server.test.js
```

Result: exit 1, 6 passing and 3 failing. Each new test reported `Missing
expected rejection.`, proving malformed explicit values were defaulted and
read successfully.

GREEN, after the minimal validation change:

```bash
node --test tests/unit/mcp-server.test.js tests/unit/history.test.js
```

Result: exit 0, 19 passing and 0 failing.

Full verification:

```bash
npm test
npm run check
```

Result: both exit 0. `npm test` passed 73 tests; `npm run check` passed
syntax, 73 tests, and smoke.

### Changes

- Default the history channel only when `channelId` is not an own argument
  property.
- Reject present non-string and blank snowflake fields with
  `invalid_history_args`; absent `channelId` and `before` remain optional.
- Cover `null`, numeric, empty, and whitespace-only explicit `channelId`
  values at the MCP boundary, asserting no Discord fetch occurs.

## Final Review Fixes: MCP Result Budget And Arguments Presence

### RED

Command, run after adding the boundary regressions and before production edits:

```bash
node --test tests/unit/mcp-server.test.js
```

Result: exit 1, 7 passing and 4 failing tests.

- The large authorized history regression failed because
  `Buffer.byteLength(JSON.stringify(result), 'utf8')` exceeded 64 KiB.
- The JSON-RPC regression failed because explicit `null`, `false`, `0`, and
  empty-string `params.arguments` values returned success instead of
  `invalid_history_args` and entered the Discord fetch path.
- Two existing success assertions also failed because they now require the
  bounded non-message `structuredContent` shape used by the regression.

### GREEN

Focused history/MCP command:

```bash
node --test tests/unit/mcp-server.test.js tests/unit/history.test.js
```

Result: exit 0, 21 passing and 0 failing tests.

Full repository gate from `plugins/codex-discord-channel`:

```bash
npm run check
```

Result: exit 0; syntax passed, 75 tests passed, and smoke passed.

Plugin validator from `plugins/codex-discord-channel`:

```bash
python3 /home/zheng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Result: exit 0; plugin validation passed. Running the same command from the
repository root is invalid because the manifest is intentionally under the
plugin directory.

Diff gate before the implementation commit:

```bash
git diff --check
```

Result: exit 0 with no output.

### Changes

- Budget history candidates against the complete MCP `CallToolResult`, not
  only the inner history object.
- Serialize full history once as compact content JSON and expose only bounded
  channel, source, page, and message-count metadata in `structuredContent`.
- Preserve the existing truncation cursor and sanitization paths while fitting
  oversized first messages against the real response wrapper.
- Default `params.arguments` only when the property is absent; explicit
  malformed falsy values now reach `validateHistoryArgs` and fail before any
  Discord fetch.

Implementation commit:
`0f95545c3386cad41d0103a16f3b39ea89cef203`

### Final Concerns

No known implementation blocker. Plugin validation must be invoked from
`plugins/codex-discord-channel`, where `.codex-plugin/plugin.json` resides.
