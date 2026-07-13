'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig, loadEnvFile } = require('../../src/config');

test('loadEnvFile does not override existing environment values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-config-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'DISCORD_BOT_TOKEN=file-token\nDISCORD_INSTANCE=file-instance\n');
  const env = { DISCORD_BOT_TOKEN: 'real-token' };
  assert.equal(loadEnvFile(envFile, env), true);
  assert.equal(env.DISCORD_BOT_TOKEN, 'real-token');
  assert.equal(env.DISCORD_INSTANCE, 'file-instance');
});

test('loadConfig resolves default instance state path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'Codex 01' }, { cwd: '/workspace' });
  assert.equal(config.paths.instance, 'codex-01');
  assert.equal(config.paths.stateDir, path.join(home, '.codex', 'channels', 'discord', 'codex-01'));
  assert.equal(config.paths.deliveryQueuePath, path.join(
    home,
    '.codex',
    'channels',
    'discord',
    'codex-01',
    'pending-delivery.json',
  ));
  assert.equal(config.cwd, '/workspace');
});

test('loadConfig reads token from instance env file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=from-file\n');
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' });
  assert.equal(config.token, 'from-file');
  assert.equal(config.tokenConfigured, true);
});

test('loadConfig captures proxy and insecure TLS settings', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    HTTPS_PROXY: 'http://127.0.0.1:8080',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  });
  assert.equal(config.proxyUrl, 'http://127.0.0.1:8080');
  assert.equal(config.insecureTls, true);
});

test('loadConfig captures TTY delivery settings', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_DELIVERY_MODE: 'tty',
    CODEX_DISCORD_TTY: '/dev/pts/7',
    CODEX_DISCORD_TTY_USE_SUDO: 'true',
    CODEX_DISCORD_TTY_PROMPT_FORMAT: 'compact',
    CODEX_DISCORD_TTY_SUBMIT_SEQUENCE: 'lf',
  });
  assert.equal(config.deliveryMode, 'tty');
  assert.equal(config.tty, '/dev/pts/7');
  assert.equal(config.ttyUseSudo, true);
  assert.equal(config.ttyPromptFormat, 'compact');
  assert.equal(config.ttySubmitSequence, 'lf');
});

test('loadConfig accepts display prompt format', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_TTY_PROMPT_FORMAT: 'display',
  });
  assert.equal(config.ttyPromptFormat, 'display');
});

test('loadConfig uses Codex thread id as stable owner id', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_THREAD_ID: 'thread-123',
  });
  assert.equal(config.ownerId, 'thread-123');
});

test('explicit Discord owner id overrides Codex thread id', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_OWNER_ID: 'manual-owner',
    CODEX_THREAD_ID: 'thread-123',
  });
  assert.equal(config.ownerId, 'manual-owner');
});

test('loadConfig accepts explicit owner pid for session binding metadata', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_OWNER_PID: '3547805',
  });
  assert.equal(config.pid, 3547805);
});
