'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createAppServerHost } = require('./app-server-host');
const { isProcessAlive } = require('./receiver-state');

const DELIVERY_QUEUE_ERROR_MESSAGE = 'Unable to read persistent Discord delivery queue.';
const DELIVERY_IN_PROGRESS = 'structured_delivery_in_progress';
const DELIVERY_ACK_UNCERTAIN = 'structured_ack_uncertain';
const DELIVERY_LEASE_RETRY_AT = Symbol('deliveryLeaseRetryAt');
const MAX_TIMER_DELAY_MS = (2 ** 31) - 1;
const activeDeliveryAttempts = new Set();

function currentTimeMs(deps = {}) {
  const value = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function normalizeDiscordMessage(message, referencedMessage = null) {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : Array.from(message.attachments?.values?.() || []);
  const hasReference = Boolean(message.reference?.messageId);
  return {
    source: message.guildId ? 'guild' : 'dm',
    channelId: message.channelId,
    guildId: message.guildId || null,
    messageId: message.id,
    authorId: message.author?.id || message.authorId || '',
    authorName: message.author?.username || message.authorName || '',
    authorIsBot: Boolean(message.author?.bot || message.authorIsBot),
    repliedToAuthorId: hasReference ? String(referencedMessage?.author?.id || '') : '',
    repliedToContent: hasReference && typeof referencedMessage?.content === 'string'
      ? referencedMessage.content
      : '',
    content: message.content || '',
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType || null,
      size: attachment.size || null,
    })),
  };
}

function formatEnvelope(normalized) {
  const header = [
    '<channel source="discord"',
    ` channel_id="${escapeAttr(normalized.channelId)}"`,
    normalized.guildId ? ` guild_id="${escapeAttr(normalized.guildId)}"` : '',
    ` message_id="${escapeAttr(normalized.messageId)}"`,
    ` author_id="${escapeAttr(normalized.authorId)}"`,
    ` author_name="${escapeAttr(normalized.authorName)}"`,
    ' reply="required">',
  ].join('');
  const attachmentText = normalized.attachments.length > 0
    ? `\n\n[attachments]\n${normalized.attachments.map((item) => `- ${item.name || item.id}: ${item.url}`).join('\n')}`
    : '';
  return `${header}\n${normalized.content}${attachmentText}\n</channel>`;
}

