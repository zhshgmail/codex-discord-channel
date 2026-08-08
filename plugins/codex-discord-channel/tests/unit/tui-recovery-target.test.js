'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');
const {
  beginTuiLease,
  captureRecoveryTarget,
  clearRecoveryTarget,
  parseRecoveryTarget,
  parseTuiLease,
  readRecoveryThread,
} = require('../../src/tui-recovery-target');

const THREAD_ID = '019f3763-d308-7871-bedc-e6489b02190e';
const LEASE_ID = 'lease-0000000000000001';
const REPLACEMENT_LEASE_ID = 'lease-0000000000000002';
const MODULE_PATH = require.resolve('../../src/tui-recovery-target');

const RACE_WORKER = String.raw`
  'use strict';
  const fs = require('node:fs');
  const { parentPort, workerData } = require('node:worker_threads');
  const target = require(workerData.modulePath);
  const config = { paths: { stateDir: workerData.stateDir } };
  try {
    if (workerData.role === 'replacement') {
      target.beginTuiLease(config, workerData.lease);
    } else {
      const recovery = workerData.recovery;
      let paused = false;
      const fsProxy = new Proxy(fs, {
        get(subject, property) {
          if (property === 'readFileSync') {
            return (file, ...args) => {
              const value = fs.readFileSync(file, ...args);
              if (!paused && String(file) === recovery) {
                paused = true;
                parentPort.postMessage('paused');
                const signal = new Int32Array(workerData.signal);
                Atomics.wait(signal, 0, 0);
              }
              return value;
            };
          }
          const value = Reflect.get(subject, property);
          return typeof value === 'function' ? value.bind(subject) : value;
        },
      });
      if (workerData.operation === 'clear') {
        target.clearRecoveryTarget(config, { fs: fsProxy, leaseId: workerData.leaseId });
      } else {
        target.captureRecoveryTarget(config, 0, { fs: fsProxy, leaseId: workerData.leaseId });
      }
    }
    parentPort.postMessage('done');
  } catch (error) {
    parentPort.postMessage({ error: error && error.stack ? error.stack : String(error) });
  }
`;

function workerResult(worker, expectedFirstMessage = '') {
  return new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (message) => {
      if (message?.error) reject(new Error(message.error));
      else if (!expectedFirstMessage || message === expectedFirstMessage) resolve(message);
    });
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`lease race worker exited ${code}`));
    });
  });
}

async function proveReplacementWins(operation) {
  const { config } = fixture();
  begin(config);
  const recovery = path.join(config.paths.stateDir, 'tui-recovery-target.json');
  const signalBuffer = new SharedArrayBuffer(4);
  const stale = new Worker(RACE_WORKER, {
    eval: true,
    workerData: {
      role: 'stale',
      operation,
      modulePath: MODULE_PATH,
      stateDir: config.paths.stateDir,
      recovery,
      leaseId: LEASE_ID,
      signal: signalBuffer,
    },
  });
  await workerResult(stale, 'paused');
  const replacement = new Worker(RACE_WORKER, {
    eval: true,
    workerData: {
      role: 'replacement',
      modulePath: MODULE_PATH,
      stateDir: config.paths.stateDir,
      lease: {
        leaseId: REPLACEMENT_LEASE_ID,
        supervisorPid: 5252,
        supervisorStartTicks: '54321',
        startedAtMs: 2000,
      },
    },
  });
  const replacementDone = workerResult(replacement, 'done');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const signal = new Int32Array(signalBuffer);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
  await Promise.all([workerResult(stale, 'done'), replacementDone]);
  assert.equal(parseTuiLease(fs.readFileSync(recovery, 'utf8')).leaseId, REPLACEMENT_LEASE_ID);
}

function begin(config) {
  return beginTuiLease(config, {
    leaseId: LEASE_ID,
    supervisorPid: 4242,
    supervisorStartTicks: '12345',
    startedAtMs: 1000,
  });
}

function capture(config, minimumMtimeMs = 0) {
  return captureRecoveryTarget(config, minimumMtimeMs, { leaseId: LEASE_ID });
}

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
  assert.deepEqual(parseRecoveryTarget(JSON.stringify({
    version: 3,
    leaseId: LEASE_ID,
    threadId: THREAD_ID,
    loadedThreadIds: [THREAD_ID],
  })), {
    version: 3,
    leaseId: LEASE_ID,
    threadId: THREAD_ID,
    loadedThreadIds: [THREAD_ID],
  });
  assert.equal(parseRecoveryTarget(JSON.stringify({
    version: 2,
    threadId: THREAD_ID,
    loadedThreadIds: ['019f3763-d308-7871-bedc-e6489b02190f'],
  })), null);
  assert.deepEqual(parseTuiLease(JSON.stringify({
    version: 3,
    leaseId: LEASE_ID,
    supervisorPid: 4242,
    supervisorStartTicks: '12345',
    startedAtMs: 1000,
    phase: 'launching',
  })), {
    version: 3,
    leaseId: LEASE_ID,
    supervisorPid: 4242,
    supervisorStartTicks: '12345',
    startedAtMs: 1000,
    phase: 'launching',
  });
});

