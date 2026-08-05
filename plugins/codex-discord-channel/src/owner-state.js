'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OWNER_VERSION = 2;
const DEFAULT_LOCK_TIMEOUT_MS = 60000;
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_STALE_MS = 45000;

function currentPid(deps = {}) {
  const pid = Number(deps.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : process.pid;
}

function currentTimeMs(deps = {}) {
  return Number(typeof deps.now === 'function' ? deps.now() : Date.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function readJson(file, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function createOwner(config) {
  return {
    instance: config.paths.instance,
    stateDir: path.resolve(config.paths.stateDir),
    ownerId: config.ownerId,
    pid: config.pid,
    hostname: config.hostname,
    cwd: config.cwd,
    startedAt: config.startedAt,
    threadId: config.threadId || '',
    turnId: config.turnId || '',
  };
}

function readOwner(ownerPath, deps = {}) {
  const owner = readJson(ownerPath, deps.fs || fs);
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
  return owner;
}

function sameOwnerCapability(left, right) {
  if (!left || !right) return false;
  if (left.version === OWNER_VERSION || right.version === OWNER_VERSION) {
    return left.version === OWNER_VERSION
      && right.version === OWNER_VERSION
      && left.instance === right.instance
      && path.resolve(left.stateDir || '.') === path.resolve(right.stateDir || '.')
      && left.ownerId === right.ownerId
      && left.pid === right.pid
      && left.generation === right.generation
      && left.capability === right.capability;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOwnerLineage(left, right) {
  return Boolean(
    left?.version === OWNER_VERSION
    && right?.version === OWNER_VERSION
    && left.instance === right.instance
    && path.resolve(left.stateDir || '.') === path.resolve(right.stateDir || '.')
    && left.ownerId === right.ownerId
    && left.pid === right.pid
    && left.threadId === right.threadId
    && typeof left.claimCapability === 'string'
    && left.claimCapability !== ''
    && left.claimCapability === right.claimCapability,
  );
}

function lockOwner(lockPath, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeLock(lockPath, fsImpl) {
  fsImpl.rmSync(lockPath, { recursive: true, force: true });
}

function reclaimStaleLock(lockPath, options, deps, fsImpl) {
  let ageMs;
  try {
    ageMs = currentTimeMs(deps) - fsImpl.statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  const staleMs = Number(options.lockStaleMs) || DEFAULT_LOCK_STALE_MS;
  if (ageMs < staleMs) return false;
  const owner = lockOwner(lockPath, fsImpl);
  if ((deps.isProcessAlive || isProcessAlive)(Number(owner?.pid) || 0)) return false;

  const stalePath = `${lockPath}.stale.${currentPid(deps)}.${currentTimeMs(deps)}`;
  try {
    fsImpl.renameSync(lockPath, stalePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  removeLock(stalePath, fsImpl);
  return true;
}

async function acquireOwnerLock(ownerPath, options = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const lockPath = `${ownerPath}.lock`;
  const timeoutMs = Number(options.lockTimeoutMs) || DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = Number(options.lockRetryMs) || DEFAULT_LOCK_RETRY_MS;
  const startedAt = currentTimeMs(deps);
  const token = `${currentPid(deps)}-${startedAt}-${Math.random().toString(16).slice(2)}`;
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      fsImpl.mkdirSync(lockPath, { mode: 0o700 });
      try {
        fsImpl.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
          pid: currentPid(deps),
          token,
          acquiredAt: new Date(currentTimeMs(deps)).toISOString(),
        })}\n`, { mode: 0o600 });
      } catch (error) {
        removeLock(lockPath, fsImpl);
        throw error;
      }
      return () => {
        try {
          if (lockOwner(lockPath, fsImpl)?.token === token) removeLock(lockPath, fsImpl);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (reclaimStaleLock(lockPath, options, deps, fsImpl)) continue;
      if (currentTimeMs(deps) - startedAt >= timeoutMs) {
        const timeout = new Error('Timed out waiting for Discord sender owner lock.');
        timeout.code = 'owner_lock_timeout';
        throw timeout;
      }
      await (deps.sleep || sleep)(retryMs);
    }
  }
}

async function withOwnerLock(ownerPath, options, deps, operation) {
  const release = await acquireOwnerLock(ownerPath, options, deps);
  try {
    return await operation();
  } finally {
    release();
  }
}

function fsyncDirectory(dir, fsImpl) {
  const fd = fsImpl.openSync(dir, 'r');
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function writeOwner(ownerPath, owner, deps = {}) {
  const fsImpl = deps.fs || fs;
  const dir = path.dirname(ownerPath);
  const tempPath = `${ownerPath}.${currentPid(deps)}.${currentTimeMs(deps)}.tmp`;
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fsImpl.writeFileSync(tempPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
    fd = fsImpl.openSync(tempPath, 'r');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(tempPath, ownerPath);
    fsyncDirectory(dir, fsImpl);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
    try {
      fsImpl.rmSync(tempPath, { force: true });
    } catch {}
  }
}

function expectedOwnerMatches(current, expected) {
  if (expected === null) return current === null;
  return sameOwnerCapability(current, expected);
}

async function claimOwner(ownerPath, owner, options = {}, deps = {}) {
  if (!Object.hasOwn(options, 'expected')) {
    const error = new Error('Discord sender owner claim requires explicit compare-and-swap authority.');
    error.code = 'owner_claim_authorization_required';
    throw error;
  }
  return withOwnerLock(ownerPath, options, deps, async () => {
    const current = readOwner(ownerPath, deps);
    const exact = expectedOwnerMatches(current, options.expected);
    const lineage = options.allowLineage === true
      && sameOwnerLineage(current, options.expected);
    if (!exact && !lineage) {
      const error = new Error('Stale sender owner claim cannot replace the current owner.');
      error.code = 'owner_claim_stale';
      throw error;
    }
    if (lineage) return current;
    const previousGeneration = Number.isSafeInteger(current?.generation)
      && current.generation >= 0 ? current.generation : 0;
    const capability = (deps.randomUUID || randomUUID)();
    const claimed = {
      version: OWNER_VERSION,
      instance: owner.instance,
      stateDir: path.resolve(owner.stateDir || path.dirname(ownerPath)),
      ownerId: owner.ownerId,
      pid: owner.pid,
      hostname: owner.hostname,
      cwd: owner.cwd,
      startedAt: owner.startedAt,
      threadId: owner.threadId || '',
      turnId: owner.turnId || '',
      generation: previousGeneration + 1,
      capability,
      claimCapability: capability,
      previousCapability: null,
      delivery: null,
    };
    writeOwner(ownerPath, claimed, deps);
    return claimed;
  });
}

async function bindOwnerDelivery(config, delivery, deps = {}) {
  const ownerPath = config.paths?.ownerPath || '';
  if (!ownerPath) return null;
  return withOwnerLock(ownerPath, config, deps, async () => {
    const current = readOwner(ownerPath, deps);
    const stateDir = path.resolve(config.paths?.stateDir || '.');
    const normalizedDelivery = {
      channelId: String(delivery.channelId || ''),
      sourceMessageId: String(delivery.sourceMessageId || ''),
      threadId: String(delivery.threadId || ''),
      turnId: String(delivery.turnId || ''),
    };
    if (
      current?.version !== OWNER_VERSION
      || current.instance !== config.paths?.instance
      || path.resolve(current.stateDir || '.') !== stateDir
      || !current.threadId
      || current.threadId !== delivery.threadId
    ) {
      return null;
    }
    if (
      current.delivery?.channelId === normalizedDelivery.channelId
      && current.delivery?.sourceMessageId === normalizedDelivery.sourceMessageId
      && current.delivery?.threadId === normalizedDelivery.threadId
      && current.delivery?.turnId === normalizedDelivery.turnId
    ) {
      return current;
    }
    const bound = {
      ...current,
      generation: current.generation + 1,
      capability: (deps.randomUUID || randomUUID)(),
      previousCapability: {
        generation: current.generation,
        capability: current.capability,
      },
      delivery: normalizedDelivery,
    };
    writeOwner(ownerPath, bound, deps);
    return bound;
  });
}

function isCurrentOwner(ownerPath, ownerId) {
  const owner = readOwner(ownerPath);
  return Boolean(owner && owner.ownerId === ownerId);
}

function publicOwner(owner) {
  if (!owner || typeof owner !== 'object') return owner;
  const {
    capability, claimCapability, previousCapability, ...safe
  } = owner;
  return safe;
}

module.exports = {
  OWNER_VERSION,
  acquireOwnerLock,
  bindOwnerDelivery,
  claimOwner,
  createOwner,
  isCurrentOwner,
  publicOwner,
  readOwner,
  sameOwnerCapability,
  sameOwnerLineage,
  withOwnerLock,
};