function structuredSafeText(text) {
  let result = '';
  let afterEscape = false;
  for (const character of String(text)) {
    const codePoint = character.codePointAt(0);
    if (afterEscape && (character === '[' || character === ']')) {
      result += character === '[' ? '\\x5b' : '\\x5d';
      afterEscape = false;
      continue;
    }
    afterEscape = false;
    if (codePoint === 0x1b) {
      result += '\\x1b';
      afterEscape = true;
    } else if (codePoint === 0x00) {
      result += '\\0';
    } else if (codePoint === 0x08) {
      result += '\\b';
    } else if (codePoint === 0x09) {
      result += '\\t';
    } else if (codePoint === 0x0a) {
      result += '\\n';
    } else if (codePoint === 0x0d) {
      result += '\\r';
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      result += `\\x${codePoint.toString(16).padStart(2, '0')}`;
    } else {
      result += character;
    }
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildReplyCommand(normalized, config = {}) {
  const helper = config.replyHelper || path.join(__dirname, '..', 'bin', 'codex-discord-channel');
  const envPairs = [
    ['DISCORD_INSTANCE', config.paths?.instance],
    ['DISCORD_CONFIG_DIR', config.paths?.stateDir],
    ['DISCORD_ENV_FILE', config.paths?.envFile],
  ].filter(([, value]) => typeof value === 'string' && value !== '');
  const envPrefix = envPairs.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
  const command = `node ${shellQuote(helper)} send --channel ${shellQuote(normalized.channelId)} --reply-to ${shellQuote(normalized.messageId)}`;
  return `printf '%s' 'REPLY_TEXT_HERE' | ${envPrefix ? `${envPrefix} ` : ''}${command}`;
}

function getLastInboundPath(config = {}) {
  return config.paths?.lastInboundPath || (
    config.paths?.stateDir ? path.join(config.paths.stateDir, 'last-inbound.json') : ''
  );
}

function getDeliveryQueuePath(config = {}) {
  return config.paths?.deliveryQueuePath || (
    config.paths?.stateDir ? path.join(config.paths.stateDir, 'pending-delivery.json') : ''
  );
}

function getDeliveryQueueLockPath(config = {}) {
  const queuePath = getDeliveryQueuePath(config);
  return queuePath ? `${queuePath}.lock` : '';
}

function readLockOwner(lockPath, fsImpl) {
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function removeLockDirectory(lockPath, fsImpl) {
  fsImpl.rmSync(lockPath, { recursive: true, force: true });
}

function tryReclaimStaleQueueLock(lockPath, config, deps, fsImpl) {
  const staleMs = Number(config.deliveryQueueLockStaleMs) || 45000;
  let ageMs;
  try {
    ageMs = Date.now() - fsImpl.statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (ageMs < staleMs) return false;

  const owner = readLockOwner(lockPath, fsImpl);
  const ownerPid = Number(owner?.pid) || 0;
  const ownerAlive = ownerPid > 0 && (deps.isProcessAlive || isProcessAlive)(ownerPid);
  const liveLeaseMs = Number(config.deliveryQueueLockLiveLeaseMs) || 55000;
  if (ownerAlive && ageMs < liveLeaseMs) return false;

  const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
  try {
    fsImpl.renameSync(lockPath, stalePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
  removeLockDirectory(stalePath, fsImpl);
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function acquireDeliveryQueueLock(config = {}, deps = {}) {
  const lockPath = getDeliveryQueueLockPath(config);
  if (!lockPath) throw new Error('Discord delivery queue path is not configured.');
  const fsImpl = deps.fs || fs;
  const timeoutMs = Number(config.deliveryQueueLockTimeoutMs) || 60000;
  const retryMs = Number(config.deliveryQueueLockRetryMs) || 20;
  const startedAt = Date.now();
  const token = `${process.pid}-${startedAt}-${Math.random().toString(16).slice(2)}`;
  fsImpl.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      fsImpl.mkdirSync(lockPath, { mode: 0o700 });
      try {
        fsImpl.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
          pid: process.pid,
          token,
          acquiredAt: new Date().toISOString(),
        })}\n`, { mode: 0o600 });
      } catch (error) {
        removeLockDirectory(lockPath, fsImpl);
        throw error;
      }
      return () => {
        const owner = readLockOwner(lockPath, fsImpl);
        if (owner?.token === token) removeLockDirectory(lockPath, fsImpl);
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (tryReclaimStaleQueueLock(lockPath, config, deps, fsImpl)) continue;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Discord delivery queue lock: ${lockPath}`);
      }
      await sleep(retryMs);
    }
  }
}

async function withDeliveryQueueLock(config, deps, operation) {
  const release = await acquireDeliveryQueueLock(config, deps);
  try {
    return await operation();
  } finally {
    release();
  }
}

function emptyDeliveryQueue() {
  return { version: 1, items: [], completed: [], blocked: null };
}

function readDeliveryQueue(config = {}, deps = {}) {
  const file = getDeliveryQueuePath(config);
  if (!file) throw new Error('Discord delivery queue path is not configured.');
  const fsImpl = deps.fs || fs;
  if (!fsImpl.existsSync(file)) return emptyDeliveryQueue();
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(DELIVERY_QUEUE_ERROR_MESSAGE);
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid Discord delivery queue: ${file}`);
  }
  return {
    version: 1,
    items: parsed.items,
    completed: Array.isArray(parsed.completed) ? parsed.completed : [],
    blocked: parsed.blocked && typeof parsed.blocked === 'object' ? parsed.blocked : null,
  };
}

function readDeliveryQueueStatus(config = {}, deps = {}) {
  const queuePath = getDeliveryQueuePath(config);
  try {
    const queue = readDeliveryQueue(config, deps);
    return {
      deliveryQueuePath: queuePath,
      deliveryQueueDepth: queue.items.length,
      deliveryBlockedReason: queue.blocked?.reason || null,
      deliveryBlockedAt: queue.blocked?.at || null,
      deliveryQueueError: null,
    };
  } catch {
    return {
      deliveryQueuePath: queuePath,
      deliveryQueueDepth: null,
      deliveryBlockedReason: 'delivery_queue_unreadable',
      deliveryBlockedAt: null,
      deliveryQueueError: DELIVERY_QUEUE_ERROR_MESSAGE,
    };
  }
}

function writeDeliveryQueue(queue, config = {}, deps = {}) {
  const file = getDeliveryQueuePath(config);
  if (!file) throw new Error('Discord delivery queue path is not configured.');
  const fsImpl = deps.fs || fs;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(temp, `${JSON.stringify(queue, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(temp, file);
}

function sameDiscordIdentity(left, right) {
  return left?.channelId === right?.channelId && left?.messageId === right?.messageId;
}

function queueDelivery(normalized, config = {}, deps = {}) {
  const queue = readDeliveryQueue(config, deps);
  const identity = { channelId: normalized.channelId, messageId: normalized.messageId };
  const pendingDuplicate = queue.items.some((item) => sameDiscordIdentity(item.normalized, identity));
  const completedDuplicate = queue.completed.some((item) => sameDiscordIdentity(item, identity));
  if (!pendingDuplicate && !completedDuplicate) {
    queue.items.push({ version: 1, queuedAt: new Date().toISOString(), normalized });
    writeDeliveryQueue(queue, config, deps);
  }
  return {
    queue,
    enqueued: !pendingDuplicate && !completedDuplicate,
    duplicate: completedDuplicate ? 'completed' : (pendingDuplicate ? 'pending' : null),
  };
}

function queueHeadMatches(queue, expected) {
  return sameDiscordIdentity(queue.items[0]?.normalized, expected?.normalized);
}

function activeDeliveryAttempt(queue, deps = {}) {
  if (queue.blocked?.reason !== DELIVERY_IN_PROGRESS) return { active: false };
  const ownerPid = Number(queue.blocked.pid) || 0;
  const expiresAt = Date.parse(queue.blocked.expiresAt || '');
  if (ownerPid === process.pid) {
    return {
      active: activeDeliveryAttempts.has(queue.blocked.attemptId),
      foreign: false,
      expiresAt,
    };
  }
  const active = ownerPid > 0 && Number.isFinite(expiresAt) &&
    expiresAt > currentTimeMs(deps) && (deps.isProcessAlive || isProcessAlive)(ownerPid);
  return { active, foreign: active, expiresAt };
}

function blockedResult(queue, reason, status = 'queued') {
  return {
    status,
    reason,
    deliveredCount: 0,
    queueDepth: queue.items.length,
  };
}

function activeAttemptBlockedResult(queue, deps = {}) {
  const attempt = activeDeliveryAttempt(queue, deps);
  if (!attempt.active) return null;
  const result = blockedResult(queue, DELIVERY_IN_PROGRESS);
  if (attempt.foreign) {
    Object.defineProperty(result, DELIVERY_LEASE_RETRY_AT, { value: attempt.expiresAt });
  }
  return result;
}

function setQueueBlock(queue, reason, details, config, deps) {
  queue.blocked = {
    reason,
    at: new Date().toISOString(),
    ...(details || {}),
  };
  writeDeliveryQueue(queue, config, deps);
}

function completedQueue(queue, next) {
  return {
    version: 1,
    items: queue.items.slice(1),
    completed: [
      ...queue.completed,
      {
        channelId: next.normalized.channelId,
        messageId: next.normalized.messageId,
        completedAt: new Date().toISOString(),
      },
    ],
    blocked: null,
  };
}

function turnStartParams(next, threadId) {
  const normalized = next.normalized;
  return {
    threadId,
    clientUserMessageId: `discord:${structuredSafeText(normalized.channelId)}:${structuredSafeText(normalized.messageId)}`,
    input: [{ type: 'text', text: structuredSafeText(formatEnvelope(normalized)) }],
  };
}

function unavailableTarget(error) {
  return {
    available: false,
    status: 'unavailable',
    reason: error?.code || 'shared_app_server_unavailable',
    error: error instanceof Error ? error.message : String(error),
  };
}

async function blockCurrentHead(config, deps, expected, reason, details = {}) {
  return withDeliveryQueueLock(config, deps, () => {
    const queue = readDeliveryQueue(config, deps);
    if (!queueHeadMatches(queue, expected)) return { retry: true };
    setQueueBlock(queue, reason, details, config, deps);
    return { result: blockedResult(queue, reason, reason === DELIVERY_ACK_UNCERTAIN ? 'failed' : 'queued') };
  });
}

async function flushStructuredQueue(config, logger, deps, host) {
  let reconciledCount = 0;
  while (true) {
    const snapshot = await withDeliveryQueueLock(config, deps, () => readDeliveryQueue(config, deps));
    if (snapshot.items.length === 0) {
      if (reconciledCount > 0) {
        return {
          status: 'delivered',
          reason: 'turn_already_accepted',
          deliveredCount: reconciledCount,
          queueDepth: 0,
        };
      }
      return { status: 'idle', reason: 'queue_empty', deliveredCount: 0, queueDepth: 0 };
    }
    const next = snapshot.items[0];

    if (snapshot.blocked?.reason === DELIVERY_ACK_UNCERTAIN) {
      const threadId = snapshot.blocked.threadId || '';
      const clientUserMessageId = snapshot.blocked.clientUserMessageId || '';
      let alreadyAccepted = false;
      if (threadId && clientUserMessageId && typeof host.hasDelivered === 'function') {
        try {
          alreadyAccepted = await host.hasDelivered(threadId, clientUserMessageId);
        } catch {}
      }
      if (!alreadyAccepted) return blockedResult(snapshot, DELIVERY_ACK_UNCERTAIN, 'failed');
      const reconciled = await withDeliveryQueueLock(config, deps, () => {
        const queue = readDeliveryQueue(config, deps);
        if (!queueHeadMatches(queue, next) || queue.blocked?.reason !== DELIVERY_ACK_UNCERTAIN) {
          return { retry: true };
        }
        const updated = completedQueue(queue, next);
        writeDeliveryQueue(updated, config, deps);
        return { queueDepth: updated.items.length };
      });
      if (reconciled.retry) continue;
      reconciledCount += 1;
      continue;
    }
    if (snapshot.blocked?.reason === DELIVERY_IN_PROGRESS) {
      const activeResult = activeAttemptBlockedResult(snapshot, deps);
      if (activeResult) return activeResult;
      const stale = await blockCurrentHead(
        config,
        deps,
        next,
        DELIVERY_ACK_UNCERTAIN,
        {
          messageId: next.normalized.messageId,
          threadId: snapshot.blocked.threadId || '',
          clientUserMessageId: snapshot.blocked.clientUserMessageId || '',
          error: 'Previous structured delivery did not complete.',
        },
      );
      if (stale.retry) continue;
      continue;
    }

    let target;
    try {
      target = await host.resolveTarget();
    } catch (error) {
      target = unavailableTarget(error);
    }
    const targetReason = target?.available === false
      ? (target.reason || 'shared_app_server_unavailable')
      : (target?.status === 'idle' ? '' : 'thread_busy');
    if (targetReason) {
      const blocked = await blockCurrentHead(config, deps, next, targetReason, {
        ...(target.error ? { error: target.error } : {}),
      });
      if (blocked.retry) continue;
      logger('ERROR', 'Structured Discord delivery is unavailable', {
        reason: targetReason,
        channelId: next.normalized.channelId,
        messageId: next.normalized.messageId,
        queueDepth: snapshot.items.length,
      });
      return blocked.result;
    }

    const attemptId = `${process.pid}-${currentTimeMs(deps)}-${Math.random().toString(16).slice(2)}`;
    const params = turnStartParams(next, target.threadId);
    const claim = await withDeliveryQueueLock(config, deps, () => {
      const queue = readDeliveryQueue(config, deps);
      if (!queueHeadMatches(queue, next)) return { retry: true };
      if (queue.blocked?.reason === DELIVERY_ACK_UNCERTAIN) {
        return { result: blockedResult(queue, DELIVERY_ACK_UNCERTAIN, 'failed') };
      }
      if (queue.blocked?.reason === DELIVERY_IN_PROGRESS) {
        const activeResult = activeAttemptBlockedResult(queue, deps);
        if (activeResult) return { result: activeResult };
      }
      const leaseMs = Number(config.appServerRequestTimeoutMs) || 30000;
      activeDeliveryAttempts.add(attemptId);
      try {
        setQueueBlock(queue, DELIVERY_IN_PROGRESS, {
          expiresAt: new Date(currentTimeMs(deps) + leaseMs + 5000).toISOString(),
          messageId: next.normalized.messageId,
          threadId: target.threadId,
          clientUserMessageId: params.clientUserMessageId,
          pid: process.pid,
          attemptId,
        }, config, deps);
      } catch (error) {
        activeDeliveryAttempts.delete(attemptId);
        throw error;
      }
      return { next: queue.items[0], queueDepth: queue.items.length };
    });
    if (claim.retry) continue;
    if (claim.result) return claim.result;

    let response;
    try {
      response = await host.startTurn(params, target);
    } catch (error) {
      activeDeliveryAttempts.delete(attemptId);
      const uncertain = error?.deliveryOutcome === 'uncertain';
      const reason = uncertain
        ? DELIVERY_ACK_UNCERTAIN
        : (error?.code === 'thread_busy' ? 'thread_busy' : (error?.code || 'shared_app_server_unavailable'));
      const blocked = await withDeliveryQueueLock(config, deps, () => {
        const queue = readDeliveryQueue(config, deps);
        if (!queueHeadMatches(queue, next) || queue.blocked?.attemptId !== attemptId) {
          return blockedResult(queue, DELIVERY_ACK_UNCERTAIN, 'failed');
        }
        setQueueBlock(queue, reason, {
          messageId: next.normalized.messageId,
          threadId: target.threadId,
          clientUserMessageId: params.clientUserMessageId,
          error: error instanceof Error ? error.message : String(error),
        }, config, deps);
        return blockedResult(queue, reason, uncertain ? 'failed' : 'queued');
      });
      logger('ERROR', uncertain
        ? 'Structured Discord delivery acknowledgement is uncertain'
        : 'Structured Discord delivery was not accepted', {
        reason,
        channelId: next.normalized.channelId,
        messageId: next.normalized.messageId,
        queueDepth: claim.queueDepth,
      });
      return blocked;
    }

    try {
      const committed = await withDeliveryQueueLock(config, deps, () => {
        const queue = readDeliveryQueue(config, deps);
        if (!queueHeadMatches(queue, next) || queue.blocked?.attemptId !== attemptId) {
          if (queueHeadMatches(queue, next)) {
            setQueueBlock(queue, DELIVERY_ACK_UNCERTAIN, {
              messageId: next.normalized.messageId,
              threadId: target.threadId,
              clientUserMessageId: params.clientUserMessageId,
              error: 'Structured delivery checkpoint changed before commit.',
            }, config, deps);
          }
          return { uncertain: true, queueDepth: queue.items.length };
        }
        const updated = completedQueue(queue, next);
        writeDeliveryQueue(updated, config, deps);
        return { queueDepth: updated.items.length };
      });
      activeDeliveryAttempts.delete(attemptId);
      if (committed.uncertain) {
        return {
          status: 'failed',
          reason: DELIVERY_ACK_UNCERTAIN,
          deliveredCount: 0,
          queueDepth: committed.queueDepth,
        };
      }
      logger('INFO', 'Accepted queued Discord message through the shared app-server', {
        channelId: next.normalized.channelId,
        messageId: next.normalized.messageId,
        queueDepth: committed.queueDepth,
      });
      return {
        status: 'delivered',
        reason: 'turn_accepted',
        deliveredCount: reconciledCount + 1,
        queueDepth: committed.queueDepth,
        turnId: response?.turn?.id || null,
      };
    } catch (error) {
      activeDeliveryAttempts.delete(attemptId);
      try {
        await blockCurrentHead(config, deps, next, DELIVERY_ACK_UNCERTAIN, {
          messageId: next.normalized.messageId,
          threadId: target.threadId,
          clientUserMessageId: params.clientUserMessageId,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {}
      return {
        status: 'failed',
        reason: DELIVERY_ACK_UNCERTAIN,
        error: error instanceof Error ? error.message : String(error),
        deliveredCount: 0,
        queueDepth: claim.queueDepth,
      };
    }
  }
}

function inboundContext(normalized) {
  return {
    version: 1,
    source: normalized.source || (normalized.guildId ? 'guild' : 'dm'),
    channelId: normalized.channelId || '',
    guildId: normalized.guildId || null,
    messageId: normalized.messageId || '',
    authorId: normalized.authorId || '',
    authorName: normalized.authorName || '',
    authorIsBot: Boolean(normalized.authorIsBot),
    content: normalized.content || '',
    attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
    receivedAt: new Date().toISOString(),
  };
}

function writeLastInboundContext(normalized, config = {}, deps = {}) {
  const file = getLastInboundPath(config);
  if (!file) return null;
  const fsImpl = deps.fs || fs;
  const context = inboundContext(normalized);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(temp, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  fsImpl.renameSync(temp, file);
  return context;
}

function readLastInboundContext(config = {}, deps = {}) {
  const file = getLastInboundPath(config);
  if (!file) return null;
  const fsImpl = deps.fs || fs;
  if (!fsImpl.existsSync(file)) return null;
  const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function resolveReplyTarget(args = {}, config = {}, deps = {}) {
  const channelId = typeof args.channelId === 'string' ? args.channelId.trim() : '';
  const replyTo = typeof args.replyTo === 'string' ? args.replyTo.trim() : '';
  if (channelId) return { channelId, replyTo, usedLastInbound: false };
  const context = readLastInboundContext(config, deps);
  if (!context?.channelId) {
    throw new Error('channelId is required and no last inbound Discord context is available.');
  }
  return {
    channelId: context.channelId,
    replyTo: replyTo || context.messageId || '',
    usedLastInbound: true,
  };
}

function createDelivery(config, logger = () => {}, deps = {}) {
  const host = deps.structuredHost || createAppServerHost(config, logger, deps.appServer || {});
  let admissionOperations = Promise.resolve();
  let drainOperations = Promise.resolve();
  let destroyed = false;
  let unsubscribeIdle = null;
  let unsubscribeReconnect = null;
  let unsubscribeThreadClosed = null;
  let startupDrain = Promise.resolve();
  let leaseWakeTimer = null;
  let leaseWakeAt = 0;
  const serializeAdmission = (operation) => {
    const result = admissionOperations.then(operation, operation);
    admissionOperations = result.catch(() => {});
    return result;
  };
  const serializeDrain = (operation) => {
    const result = drainOperations.then(operation, operation);
    drainOperations = result.catch(() => {});
    return result;
  };
  const clearLeaseWake = () => {
    if (leaseWakeTimer == null) return;
    (deps.clearTimeout || clearTimeout)(leaseWakeTimer);
    leaseWakeTimer = null;
    leaseWakeAt = 0;
  };
  const updateLeaseWake = (retryAt) => {
    if (!Number.isFinite(retryAt)) {
      clearLeaseWake();
      return;
    }
    if (leaseWakeTimer != null && leaseWakeAt === retryAt) return;
    clearLeaseWake();
    const delay = Math.max(1, Math.min(retryAt - currentTimeMs(deps), MAX_TIMER_DELAY_MS));
    const schedule = deps.setTimeout || setTimeout;
    leaseWakeAt = retryAt;
    leaseWakeTimer = schedule(() => {
      leaseWakeTimer = null;
      leaseWakeAt = 0;
      return drainAutonomously('delivery_lease_expired');
    }, delay);
    if (typeof leaseWakeTimer?.unref === 'function') leaseWakeTimer.unref();
  };

  const delivery = {
    status() {
      return host.status();
    },
    async ensurePersistenceReady() {
      if (config.deliveryMode === 'off') {
        const error = new Error('Structured Discord delivery is disabled.');
        error.code = 'delivery_disabled';
        throw error;
      }
      return serializeAdmission(() => withDeliveryQueueLock(
        config,
        deps,
        () => readDeliveryQueue(config, deps),
      ));
    },
    async ensureReady() {
      if (config.deliveryMode === 'off') {
        const error = new Error('Structured Discord delivery is disabled.');
        error.code = 'delivery_disabled';
        throw error;
      }
      let target;
      try {
        target = await host.resolveTarget();
      } catch (error) {
        const unavailable = new Error(error instanceof Error ? error.message : String(error));
        unavailable.code = error?.code || 'shared_app_server_unavailable';
        throw unavailable;
      }
      if (target?.available !== true) {
        const error = new Error(target?.error || target?.reason || 'Shared app-server is unavailable.');
        error.code = target?.reason || 'shared_app_server_unavailable';
        throw error;
      }
      return target;
    },
    flush() {
      if (config.deliveryMode === 'off') {
        return Promise.resolve({ status: 'unsupported', reason: 'delivery_disabled' });
      }
      return serializeDrain(async () => {
        const result = await flushStructuredQueue(config, logger, deps, host);
        updateLeaseWake(result[DELIVERY_LEASE_RETRY_AT]);
        return result;
      });
    },
    coordinateReceiverOwnership(operation) {
      return serializeAdmission(() => withDeliveryQueueLock(config, deps, operation));
    },
    async enqueue(normalized, options = {}) {
      const envelope = formatEnvelope(normalized);
      if (config.deliveryMode === 'off') {
        return { status: 'unsupported', reason: 'delivery_disabled', envelope };
      }

      const admission = await serializeAdmission(async () => {
        let queueResult;
        try {
          queueResult = await withDeliveryQueueLock(
            config,
            deps,
            () => {
              if (typeof options.verifyReceiverOwnership === 'function') {
                const receiver = options.verifyReceiverOwnership();
                if (!receiver?.active) return { receiverRejected: receiver || {} };
              }
              return queueDelivery(normalized, config, deps);
            },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger('ERROR', 'Failed to persist Discord message in the delivery queue', {
            channelId: normalized.channelId,
            messageId: normalized.messageId,
            error: message,
          });
          return {
            result: {
              status: 'failed',
              reason: 'delivery_queue_persist_failed',
              error: message,
              envelope,
            },
          };
        }

        try {
          if (queueResult.receiverRejected) return { receiverRejected: queueResult.receiverRejected };
          writeLastInboundContext(normalized, config, deps);
        } catch (error) {
          logger('ERROR', 'Failed to update last inbound Discord context after queueing', {
            channelId: normalized.channelId,
            messageId: normalized.messageId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return { queueResult };
      });
      if (admission.result) return admission.result;
      if (admission.receiverRejected) {
        return {
          status: 'ignored',
          reason: admission.receiverRejected.reason || 'gateway_generation_changed',
          envelope,
        };
      }
      if (admission.queueResult.duplicate === 'completed') {
        return {
          status: 'duplicate',
          reason: 'discord_message_already_completed',
          queueDepth: admission.queueResult.queue.items.length,
          envelope,
        };
      }
      return {
        status: 'accepted',
        reason: admission.queueResult.enqueued
          ? 'discord_message_persisted'
          : 'discord_message_already_pending',
        queueDepth: admission.queueResult.queue.items.length,
        envelope,
      };
    },
    async deliver(normalized, options = {}) {
      const admission = await delivery.enqueue(normalized, options);
      if (admission.status !== 'accepted') return admission;
      await startupDrain;
      const result = await delivery.flush();
      return { ...result, envelope: admission.envelope };
    },
    destroy() {
      destroyed = true;
      if (typeof unsubscribeIdle === 'function') unsubscribeIdle();
      if (typeof unsubscribeReconnect === 'function') unsubscribeReconnect();
      if (typeof unsubscribeThreadClosed === 'function') unsubscribeThreadClosed();
      clearLeaseWake();
      if (typeof host.destroy === 'function') host.destroy();
    },
  };

  const drainAutonomously = (trigger) => {
    if (destroyed) return Promise.resolve({ status: 'idle', reason: 'delivery_destroyed' });
    return delivery.flush().catch((error) => {
      logger('ERROR', 'Failed to drain Discord delivery queue automatically', {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'failed',
        reason: 'shared_app_server_unavailable',
      };
    });
  };
  unsubscribeIdle = typeof host.onThreadIdle === 'function'
    ? host.onThreadIdle(() => drainAutonomously('thread_idle'))
    : null;
  unsubscribeReconnect = typeof host.onReconnect === 'function'
    ? host.onReconnect(() => drainAutonomously('reconnect'))
    : null;
  unsubscribeThreadClosed = typeof host.onThreadClosed === 'function'
    ? host.onThreadClosed(() => drainAutonomously('thread_closed'))
    : null;
  startupDrain = drainAutonomously('startup');
  return delivery;
}

module.exports = {
  buildReplyCommand,
  createDelivery,
  escapeAttr,
  formatEnvelope,
  normalizeDiscordMessage,
  readDeliveryQueueStatus,
  readLastInboundContext,
  resolveReplyTarget,
  structuredSafeText,
  writeLastInboundContext,
};
