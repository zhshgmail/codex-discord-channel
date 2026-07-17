# Discord History And Reply Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propagate guild replies to the referenced author, agents mentioned by the referenced message, and agents explicitly mentioned by the current message, while exposing authorized bounded channel/DM history through MCP.

**Architecture:** Resolve an enabled guild message's reference through discord.js, extend normalized inbound messages with the referenced author ID and content, and preserve existing access-check order while evaluating the union reply audience. Add a focused history service that validates input, reloads access policy, authorizes the target, fetches through the authenticated discord.js client, filters/normalizes messages, enforces a byte budget, and returns sanitized errors through MCP.

**Tech Stack:** Node.js 22, CommonJS, discord.js 14, `node:test`, MCP JSON-RPC over stdio.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-12-discord-history-reply-semantics-design.md`.
- No production behavior change may be written before a focused failing test is observed.
- Keep `discord-codex-bridge` disabled and never print Discord token/proxy values.
- Preserve exact channel, sender, and bot access controls. Reply delivery is the union of the referenced author, referenced-message mentions, and current-message mentions.
- History returns at most 25 messages and at most 64 KiB serialized output.

---

### Task 1: Reply-To-Bot Implicit Mention

**Files:**
- Modify: `plugins/codex-discord-channel/tests/unit/delivery.test.js`
- Modify: `plugins/codex-discord-channel/tests/unit/access-state.test.js`
- Modify: `plugins/codex-discord-channel/src/delivery.js`
- Modify: `plugins/codex-discord-channel/src/access-state.js`

**Interfaces:**
- Produces: normalized `repliedToAuthorId: string` and `repliedToContent: string`.
- Produces: `decideAccess(state, message)` acceptance when the current content mentions the active bot, the referenced author is the active bot, or the referenced content mentions the active bot, after all sender gates pass.

- [ ] **Step 1: Add failing normalization and access tests**

Add cases proving a direct reply to the active bot is accepted without text mention; a reply to a peer message that mentioned the active bot is accepted; a peer message that did not mention the active bot remains denied; and bot-authored replies that fail `allowBots`/`allowFrom` remain denied.

- [ ] **Step 2: Run focused tests and observe the intended failures**

Run: `node --test tests/unit/delivery.test.js tests/unit/access-state.test.js`

Expected: normalization lacks `repliedToAuthorId`; reply access returns `guild_mention_required`.

- [ ] **Step 3: Implement the minimal normalization and access change**

Read `message.mentions.repliedUser.id` only when `message.reference.messageId` exists. Satisfy only the mention predicate with a matching active bot ID; do not reorder or bypass other gates.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/unit/delivery.test.js tests/unit/access-state.test.js && npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the reply behavior**

Commit only the four task files with a focused message.

### Task 2: Authorized History Policy And Normalization

**Files:**
- Create: `plugins/codex-discord-channel/src/history.js`
- Create: `plugins/codex-discord-channel/tests/unit/history.test.js`
- Modify: `plugins/codex-discord-channel/src/access-state.js`
- Modify: `plugins/codex-discord-channel/tests/unit/access-state.test.js`

**Interfaces:**
- Produces: `validateHistoryArgs(args)`.
- Produces: `decideHistoryTarget(state, target, botUserId)` and `allowHistoryMessage(state, target, message, botUserId)`.
- Produces: `readDiscordHistory({ args, config, client })` returning bounded structured history.

- [ ] **Step 1: Add failing policy, validation, pagination, filtering, reference, and byte-budget tests**

Use deterministic fake channel/message fetchers. Assert exact guild authorization, DM open/allowlist behavior, own-bot inclusion, other-bot filtering, invalid snowflakes/limits, `limit + 1` pagination, same-channel resolved references, and 64 KiB truncation.

- [ ] **Step 2: Run the history tests and observe missing-module failures**

Run: `node --test tests/unit/history.test.js tests/unit/access-state.test.js`

Expected: failure because the history interfaces do not exist.

- [ ] **Step 3: Implement the minimal pure policy and history service**

Validate own properties, fetch one channel and `limit + 1` messages, filter by access policy, normalize only required metadata, cap content/attachments, and return newest-first pagination data.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/unit/history.test.js tests/unit/access-state.test.js && npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the history service and policy**

Commit only the task files with a focused message.

### Task 3: Discord REST Adapter And MCP Surface

**Files:**
- Modify: `plugins/codex-discord-channel/src/discord-client.js`
- Modify: `plugins/codex-discord-channel/src/mcp-server.js`
- Create: `plugins/codex-discord-channel/tests/unit/discord-client.test.js`
- Modify: `plugins/codex-discord-channel/tests/unit/mcp-server.test.js`

**Interfaces:**
- Produces: bounded channel/message fetch operations used by `readDiscordHistory`.
- Produces: MCP tool `discord_channel_read_history` with read-only/idempotent annotations.

- [ ] **Step 1: Add failing client adapter and MCP tool tests**

Assert tool discovery, default channel resolution from `last-inbound.json`, structured success, strict schema limits, and sanitized 403/general failures with no secret fixture leakage.

- [ ] **Step 2: Run focused tests and observe the intended failures**

Run: `node --test tests/unit/discord-client.test.js tests/unit/mcp-server.test.js`

Expected: missing tool/adapter failures.

- [ ] **Step 3: Implement the minimal adapter and MCP dispatch**

Wire the history service to the authenticated client, map Discord permission failures to `history_channel_inaccessible`, map other failures to `history_fetch_failed`, and return structured MCP content.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/unit/discord-client.test.js tests/unit/mcp-server.test.js && npm test`

Expected: all tests pass and no sensitive fixture appears in output.

- [ ] **Step 5: Commit the MCP surface**

Commit only the task files with a focused message.

### Task 4: Documentation, Packaging, And Live Verification

**Files:**
- Modify: `README.md`
- Modify: `plugins/codex-discord-channel/README.md`
- Modify: `plugins/codex-discord-channel/skills/codex-discord-channel/SKILL.md`
- Modify: plugin marketplace/version metadata only if the repository's release process requires it.

**Interfaces:**
- Documents reply semantics, history parameters/pagination, permissions, errors, deployment, and fresh-session MCP discovery requirement.

- [ ] **Step 1: Add documentation assertions or smoke checks where practical**

Ensure smoke/tool-list verification expects `discord_channel_read_history` and its annotations.

- [ ] **Step 2: Run the complete repository gate**

Run: `npm run check` from `plugins/codex-discord-channel`, then run the plugin validator documented by the repository.

Expected: syntax, unit, smoke, and plugin validation pass.

- [ ] **Step 3: Deploy the built plugin to `codex01` without exposing `.env`**

Follow the repository's existing package/install flow, restart `codex-discord-channel@codex01.service`, and confirm status is healthy.

- [ ] **Step 4: Execute live Discord acceptance tests**

Verify direct reply-to-bot delivery in the visible console, rejection of reply-to-other, authorized guild history, sanitized inaccessible-channel failure, and real DM history. Record message IDs and non-secret evidence.

- [ ] **Step 5: Request independent code review, push, and open a PR**

Address findings, re-run gates, push the temporary branch, and create the PR. After merge, remove local/remote feature branches and the worktree.
