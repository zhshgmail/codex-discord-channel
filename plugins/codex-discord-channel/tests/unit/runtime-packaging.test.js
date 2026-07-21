'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
    env_vars: ['CODEX_HOME', 'DISCORD_INSTANCE', 'DISCORD_STATE_DIR'],
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

test('marketplace and npm payloads retain notices for every bundled dependency', () => {
  const notices = read('THIRD_PARTY_NOTICES.txt');
  for (const dependency of [
    '@discordjs/builders@1.14.1',
    '@discordjs/collection@1.5.3',
    '@discordjs/collection@2.1.1',
    '@discordjs/formatters@0.6.2',
    '@discordjs/rest@2.6.1',
    '@discordjs/util@1.2.0',
    '@discordjs/ws@1.2.3',
    '@sapphire/async-queue@1.5.5',
    '@sapphire/shapeshift@4.0.0',
    '@sapphire/snowflake@3.5.3',
    '@sapphire/snowflake@3.5.5',
    '@vladfrangu/async_event_emitter@2.4.7',
    'discord-api-types@0.38.49',
    'discord.js@14.26.4',
    'fast-deep-equal@3.1.3',
    'lodash.snakecase@4.1.1',
    'lodash@4.18.1',
    'magic-bytes.js@1.13.0',
    'ts-mixer@6.0.4',
    'tslib@2.8.1',
    'undici@6.27.0',
    'undici@7.28.0',
    'ws@8.21.0',
  ]) {
    assert.match(notices, new RegExp(dependency.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(notices, /Apache License\s+Version 2\.0/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /Copyright \(c\) Microsoft Corporation/);

  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(packed.error, undefined, packed.error?.stack);
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((entry) => entry.path);
  assert.ok(files.includes('THIRD_PARTY_NOTICES.txt'), 'npm payload must include third-party notices');
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
