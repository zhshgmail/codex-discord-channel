#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const lockPath = path.resolve(process.env.STARTUP_LOCK_PATH);
const tracePath = path.resolve(process.env.STARTUP_LOCK_TRACE);
const barrierPath = path.resolve(process.env.STARTUP_LOCK_BARRIER);
const releasePath = path.resolve(process.env.STARTUP_LOCK_RELEASE);

function isTarget(input) {
  return typeof input === 'string' && path.resolve(input) === lockPath;
}

function trace(event) {
  fs.appendFileSync(tracePath, `${JSON.stringify({ event, pid: process.pid })}\n`);
}

function pauseAfterAcquire() {
  if (process.env.STARTUP_LOCK_PAUSE_AFTER_ACQUIRE !== '1') return;
  fs.writeFileSync(barrierPath, `${process.pid}\n`, { mode: 0o600 });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for startup lock release');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

const originalOpenSync = fs.openSync;
fs.openSync = function instrumentedOpenSync(input, flags, ...args) {
  const target = isTarget(input) && flags === 'wx';
  if (target) trace('attempt');
  const descriptor = originalOpenSync.call(this, input, flags, ...args);
  if (target) {
    trace('acquired');
    pauseAfterAcquire();
  }
  return descriptor;
};

const originalMkdirSync = fs.mkdirSync;
fs.mkdirSync = function instrumentedMkdirSync(input, options) {
  const target = isTarget(input);
  if (target) trace('attempt');
  const result = originalMkdirSync.call(this, input, options);
  if (target) {
    trace('acquired');
    pauseAfterAcquire();
  }
  return result;
};

const originalLinkSync = fs.linkSync;
fs.linkSync = function instrumentedLinkSync(existingPath, newPath) {
  const target = isTarget(newPath);
  if (target) trace('attempt');
  const result = originalLinkSync.call(this, existingPath, newPath);
  if (target) {
    trace('acquired');
    pauseAfterAcquire();
  }
  return result;
};

const { ensureSharedAppServer } = require(process.env.SESSION_LAUNCHER_MODULE);

ensureSharedAppServer({
  codexBin: process.env.CODEX_DISCORD_CODEX_BIN,
  endpoint: process.env.CODEX_DISCORD_APP_SERVER_URL,
  env: process.env,
  pollMs: 25,
  timeoutMs: Number(process.env.STARTUP_LOCK_TIMEOUT_MS || 5000),
}).then((result) => {
  fs.writeFileSync(process.env.STARTUP_LOCK_RESULT, `${JSON.stringify(result)}\n`, { mode: 0o600 });
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
