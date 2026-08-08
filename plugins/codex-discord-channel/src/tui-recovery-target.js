'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TARGET_VERSION = 2;

function targetPaths(config) {
  return {
    live: path.join(config.paths.stateDir, 'app-server-target.json'),
    invalidated: path.join(config.paths.stateDir, 'app-server-target.invalidated.json'),
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
  const legacyActive = record?.version === 1 && record.status === 'active'
    && typeof record.activeTurnId === 'string' && record.activeTurnId !== '';
  if (
    ![1, TARGET_VERSION].includes(record?.version)
    || (record.version === 1 && !legacyActive)
    || typeof record.threadId !== 'string'
    || !/^[0-9a-f-]{20,}$/i.test(record.threadId)
    || !Array.isArray(record.loadedThreadIds)
    || record.loadedThreadIds.length === 0
    || new Set(record.loadedThreadIds).size !== record.loadedThreadIds.length
    || !record.loadedThreadIds.includes(record.threadId)
  ) {
    return null;
  }
  return {
    version: TARGET_VERSION,
    threadId: record.threadId,
    loadedThreadIds: [...record.loadedThreadIds],
  };
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

function captureRecoveryTarget(config, minimumMtimeMs = 0, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const files = targetPaths(config);
  let record;
  try {
    fsImpl.statSync(files.invalidated);
    clearRecoveryTarget(config, dependencies);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    if (minimumMtimeMs && fsImpl.statSync(files.live).mtimeMs < minimumMtimeMs) return false;
    record = parseRecoveryTarget(fsImpl.readFileSync(files.live, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return false;
  }
  if (!record) {
    clearRecoveryTarget(config, dependencies);
    return false;
  }
  writeAtomic(files.recovery, `${JSON.stringify(record, null, 2)}\n`, dependencies);
  return true;
}

function readRecoveryThread(config, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  let record;
  try {
    record = parseRecoveryTarget(fsImpl.readFileSync(targetPaths(config).recovery, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return '';
  }
  return record?.threadId || '';
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
