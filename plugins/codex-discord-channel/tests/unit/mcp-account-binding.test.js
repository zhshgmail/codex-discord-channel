'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  bindMcpToInstalledAccount,
  installedCodexHome,
} = require('../../src/mcp-account-binding');

function installedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-mcp-account-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'account-02');
  const pluginRoot = path.join(
    codexHome,
    'plugins',
    'cache',
    'personal',
    'codex-discord-channel',
    '0.3.0+test',
  );
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'codex-discord-channel' }),
  );
  fs.writeFileSync(path.join(pluginRoot, '.mcp.json'), '{}');
  return { codexHome, pluginRoot, root };
}

test('installedCodexHome recognizes the account-scoped marketplace cache', (t) => {
  const fixture = installedFixture(t);
  assert.equal(installedCodexHome(fixture.pluginRoot), fixture.codexHome);
});

test('installedCodexHome ignores an ordinary source checkout', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-mcp-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'codex-discord-channel' }),
  );
  fs.writeFileSync(path.join(root, '.mcp.json'), '{}');
  assert.equal(installedCodexHome(root), '');
});

test('bindMcpToInstalledAccount supplies the account home missing from MCP env', (t) => {
  const fixture = installedFixture(t);
  assert.deepEqual(
    bindMcpToInstalledAccount({ HOME: fixture.root }, fixture.pluginRoot),
    { HOME: fixture.root, CODEX_HOME: fixture.codexHome },
  );
});

test('bindMcpToInstalledAccount rejects an explicit cross-account selection', (t) => {
  const fixture = installedFixture(t);
  assert.throws(
    () => bindMcpToInstalledAccount({
      HOME: fixture.root,
      CODEX_HOME: path.join(fixture.root, 'account-01'),
    }, fixture.pluginRoot),
    (error) => error?.code === 'mcp_account_home_conflict',
  );
});
