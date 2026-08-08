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

test('parser accepts exact idle targets and loaded descendants but rejects malformed bindings', () => {
  assert.equal(parseRecoveryTarget('{'), null);
  assert.deepEqual(parseRecoveryTarget(JSON.stringify({
    version: 2,
    threadId: THREAD_ID,
    loadedThreadIds: [THREAD_ID, '019f3763-d308-7871-bedc-e6489b02190f'],
  })), {
    version: 2,
    threadId: THREAD_ID,
    loadedThreadIds: [THREAD_ID, '019f3763-d308-7871-bedc-e6489b02190f'],
  });
  assert.equal(parseRecoveryTarget(JSON.stringify({
    version: 2,
    threadId: THREAD_ID,
    loadedThreadIds: ['019f3763-d308-7871-bedc-e6489b02190f'],
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

test('present malformed capture invalidates an earlier exact target', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);

  fs.writeFileSync(live, `${JSON.stringify({
    version: 2,
    threadId: THREAD_ID,
    loadedThreadIds: ['019f3763-d308-7871-bedc-e6489b02190f'],
  })}\n`);
  assert.equal(captureRecoveryTarget(config), false);
  assert.equal(readRecoveryThread(config), '');
});

test('a transient missing live checkpoint preserves the last exact recovery target', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);

  fs.unlinkSync(live);
  assert.equal(captureRecoveryTarget(config), false);
  assert.equal(readRecoveryThread(config), THREAD_ID);
});

test('an explicit live-target invalidation clears the last recovery target', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);

  fs.unlinkSync(live);
  fs.writeFileSync(
    path.join(config.paths.stateDir, 'app-server-target.invalidated.json'),
    `${JSON.stringify({ version: 1, invalidatedAt: '2026-08-08T00:00:00.000Z' })}\n`,
  );
  assert.equal(captureRecoveryTarget(config), false);
  assert.equal(readRecoveryThread(config), '');
});
