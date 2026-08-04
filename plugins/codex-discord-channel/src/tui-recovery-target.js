'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TARGET_VERSION = 1;
const PUBLICATION_VERSION = 2;
const CAPTURE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ATTEMPT_FILE_PATTERN = /^([1-9][0-9]*)\.attempt$/;

function targetPaths(config) {
  return {
    live: path.join(config.paths.stateDir, 'app-server-target.json'),
    attempts: path.join(config.paths.stateDir, 'tui-recovery-attempts'),
    publications: path.join(config.paths.stateDir, 'tui-recovery-publications'),
    targets: path.join(config.paths.stateDir, 'tui-recovery-targets'),
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

function attemptPath(files, sequence) {
  return path.join(files.attempts, `${sequence}.attempt`);
}

function publicationPath(files, sequence) {
  return path.join(files.publications, `${sequence}.json`);
}

function recoveryPath(files, sequence) {
  return path.join(files.targets, `${sequence}.json`);
}

function latestAttemptSequence(files, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  let names;
  try {
    names = fsImpl.readdirSync(files.attempts);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let latest = 0;
  for (const name of names) {
    const match = ATTEMPT_FILE_PATTERN.exec(name);
    if (!match) return null;
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || String(sequence) !== match[1]) return null;
    if (sequence > latest) latest = sequence;
  }
  return latest;
}

function allocateAttempt(files, operationId, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  fsImpl.mkdirSync(files.attempts, { recursive: true, mode: 0o700 });
  let latest = latestAttemptSequence(files, dependencies);
  if (latest === null || latest >= Number.MAX_SAFE_INTEGER) {
    throw new Error('recovery attempt ledger is invalid or exhausted');
  }
  while (latest < Number.MAX_SAFE_INTEGER) {
    const sequence = latest + 1;
    const content = `${JSON.stringify({
      version: PUBLICATION_VERSION,
      sequence,
      status: 'started',
      operationId,
    }, null, 2)}\n`;
    try {
      fsImpl.writeFileSync(attemptPath(files, sequence), content, { flag: 'wx', mode: 0o600 });
      return sequence;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      latest = sequence;
    }
  }
  throw new Error('recovery attempt ledger is exhausted');
}

function writeAtomic(file, content, sequence, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const temp = `${file}.tmp-${process.pid}-${sequence}`;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fsImpl.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
    fsImpl.chmodSync(temp, 0o600);
    fsImpl.renameSync(temp, file);
  } catch (error) {
    try {
      fsImpl.unlinkSync(temp);
    } catch {}
    throw error;
  }
}

function publicationRecord(sequence, status, identity) {
  return `${JSON.stringify({
    version: PUBLICATION_VERSION,
    sequence,
    status,
    ...identity,
  }, null, 2)}\n`;
}

function parsePublication(raw, sequence) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    record?.version !== PUBLICATION_VERSION
    || record.sequence !== sequence
    || !['published', 'invalid', 'cleared'].includes(record.status)
  ) {
    return null;
  }
  return record;
}

function publish(files, sequence, status, identity, dependencies = {}) {
  writeAtomic(
    publicationPath(files, sequence),
    publicationRecord(sequence, status, identity),
    sequence,
    dependencies,
  );
}

function publishInvalid(files, sequence, captureId, dependencies = {}) {
  publish(files, sequence, 'invalid', { captureId }, dependencies);
}

function captureRecoveryTarget(config, minimumMtimeMs = 0, captureIdentity, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const files = targetPaths(config);
  const captureId = requireCaptureId(captureIdentity);
  if (!Number.isSafeInteger(minimumMtimeMs) || minimumMtimeMs < 0) {
    throw new Error('minimum recovery target mtime must be a non-negative integer');
  }

  const sequence = allocateAttempt(files, captureId, dependencies);
  let liveMtimeMs;
  let record;
  try {
    liveMtimeMs = Math.floor(fsImpl.statSync(files.live).mtimeMs);
    if (!Number.isFinite(liveMtimeMs)) throw new Error('recovery target mtime is invalid');
    record = parseRecoveryTarget(fsImpl.readFileSync(files.live, 'utf8'));
  } catch (error) {
    publishInvalid(files, sequence, captureId, dependencies);
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (liveMtimeMs <= minimumMtimeMs || !record) {
    publishInvalid(files, sequence, captureId, dependencies);
    return false;
  }

  writeAtomic(
    recoveryPath(files, sequence),
    `${JSON.stringify({ ...record, captureId }, null, 2)}\n`,
    sequence,
    dependencies,
  );
  publish(files, sequence, 'published', { captureId }, dependencies);
  return true;
}

function readRecoveryThread(config, captureIdentity, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  const captureId = requireCaptureId(captureIdentity);
  const files = targetPaths(config);
  const firstSequence = latestAttemptSequence(files, dependencies);
  if (!firstSequence) return '';

  let publication;
  let target;
  try {
    publication = parsePublication(
      fsImpl.readFileSync(publicationPath(files, firstSequence), 'utf8'),
      firstSequence,
    );
    if (publication?.status !== 'published' || publication.captureId !== captureId) return '';
    target = parseRecoveryTarget(fsImpl.readFileSync(recoveryPath(files, firstSequence), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return '';
  }
  const secondSequence = latestAttemptSequence(files, dependencies);
  if (secondSequence !== firstSequence) return '';
  if (target?.captureId !== captureId) return '';
  return target.threadId || '';
}

function clearRecoveryTarget(config, dependencies = {}) {
  const files = targetPaths(config);
  const now = dependencies.now || Date.now;
  const operationId = `clear-${process.pid}-${now()}`;
  const sequence = allocateAttempt(files, operationId, dependencies);
  publish(files, sequence, 'cleared', { operationId }, dependencies);
}

module.exports = {
  captureRecoveryTarget,
  clearRecoveryTarget,
  parseRecoveryTarget,
  readRecoveryThread,
  targetPaths,
};
