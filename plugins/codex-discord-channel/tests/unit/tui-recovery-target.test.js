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
  targetPaths,
} = require('../../src/tui-recovery-target');

const THREAD_ID = '019f3763-d308-7871-bedc-e6489b02190e';
const CAPTURE_ID_A = 'capture-a';
const CAPTURE_ID_B = 'capture-b';
const CAPTURE_ID_C = 'capture-c';

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

test('failed invalidation tombstones every prior capture even when stale cleanup also fails', () => {
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

  const recovery = path.join(config.paths.stateDir, 'tui-recovery-target.json');
  const tombstone = path.join(config.paths.stateDir, 'tui-recovery-target.invalid');
  const forcedFs = {
    ...fs,
    renameSync(source, destination) {
      if (destination === recovery) {
        const error = new Error('forced recovery target replacement failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.renameSync(source, destination);
    },
    unlinkSync(file) {
      if (file === recovery) {
        const error = new Error('forced stale recovery target deletion failure');
        error.code = 'EBUSY';
        throw error;
      }
      return fs.unlinkSync(file);
    },
  };

  assert.throws(
    () => captureRecoveryTarget(config, 0, CAPTURE_ID_B, { fs: forcedFs }),
    (error) => error instanceof AggregateError
      && error.errors.some((item) => item?.code === 'EIO')
      && error.errors.some((item) => item?.code === 'EBUSY'),
  );
  assert.equal(fs.existsSync(tombstone), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(recovery, 'utf8')), {
    version: 1,
    threadId: THREAD_ID,
    status: 'active',
    activeTurnId: '019fce01-eab5-7381-a3bd-a15ad0ac634a',
    loadedThreadIds: [THREAD_ID],
    captureId: CAPTURE_ID_A,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(tombstone, 'utf8')), {
    version: 1,
    status: 'invalid',
    captureId: CAPTURE_ID_B,
  });
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');

  const valid = JSON.parse(fs.readFileSync(live, 'utf8'));
  valid.loadedThreadIds = [THREAD_ID];
  fs.writeFileSync(live, `${JSON.stringify(valid)}\n`);
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_C), true);
  assert.equal(fs.existsSync(tombstone), false);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_C), THREAD_ID);
});

for (const failurePoint of ['temp-write', 'rename']) {
  test(`tombstone ${failurePoint} failure leaves every prior capture unpublished`, () => {
    const { config } = fixture();
    assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);

    const files = targetPaths(config);
    const forcedFs = {
      ...fs,
      writeFileSync(file, ...args) {
        if (failurePoint === 'temp-write' && file.startsWith(`${files.tombstone}.tmp-`)) {
          const error = new Error('forced tombstone temp-write failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.writeFileSync(file, ...args);
      },
      renameSync(source, destination) {
        if (failurePoint === 'rename' && destination === files.tombstone) {
          const error = new Error('forced tombstone rename failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.renameSync(source, destination);
      },
    };

    assert.throws(
      () => captureRecoveryTarget(config, 0, CAPTURE_ID_B, { fs: forcedFs }),
      (error) => error?.code === 'EIO',
    );
    assert.equal(fs.existsSync(files.tombstone), false);
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
    assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');

    fs.writeFileSync(files.tombstone, '{');
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
    fs.unlinkSync(files.tombstone);
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');

    assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_C), true);
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
    assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
    assert.equal(readRecoveryThread(config, CAPTURE_ID_C), THREAD_ID);
  });
}

test('integer launch threshold rejects a fractional same-millisecond prelaunch checkpoint', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  fs.utimesSync(live, 1.000499, 1.000499);
  assert.ok(fs.statSync(live).mtimeMs > 1000);
  assert.ok(fs.statSync(live).mtimeMs < 1001);

  assert.equal(captureRecoveryTarget(config, 1000, CAPTURE_ID_B), false);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
});
