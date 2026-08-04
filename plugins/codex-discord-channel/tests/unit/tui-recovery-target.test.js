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
  const files = targetPaths(config);
  for (const file of [
    path.join(files.attempts, '1.attempt'),
    path.join(files.publications, '1.json'),
    path.join(files.targets, '1.json'),
  ]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  clearRecoveryTarget(config);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(files.publications, '2.json'), 'utf8')).status, 'cleared');
});

test('capture refuses a checkpoint older than the supervised launch', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);
  const afterLiveWrite = Math.ceil(fs.statSync(live).mtimeMs) + 1;
  assert.equal(captureRecoveryTarget(config, afterLiveWrite, CAPTURE_ID_B), false);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
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
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
});

test('missing live checkpoint invalidates the previously captured thread', () => {
  const { config, live } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);

  fs.unlinkSync(live);

  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_B), false);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
});

test('partially created attempt record invalidates prior captures and a later C can publish', () => {
  const { config } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);
  const files = targetPaths(config);
  let injected = false;
  const forcedFs = {
    ...fs,
    writeFileSync(file, content, options) {
      if (!injected && path.dirname(file) === files.attempts && options?.flag === 'wx') {
        injected = true;
        fs.writeFileSync(file, '', options);
        const error = new Error('forced partial attempt creation failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.writeFileSync(file, content, options);
    },
  };

  assert.throws(
    () => captureRecoveryTarget(config, 0, CAPTURE_ID_B, { fs: forcedFs }),
    (error) => error?.code === 'EIO',
  );
  assert.equal(injected, true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');

  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_C), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_C), THREAD_ID);
});

test('failed generation target write leaves only its own incomplete files', () => {
  const { config } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  const files = targetPaths(config);
  const forcedFs = {
    ...fs,
    writeFileSync(file, ...args) {
      if (path.dirname(file) === files.targets && file.includes('.tmp-')) {
        const error = new Error('forced generation target write failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.writeFileSync(file, ...args);
    },
  };

  assert.throws(
    () => captureRecoveryTarget(config, 0, CAPTURE_ID_B, { fs: forcedFs }),
    (error) => error?.code === 'EIO',
  );
  assert.equal(fs.existsSync(path.join(files.targets, '1.json')), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_C), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_C), THREAD_ID);
});

for (const failurePoint of ['temp-write', 'pre-rename-chmod', 'rename']) {
  test(`generation publication ${failurePoint} failure cannot publish A or B`, () => {
    const { config } = fixture();
    assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);

    const files = targetPaths(config);
    const forcedFs = {
      ...fs,
      writeFileSync(file, ...args) {
        if (failurePoint === 'temp-write'
          && path.dirname(file) === files.publications
          && file.includes('.tmp-')) {
          const error = new Error('forced publication temp-write failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.writeFileSync(file, ...args);
      },
      chmodSync(file, mode) {
        if (failurePoint === 'pre-rename-chmod'
          && path.dirname(file) === files.publications
          && file.includes('.tmp-')) {
          const error = new Error('forced publication pre-rename chmod failure');
          error.code = 'EIO';
          throw error;
        }
        return fs.chmodSync(file, mode);
      },
      renameSync(source, destination) {
        if (failurePoint === 'rename' && path.dirname(destination) === files.publications) {
          const error = new Error('forced publication rename failure');
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
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
    assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');

    const failedPublication = path.join(files.publications, '2.json');
    fs.writeFileSync(failedPublication, '{');
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
    fs.unlinkSync(failedPublication);
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');

    assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_C), true);
    assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
    assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
    assert.equal(readRecoveryThread(config, CAPTURE_ID_C), THREAD_ID);
  });
}

test('replacement remains fail closed when legacy publication removal fails', () => {
  const { config } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), THREAD_ID);
  const files = targetPaths(config);
  const forcedFs = {
    ...fs,
    unlinkSync(file) {
      if (file === files.publication) {
        const error = new Error('forced publication removal failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.unlinkSync(file);
    },
  };

  let captureB;
  let captureError;
  try {
    captureB = captureRecoveryTarget(config, 0, CAPTURE_ID_B, { fs: forcedFs });
  } catch (error) {
    captureError = error;
  }
  if (captureError) assert.equal(captureError.code, 'EIO');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), captureB ? THREAD_ID : '');

  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_C), true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_C), THREAD_ID);
});

test('no post-publication permission failure can expose a thrown capture', () => {
  const { config } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  const files = targetPaths(config);
  let publishedPath = files.publication;
  const forcedFs = {
    ...fs,
    chmodSync(file, mode) {
      if (file === publishedPath) {
        const error = new Error('forced post-publication chmod failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.chmodSync(file, mode);
    },
    renameSync(source, destination) {
      const result = fs.renameSync(source, destination);
      if (path.dirname(destination) === files.publications) publishedPath = destination;
      return result;
    },
  };

  let captureB;
  let captureError;
  try {
    captureB = captureRecoveryTarget(config, 0, CAPTURE_ID_B, { fs: forcedFs });
  } catch (error) {
    captureError = error;
  }
  assert.equal(captureError, undefined);
  assert.equal(captureB, true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), THREAD_ID);
});

test('failed capture B cleanup cannot delete concurrently published capture C', () => {
  const { config } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  const files = targetPaths(config);
  let injected = false;
  const forcedFs = {
    ...fs,
    writeFileSync(file, ...args) {
      const generationTarget = files.targets && path.dirname(file) === files.targets;
      if (!injected && (file.startsWith(`${files.recovery}.tmp-`) || generationTarget)) {
        injected = true;
        assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_C), true);
        const error = new Error('forced capture B target-write failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.writeFileSync(file, ...args);
    },
  };

  assert.throws(
    () => captureRecoveryTarget(config, 0, CAPTURE_ID_B, { fs: forcedFs }),
    (error) => error?.code === 'EIO',
  );
  assert.equal(injected, true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_B), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_C), THREAD_ID);
});

test('clear generation cannot delete a concurrently published capture C', () => {
  const { config } = fixture();
  assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_A), true);
  const files = targetPaths(config);
  let injected = false;
  const captureC = () => {
    injected = true;
    assert.equal(captureRecoveryTarget(config, 0, CAPTURE_ID_C), true);
  };
  const forcedFs = {
    ...fs,
    unlinkSync(file) {
      if (!injected && file === files.recovery) captureC();
      return fs.unlinkSync(file);
    },
    writeFileSync(file, content, ...args) {
      const generationPublication = files.publications
        && path.dirname(file) === files.publications
        && String(content).includes('"status": "cleared"');
      if (!injected && generationPublication) captureC();
      return fs.writeFileSync(file, content, ...args);
    },
  };

  clearRecoveryTarget(config, { fs: forcedFs });
  assert.equal(injected, true);
  assert.equal(readRecoveryThread(config, CAPTURE_ID_A), '');
  assert.equal(readRecoveryThread(config, CAPTURE_ID_C), THREAD_ID);
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
