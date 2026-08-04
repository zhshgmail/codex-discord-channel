'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECEIPT_VERSION = 2;
const DEFAULT_LOCK_TIMEOUT_MS = 60000;
const DEFAULT_LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_STALE_MS = 45000;
const DEFAULT_LOCK_LIVE_LEASE_MS = 55000;
const DEFAULT_IN_FLIGHT_LEASE_MS = 60000;
const DEFAULT_NONCE_REPLAY_WINDOW_MS = 60000;

function nowMs(deps = {}) {
  return Number(typeof deps.now === 'function' ? deps.now() : Date.now());
}

function nowIso(deps = {}) {
  return new Date(nowMs(deps)).toISOString();
}

function currentPid(deps = {}) {
  return Number(deps.pid) || process.pid;
}

function contentDigest(content) {
  return createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function replyNonce(channelId, sourceMessageId) {
  const digest = createHash('sha256')
    .update(`discord-reply\0${channelId}\0${sourceMessageId}`, 'utf8')
    .digest('hex');
  return `cdr-${digest.slice(0, 21)}`;
}

function receiptPath(config, channelId, sourceMessageId) {
  const dir = config.paths?.replyReceiptDir || path.join(config.paths?.stateDir || '', 'reply-receipts');
  if (!dir) throw new Error('Discord reply receipt directory is not configured.');
  const key = createHash('sha256')
    .update(`${channelId}\0${sourceMessageId}`, 'utf8')
    .digest('hex');
  return path.join(dir, `${key}.json`);
}

function receiptIdentityMatches(config, file, receipt, identity, nonce) {
  if (receipt?.version !== RECEIPT_VERSION) return false;
  if (receipt.channelId !== identity.channelId) return false;
  if (receipt.sourceMessageId !== identity.sourceMessageId) return false;
  if (receipt.nonce !== nonce) return false;
  try {
    return path.resolve(receiptPath(config, receipt.channelId, receipt.sourceMessageId))
      === path.resolve(file);
  } catch {
    return false;
  }
}

function readReceipt(file, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    const validV1 = parsed?.version === 1 && typeof parsed.status === 'string';
    const validV2 = parsed?.version === RECEIPT_VERSION
      && ['in_flight', 'uncertain', 'confirmed'].includes(parsed.status);
    if (!validV1 && !validV2) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return null;
  }
}

