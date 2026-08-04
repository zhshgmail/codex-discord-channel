'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TARGET_VERSION = 1;
const CAPTURE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function targetPaths(config) {
  return {
    live: path.join(config.paths.stateDir, 'app-server-target.json'),
    recovery: path.join(config.paths.stateDir, 'tui-recovery-target.json'),
  };
}

function parseRecoveryTarget(raw) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    record?.version !== TARGET_VERSION
    || record.status !== 'active'
    || typeof record.threadId !== 'string'
    || !/^[0-9a-f-]{20,}$/i.test(record.threadId)
    || typeof record.activeTurnId !== 'string'
    || !Array.isArray(record.loadedThreadIds)
    || record.loadedThreadIds.length !== 1
    || record.loadedThreadIds[0] !== record.threadId
  ) {
    return null;
  }
  return record;
}

function requireCaptureId(captureId) {
  if (typeof captureId !== 'string' || !CAPTURE_ID_PATTERN.test(captureId)) {
    throw new Error('recovery capture identity is required');
  }
  return captureId;
}

function writeAtomic(file, content, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const now = dependencies.now || Date.now;
  const temp = `${file}.tmp-${process.pid}-${now()}`;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fsImpl.writeFileSync(temp, content, { mode: 0o600 });
    fsImpl.renameSync(temp, file);
    fsImpl.chmodSync(file, 0o600);
  } catch (error) {
    try {
      fsImpl.unlinkSync(temp);
    } catch {}
    throw error;
  }
}

function invalidateRecoveryTarget(file, captureId, dependencies = {}) {
  writeAtomic(file, `${JSON.stringify({
    version: TARGET_VERSION,
    status: 'invalid',
    captureId,
  }, null, 2)}\n`, dependencies);
}

function captureRecoveryTarget(config, minimumMtimeMs = 0, captureIdentity, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const files = targetPaths(config);
  const captureId = requireCaptureId(captureIdentity);
  if (!Number.isSafeInteger(minimumMtimeMs) || minimumMtimeMs < 0) {
    throw new Error('minimum recovery target mtime must be a non-negative integer');
  }
  let record;
  try {
    const liveMtimeMs = Math.floor(fsImpl.statSync(files.live).mtimeMs);
    if (!Number.isFinite(liveMtimeMs)) throw new Error('recovery target mtime is invalid');
    if (liveMtimeMs <= minimumMtimeMs) {
      invalidateRecoveryTarget(files.recovery, captureId, dependencies);
      return false;
    }
    record = parseRecoveryTarget(fsImpl.readFileSync(files.live, 'utf8'));
  } catch (error) {
    invalidateRecoveryTarget(files.recovery, captureId, dependencies);
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!record) {
    invalidateRecoveryTarget(files.recovery, captureId, dependencies);
    return false;
  }
  writeAtomic(files.recovery, `${JSON.stringify({ ...record, captureId }, null, 2)}\n`, dependencies);
  return true;
}

function readRecoveryThread(config, captureIdentity, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const captureId = requireCaptureId(captureIdentity);
  let record;
  try {
    record = parseRecoveryTarget(fsImpl.readFileSync(targetPaths(config).recovery, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return '';
  }
  if (record?.captureId !== captureId) return '';
  return record.threadId || '';
}

function clearRecoveryTarget(config, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  try {
    fsImpl.unlinkSync(targetPaths(config).recovery);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

module.exports = {
  captureRecoveryTarget,
  clearRecoveryTarget,
  parseRecoveryTarget,
  readRecoveryThread,
  targetPaths,
};
