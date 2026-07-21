'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function productionFiles() {
  const files = [];
  for (const directory of ['src', 'bin', 'runtime']) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile()) files.push(path.join(absolute, entry.name));
    }
  }
  return files;
}

test('MCP and executable shims load only committed plugin-root-relative bundles', () => {
  const mcp = JSON.parse(read('.mcp.json')).mcpServers['codex-discord-channel'];
  assert.deepEqual(mcp, {
    cwd: '.',
    command: 'node',
    args: ['./runtime/mcp-server.cjs'],
  });

  for (const file of ['runtime/mcp-server.cjs', 'runtime/channel-cli.cjs']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} must be committed`);
  }
  assert.match(read('bin/codex-discord-channel'), /require\('\.\.\/runtime\/channel-cli\.cjs'\)/);
  assert.match(read('bin/codex-discord-session'), /require\('\.\.\/runtime\/channel-cli\.cjs'\)/);
});

test('bundles leave only node-prefixed runtime imports external', () => {
  for (const file of ['runtime/mcp-server.cjs', 'runtime/channel-cli.cjs']) {
    const source = read(file);
    const imports = [...source.matchAll(/(?:require|__require)\(["']([^"']+)["']\)/g)]
      .map((match) => match[1]);
    assert.ok(imports.length > 0, `${file} must retain explicit node:* imports`);
    assert.deepEqual(
      imports.filter((specifier) => !specifier.startsWith('node:')),
      [],
      `${file} contains an external non-node dependency`,
    );
  }
});

test('source, shims, and runtime contain no terminal injection seam', () => {
  const source = productionFiles().map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const forbidden of [
    'TIOCSTI',
    'tty-detect',
    'runTtyInjector',
    'injectIntoTty',
    'CODEX_DISCORD_TTY',
    'CODEX_DISCORD_TTY_AUTO_SUBMIT_COMPAT',
    '/dev/pts/',
    '/dev/tty',
    'BRACKETED_PASTE',
    '\\x1b[200~',
    '\\x1b[201~',
    'process.stdin.setRawMode',
    'String.fromCharCode(13)',
    'String.fromCharCode(27)',
    'Buffer.from([13',
    'Buffer.from([27',
    'sendKeypress',
    'sendTerminalKey',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden runtime primitive remains: ${forbidden}`);
  }
});