function fsyncDirectory(dir, fsImpl = fs) {
  const fd = fsImpl.openSync(dir, 'r');
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function writeReceipt(file, receipt, deps = {}) {
  const fsImpl = deps.fs || fs;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${currentPid(deps)}.${Date.now()}.tmp`;
  let fd;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    fd = fsImpl.openSync(temp, 'r');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsImpl.renameSync(temp, file);
    fsyncDirectory(path.dirname(file), fsImpl);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
    try {
      fsImpl.rmSync(temp, { force: true });
    } catch {}
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function lockOwner(lockPath, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function removeLock(lockPath, fsImpl) {
  fsImpl.rmSync(lockPath, { recursive: true, force: true });
}

function reclaimStaleLock(lockPath, config, deps, fsImpl) {
  let ageMs;
  try {
    ageMs = nowMs(deps) - fsImpl.statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  const staleMs = Number(config.replyReceiptLockStaleMs) || DEFAULT_LOCK_STALE_MS;
  if (ageMs < staleMs) return false;
  const owner = lockOwner(lockPath, fsImpl);
  const ownerAlive = (deps.isProcessAlive || isProcessAlive)(Number(owner?.pid) || 0);
  const liveLeaseMs = Number(config.replyReceiptLockLiveLeaseMs) || DEFAULT_LOCK_LIVE_LEASE_MS;
  if (ownerAlive && ageMs < liveLeaseMs) return false;

  const stalePath = `${lockPath}.stale.${currentPid(deps)}.${Date.now()}`;
  try {
    fsImpl.renameSync(lockPath, stalePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  removeLock(stalePath, fsImpl);
  return true;
}

async function acquireReceiptLock(file, config, deps = {}) {
  const fsImpl = deps.fs || fs;
  const lockPath = `${file}.lock`;
  const timeoutMs = Number(config.replyReceiptLockTimeoutMs) || DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = Number(config.replyReceiptLockRetryMs) || DEFAULT_LOCK_RETRY_MS;
  const startedAt = nowMs(deps);
  const token = `${currentPid(deps)}-${startedAt}-${Math.random().toString(16).slice(2)}`;
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      fsImpl.mkdirSync(lockPath, { mode: 0o700 });
      try {
        fsImpl.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
          pid: currentPid(deps),
          token,
          acquiredAt: nowIso(deps),
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
      if (reclaimStaleLock(lockPath, config, deps, fsImpl)) continue;
      if (nowMs(deps) - startedAt >= timeoutMs) {
        throw new Error('Timed out waiting for Discord reply receipt lock.');
      }
      await (deps.sleep || sleep)(retryMs);
    }
  }
}

async function withReceiptLock(file, config, deps, operation) {
  const release = await acquireReceiptLock(file, config, deps);
  try {
    return await operation();
  } finally {
    release();
  }
}

function operationId(deps = {}) {
  return typeof deps.randomUUID === 'function' ? deps.randomUUID() : randomUUID();
}

function receiptStatusIsConfirmed(receipt) {
  return receipt?.status === 'confirmed' || (receipt?.version === 1 && receipt?.status === 'sent');
}

function receiptHasPermanentNonceMismatch(receipt) {
  return receipt?.status === 'uncertain'
    && receipt?.errorCode === 'reply_send_response_nonce_mismatch'
    && typeof receipt?.outboundMessageId === 'string'
    && receipt.outboundMessageId !== '';
}

function receiptLeaseIsLive(receipt, config, deps = {}) {
  const timestamp = Date.parse(receipt?.updatedAt || receipt?.claimedAt || '');
  const ageMs = Number.isFinite(timestamp) ? Math.max(0, nowMs(deps) - timestamp) : Infinity;
  const leaseMs = Number(config.replyReceiptInFlightLeaseMs) || DEFAULT_IN_FLIGHT_LEASE_MS;
  return ageMs < leaseMs
    && (deps.isProcessAlive || isProcessAlive)(Number(receipt?.pid) || 0);
}

function suppressResult(identity, receipt, reason) {
  return {
    mode: 'suppress',
    result: {
      channelId: identity.channelId,
      messageId: receipt?.outboundMessageId || null,
      sourceMessageId: identity.sourceMessageId,
      duplicateSuppressed: true,
      reason,
      receiptStatus: receipt?.status || 'unreadable',
    },
  };
}

async function beginReply(config, identity, content, deps = {}) {
  const file = receiptPath(config, identity.channelId, identity.sourceMessageId);
  const digest = contentDigest(content);
  const nonce = replyNonce(identity.channelId, identity.sourceMessageId);
  return withReceiptLock(file, config, deps, async () => {
    const fsImpl = deps.fs || fs;
    const existing = readReceipt(file, fsImpl);
    if (!existing && fsImpl.existsSync(file)) {
      return suppressResult(identity, null, 'source_message_reply_receipt_unreadable');
    }
    if (existing?.version === 1) {
      return suppressResult(identity, existing, 'source_message_reply_legacy_uncertain');
    }
    if (existing && !receiptIdentityMatches(config, file, existing, identity, nonce)) {
      return suppressResult(identity, existing, 'source_message_reply_receipt_identity_mismatch');
    }
    if (receiptStatusIsConfirmed(existing)) {
      return suppressResult(identity, existing, 'source_message_already_replied');
    }
    if (existing && existing.contentSha256 !== digest) {
      return suppressResult(identity, existing, 'source_message_reply_content_mismatch');
    }
    if (receiptHasPermanentNonceMismatch(existing)) {
      return suppressResult(identity, existing, 'source_message_reply_nonce_mismatch');
    }
    if (existing?.status === 'in_flight' && receiptLeaseIsLive(existing, config, deps)) {
      return suppressResult(identity, existing, 'source_message_reply_in_progress');
    }

    const id = operationId(deps);
    const timestamp = nowIso(deps);
    if (existing) {
      const receipt = {
        ...existing,
        version: RECEIPT_VERSION,
        status: 'in_flight',
        nonce: existing.nonce || nonce,
        operationId: id,
        pid: currentPid(deps),
        updatedAt: timestamp,
        reconciliationStartedAt: timestamp,
      };
      writeReceipt(file, receipt, deps);
      return { mode: 'reconcile', file, receipt };
    }

    const receipt = {
      version: RECEIPT_VERSION,
      status: 'in_flight',
      channelId: identity.channelId,
      sourceMessageId: identity.sourceMessageId,
      contentSha256: digest,
      nonce,
      operationId: id,
      claimedAt: timestamp,
      updatedAt: timestamp,
      pid: currentPid(deps),
    };
    writeReceipt(file, receipt, deps);
    return { mode: 'send', file, receipt };
  });
}

async function transitionReply(config, state, deps, update) {
  return withReceiptLock(state.file, config, deps, async () => {
    const current = readReceipt(state.file, deps.fs || fs);
    if (!current || current.operationId !== state.receipt.operationId) return current;
    if (
      current.channelId !== state.receipt.channelId
      || current.sourceMessageId !== state.receipt.sourceMessageId
      || current.nonce !== state.receipt.nonce
    ) return current;
    const next = update(current);
    if (next === null) {
      (deps.fs || fs).rmSync(state.file, { force: true });
      fsyncDirectory(path.dirname(state.file), deps.fs || fs);
      return null;
    }
    writeReceipt(state.file, next, deps);
    return next;
  });
}

async function releaseReplyClaim(config, state, deps = {}) {
  return transitionReply(config, state, deps, () => null);
}

async function completeReply(config, state, sent, deps = {}) {
  const channelId = String(sent?.channelId || '');
  const messageId = String(sent?.messageId || '');
  if (channelId !== state.receipt.channelId || !messageId) {
    const error = new Error('Discord reply confirmation did not match the claimed source identity.');
    error.code = 'reply_confirmation_mismatch';
    throw error;
  }
  const completed = await transitionReply(config, state, deps, (current) => ({
    ...current,
    status: 'confirmed',
    outboundMessageId: messageId,
    confirmedAt: nowIso(deps),
    updatedAt: nowIso(deps),
  }));
  if (
    completed?.status !== 'confirmed'
    || completed.channelId !== state.receipt.channelId
    || completed.sourceMessageId !== state.receipt.sourceMessageId
    || completed.nonce !== state.receipt.nonce
    || completed.outboundMessageId !== messageId
  ) {
    const error = new Error('Discord reply receipt changed before confirmation.');
    error.code = 'reply_receipt_changed';
    throw error;
  }
  return completed;
}

async function markReplyUncertain(config, state, error, deps = {}, sent = null) {
  return transitionReply(config, state, deps, (current) => ({
    ...current,
    status: 'uncertain',
    outboundMessageId: sent?.messageId || current.outboundMessageId,
    sentAt: sent?.messageId ? nowIso(deps) : current.sentAt,
    uncertainAt: nowIso(deps),
    updatedAt: nowIso(deps),
    errorCode: typeof error?.code === 'string' ? error.code : null,
  }));
}

function replyDispatch(args, config) {
  const channelId = typeof args.channelId === 'string' ? args.channelId.trim() : '';
  const replyTo = typeof args.replyTo === 'string' ? args.replyTo.trim() : '';
  if (args.followup === true) {
    if (!channelId) throw new Error('channelId is required for an explicit Discord followup.');
    return {
      target: { channelId, replyTo, usedLastInbound: false },
      sourceMessageId: '',
      guarded: false,
    };
  }
  if (!channelId || !replyTo) {
    throw new Error('channelId and replyTo are required for a guarded Discord reply.');
  }
  return {
    target: { channelId, replyTo, usedLastInbound: false },
    sourceMessageId: replyTo,
    guarded: true,
  };
}

function replayWindowOpen(receipt, config, deps = {}) {
  if (receipt?.outboundMessageId) return false;
  const claimedAt = Date.parse(receipt?.claimedAt || '');
  if (!Number.isFinite(claimedAt)) return false;
  const windowMs = Number(config.replyReceiptNonceReplayWindowMs)
    || DEFAULT_NONCE_REPLAY_WINDOW_MS;
  return nowMs(deps) - claimedAt <= windowMs;
}

async function sendAndConfirm({
  config,
  state,
  target,
  prepared,
  sender,
  confirmer,
  deps,
}) {
  try {
    const sent = await sender(target, prepared, {
      nonce: state.receipt.nonce,
      enforceNonce: true,
    });
    await markReplyUncertain(config, state, null, deps, sent);
    const confirmed = await confirmer(target, prepared, sent, state.receipt);
    await completeReply(config, state, confirmed, deps);
    return {
      ...confirmed,
      sourceMessageId: state.receipt.sourceMessageId,
      duplicateSuppressed: false,
    };
  } catch (error) {
    if (error?.definitiveNoSend === true) {
      await releaseReplyClaim(config, state, deps);
    } else {
      await markReplyUncertain(config, state, error, deps, error?.replySendIdentity);
    }
    throw error;
  }
}

async function sendDiscordReplyOnce({
  args = {},
  config,
  content,
  preflight,
  sender,
  confirmer,
  reconciler,
  deps = {},
}) {
  const dispatch = replyDispatch(args, config);
  if (!dispatch.guarded) {
    const prepared = typeof preflight === 'function' ? await preflight(dispatch.target, {}) : undefined;
    const sent = await sender(dispatch.target, prepared, {});
    return { ...sent, duplicateSuppressed: false, sourceMessageId: null };
  }

  const identity = {
    channelId: dispatch.target.channelId,
    sourceMessageId: dispatch.sourceMessageId,
  };
  const state = await beginReply(config, identity, content, deps);
  if (state.mode === 'suppress') return state.result;

  if (state.mode === 'send' && typeof confirmer !== 'function') {
    await releaseReplyClaim(config, state, deps);
    const error = new Error('Guarded Discord replies require exact readback confirmation.');
    error.code = 'reply_confirmation_required';
    throw error;
  }

  const sendIdentity = {
    nonce: state.receipt.nonce,
    enforceNonce: true,
  };
  let prepared;
  try {
    prepared = typeof preflight === 'function'
      ? await preflight(dispatch.target, sendIdentity)
      : undefined;
  } catch (error) {
    if (state.mode === 'send') {
      await releaseReplyClaim(config, state, deps);
    } else {
      await markReplyUncertain(config, state, error, deps);
    }
    throw error;
  }

  if (state.mode === 'reconcile') {
    if (typeof reconciler !== 'function') {
      const uncertain = await markReplyUncertain(config, state, null, deps);
      return suppressResult(identity, uncertain, 'source_message_reply_uncertain').result;
    }
    let reconciliation;
    try {
      reconciliation = await reconciler(dispatch.target, prepared, state.receipt);
    } catch (error) {
      await markReplyUncertain(config, state, error, deps);
      throw error;
    }
    if (reconciliation?.found === true && reconciliation.messageId) {
      await completeReply(config, state, reconciliation, deps);
      return {
        channelId: reconciliation.channelId || identity.channelId,
        messageId: reconciliation.messageId,
        sourceMessageId: identity.sourceMessageId,
        duplicateSuppressed: false,
        reconciled: true,
      };
    }
    if (!replayWindowOpen(state.receipt, config, deps)) {
      const uncertain = await markReplyUncertain(config, state, null, deps);
      return suppressResult(identity, uncertain, 'source_message_reply_uncertain').result;
    }
    if (typeof confirmer !== 'function') {
      const uncertain = await markReplyUncertain(config, state, null, deps);
      return suppressResult(identity, uncertain, 'source_message_reply_uncertain').result;
    }
  }

  return sendAndConfirm({
    config,
    state,
    target: dispatch.target,
    prepared,
    sender,
    confirmer,
    deps,
  });
}

module.exports = {
  acquireReceiptLock,
  beginReply,
  completeReply,
  contentDigest,
  markReplyUncertain,
  readReceipt,
  receiptPath,
  releaseReplyClaim,
  replyDispatch,
  replyNonce,
  sendDiscordReplyOnce,
};
