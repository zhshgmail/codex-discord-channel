'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../../src/config');
const { callTool } = require('../../src/mcp-server');

test('status reports non-secret Discord startup diagnostics', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), [
    'DISCORD_BOT_TOKEN=secret-token',
    'DISCORD_PROXY_URL=http://127.0.0.1:8080',
    'DISCORD_INSECURE_TLS=true',
  ].join('\n'));

  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: { started: false, client: null, reason: 'startup_failed' },
    claim() {
      throw new Error('not used');
    },
  };

  const result = await callTool(context, 'discord_channel_status');
  assert.equal(result.structuredContent.envLoaded, true);
  assert.equal(result.structuredContent.tokenConfigured, true);
  assert.equal(result.structuredContent.proxyConfigured, true);
  assert.equal(result.structuredContent.insecureTls, true);
  assert.equal(result.structuredContent.discordStarted, false);
  assert.equal(result.structuredContent.discordReason, 'startup_failed');
  assert.equal(result.content[0].text.includes('secret-token'), false);
  assert.equal(result.content[0].text.includes('127.0.0.1:8080'), false);
});
