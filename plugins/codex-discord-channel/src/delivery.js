'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createAppServerHost } = require('./app-server-host');
const { isProcessAlive } = require('./receiver-state');

const DELIVERY_QUEUE_ERROR_MESSAGE = 'Unable to read persistent Discord delivery queue.';
const DELIVERY_QUEUE_VERSION = 3;
const DELIVERY_IN_PROGRESS = 'structured_delivery_in_progress';
const DELIVERY_ACK_UNCERTAIN = 'structured_ack_uncertain';
const STALE_DELIVERY_ACTIVATION = 'stale_delivery_activation';
const DELIVERY_LEASE_RETRY_AT = Symbol('deliveryLeaseRetryAt');
const MAX_TIMER_DELAY_MS = (2 ** 31) - 1;
const DEFAULT_UNCERTAIN_RETRY_BASE_MS = 5000;
const DEFAULT_UNCERTAIN_RETRY_MAX_MS = 5 * 60 * 1000;
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
  const createdTimestamp = Number(message.createdTimestamp);
  const isThread = typeof message.channel?.isThread === 'function' && message.channel.isThread();
  const threadParentId = isThread && message.channel.parentId
    ? String(message.channel.parentId)
    : null;
  return {
    source: message.guildId ? 'guild' : 'dm',
    channelId: message.channelId,
    policyChannelId: threadParentId || message.channelId,
    threadParentId,
    guildId: message.guildId || null,
    messageId: message.id,
    authorId: message.author?.id || message.authorId || '',
    authorName: message.author?.username || message.authorName || '',
    authorIsBot: Boolean(message.author?.bot || message.authorIsBot),
    repliedToAuthorId: hasReference ? String(referencedMessage?.author?.id || '') : '',
    repliedToContent: hasReference && typeof referencedMessage?.content === 'string'
      ? referencedMessage.content
      : '',
    createdAt: Number.isFinite(createdTimestamp)
      ? new Date(createdTimestamp).toISOString()
      : null,
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
    normalized.createdAt ? ` created_at="${escapeAttr(normalized.createdAt)}"` : '',
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
        try {
          const owner = readLockOwner(lockPath, fsImpl);
          if (owner?.token === token) removeLockDirectory(lockPath, fsImpl);
        } catch {}
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
  return {
    version: DELIVERY_QUEUE_VERSION,
    activation: null,
    items: [],
    uncertain: [],
    completed: [],
    archived: [],
    blocked: null,
  };
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
  if (![1, 2, DELIVERY_QUEUE_VERSION].includes(parsed?.version) || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid Discord delivery queue: ${file}`);
  }
  return {
    version: parsed.version,
    activation: parsed.activation && typeof parsed.activation === 'object'
      ? parsed.activation
      : null,
    items: parsed.items,
    uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain : [],
    completed: Array.isArray(parsed.completed) ? parsed.completed : [],
    archived: Array.isArray(parsed.archived) ? parsed.archived : [],
    blocked: parsed.blocked && typeof parsed.blocked === 'object' ? parsed.blocked : null,
  };
}

function readDeliveryQueueStatus(config = {}, deps = {}) {
  const queuePath = getDeliveryQueuePath(config);
  try {
    const queue = readDeliveryQueue(config, deps);
    const oldestUncertain = queue.uncertain[0] || null;
    const degradedReason = queue.blocked?.reason || (
      oldestUncertain ? DELIVERY_ACK_UNCERTAIN : null
    );
    return {
      deliveryQueuePath: queuePath,
      deliveryQueueDepth: queue.items.length + queue.uncertain.length,
      deliveryReadyCount: queue.items.length,
      deliveryUncertainCount: queue.uncertain.length,
      deliveryState: queue.blocked
        ? 'blocked'
        : (oldestUncertain ? 'degraded' : (queue.items.length > 0 ? 'queued' : 'idle')),
      deliveryDegradedReason: degradedReason,
      deliveryOldestUncertainMessageId: oldestUncertain?.normalized?.messageId || null,
      deliveryOldestUncertainRetryAt: oldestUncertain?.delivery?.retryAt || null,
      deliveryOldestUncertainAttempts: oldestUncertain
        ? Math.max(0, Number(oldestUncertain.delivery?.attempts) || 0)
        : null,
      deliveryArchivedCount: queue.archived.length,
      deliveryActivatedAt: queue.activation?.activatedAt || null,
      deliveryBlockedReason: queue.blocked?.reason || null,
      deliveryBlockedAt: queue.blocked?.at || null,
      deliveryQueueError: null,
    };
  } catch {
    return {
      deliveryQueuePath: queuePath,
      deliveryQueueDepth: null,
      deliveryReadyCount: null,
      deliveryUncertainCount: null,
      deliveryState: 'unreadable',
      deliveryDegradedReason: 'delivery_queue_unreadable',
      deliveryOldestUncertainMessageId: null,
      deliveryOldestUncertainRetryAt: null,
      deliveryOldestUncertainAttempts: null,
      deliveryArchivedCount: null,
      deliveryActivatedAt: null,
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

function deliveryActivationId(config = {}, deps = {}) {
  const configured = String(
    deps.deliveryActivationId || config.deliveryActivationId || '',
  ).trim();
  return configured || fs.realpathSync(path.resolve(__dirname, '..'));
}

function timestampMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourcePredatesActivation(normalized, activatedAtMs) {
  if (normalized?.createdAt == null || normalized.createdAt === '') return false;
  const createdAtMs = timestampMs(normalized.createdAt);
  return createdAtMs == null || createdAtMs < activatedAtMs;
}

function itemMatchesActivation(item, activationId, activatedAtMs) {
  if (item?.activationId !== activationId) return false;
  const queuedAtMs = timestampMs(item.queuedAt);
  if (queuedAtMs == null || queuedAtMs < activatedAtMs) return false;
  return !sourcePredatesActivation(item.normalized, activatedAtMs);
}

function archiveIdentity(archived, completed, identity, queuedAt, archivedAt) {
  if (!identity?.channelId || !identity?.messageId) return false;
  if (archived.some((entry) => sameDiscordIdentity(entry, identity))) return false;
  if (completed.some((entry) => sameDiscordIdentity(entry, identity))) return false;
  archived.push({
    channelId: identity.channelId,
    messageId: identity.messageId,
    queuedAt: queuedAt || null,
    archivedAt,
    reason: STALE_DELIVERY_ACTIVATION,
  });
  return true;
}

function activateDeliveryQueue(queue, config = {}, deps = {}) {
  const activationId = deliveryActivationId(config, deps);
  const activatedAtMs = timestampMs(queue.activation?.activatedAt);
  const activationMatches = queue.activation?.id === activationId && activatedAtMs != null;
  const itemIsEligible = (item) => itemMatchesActivation(item, activationId, activatedAtMs) &&
    !queue.completed.some((entry) => sameDiscordIdentity(entry, item.normalized)) &&
    !queue.archived.some((entry) => sameDiscordIdentity(entry, item.normalized));
  const staleItems = activationMatches
    ? queue.items.filter((item) => !itemIsEligible(item))
    : queue.items;
  const staleIdentities = new Set(staleItems.map((item) => (
    `${item.normalized?.channelId || ''}\0${item.normalized?.messageId || ''}`
  )));
  const eligibleItems = activationMatches
    ? queue.items.filter((item) => itemIsEligible(item))
    : [];
  const staleUncertain = activationMatches
    ? queue.uncertain.filter((item) => !itemIsEligible(item))
    : queue.uncertain;
  const eligibleUncertain = activationMatches
    ? queue.uncertain.filter((item) => itemIsEligible(item))
    : [];
  const archived = [...queue.archived];
  const archivedAt = new Date(currentTimeMs(deps)).toISOString();
  for (const item of [...staleItems, ...staleUncertain]) {
    archiveIdentity(
      archived,
      queue.completed,
      item.normalized,
      item.queuedAt,
      archivedAt,
    );
  }
  const headIdentity = queue.items[0]?.normalized;
  const headWasArchived = headIdentity && staleIdentities.has(
    `${headIdentity.channelId || ''}\0${headIdentity.messageId || ''}`,
  );
  const changed = queue.version !== DELIVERY_QUEUE_VERSION || !activationMatches ||
    staleItems.length > 0 || staleUncertain.length > 0;
  if (!changed) return { queue, changed: false, archivedCount: 0 };
  return {
    queue: {
      version: DELIVERY_QUEUE_VERSION,
      activation: activationMatches
        ? queue.activation
        : { id: activationId, activatedAt: archivedAt },
      items: eligibleItems,
      uncertain: eligibleUncertain,
      completed: queue.completed,
      archived,
      blocked: !activationMatches || headWasArchived ? null : queue.blocked,
    },
    changed: true,
    archivedCount: staleItems.length + staleUncertain.length,
  };
}

function queueDelivery(normalized, config = {}, deps = {}) {
  const activated = activateDeliveryQueue(readDeliveryQueue(config, deps), config, deps);
  const queue = activated.queue;
  const activationId = queue.activation.id;
  const activatedAtMs = timestampMs(queue.activation.activatedAt);
  const identity = { channelId: normalized.channelId, messageId: normalized.messageId };
  if (sourcePredatesActivation(normalized, activatedAtMs)) {
    archiveIdentity(
      queue.archived,
      queue.completed,
      identity,
      null,
      new Date(currentTimeMs(deps)).toISOString(),
    );
    writeDeliveryQueue(queue, config, deps);
    return { queue, enqueued: false, duplicate: 'archived' };
  }
  const pendingDuplicate = queue.items.some((item) => sameDiscordIdentity(item.normalized, identity));
  const uncertainDuplicate = queue.uncertain.some((item) => sameDiscordIdentity(item.normalized, identity));
  const completedDuplicate = queue.completed.some((item) => sameDiscordIdentity(item, identity));
  const archivedDuplicate = queue.archived.some((item) => sameDiscordIdentity(item, identity));
  if (!pendingDuplicate && !uncertainDuplicate && !completedDuplicate && !archivedDuplicate) {
    queue.items.push({
      version: DELIVERY_QUEUE_VERSION,
      activationId,
      queuedAt: new Date(currentTimeMs(deps)).toISOString(),
      normalized,
    });
    writeDeliveryQueue(queue, config, deps);
  } else if (activated.changed) {
    writeDeliveryQueue(queue, config, deps);
  }
  return {
    queue,
    enqueued: !pendingDuplicate && !uncertainDuplicate && !completedDuplicate && !archivedDuplicate,
    duplicate: completedDuplicate
      ? 'completed'
      : (archivedDuplicate ? 'archived' : ((pendingDuplicate || uncertainDuplicate) ? 'pending' : null)),
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
    queueDepth: queue.items.length + queue.uncertain.length,
  };
}

function pendingQueueDepth(queue) {
  return queue.items.length + queue.uncertain.length;
}

function receiverRejectedResult(queue, receiver = {}) {
  return blockedResult(
    queue,
    receiver.reason || 'gateway_generation_changed',
  );
}

function rejectedReceiver(verifyReceiverOwnership) {
  if (typeof verifyReceiverOwnership !== 'function') return null;
  const receiver = verifyReceiverOwnership();
  return receiver?.active ? null : (receiver || {});
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
    version: DELIVERY_QUEUE_VERSION,
    activation: queue.activation,
    items: queue.items.slice(1),
    uncertain: queue.uncertain,
    completed: [
      ...queue.completed,
      {
        channelId: next.normalized.channelId,
        messageId: next.normalized.messageId,
        completedAt: new Date().toISOString(),
      },
    ],
    archived: queue.archived,
    blocked: null,
  };
}

function uncertainRetryDelayMs(config, attemptCount) {
  const base = Math.max(
    1,
    Number(config.deliveryUncertainRetryBaseMs) || DEFAULT_UNCERTAIN_RETRY_BASE_MS,
  );
  const maximum = Math.max(
    base,
    Number(config.deliveryUncertainRetryMaxMs) || DEFAULT_UNCERTAIN_RETRY_MAX_MS,
  );
  const exponent = Math.max(0, Math.min(16, Number(attemptCount) - 1));
  return Math.min(maximum, base * (2 ** exponent));
}

function moveQueueHeadToUncertain(queue, config, deps, details = {}) {
  const item = queue.items.shift();
  const attempts = Math.max(0, Number(item.delivery?.attempts) || 0) + 1;
  const deferredAtMs = currentTimeMs(deps);
  item.delivery = {
    state: DELIVERY_ACK_UNCERTAIN,
    attempts,
    firstDeferredAt: item.delivery?.firstDeferredAt || new Date(deferredAtMs).toISOString(),
    lastDeferredAt: new Date(deferredAtMs).toISOString(),
    retryAt: new Date(
      deferredAtMs + uncertainRetryDelayMs(config, attempts),
    ).toISOString(),
    messageId: item.normalized.messageId,
    threadId: details.threadId || item.delivery?.threadId || '',
    clientUserMessageId: details.clientUserMessageId ||
      item.delivery?.clientUserMessageId || '',
    error: details.error || item.delivery?.error || '',
  };
  queue.uncertain.push(item);
  queue.blocked = null;
  return item;
}

async function deferCurrentHead(
  config,
  deps,
  expected,
  details = {},
  verifyReceiverOwnership = null,
) {
  return withDeliveryQueueLock(config, deps, () => {
    const queue = readDeliveryQueue(config, deps);
    if (!queueHeadMatches(queue, expected)) return { retry: true };
    const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
    if (receiverRejected) return { receiverRejected, queue };
    moveQueueHeadToUncertain(queue, config, deps, details);
    writeDeliveryQueue(queue, config, deps);
    return {
      result: blockedResult(queue, DELIVERY_ACK_UNCERTAIN, 'failed'),
      queue,
    };
  });
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

async function flushStructuredQueue(config, logger, deps, host, options = {}) {
  const verifyReceiverOwnership = options.verifyReceiverOwnership;
  let reconciledCount = 0;
  while (true) {
    const inspection = await withDeliveryQueueLock(config, deps, () => {
      const persisted = readDeliveryQueue(config, deps);
      const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
      if (receiverRejected) return { queue: persisted, receiverRejected };
      const activated = activateDeliveryQueue(persisted, config, deps);
      const queue = activated.queue;
      if (activated.changed) writeDeliveryQueue(queue, config, deps);
      if (queue.items.length === 0) return { queue };
      return { queue };
    });
    const snapshot = inspection.queue;
    if (inspection.receiverRejected) {
      return receiverRejectedResult(snapshot, inspection.receiverRejected);
    }
    const uncertain = snapshot.uncertain[0];
    if (uncertain) {
      const threadId = uncertain.delivery?.threadId || '';
      const clientUserMessageId = uncertain.delivery?.clientUserMessageId || '';
      let alreadyAccepted = false;
      if (threadId && clientUserMessageId && typeof host.hasDelivered === 'function') {
        try {
          alreadyAccepted = await host.hasDelivered(threadId, clientUserMessageId);
        } catch {}
      }
      const reconciled = await withDeliveryQueueLock(config, deps, () => {
        const queue = readDeliveryQueue(config, deps);
        if (!sameDiscordIdentity(queue.uncertain[0]?.normalized, uncertain.normalized)) {
          return { retry: true };
        }
        const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
        if (receiverRejected) return { receiverRejected, queue };
        if (alreadyAccepted) {
          queue.uncertain.shift();
          queue.completed.push({
            channelId: uncertain.normalized.channelId,
            messageId: uncertain.normalized.messageId,
            completedAt: new Date(currentTimeMs(deps)).toISOString(),
          });
          writeDeliveryQueue(queue, config, deps);
          return { completed: true, queueDepth: queue.items.length + queue.uncertain.length };
        }
        const retryAt = timestampMs(uncertain.delivery?.retryAt);
        if (queue.uncertain.length > 1) {
          queue.uncertain.push(queue.uncertain.shift());
          writeDeliveryQueue(queue, config, deps);
        }
        return { waiting: true, retryAt, queue };
      });
      if (reconciled.retry) continue;
      if (reconciled.receiverRejected) {
        return receiverRejectedResult(reconciled.queue, reconciled.receiverRejected);
      }
      if (reconciled.completed) {
        reconciledCount += 1;
        continue;
      }
      if (snapshot.items.length === 0) {
        const result = blockedResult(snapshot, DELIVERY_ACK_UNCERTAIN);
        if (
          Number.isFinite(reconciled.retryAt) &&
          reconciled.retryAt > currentTimeMs(deps)
        ) {
          Object.defineProperty(result, DELIVERY_LEASE_RETRY_AT, { value: reconciled.retryAt });
        }
        return result;
      }
    }
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
      if (!alreadyAccepted) {
        const deferred = await deferCurrentHead(
          config,
          deps,
          next,
          snapshot.blocked,
          verifyReceiverOwnership,
        );
        if (deferred.retry) continue;
        if (deferred.receiverRejected) {
          return receiverRejectedResult(deferred.queue, deferred.receiverRejected);
        }
        return deferred.result;
      }
      const reconciled = await withDeliveryQueueLock(config, deps, () => {
        const queue = readDeliveryQueue(config, deps);
        if (!queueHeadMatches(queue, next) || queue.blocked?.reason !== DELIVERY_ACK_UNCERTAIN) {
          return { retry: true };
        }
        const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
        if (receiverRejected) return { receiverRejected, queue };
        const updated = completedQueue(queue, next);
        writeDeliveryQueue(updated, config, deps);
        return { queueDepth: pendingQueueDepth(updated) };
      });
      if (reconciled.retry) continue;
      if (reconciled.receiverRejected) {
        return receiverRejectedResult(reconciled.queue, reconciled.receiverRejected);
      }
      reconciledCount += 1;
      continue;
    }
    if (snapshot.blocked?.reason === DELIVERY_IN_PROGRESS) {
      const activeResult = activeAttemptBlockedResult(snapshot, deps);
      if (activeResult) return activeResult;
      if (
        snapshot.blocked.phase === 'resolving_target' &&
        !snapshot.blocked.threadId &&
        !snapshot.blocked.clientUserMessageId
      ) {
        const abandoned = await withDeliveryQueueLock(config, deps, () => {
          const queue = readDeliveryQueue(config, deps);
          if (
            !queueHeadMatches(queue, next) ||
            queue.blocked?.attemptId !== snapshot.blocked.attemptId ||
            queue.blocked?.phase !== 'resolving_target'
          ) {
            return { retry: true };
          }
          const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
          if (receiverRejected) return { receiverRejected, queue };
          queue.blocked = null;
          writeDeliveryQueue(queue, config, deps);
          return { released: true };
        });
        if (abandoned.retry) continue;
        if (abandoned.receiverRejected) {
          return receiverRejectedResult(abandoned.queue, abandoned.receiverRejected);
        }
        continue;
      }
      const stale = await deferCurrentHead(
        config,
        deps,
        next,
        {
          messageId: next.normalized.messageId,
          threadId: snapshot.blocked.threadId || '',
          clientUserMessageId: snapshot.blocked.clientUserMessageId || '',
          error: 'Previous structured delivery did not complete.',
        },
        verifyReceiverOwnership,
      );
      if (stale.retry) continue;
      if (stale.receiverRejected) {
        return receiverRejectedResult(stale.queue, stale.receiverRejected);
      }
      continue;
    }

    const attemptId = `${process.pid}-${currentTimeMs(deps)}-${Math.random().toString(16).slice(2)}`;
    const claim = await withDeliveryQueueLock(config, deps, () => {
      const queue = readDeliveryQueue(config, deps);
      if (!queueHeadMatches(queue, next)) return { retry: true };
      const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
      if (receiverRejected) return { receiverRejected, queue };
      if (queue.blocked?.reason === DELIVERY_ACK_UNCERTAIN) {
        return { result: blockedResult(queue, DELIVERY_ACK_UNCERTAIN, 'failed') };
      }
      if (queue.blocked?.reason === DELIVERY_IN_PROGRESS) {
        const activeResult = activeAttemptBlockedResult(queue, deps);
        if (activeResult) return { result: activeResult };
        return { retry: true };
      }
      const leaseMs = Number(config.appServerRequestTimeoutMs) || 30000;
      activeDeliveryAttempts.add(attemptId);
      try {
        setQueueBlock(queue, DELIVERY_IN_PROGRESS, {
          phase: 'resolving_target',
          expiresAt: new Date(currentTimeMs(deps) + leaseMs + 5000).toISOString(),
          messageId: next.normalized.messageId,
          threadId: '',
          clientUserMessageId: '',
          pid: process.pid,
          attemptId,
        }, config, deps);
      } catch (error) {
        activeDeliveryAttempts.delete(attemptId);
        throw error;
      }
      return {
        next: queue.items[0],
        queueDepth: queue.items.length + queue.uncertain.length,
      };
    });
    if (claim.retry) continue;
    if (claim.receiverRejected) {
      return receiverRejectedResult(claim.queue, claim.receiverRejected);
    }
    if (claim.result) return claim.result;

    let target;
    try {
      target = await host.resolveTarget();
    } catch (error) {
      target = unavailableTarget(error);
    }
    const targetAcceptsInput = ['idle', 'systemError'].includes(target?.status) || (
      target?.status === 'active' &&
      typeof target.activeTurnId === 'string' &&
      target.activeTurnId !== ''
    );
    const targetReason = target?.available === false
      ? (target.reason || 'shared_app_server_unavailable')
      : (targetAcceptsInput ? '' : 'thread_busy');
    if (targetReason) {
      const blocked = await withDeliveryQueueLock(config, deps, () => {
        const queue = readDeliveryQueue(config, deps);
        if (!queueHeadMatches(queue, next) || queue.blocked?.attemptId !== attemptId) {
          return { retry: true };
        }
        const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
        if (receiverRejected) return { receiverRejected, queue };
        setQueueBlock(queue, targetReason, {
          ...(target.error ? { error: target.error } : {}),
        }, config, deps);
        return { result: blockedResult(queue, targetReason) };
      });
      activeDeliveryAttempts.delete(attemptId);
      if (blocked.retry) continue;
      if (blocked.receiverRejected) {
        return receiverRejectedResult(blocked.queue, blocked.receiverRejected);
      }
      logger('ERROR', 'Structured Discord delivery is unavailable', {
        reason: targetReason,
        channelId: next.normalized.channelId,
        messageId: next.normalized.messageId,
        queueDepth: claim.queueDepth,
      });
      return blocked.result;
    }

    const params = turnStartParams(next, target.threadId);
    const prepared = await withDeliveryQueueLock(config, deps, () => {
      const queue = readDeliveryQueue(config, deps);
      if (!queueHeadMatches(queue, next) || queue.blocked?.attemptId !== attemptId) {
        return { retry: true };
      }
      const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
      if (receiverRejected) return { receiverRejected, queue };
      queue.blocked = {
        ...queue.blocked,
        phase: 'starting_turn',
        threadId: target.threadId,
        clientUserMessageId: params.clientUserMessageId,
      };
      writeDeliveryQueue(queue, config, deps);
      return { prepared: true };
    });
    if (!prepared.prepared) {
      activeDeliveryAttempts.delete(attemptId);
      if (prepared.receiverRejected) {
        return receiverRejectedResult(prepared.queue, prepared.receiverRejected);
      }
      if (prepared.retry) continue;
    }

    let response;
    try {
      response = await host.startTurn(params, target);
    } catch (error) {
      const uncertain = error?.deliveryOutcome === 'uncertain';
      const reason = uncertain
        ? DELIVERY_ACK_UNCERTAIN
        : (error?.code === 'thread_busy' ? 'thread_busy' : (error?.code || 'shared_app_server_unavailable'));
      const details = {
        messageId: next.normalized.messageId,
        threadId: target.threadId,
        clientUserMessageId: params.clientUserMessageId,
        error: error instanceof Error ? error.message : String(error),
      };
      let blocked;
      if (uncertain) {
        const deferred = await deferCurrentHead(
          config,
          deps,
          next,
          details,
          verifyReceiverOwnership,
        );
        if (deferred.retry) continue;
        if (deferred.receiverRejected) {
          return receiverRejectedResult(deferred.queue, deferred.receiverRejected);
        }
        blocked = deferred.result;
      } else {
        blocked = await withDeliveryQueueLock(config, deps, () => {
          const queue = readDeliveryQueue(config, deps);
          if (!queueHeadMatches(queue, next) || queue.blocked?.attemptId !== attemptId) {
            return blockedResult(queue, DELIVERY_ACK_UNCERTAIN, 'failed');
          }
          const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
          if (receiverRejected) return receiverRejectedResult(queue, receiverRejected);
          setQueueBlock(queue, reason, details, config, deps);
          return blockedResult(queue, reason);
        });
      }
      activeDeliveryAttempts.delete(attemptId);
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

    let persistedUserItem = false;
    try {
      if (typeof host.hasDelivered === 'function') {
        persistedUserItem = await host.hasDelivered(
          target.threadId,
          params.clientUserMessageId,
        );
      }
    } catch {}
    if (!persistedUserItem) {
      const unverified = await deferCurrentHead(
        config,
        deps,
        next,
        {
          messageId: next.normalized.messageId,
          threadId: target.threadId,
          clientUserMessageId: params.clientUserMessageId,
          error: 'Structured turn was acknowledged but its user item was not observed.',
        },
        verifyReceiverOwnership,
      );
      activeDeliveryAttempts.delete(attemptId);
      if (unverified.retry) continue;
      if (unverified.receiverRejected) {
        return receiverRejectedResult(unverified.queue, unverified.receiverRejected);
      }
      logger('ERROR', 'Structured Discord delivery acknowledgement was not persisted', {
        reason: DELIVERY_ACK_UNCERTAIN,
        channelId: next.normalized.channelId,
        messageId: next.normalized.messageId,
        queueDepth: claim.queueDepth,
      });
      return unverified.result;
    }

    try {
      const committed = await withDeliveryQueueLock(config, deps, () => {
        const queue = readDeliveryQueue(config, deps);
        if (!queueHeadMatches(queue, next) || queue.blocked?.attemptId !== attemptId) {
          if (queueHeadMatches(queue, next)) {
            moveQueueHeadToUncertain(queue, config, deps, {
              messageId: next.normalized.messageId,
              threadId: target.threadId,
              clientUserMessageId: params.clientUserMessageId,
              error: 'Structured delivery checkpoint changed before commit.',
            });
            writeDeliveryQueue(queue, config, deps);
          }
          return {
            uncertain: true,
            queueDepth: queue.items.length + queue.uncertain.length,
          };
        }
        const receiverRejected = rejectedReceiver(verifyReceiverOwnership);
        if (receiverRejected) return { receiverRejected, queue };
        const updated = completedQueue(queue, next);
        writeDeliveryQueue(updated, config, deps);
        return { queueDepth: updated.items.length + updated.uncertain.length };
      });
      activeDeliveryAttempts.delete(attemptId);
      if (committed.receiverRejected) {
        return receiverRejectedResult(committed.queue, committed.receiverRejected);
      }
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
        turnId: response?.turn?.id || response?.turnId || null,
      };
    } catch (error) {
      try {
        await deferCurrentHead(config, deps, next, {
          messageId: next.normalized.messageId,
          threadId: target.threadId,
          clientUserMessageId: params.clientUserMessageId,
          error: error instanceof Error ? error.message : String(error),
        }, verifyReceiverOwnership);
      } catch {}
      activeDeliveryAttempts.delete(attemptId);
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
  let unsubscribeActive = null;
  let unsubscribeReconnect = null;
  let unsubscribeThreadClosed = null;
  let startupDrain = Promise.resolve();
  let receiverVerification = null;
  let receiverActivated = false;
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
    refreshTargetCheckpoint() {
      if (config.deliveryMode === 'off') {
        return Promise.resolve({ status: 'unsupported', reason: 'delivery_disabled' });
      }
      return serializeDrain(() => delivery.ensureReady());
    },
    flush(options = {}) {
      if (config.deliveryMode === 'off') {
        return Promise.resolve({ status: 'unsupported', reason: 'delivery_disabled' });
      }
      return serializeDrain(async () => {
        const result = await flushStructuredQueue(config, logger, deps, host, options);
        updateLeaseWake(result[DELIVERY_LEASE_RETRY_AT]);
        return result;
      });
    },
    coordinateReceiverOwnership(operation) {
      const coordinate = async () => {
        const timeoutMs = Number(config.deliveryQueueLockTimeoutMs) || 60000;
        const retryMs = Number(config.deliveryQueueLockRetryMs) || 20;
        const startedAt = Date.now();
        while (true) {
          const outcome = await withDeliveryQueueLock(config, deps, async () => {
            const queue = readDeliveryQueue(config, deps);
            if (activeAttemptBlockedResult(queue, deps)) return { waitForLease: true };
            return { result: await operation() };
          });
          if (!outcome.waitForLease) return outcome.result;
          if (Date.now() - startedAt >= timeoutMs) {
            throw new Error('Timed out waiting for the active Discord delivery lease.');
          }
          await sleep(retryMs);
        }
      };
      return serializeDrain(() => serializeAdmission(coordinate));
    },
    activateReceiver(verifyReceiverOwnership) {
      if (typeof verifyReceiverOwnership !== 'function') {
        throw new Error('Discord receiver activation requires an authority verifier.');
      }
      receiverVerification = verifyReceiverOwnership;
      if (!receiverActivated) {
        receiverActivated = true;
        startupDrain = drainAutonomously('startup', { propagateErrors: true }).catch((error) => {
          receiverActivated = false;
          receiverVerification = null;
          throw error;
        });
      }
      return startupDrain;
    },
    deactivateReceiver() {
      receiverActivated = false;
      receiverVerification = null;
      clearLeaseWake();
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
          queueDepth: pendingQueueDepth(admission.queueResult.queue),
          envelope,
        };
      }
      if (admission.queueResult.duplicate === 'archived') {
        return {
          status: 'duplicate',
          reason: 'discord_message_archived_at_activation',
          queueDepth: pendingQueueDepth(admission.queueResult.queue),
          envelope,
        };
      }
      return {
        status: 'accepted',
        reason: admission.queueResult.enqueued
          ? 'discord_message_persisted'
          : 'discord_message_already_pending',
        queueDepth: pendingQueueDepth(admission.queueResult.queue),
        envelope,
      };
    },
    async deliver(normalized, options = {}) {
      const admission = await delivery.enqueue(normalized, options);
      if (admission.status !== 'accepted') return admission;
      await startupDrain;
      const result = await delivery.flush(receiverVerification
        ? { verifyReceiverOwnership: receiverVerification }
        : {});
      return { ...result, envelope: admission.envelope };
    },
    destroy() {
      destroyed = true;
      receiverActivated = false;
      receiverVerification = null;
      if (typeof unsubscribeIdle === 'function') unsubscribeIdle();
      if (typeof unsubscribeActive === 'function') unsubscribeActive();
      if (typeof unsubscribeReconnect === 'function') unsubscribeReconnect();
      if (typeof unsubscribeThreadClosed === 'function') unsubscribeThreadClosed();
      clearLeaseWake();
      if (typeof host.destroy === 'function') host.destroy();
    },
  };

  const drainAutonomously = (trigger, options = {}) => {
    if (destroyed) return Promise.resolve({ status: 'idle', reason: 'delivery_destroyed' });
    const verifyReceiverOwnership = receiverVerification;
    if (!receiverActivated || typeof verifyReceiverOwnership !== 'function') {
      return Promise.resolve({ status: 'idle', reason: 'receiver_inactive' });
    }
    const operation = delivery.flush({ verifyReceiverOwnership });
    if (options.propagateErrors) return operation;
    return operation.catch((error) => {
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
  unsubscribeActive = typeof host.onThreadActive === 'function'
    ? host.onThreadActive(() => drainAutonomously('thread_active'))
    : null;
  unsubscribeReconnect = typeof host.onReconnect === 'function'
    ? host.onReconnect(() => drainAutonomously('reconnect'))
    : null;
  unsubscribeThreadClosed = typeof host.onThreadClosed === 'function'
    ? host.onThreadClosed(() => drainAutonomously('thread_closed'))
    : null;
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