test('capture accepts the production v3 checkpoint bound to its exact lease', () => {
  const { config, live } = fixture();
  begin(config);
  fs.writeFileSync(live, `${JSON.stringify({
    version: 3,
    leaseId: LEASE_ID,
    threadId: THREAD_ID,
    loadedThreadIds: [THREAD_ID],
  })}\n`);
  assert.equal(capture(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);
});

test('capture binds one exact active thread and read returns only that id', () => {
  const { config } = fixture();
  begin(config);
  assert.equal(capture(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);
  const recovery = path.join(config.paths.stateDir, 'tui-recovery-target.json');
  assert.equal(fs.statSync(recovery).mode & 0o777, 0o600);
  clearRecoveryTarget(config);
  assert.equal(readRecoveryThread(config), '');
});

test('an older launcher cannot clear a replacement launcher lease', () => {
  const { config } = fixture();
  begin(config);
  clearRecoveryTarget(config, { leaseId: 'lease-0000000000000000' });
  assert.equal(parseTuiLease(fs.readFileSync(
    path.join(config.paths.stateDir, 'tui-recovery-target.json'),
    'utf8',
  )).leaseId, LEASE_ID);
  clearRecoveryTarget(config, { leaseId: LEASE_ID });
  assert.equal(readRecoveryThread(config), '');
});

test('a stale clear cannot delete a replacement lease created during its ownership check', async () => {
  await proveReplacementWins('clear');
});

test('a stale snapshot cannot overwrite a replacement lease created during capture', async () => {
  await proveReplacementWins('capture');
});

test('orphan lock reclamation preserves a successor installed before the atomic rename', () => {
  const { config } = fixture();
  const recovery = path.join(config.paths.stateDir, 'tui-recovery-target.json');
  const lockFile = `${recovery}.lock`;
  fs.writeFileSync(lockFile, `${JSON.stringify({
    token: 'orphan-lock-token',
    pid: 999_999_999,
    startTicks: '1',
  })}\n`);
  const procStat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const successor = {
    token: 'successor-lock-token',
    pid: process.pid,
    startTicks: procStat.slice(procStat.lastIndexOf(')') + 1).trim().split(/\s+/)[19],
  };
  let injected = false;
  const fsProxy = new Proxy(fs, {
    get(subject, property) {
      if (property === 'renameSync') {
        return (from, to) => {
          if (!injected && String(from) === lockFile) {
            injected = true;
            fs.unlinkSync(lockFile);
            fs.writeFileSync(lockFile, `${JSON.stringify(successor)}\n`);
          }
          return fs.renameSync(from, to);
        };
      }
      const value = Reflect.get(subject, property);
      return typeof value === 'function' ? value.bind(subject) : value;
    },
  });
  let lockTime = 0;
  assert.throws(() => beginTuiLease(config, {
    leaseId: REPLACEMENT_LEASE_ID,
    supervisorPid: 5252,
    supervisorStartTicks: '54321',
    startedAtMs: 2000,
  }, {
    fs: fsProxy,
    lockNow: () => {
      lockTime += 6_000;
      return lockTime;
    },
  }), /Timed out waiting for supervised TUI lease lock/);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')), successor);
});

test('capture refuses a checkpoint older than the supervised launch', () => {
  const { config, live } = fixture();
  begin(config);
  const afterLiveWrite = fs.statSync(live).mtimeMs + 1;
  assert.equal(capture(config, afterLiveWrite), false);
  assert.equal(readRecoveryThread(config), '');
});

test('present malformed capture invalidates an earlier exact target', () => {
  const { config, live } = fixture();
  begin(config);
  assert.equal(capture(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);

  fs.writeFileSync(live, `${JSON.stringify({
    version: 2,
    threadId: THREAD_ID,
    loadedThreadIds: ['019f3763-d308-7871-bedc-e6489b02190f'],
  })}\n`);
  assert.equal(capture(config), false);
  assert.equal(readRecoveryThread(config), '');
});

test('a transient missing live checkpoint preserves the last exact recovery target', () => {
  const { config, live } = fixture();
  begin(config);
  assert.equal(capture(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);

  fs.unlinkSync(live);
  assert.equal(capture(config), false);
  assert.equal(readRecoveryThread(config), THREAD_ID);
});

test('snapshot heartbeats an unbound lease while the TUI is still attaching', () => {
  const { config, live } = fixture();
  begin(config);
  fs.unlinkSync(live);
  const recovery = path.join(config.paths.stateDir, 'tui-recovery-target.json');
  const before = fs.statSync(recovery).mtimeMs;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);

  assert.equal(capture(config), false);
  assert.ok(fs.statSync(recovery).mtimeMs > before);
  assert.equal(parseTuiLease(fs.readFileSync(recovery, 'utf8')).phase, 'launching');
});

test('an explicit live-target invalidation clears the last recovery target', () => {
  const { config, live } = fixture();
  begin(config);
  assert.equal(capture(config), true);
  assert.equal(readRecoveryThread(config), THREAD_ID);

  fs.unlinkSync(live);
  fs.writeFileSync(
    path.join(config.paths.stateDir, 'app-server-target.invalidated.json'),
    `${JSON.stringify({ version: 1, invalidatedAt: '2026-08-08T00:00:00.000Z' })}\n`,
  );
  assert.equal(capture(config), false);
  assert.equal(readRecoveryThread(config), '');
});
