'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function localPid(deps = {}) {
  const pid = Number(deps.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : process.pid;
}

function parseLegacyPid(contents) {
  const text = String(contents).trim();
  if (!/^[1-9]\d*$/.test(text)) return 0;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : 0;
}

function validOwnershipIdentity(record) {
  return Boolean(
    record &&
    (record.version === 1 || record.version === 2) &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.generation === 'string' &&
    record.generation !== '' &&
    typeof record.claimedAt === 'string',
  );
}

function parseOwnershipRecord(contents) {
  try {
    const record = JSON.parse(String(contents));
    if (!validOwnershipIdentity(record)) return null;
    if (record.version === 2 && record.fallback !== null && !validOwnershipIdentity(record.fallback)) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getReceiverAuthorityPath(config = {}) {
  return config.paths?.gatewayPidPath || '';
}

function getStagedReceiverAuthorityPath(config = {}) {
  const authorityPath = getReceiverAuthorityPath(config);
  return authorityPath ? `${authorityPath}.v2` : '';
}

function getLegacyOwnershipPath(config = {}) {
  const authorityPath = getReceiverAuthorityPath(config);
  return config.paths?.receiverOwnershipPath || (authorityPath ? `${authorityPath}.generation` : '');
}

function readLegacyOwnership(config, pid, fsImpl) {
  const legacyPath = getLegacyOwnershipPath(config);
  if (!legacyPath) return null;
  try {
    const record = parseOwnershipRecord(fsImpl.readFileSync(legacyPath, 'utf8'));
    return record?.pid === pid ? record : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readStructuredAuthority(pathname, fsImpl, source) {
  let contents;
  try {
    contents = fsImpl.readFileSync(pathname, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const token = String(contents);
  const record = parseOwnershipRecord(token);
  return {
    path: pathname,
    exists: true,
    valid: Boolean(record),
    token,
    record,
    source: record ? source : 'invalid',
  };
}

function readReceiverAuthoritySnapshot(config = {}, deps = {}) {
  const authorityPath = getReceiverAuthorityPath(config);
  if (!authorityPath) {
    return { path: '', exists: false, valid: false, token: null, record: null, source: 'unconfigured' };
  }
  const fsImpl = deps.fs || fs;
  const staged = readStructuredAuthority(getStagedReceiverAuthorityPath(config), fsImpl, 'staged');
  if (staged) return staged;

  let contents;
  try {
    contents = fsImpl.readFileSync(authorityPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path: authorityPath, exists: false, valid: true, token: null, record: null, source: 'missing' };
    }
    throw error;
  }

  const token = String(contents);
  const atomicRecord = parseOwnershipRecord(token);
  if (atomicRecord) {
    return {
      path: authorityPath,
      exists: true,
      valid: true,
      token,
      record: atomicRecord,
      source: 'atomic',
    };
  }

  const pid = parseLegacyPid(token);
  if (pid) {
    const legacyRecord = readLegacyOwnership(config, pid, fsImpl) || {
      version: 1,
      pid,
      generation: `legacy-pid:${pid}`,
      claimedAt: '',
    };
    return {
      path: authorityPath,
      exists: true,
      valid: true,
      token,
      record: legacyRecord,
      source: 'legacy',
    };
  }

  return {
    path: authorityPath,
    exists: true,
    valid: false,
    token,
    record: null,
    source: 'invalid',
  };
}

function processIsAlive(pid, deps = {}) {
  return (deps.isProcessAlive || isProcessAlive)(pid);
}

function effectiveReceiverOwnership(snapshot, deps = {}) {
  const record = snapshot?.valid ? snapshot.record : null;
  if (!record) return null;
  if (processIsAlive(record.pid, deps)) return { record, fallback: false };
  if (record.version === 2 && record.fallback && processIsAlive(record.fallback.pid, deps)) {
    return { record: record.fallback, fallback: true };
  }
  return null;
}

function sameReceiverOwnership(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.generation === right.generation,
  );
}

function isActiveDiscordReceiver(config = {}, deps = {}) {
  const authorityPath = getReceiverAuthorityPath(config);
  if (!authorityPath) return { active: false, reason: 'gateway_pid_unconfigured' };
  const snapshot = readReceiverAuthoritySnapshot(config, deps);
  if (!snapshot.valid) return { active: false, reason: 'gateway_authority_invalid' };
  if (!snapshot.record) return { active: false, reason: 'gateway_pid_missing' };
  const effective = effectiveReceiverOwnership(snapshot, deps);
  if (!effective) {
    return { active: false, reason: 'stale_gateway_pid', pid: snapshot.record.pid };
  }
  if (effective.record.pid !== localPid(deps)) {
    return { active: false, reason: 'another_gateway_active', pid: effective.record.pid };
  }
  const reason = snapshot.source === 'legacy'
    ? 'gateway_pid_match'
    : (effective.fallback ? 'gateway_generation_fallback' : 'gateway_generation_match');
  const result = {
    active: true,
    reason,
    pid: effective.record.pid,
  };
  if (snapshot.source !== 'legacy') result.generation = effective.record.generation;
  return result;
}

function isCurrentReceiverOwnership(config = {}, expected, deps = {}) {
  const snapshot = readReceiverAuthoritySnapshot(config, deps);
  if (!snapshot.valid) return { active: false, reason: 'gateway_authority_invalid' };
  if (!snapshot.record) return { active: false, reason: 'gateway_pid_missing' };
  const effective = effectiveReceiverOwnership(snapshot, deps);
  if (
    !expected ||
    !effective ||
    !sameReceiverOwnership(effective.record, expected) ||
    expected.pid !== localPid(deps)
  ) {
    return {
      active: false,
      reason: 'gateway_generation_changed',
      pid: effective?.record?.pid || snapshot.record.pid || 0,
    };
  }
  return {
    active: true,
    reason: effective.fallback ? 'gateway_generation_fallback' : 'gateway_generation_match',
    pid: expected.pid,
    generation: expected.generation,
  };
}

function fallbackRecord(record) {
  if (!record) return null;
  if (record.version === 2) return { ...record, fallback: null };
  return { ...record };
}

function createReceiverOwnership(previous, deps = {}) {
  const pid = localPid(deps);
  const nowValue = typeof deps.now === 'function' ? deps.now() : Date.now();
  return {
    version: 2,
    pid,
    generation: (deps.randomUUID || randomUUID)(),
    claimedAt: new Date(nowValue).toISOString(),
    fallback: previous && previous.pid !== pid ? fallbackRecord(previous) : null,
  };
}

function writeAuthorityAtomically(file, record, deps = {}) {
  const fsImpl = deps.fs || fs;
  const pid = localPid(deps);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${pid}.${record.generation}.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fsImpl.renameSync(temp, file);
  } finally {
    try {
      fsImpl.rmSync(temp, { force: true });
    } catch {}
  }
}

function snapshotsMatch(left, right) {
  return left?.path === right?.path && left?.token === right?.token;
}

function commitReceiverOwnership(config, expectedSnapshot, candidate, deps = {}) {
  const current = readReceiverAuthoritySnapshot(config, deps);
  if (!current.valid || !snapshotsMatch(current, expectedSnapshot)) {
    const error = new Error('Discord receiver ownership changed before atomic commit.');
    error.code = 'receiver_ownership_changed';
    throw error;
  }
  const targetPath = current.source === 'legacy' && candidate.fallback?.version === 1
    ? getStagedReceiverAuthorityPath(config)
    : current.path;
  writeAuthorityAtomically(targetPath, candidate, deps);
  return candidate;
}

function releaseReceiverOwnership(config, expected, deps = {}) {
  const snapshot = readReceiverAuthoritySnapshot(config, deps);
  if (!snapshot.valid || !snapshot.record || !expected) return false;
  const fsImpl = deps.fs || fs;
  const current = snapshot.record;
  if (sameReceiverOwnership(current, expected)) {
    const fallback = current.version === 2 && current.fallback && processIsAlive(current.fallback.pid, deps)
      ? fallbackRecord(current.fallback)
      : null;
    if (fallback) {
      if (fallback.version === 1 && snapshot.source === 'staged') {
        fsImpl.unlinkSync(snapshot.path);
      } else {
        writeAuthorityAtomically(snapshot.path, fallback, deps);
      }
    } else {
      fsImpl.unlinkSync(snapshot.path);
    }
    return true;
  }
  if (
    current.version === 2 &&
    sameReceiverOwnership(current.fallback, expected)
  ) {
    writeAuthorityAtomically(snapshot.path, { ...current, fallback: null }, deps);
    return true;
  }
  return false;
}

module.exports = {
  commitReceiverOwnership,
  createReceiverOwnership,
  effectiveReceiverOwnership,
  getReceiverAuthorityPath,
  getStagedReceiverAuthorityPath,
  isActiveDiscordReceiver,
  isCurrentReceiverOwnership,
  isProcessAlive,
  readReceiverAuthoritySnapshot,
  releaseReceiverOwnership,
  sameReceiverOwnership,
};
