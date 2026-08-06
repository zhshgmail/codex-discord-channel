'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  captureRecoveryTarget,
  clearRecoveryTarget,
  parseRecoveryTarget,
  readRecoveryThread,
} = require('../../src/tui-recovery-target');

const THREAD_ID = '019f3763-d308-7871-bedc-e6489b02190e';

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-tui-target-'));
  const config = { paths: { stateDir } };
  const live = path.join(stateDir, 'app-server-target.json');
  fs.writeFileSync(live, `${JSON.stringify({
    version: 1,
    threadId: THREAD_ID,
    status: 'active',
    activeTurnId: '019fce01-eab5-7381-a3bd-a15ad0ac634a',
    loadedThreadIds: [THREAD_ID],
  })}\n`);
  return { config, live };
}

test('parser rejects malformed, idle, and ambiguous target checkpoints', () => {
  assert.equal(parseRecoveryTarget('{'), null);
  assert.equal(parseRecoveryTarget(JSON.stringify({
    version: 1,
    threadId: THREAD_ID,
    status: 'idle',
    activeTurnId: 'turn-1',
    loadedThreadIds: [THREAD_ID],
  })), null);
  assert.equal(parseRecoveryTarget(JSON.stringify({
    version: 1,
    threadId: THREAD_ID,
    status: 'active',
    activeTurnId: 'turn-1',
    loadedThreadIds: [THREAD_ID, '019f3763-d308-7871-bedc-e6489b02190f'],
  })), null);
});

test('capture binds one exact active thread and read returns only that id', () => {
  const { config } = fixture();
  assert.equal(captureRecoveryTarget(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);
  const recovery = path.join(config.paths.stateDir, 'tui-recovery-target.json');
  assert.equal(fs.statSync(recovery).mode & 0o777, 0o600);
  clearRecoveryTarget(config);
  assert.equal(readRecoveryThread(config), '');
});

test('capture refuses a checkpoint older than the supervised launch', () => {
  const { config, live } = fixture();
  const afterLiveWrite = fs.statSync(live).mtimeMs + 1;
  assert.equal(captureRecoveryTarget(config, afterLiveWrite), false);
  assert.equal(readRecoveryThread(config), '');
});
