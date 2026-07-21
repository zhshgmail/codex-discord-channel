'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.resolve(__dirname, '..', '..', 'src', 'session-launcher.js');

function launcher() {
  assert.equal(fs.existsSync(modulePath), true, 'session launcher source must exist');
  return require(modulePath);
}

test('session endpoint is fixed to the isolated Discord state path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-session-state '));
  const stateDir = path.join(home, 'state with spaces');
  const { resolveSessionEndpoint } = launcher();
  assert.equal(
    resolveSessionEndpoint({ HOME: home, CODEX_HOME: path.join(home, '.codex'), DISCORD_STATE_DIR: stateDir }),
    `unix://${path.join(stateDir, 'app-server.sock')}`,
  );
  assert.throws(
    () => resolveSessionEndpoint({
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      DISCORD_STATE_DIR: stateDir,
      CODEX_DISCORD_APP_SERVER_URL: 'unix:///tmp/other.sock',
    }),
    /must match the Discord state path/,
  );
});

test('session launcher rejects caller-controlled remote attachment flags', () => {
  const { validateSessionArguments } = launcher();
  assert.deepEqual(validateSessionArguments(['resume', '--last']), ['resume', '--last']);
  for (const args of [
    ['--remote', 'unix:///tmp/other.sock'],
    ['--remote=unix:///tmp/other.sock'],
    ['--remote-auth-token-env', 'TOKEN'],
    ['--remote-auth-token-env=TOKEN'],
  ]) {
    assert.throws(() => validateSessionArguments(args), /managed by the Discord session launcher/);
  }
});

test('session timing settings are bounded positive integers', () => {
  const { sessionTiming } = launcher();
  assert.deepEqual(sessionTiming({}), { pollMs: 100, timeoutMs: 15000 });
  assert.deepEqual(sessionTiming({
    CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '25',
    CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '4000',
  }), { pollMs: 25, timeoutMs: 4000 });
  assert.throws(
    () => sessionTiming({ CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '1:2' }),
    /positive integer/,
  );
  assert.throws(
    () => sessionTiming({ CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '0' }),
    /positive integer/,
  );
});
