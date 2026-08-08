'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const TARGET_VERSION = 2;
const TUI_LEASE_VERSION = 3;
const LEASE_ID = /^[0-9a-z][0-9a-z._-]{15,127}$/i;
const LOCK_WAIT_MS = 5_000;
const LOCK_ORPHAN_GRACE_MS = 30_000;

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
    ![1, TARGET_VERSION, TUI_LEASE_VERSION].includes(record?.version)
    || (record.version === 1 && !legacyActive)
    || typeof record.threadId !== 'string'
    || !/^[0-9a-f-]{20,}$/i.test(record.threadId)
    || !Array.isArray(record.loadedThreadIds)
    || record.loadedThreadIds.length === 0
    || new Set(record.loadedThreadIds).size !== record.loadedThreadIds.length
    || !record.loadedThreadIds.includes(record.threadId)
    || (record.version === TUI_LEASE_VERSION && !LEASE_ID.test(record.leaseId || ''))
  ) {
    return null;
  }
  return {
    version: record.version === TUI_LEASE_VERSION ? TUI_LEASE_VERSION : TARGET_VERSION,
    threadId: record.threadId,
    loadedThreadIds: [...record.loadedThreadIds],
    ...(record.version === TUI_LEASE_VERSION ? { leaseId: record.leaseId } : {}),
  };
}

function parseTuiLease(raw) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    record?.version !== TUI_LEASE_VERSION
    || !LEASE_ID.test(record.leaseId || '')
    || !Number.isSafeInteger(record.supervisorPid)
    || record.supervisorPid <= 1
    || typeof record.supervisorStartTicks !== 'string'
    || !/^\d+$/.test(record.supervisorStartTicks)
    || !Number.isSafeInteger(record.startedAtMs)
    || record.startedAtMs < 0
    || !['launching', 'active'].includes(record.phase)
  ) {
    return null;
  }
  const base = {
    version: TUI_LEASE_VERSION,
    leaseId: record.leaseId,
    supervisorPid: record.supervisorPid,
    supervisorStartTicks: record.supervisorStartTicks,
    startedAtMs: record.startedAtMs,
    phase: record.phase,
  };
  if (record.phase === 'launching') return base;
  const target = parseRecoveryTarget(JSON.stringify({
    version: TARGET_VERSION,
    threadId: record.threadId,
    loadedThreadIds: record.loadedThreadIds,
  }));
  return target ? { ...base, ...target, version: TUI_LEASE_VERSION } : null;
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

