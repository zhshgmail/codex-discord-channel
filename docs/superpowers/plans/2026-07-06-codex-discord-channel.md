# Codex Discord Channel Implementation Plan

> Safety update (2026-07-13): automatic TTY injection is superseded by the fail-closed queue described in [`docs/tty-delivery-safety.md`](../../tty-delivery-safety.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Codex plugin that provides Claude-style Discord session ownership for Codex.

**Architecture:** The plugin is a marketplace repo with one plugin under `plugins/codex-discord-channel`. It ships a Node MCP server that owns a Discord bot instance for the current process, uses Claude-compatible access state, exposes safe Discord reply/read tools, and persistently queues accepted messages while no verifiable host delivery API exists. The Codex delivery adapter remains isolated so a future structured channel API can replace the legacy TTY path.

**Tech Stack:** Node.js 22, CommonJS, stdio JSON-RPC MCP handling, `discord.js`, `node:test`, Codex plugin manifest and marketplace files.

---

## File Structure

- Create `plugins/codex-discord-channel/.codex-plugin/plugin.json`: Codex plugin metadata.
- Create `plugins/codex-discord-channel/.mcp.json`: MCP server launch config.
- Create `plugins/codex-discord-channel/package.json`: package scripts, bin, dependencies, tests.
- Create `plugins/codex-discord-channel/bin/codex-discord-channel`: CLI entrypoint.
- Create `plugins/codex-discord-channel/src/paths.js`: instance path resolution.
- Create `plugins/codex-discord-channel/src/config.js`: env loading and runtime config.
- Create `plugins/codex-discord-channel/src/access-state.js`: Claude-compatible access model and decisions.
- Create `plugins/codex-discord-channel/src/owner-state.js`: single active owner claim/supersede checks.
- Create `plugins/codex-discord-channel/src/tty-detect.js`: interactive Codex TTY discovery.
- Create `plugins/codex-discord-channel/src/delivery.js`: normalized Discord envelope, TTY prompt, and bounded delivery result.
- Create `plugins/codex-discord-channel/src/discord-client.js`: Discord Gateway and REST wiring.
- Create `plugins/codex-discord-channel/src/mcp-server.js`: MCP tools/resources and lifecycle.
- Create `plugins/codex-discord-channel/scripts/smoke.js`: local validation beyond plugin manifest checks.
- Create `plugins/codex-discord-channel/tests/unit/*.test.js`: focused unit coverage.
- Create `plugins/codex-discord-channel/README.md`: setup, instance, and current limitation docs.
- Create `.agents/plugins/marketplace.json`: repo-local marketplace entry.

### Task 1: Scaffold Plugin Project

**Files:**
- Create: `plugins/codex-discord-channel/.codex-plugin/plugin.json`
- Create: `plugins/codex-discord-channel/.mcp.json`
- Create: `.agents/plugins/marketplace.json`

- [ ] **Step 1: Run Codex plugin scaffold**

Run:

```bash
python3 /home/zheng/.codex/skills/.system/plugin-creator/scripts/create_basic_plugin.py \
  codex-discord-channel \
  --path /home/zheng/workspace/a5/a5_codex/codex-discord-channel/plugins \
  --marketplace-path /home/zheng/workspace/a5/a5_codex/codex-discord-channel/.agents/plugins/marketplace.json \
  --with-skills \
  --with-scripts \
  --with-mcp \
  --with-marketplace
```

Expected: scaffold prints plugin and marketplace manifest paths.

- [ ] **Step 2: Replace scaffold metadata**

Set `plugin.json` to describe Discord session-channel behavior and point `mcpServers` at `./.mcp.json`.

- [ ] **Step 3: Configure MCP launch**

Set `.mcp.json` to run:

```json
{
  "mcpServers": {
    "codex-discord-channel": {
      "cwd": ".",
      "command": "node",
      "args": ["./src/mcp-server.js"]
    }
  }
}
```

### Task 2: Runtime Config and Owner State

**Files:**
- Create: `plugins/codex-discord-channel/src/paths.js`
- Create: `plugins/codex-discord-channel/src/config.js`
- Create: `plugins/codex-discord-channel/src/owner-state.js`
- Test: `plugins/codex-discord-channel/tests/unit/config.test.js`
- Test: `plugins/codex-discord-channel/tests/unit/owner-state.test.js`

- [ ] **Step 1: Write config and owner tests**

Cover default state path, instance override, `.env` parsing without overriding real env, owner claim, and supersede detection.

- [ ] **Step 2: Implement path/config helpers**

Implement deterministic path resolution under `$HOME/.codex/channels/discord/<instance>` with overrides for `DISCORD_STATE_DIR`, `DISCORD_CONFIG_DIR`, and `DISCORD_INSTANCE`.

- [ ] **Step 3: Implement owner claim**

Write `owner.json` atomically enough for local single-user use: write a temp file then rename. Include `ownerId`, `pid`, `hostname`, `cwd`, and `startedAt`.

### Task 3: Access State and Delivery Boundary

**Files:**
- Create: `plugins/codex-discord-channel/src/access-state.js`
- Create: `plugins/codex-discord-channel/src/delivery.js`
- Test: `plugins/codex-discord-channel/tests/unit/access-state.test.js`
- Test: `plugins/codex-discord-channel/tests/unit/delivery.test.js`

- [ ] **Step 1: Write access tests**

Cover DM pairing policy, allowlisted DM, guild channel disabled, guild mention required, channel `requireMention:false`, and bot-authored rejection by default.

- [ ] **Step 2: Implement fail-closed access decisions**

Return structured decisions with `allowed`, `reason`, and `requiresPairingCode` fields.

- [ ] **Step 3: Implement delivery envelope and TTY delivery**

Build a stable text envelope with Discord channel, message, author, and attachment metadata. In default `tty` delivery mode, inject a prompt into the owning Codex session terminal. Return `failed` if no usable TTY is available, and `unsupported` only when delivery is explicitly disabled.

### Task 4: MCP Server and Discord Client

**Files:**
- Create: `plugins/codex-discord-channel/src/mcp-server.js`
- Create: `plugins/codex-discord-channel/src/discord-client.js`
- Create: `plugins/codex-discord-channel/bin/codex-discord-channel`
- Create: `plugins/codex-discord-channel/package.json`

- [ ] **Step 1: Implement MCP tools**

Expose `discord_channel_status`, `discord_channel_send`, `discord_channel_read_owner`, and `discord_channel_claim_owner`.

- [ ] **Step 2: Implement Discord login lifecycle**

Start Discord only when `DISCORD_BOT_TOKEN` or `DISCORD_TOKEN` is set. If absent, keep MCP tools usable and report `tokenConfigured:false`.

- [ ] **Step 3: Wire inbound handler**

On `messageCreate`, refresh access, check current owner, ignore the bot's own messages, normalize the Discord message, and call the delivery boundary.

### Task 5: Docs, Validation, and GitHub

**Files:**
- Create: `plugins/codex-discord-channel/README.md`
- Create: `plugins/codex-discord-channel/scripts/smoke.js`
- Modify: project git metadata only through `git init`, `git add`, `git commit`, and `gh repo create`.

- [ ] **Step 1: Write README**

Document Claude-style target behavior, current Codex host limitation, TTY delivery mode, install commands, env files, and validation commands.

- [ ] **Step 2: Add smoke validation**

Validate manifest, MCP config, bin executability, package scripts, and no committed `.env`.

- [ ] **Step 3: Run checks**

Run:

```bash
cd /home/zheng/workspace/a5/a5_codex/codex-discord-channel/plugins/codex-discord-channel
npm install
npm run check
python3 /home/zheng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

- [ ] **Step 4: Initialize and publish repo**

Run:

```bash
cd /home/zheng/workspace/a5/a5_codex/codex-discord-channel
git init
git add .agents docs plugins README.md .gitignore
git commit -m "init discord channel plugin"
gh repo create codex-discord-channel --source . --private --push
```

Use private visibility by default because local Discord bridge workflows are operationally sensitive.

## Self-Review

- Spec coverage: tasks cover scaffold, owner model, access model, delivery boundary, MCP/Discord lifecycle, docs, checks, and GitHub publish.
- Placeholder scan: no TBD/TODO/fill-in placeholders remain.
- Type consistency: filenames and exported module names are stable across tasks.
