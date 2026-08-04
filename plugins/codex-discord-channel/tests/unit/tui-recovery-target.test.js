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
const CAPTURE_ID_A = 'capture-a';
const CAPTURE_ID_B = 'capture-b';

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
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);
  const recovery = path.join(config.paths.stateDir, 'tui-recovery-target.json');
  assert.equal(fs.statSync(recovery).mode & 0o777, 0o600);
  clearRecoveryTarget(config);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
});

test('capture refuses a checkpoint older than the supervised launch', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);
  const afterLiveWrite = Math.ceil(fs.statSync(live).mtimeMs) + 1;
  assert.equal(captureRecoveryTarget(config, afterLiveWrite, CAPTURE_ID_B), false);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
});

test('rejected ambiguous capture atomically invalidates the previously captured thread', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);

  fs.writeFileSync(live, `${JSON.stringify({
    version: 1,
    threadId: THREAD_ID,
    status: 'active',
    activeTurnId: 'turn-2',
    loadedThreadIds: [THREAD_ID, '019f3763-d308-7871-bedc-e6489b02190f'],
  })}\n`);

  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_B), false);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
});

test('missing live checkpoint invalidates the previously captured thread', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);

  fs.unlinkSync(live);

  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_B), false);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
});

test('failed invalidation cannot make an old capture readable under the new identity', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);
  fs.writeFileSync(live, `${JSON.stringify({
    version: 1,
    threadId: THREAD_ID,
    status: 'active',
    activeTurnId: 'turn-2',
    loadedThreadIds: [THREAD_ID, '019f3763-d308-7871-bedc-e6489b02190f'],
  })}\n`);

  fs.chmodSync(config.paths.stateDir, 0o500);
  try {
    assert.throws(
      () => captureRecoveryTarget(config, 0, CAPTURE_ID_B),
      (error) => error?.code === 'EACCES',
    );
    assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
  } finally {
    fs.chmodSync(config.paths.stateDir, 0o700);
  }
});

test('integer launch threshold rejects a fractional same-millisecond prelaunch checkpoint', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  fs.utimesSync(live, 1.000499, 1.000499);
  assert.ok(fs.statSync(live).mtimeMs > 1000);
  assert.ok(fs.statSync(live).mtimeMs < 1001);

  assert.equal(captureRecoveryTarget(config, 1000, CAPTURE_ID_B), false);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
});
