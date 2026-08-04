'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadMcpConfig, requireMcpIdentity } = require('../../src/mcp-config');

function makeIdentityFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-mcp-identity-'));
  const codexHome = path.join(root, 'codex-home');
  const stateDir = path.join(root, 'discord', 'codex02');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'discord-instance.env'),
    `DISCORD_INSTANCE=codex02\nDISCORD_CONFIG_DIR=${stateDir}\n`,
  );
  fs.writeFileSync(path.join(stateDir, 'account.env'), `CODEX_HOME=${codexHome}\n`);
  return {
    env: {
      HOME: root,
      CODEX_HOME: codexHome,
      DISCORD_INSTANCE: 'codex02',
      DISCORD_CONFIG_DIR: stateDir,
    },
    root,
  };
}

test('MCP config accepts an exact explicit identity bound on disk', (t) => {
  const fixture = makeIdentityFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const config = loadMcpConfig(fixture.env);
  assert.equal(config.paths.instance, 'codex02');
  assert.equal(config.codexHome, fixture.env.CODEX_HOME);
  assert.equal(config.paths.stateDir, fixture.env.DISCORD_CONFIG_DIR);
});

test('MCP config fails closed when Codex filters any identity variable', () => {
  for (const missing of ['CODEX_HOME', 'DISCORD_INSTANCE', 'DISCORD_CONFIG_DIR']) {
    const env = {
      CODEX_HOME: '/tmp/codex-home',
      DISCORD_INSTANCE: 'codex02',
      DISCORD_CONFIG_DIR: '/tmp/discord/codex02',
    };
    delete env[missing];
    assert.throws(
      () => requireMcpIdentity(env),
      (error) => error.code === 'mcp_account_identity_missing' && error.message.includes(missing),
    );
  }
});

test('MCP config rejects an explicit identity that conflicts with its binding', (t) => {
  const fixture = makeIdentityFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(
    () => loadMcpConfig({ ...fixture.env, DISCORD_INSTANCE: 'codex01' }),
    /DISCORD_INSTANCE conflicts|does not match its durable account binding/,
  );
});
