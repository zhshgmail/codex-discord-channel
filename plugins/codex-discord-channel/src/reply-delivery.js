'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function nowIso(deps = {}) {
  const value = typeof deps.now === 'function' ? deps.now() : Date.now();
  return new Date(value).toISOString();
}

function contentDigest(content) {
  return createHash('sha256').update(String(content), 'utf8').digest('hex');
}

function receiptPath(config, channelId, sourceMessageId) {
  const dir = config.paths?.replyReceiptDir || path.join(config.paths?.stateDir || '', 'reply-receipts');
  if (!dir) throw new Error('Discord reply receipt directory is not configured.');
  const key = createHash('sha256')
    .update(`${channelId}\0${sourceMessageId}`, 'utf8')
    .digest('hex');
  return path.join(dir, `${key}.json`);
}

function readReceipt(file, fsImpl = fs) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== 1 || typeof parsed.status !== 'string') return null;
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
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
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

function claimReply(config, identity, content, deps = {}) {
  const fsImpl = deps.fs || fs;
  const file = receiptPath(config, identity.channelId, identity.sourceMessageId);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const receipt = {
    version: 1,
    status: 'claimed',
    channelId: identity.channelId,
    sourceMessageId: identity.sourceMessageId,
    contentSha256: contentDigest(content),
    claimedAt: nowIso(deps),
    pid: process.pid,
  };
  let fd;
  try {
    fd = fsImpl.openSync(file, 'wx', 0o600);
    fsImpl.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    fsyncDirectory(path.dirname(file), fsImpl);
    return { acquired: true, file, receipt };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return {
      acquired: false,
      file,
      receipt: readReceipt(file, fsImpl) || {
        version: 1,
        status: 'unreadable',
        channelId: identity.channelId,
        sourceMessageId: identity.sourceMessageId,
      },
    };
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
  }
}

function releaseReplyClaim(claim, deps = {}) {
  const fsImpl = deps.fs || fs;
  fsImpl.rmSync(claim.file, { force: true });
  fsyncDirectory(path.dirname(claim.file), fsImpl);
}

function completeReply(claim, sent, deps = {}) {
  const receipt = {
    ...claim.receipt,
    status: 'sent',
    outboundMessageId: sent.messageId,
    sentAt: nowIso(deps),
  };
  writeReceipt(claim.file, receipt, deps);
  return receipt;
}

function markReplyUncertain(claim, error, deps = {}) {
  const receipt = {
    ...claim.receipt,
    status: 'uncertain',
    uncertainAt: nowIso(deps),
    errorCode: typeof error?.code === 'string' ? error.code : null,
  };
  writeReceipt(claim.file, receipt, deps);
  return receipt;
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

async function sendDiscordReplyOnce({ args = {}, config, content, preflight, sender, deps = {} }) {
  const dispatch = replyDispatch(args, config);
  const prepared = typeof preflight === 'function'
    ? await preflight(dispatch.target)
    : undefined;
  if (!dispatch.guarded) {
    const sent = await sender(dispatch.target, prepared);
    return { ...sent, duplicateSuppressed: false, sourceMessageId: null };
  }

  const identity = {
    channelId: dispatch.target.channelId,
    sourceMessageId: dispatch.sourceMessageId,
  };
  const claim = claimReply(config, identity, content, deps);
  if (!claim.acquired) {
    return {
      channelId: identity.channelId,
      messageId: claim.receipt.outboundMessageId || null,
      sourceMessageId: identity.sourceMessageId,
      duplicateSuppressed: true,
      reason: claim.receipt.status === 'sent'
        ? 'source_message_already_replied'
        : 'source_message_reply_in_progress_or_uncertain',
      receiptStatus: claim.receipt.status,
    };
  }

  try {
    const sent = await sender(dispatch.target, prepared);
    completeReply(claim, sent, deps);
    return {
      ...sent,
      sourceMessageId: identity.sourceMessageId,
      duplicateSuppressed: false,
    };
  } catch (error) {
    if (error?.definitiveNoSend === true) {
      releaseReplyClaim(claim, deps);
    } else {
      markReplyUncertain(claim, error, deps);
    }
    throw error;
  }
}

module.exports = {
  claimReply,
  completeReply,
  contentDigest,
  markReplyUncertain,
  readReceipt,
  releaseReplyClaim,
  replyDispatch,
  sendDiscordReplyOnce,
};
