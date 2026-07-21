# Discord Self-Contained Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an installable Discord channel plugin whose committed Node 22 bundles run from a real Codex marketplace cache without `node_modules`, `npm install`, lifecycle hooks, host-specific paths, or terminal injection.

**Architecture:** Keep the existing source modules as the reviewed development source and use esbuild only to produce committed CommonJS runtime artifacts. The MCP manifest starts the bundled server by a plugin-root-relative path, while dependency-free executable shims load the bundled CLI. The CLI owns a future-session launcher that starts or reuses one state-path Unix-socket app-server, attaches the visible Codex process with `--remote`, and provides a bounded structured probe that resolves `thread/loaded/list` and can exercise `turn/start`.

**Tech Stack:** Node.js 22, CommonJS, esbuild, Node test runner, Codex plugin marketplace CLI, WebSocket app-server RPC.

## Global Constraints

- Start from exact base `20ec5cd0ba58fa43bb7ea55803c2e280d065c817`.
- Bundle every non-`node:*` runtime dependency, including `ws`, `discord.js`, and `undici`.
- Do not read or mutate the live marketplace cache, systemd service, Codex state, Discord credentials, `.env`, or current TUI.
- Preserve durable FIFO delivery and the periodic 30-second structured drain; `owner.json` remains status and handoff metadata only.
- Never add TUI, TIOCSTI, bracketed-paste, ESC, CR, keypress, or terminal auto-submit delivery.
- A currently running TUI is not adopted; the launcher establishes the topology only for a later explicit session launch or resume.

---

### Task 1: Isolated Marketplace Contract

**Files:**
- Create: `plugins/codex-discord-channel/tests/integration/isolated-marketplace-runtime.test.js`
- Create: `plugins/codex-discord-channel/tests/fixtures/fake-codex.js`
- Modify: `plugins/codex-discord-channel/package.json`

**Interfaces:**
- Consumes: the repository marketplace manifest and plugin directory.
- Produces: a real isolated `codex plugin add` acceptance test and a fake app-server/TUI fixture confined to temporary state.

- [ ] Copy the marketplace and plugin into a temporary source path containing spaces, excluding `node_modules`.
- [ ] Put a failing `npm` sentinel first in `PATH`, install through the real Codex marketplace CLI, and assert no sentinel or installed `node_modules` exists.
- [ ] From the returned installed cache path, assert `.mcp.json` is host-independent, initialize MCP over stdio, call `tools/list`, and force-load bundled `ws`, `discord.js`, and `undici` with networking disabled.
- [ ] Launch a future fake visible session through the installed shim, prove the same state-path app-server observes its loaded thread, and use the installed bounded probe to record `thread/loaded/list`, `thread/read`, and `turn/start`.
- [ ] Run `node --test tests/integration/isolated-marketplace-runtime.test.js` and capture RED caused by missing runtime bundles/session shim.

### Task 2: Security And Packaging Contract

**Files:**
- Create: `plugins/codex-discord-channel/tests/unit/runtime-packaging.test.js`
- Modify: `plugins/codex-discord-channel/tests/unit/delivery.test.js`
- Modify: `plugins/codex-discord-channel/scripts/smoke.js`

**Interfaces:**
- Consumes: `.mcp.json`, executable shims, runtime bundles, and package scripts.
- Produces: deterministic scans that permit process launch but prohibit every terminal-injection primitive in source and generated runtime.

- [ ] Assert committed runtime files exist and contain no external non-`node:*` module imports.
- [ ] Assert both shims are executable, dependency-free, and load only committed runtime bundles.
- [ ] Extend scans across `src`, `bin`, and `runtime` for TIOCSTI, tty paths/injectors, bracketed paste, ESC/CR submission, raw mode, and terminal key APIs.
- [ ] Run focused tests and retain the expected RED failures before changing production files.

### Task 3: Bundled Runtime And Shared Session Launcher

**Files:**
- Create: `plugins/codex-discord-channel/scripts/build-runtime.js`
- Create: `plugins/codex-discord-channel/src/channel-cli.js`
- Create: `plugins/codex-discord-channel/src/session-launcher.js`
- Create: `plugins/codex-discord-channel/bin/codex-discord-session`
- Create: `plugins/codex-discord-channel/runtime/mcp-server.cjs`
- Create: `plugins/codex-discord-channel/runtime/channel-cli.cjs`
- Modify: `plugins/codex-discord-channel/bin/codex-discord-channel`
- Modify: `plugins/codex-discord-channel/src/app-server-host.js`
- Modify: `plugins/codex-discord-channel/.mcp.json`
- Modify: `plugins/codex-discord-channel/package.json`
- Modify: `plugins/codex-discord-channel/package-lock.json`

**Interfaces:**
- Produces: `channelCli.main(argv)`, `channelCli.runSession(argv)`, a bounded `app-server-probe`, and two reproducible Node 22 CommonJS bundles.

- [ ] Add esbuild as a development-only dependency and normalize every built-in external to `node:*`; fail the build if its metafile reports any other external import.
- [ ] Move the existing CLI behavior into `src/channel-cli.js`, add explicit runtime-dependency and bounded structured probe commands, and leave both `bin` files as minimal runtime loaders.
- [ ] Implement state-path endpoint validation, atomic startup coordination, bounded protocol readiness, detached app-server startup, and visible child launch with a forced `--remote` endpoint.
- [ ] Reject caller-provided remote endpoints, do not inspect live TTY state, and clean up only a child started by the failing launcher invocation.
- [ ] Build and commit both runtime artifacts, then run the focused tests to GREEN.

### Task 4: Verification, Review, And Publish

**Files:**
- Modify: `README.md`
- Modify: `plugins/codex-discord-channel/README.md`
- Modify: `docs/structured-delivery.md`

**Interfaces:**
- Produces: reproducible build/install commands and evidence for reviewer-controlled acceptance.

- [ ] Document marketplace execution, bundle rebuilds, explicit future-session launch/resume, state-path sharing, and the prohibition on current-TUI adoption or terminal injection.
- [ ] Run `npm test`, `npm run check`, the isolated marketplace integration test, a fresh build cleanliness check, and repository/runtime forbidden-pattern scans.
- [ ] Compare `git diff --name-only 20ec5cd0ba58..HEAD` to the allowed runtime/build/config/tests/docs scope and request an independent review.
- [ ] Fix Critical or Important findings, rerun all verification, commit, and push `codex/discord-self-contained-runtime-a1-20260720`.