function processStartTicks(pid, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return '';
    const startTicks = raw.slice(close + 1).trim().split(/\s+/)[19];
    return /^\d+$/.test(startTicks || '') ? startTicks : '';
  } catch {
    return '';
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function removeOrphanedLock(lockFile, fsImpl, now) {
  let owner = null;
  let observedStat;
  try {
    owner = JSON.parse(fsImpl.readFileSync(lockFile, 'utf8'));
  } catch {}
  try {
    observedStat = fsImpl.statSync(lockFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (
    Number.isSafeInteger(owner?.pid)
    && owner.pid > 1
    && /^\d+$/.test(owner?.startTicks || '')
  ) {
    const actual = processStartTicks(owner.pid, fsImpl);
    if (actual === owner.startTicks) return false;
  } else {
    if (now() - observedStat.mtimeMs < LOCK_ORPHAN_GRACE_MS) return false;
  }
  const tombstone = `${lockFile}.stale-${process.pid}-${randomUUID()}`;
  try {
    fsImpl.renameSync(lockFile, tombstone);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  let movedOwner = null;
  let movedStat = null;
  try {
    movedOwner = JSON.parse(fsImpl.readFileSync(tombstone, 'utf8'));
  } catch {}
  try {
    movedStat = fsImpl.statSync(tombstone);
  } catch {}
  const movedObservedLock = movedStat
    && movedStat.dev === observedStat.dev
    && movedStat.ino === observedStat.ino;
  if (!movedObservedLock || (owner?.token && movedOwner?.token !== owner.token)) {
    try {
      fsImpl.linkSync(tombstone, lockFile);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  try {
    fsImpl.unlinkSync(tombstone);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

function releaseRecoveryLock(lockFile, ownerToken, fsImpl) {
  let owner;
  try {
    owner = JSON.parse(fsImpl.readFileSync(lockFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (owner?.token !== ownerToken) return;
  try {
    fsImpl.unlinkSync(lockFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function withRecoveryLock(config, dependencies, callback) {
  const fsImpl = dependencies.fs || fs;
  const now = dependencies.lockNow || Date.now;
  const recovery = targetPaths(config).recovery;
  const lockFile = `${recovery}.lock`;
  const ownerToken = randomUUID();
  const deadline = now() + LOCK_WAIT_MS;
  fsImpl.mkdirSync(path.dirname(recovery), { recursive: true, mode: 0o700 });
  for (;;) {
    let descriptor;
    let created = false;
    try {
      descriptor = fsImpl.openSync(lockFile, 'wx', 0o600);
      created = true;
      fsImpl.writeFileSync(descriptor, `${JSON.stringify({
        token: ownerToken,
        pid: process.pid,
        startTicks: processStartTicks(process.pid, fsImpl),
      })}\n`);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      let installedOwner = null;
      try {
        installedOwner = JSON.parse(fsImpl.readFileSync(lockFile, 'utf8'));
      } catch {}
      if (installedOwner?.token !== ownerToken) continue;
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        try {
          fsImpl.closeSync(descriptor);
        } catch {}
      }
      if (error?.code !== 'EEXIST') {
        if (created) {
          try {
            fsImpl.unlinkSync(lockFile);
          } catch {}
        }
        throw error;
      }
      if (removeOrphanedLock(lockFile, fsImpl, now)) continue;
      if (now() >= deadline) throw new Error('Timed out waiting for supervised TUI lease lock');
      sleepSync(10);
    }
  }
  try {
    return callback();
  } finally {
    releaseRecoveryLock(lockFile, ownerToken, fsImpl);
  }
}

function beginTuiLease(config, lease, dependencies = {}) {
  const record = parseTuiLease(JSON.stringify({
    version: TUI_LEASE_VERSION,
    leaseId: lease?.leaseId,
    supervisorPid: lease?.supervisorPid,
    supervisorStartTicks: String(lease?.supervisorStartTicks || ''),
    startedAtMs: lease?.startedAtMs,
    phase: 'launching',
  }));
  if (!record) throw new Error('Invalid supervised TUI lease identity');
  withRecoveryLock(config, dependencies, () => writeAtomic(
    targetPaths(config).recovery,
    `${JSON.stringify(record, null, 2)}\n`,
    dependencies,
  ));
  return record;
}

function captureRecoveryTarget(config, minimumMtimeMs = 0, dependencies = {}) {
  return withRecoveryLock(config, dependencies, () => {
    const fsImpl = dependencies.fs || fs;
    const files = targetPaths(config);
    let lease;
    try {
      lease = parseTuiLease(fsImpl.readFileSync(files.recovery, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return false;
    }
    if (!lease || lease.leaseId !== dependencies.leaseId) return false;
    const launching = {
      version: TUI_LEASE_VERSION,
      leaseId: lease.leaseId,
      supervisorPid: lease.supervisorPid,
      supervisorStartTicks: lease.supervisorStartTicks,
      startedAtMs: lease.startedAtMs,
      phase: 'launching',
    };
    let record;
    try {
      fsImpl.statSync(files.invalidated);
      writeAtomic(files.recovery, `${JSON.stringify(launching, null, 2)}\n`, dependencies);
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      if (minimumMtimeMs && fsImpl.statSync(files.live).mtimeMs < minimumMtimeMs) {
        writeAtomic(files.recovery, `${JSON.stringify(lease, null, 2)}\n`, dependencies);
        return false;
      }
      record = parseRecoveryTarget(fsImpl.readFileSync(files.live, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      writeAtomic(files.recovery, `${JSON.stringify(lease, null, 2)}\n`, dependencies);
      return false;
    }
    if (!record) {
      writeAtomic(files.recovery, `${JSON.stringify(launching, null, 2)}\n`, dependencies);
      return false;
    }
    if (record.version === TUI_LEASE_VERSION && record.leaseId !== lease.leaseId) {
      writeAtomic(files.recovery, `${JSON.stringify(lease, null, 2)}\n`, dependencies);
      return false;
    }
    writeAtomic(files.recovery, `${JSON.stringify({
      ...launching,
      phase: 'active',
      threadId: record.threadId,
      loadedThreadIds: record.loadedThreadIds,
    }, null, 2)}\n`, dependencies);
    return true;
  });
}

function readRecoveryThread(config, dependencies = {}) {
  const fsImpl = dependencies.fs || fs;
  let record;
  try {
    record = parseTuiLease(fsImpl.readFileSync(targetPaths(config).recovery, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return '';
  }
  return record?.phase === 'active' ? record.threadId : '';
}

function clearRecoveryTarget(config, dependencies = {}) {
  return withRecoveryLock(config, dependencies, () => {
    const fsImpl = dependencies.fs || fs;
    const expectedLeaseId = dependencies.leaseId || '';
    if (expectedLeaseId) {
      let current;
      try {
        current = parseTuiLease(fsImpl.readFileSync(targetPaths(config).recovery, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      if (!current || current.leaseId !== expectedLeaseId) return;
    }
    try {
      fsImpl.unlinkSync(targetPaths(config).recovery);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  });
}

module.exports = {
  beginTuiLease,
  captureRecoveryTarget,
  clearRecoveryTarget,
  parseRecoveryTarget,
  parseTuiLease,
  readRecoveryThread,
  targetPaths,
};
