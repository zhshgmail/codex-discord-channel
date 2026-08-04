'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TARGET_VERSION = 1;
const CAPTURE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function targetPaths(config) {
  return {
    live: path.join(config.paths.stateDir, 'app-server-target.json'),
    publication: path.join(config.paths.stateDir, 'tui-recovery-target.ready'),
    recovery: path.join(config.paths.stateDir, 'tui-recovery-target.json'),
    tombstone: path.join(config.paths.stateDir, 'tui-recovery-target.invalid'),
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

function unlinkIfExists(file, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  try {
    fsImpl.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function invalidationRecord(captureId) {
  return `${JSON.stringify({
    version: TARGET_VERSION,
    status: 'invalid',
    captureId,
  }, null, 2)}\n`;
}

function publicationRecord(captureId) {
  return `${JSON.stringify({
    version: TARGET_VERSION,
    status: 'published',
    captureId,
  }, null, 2)}\n`;
}

function readPublication(file, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    record?.version !== TARGET_VERSION
    || record.status !== 'published'
    || typeof record.captureId !== 'string'
    || !CAPTURE_ID_PATTERN.test(record.captureId)
  ) {
    return null;
  }
  return { raw, record };
}

function tombstoneExists(file, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  try {
    fsImpl.statSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function replaceRecoveryTarget(files, content, captureId, clearTombstone, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  unlinkIfExists(files.publication, dependencies);
  writeAtomic(files.tombstone, invalidationRecord(captureId), dependencies);
  try {
    writeAtomic(files.recovery, content, dependencies);
  } catch (writeError) {
    try {
      unlinkIfExists(files.recovery, dependencies);
    } catch (deleteError) {
      throw new AggregateError(
        [writeError, deleteError],
        'recovery target replacement and stale target deletion both failed',
      );
    }
    throw writeError;
  }
  if (clearTombstone) {
    unlinkIfExists(files.tombstone, { ...dependencies, fs: fsImpl });
    writeAtomic(files.publication, publicationRecord(captureId), dependencies);
  }
}

function invalidateRecoveryTarget(files, captureId, dependencies = {}) {
  const invalid = invalidationRecord(captureId);
  replaceRecoveryTarget(files, invalid, captureId, false, dependencies);
}

function captureRecoveryTarget(config, minimumMtimeMs = 0, captureIdentity, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const files = targetPaths(config);
  const captureId = requireCaptureId(captureIdentity);
  if (!Number.isSafeInteger(minimumMtimeMs) || minimumMtimeMs < 0) {
    throw new Error('minimum recovery target mtime must be a non-negative integer');
  }
  let liveMtimeMs;
  let record;
  try {
    liveMtimeMs = Math.floor(fsImpl.statSync(files.live).mtimeMs);
    if (!Number.isFinite(liveMtimeMs)) throw new Error('recovery target mtime is invalid');
    record = parseRecoveryTarget(fsImpl.readFileSync(files.live, 'utf8'));
  } catch (error) {
    invalidateRecoveryTarget(files, captureId, dependencies);
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (liveMtimeMs <= minimumMtimeMs) {
    invalidateRecoveryTarget(files, captureId, dependencies);
    return false;
  }
  if (!record) {
    invalidateRecoveryTarget(files, captureId, dependencies);
    return false;
  }
  replaceRecoveryTarget(
    files,
    `${JSON.stringify({ ...record, captureId }, null, 2)}\n`,
    captureId,
    true,
    dependencies,
  );
  return true;
}

function readRecoveryThread(config, captureIdentity, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const captureId = requireCaptureId(captureIdentity);
  const files = targetPaths(config);
  const firstPublication = readPublication(files.publication, dependencies);
  if (firstPublication?.record.captureId !== captureId) return '';
  if (tombstoneExists(files.tombstone, dependencies)) return '';
  let record;
  try {
    record = parseRecoveryTarget(fsImpl.readFileSync(files.recovery, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return '';
  }
  if (tombstoneExists(files.tombstone, dependencies)) return '';
  const secondPublication = readPublication(files.publication, dependencies);
  if (secondPublication?.raw !== firstPublication.raw) return '';
  if (record?.captureId !== captureId) return '';
  return record.threadId || '';
}

function clearRecoveryTarget(config, dependencies = {}) {
  const files = targetPaths(config);
  unlinkIfExists(files.publication, dependencies);
  unlinkIfExists(files.recovery, dependencies);
  unlinkIfExists(files.tombstone, dependencies);
}

module.exports = {
  captureRecoveryTarget,
  clearRecoveryTarget,
  parseRecoveryTarget,
  readRecoveryThread,
  targetPaths,
};
