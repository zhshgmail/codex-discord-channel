'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  effectiveReceiverOwnership,
  readReceiverAuthoritySnapshot,
  sameReceiverOwnership,
} = require('./receiver-state');

const GATEWAY_HEALTH_VERSION = 1;

function currentTimeMs(deps = {}) {
  const value = typeof deps.now === 'function' ? Number(deps.now()) : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function getGatewayHealthPath(config = {}) {
  return config.paths?.gatewayHealthPath || (
    config.paths?.stateDir ? path.join(config.paths.stateDir, 'gateway-health.json') : ''
  );
}

function normalizedReceiver(receiverOwnership) {
  const pid = Number(receiverOwnership?.pid);
  const generation = typeof receiverOwnership?.generation === 'string'
    ? receiverOwnership.generation.trim()
    : '';
  if (!Number.isSafeInteger(pid) || pid <= 0 || !generation) return null;
  return { pid, generation };
}

function normalizedStructured(value = {}) {
  return {
    configured: Boolean(value.configured),
    available: Boolean(value.available),
    reason: typeof value.reason === 'string' && value.reason ? value.reason : null,
  };
}

function normalizedQueue(value = {}) {
  const integerOrNull = (field) => Number.isInteger(value[field]) && value[field] >= 0
    ? value[field]
    : null;
  return {
    depth: integerOrNull('deliveryQueueDepth'),
    ready: integerOrNull('deliveryReadyCount'),
    uncertain: integerOrNull('deliveryUncertainCount'),
    blockedReason: typeof value.deliveryBlockedReason === 'string' && value.deliveryBlockedReason
      ? value.deliveryBlockedReason
      : null,
  };
}

function normalizedLastDrain(value = {}, deps = {}) {
  return {
    status: typeof value.status === 'string' && value.status ? value.status : 'unknown',
    reason: typeof value.reason === 'string' && value.reason ? value.reason : null,
    at: typeof value.at === 'string' && value.at
      ? value.at
      : new Date(currentTimeMs(deps)).toISOString(),
  };
}

function normalizedResources(value = {}) {
  const integerOrNull = (field) => Number.isInteger(value[field]) && value[field] >= 0
    ? value[field]
    : null;
  return {
    rssBytes: integerOrNull('rssBytes'),
    heapTotalBytes: integerOrNull('heapTotalBytes'),
    heapUsedBytes: integerOrNull('heapUsedBytes'),
    externalBytes: integerOrNull('externalBytes'),
    arrayBuffersBytes: integerOrNull('arrayBuffersBytes'),
    totalMemoryBytes: integerOrNull('totalMemoryBytes'),
    caches: {
      guilds: Number.isInteger(value.caches?.guilds) ? value.caches.guilds : null,
      channels: Number.isInteger(value.caches?.channels) ? value.caches.channels : null,
      users: Number.isInteger(value.caches?.users) ? value.caches.users : null,
    },
  };
}

function writeGatewayHealth(config = {}, state = {}, deps = {}) {
  const file = getGatewayHealthPath(config);
  if (!file) throw new Error('Discord gateway health path is not configured.');
  const receiver = normalizedReceiver(state.receiverOwnership);
  if (!receiver) throw new Error('Discord gateway health requires exact receiver ownership.');
  const fsImpl = deps.fs || fs;
  const record = {
    version: GATEWAY_HEALTH_VERSION,
    receiver,
    updatedAt: new Date(currentTimeMs(deps)).toISOString(),
    discord: {
      started: Boolean(state.discordStarted),
      reason: typeof state.discordReason === 'string' && state.discordReason
        ? state.discordReason
        : null,
    },
    structured: normalizedStructured(state.structured),
    queue: normalizedQueue(state.queue),
    resources: normalizedResources(state.resources),
    memoryLimitBytes: Number.isInteger(state.memoryLimitBytes) && state.memoryLimitBytes >= 0
      ? state.memoryLimitBytes
      : null,
    lastDrain: normalizedLastDrain(state.lastDrain, deps),
  };
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${currentTimeMs(deps)}.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fsImpl.renameSync(temp, file);
  } finally {
    try {
      fsImpl.rmSync(temp, { force: true });
    } catch {}
  }
  return record;
}

function emptyStatus(file, reason, valid = false, receiverPresent = false) {
  return {
    gatewayHealthPath: file,
    gatewayHealthValid: valid,
    gatewayReceiverPresent: receiverPresent,
    gatewayLive: false,
    gatewayHealthReason: reason,
    gatewayPid: null,
    gatewayGeneration: null,
    gatewayUpdatedAt: null,
    gatewayDiscordStarted: false,
    gatewayDiscordReason: reason,
    gatewayStructuredDeliveryState: 'unavailable',
    gatewaySharedAppServerConfigured: false,
    gatewaySharedAppServerAvailable: false,
    gatewaySharedAppServerReason: reason,
    gatewayLastDrainStatus: null,
    gatewayLastDrainReason: null,
    gatewayLastDrainAt: null,
    gatewayObservedQueueDepth: null,
    gatewayObservedReadyCount: null,
    gatewayObservedUncertainCount: null,
    gatewayObservedBlockedReason: null,
    gatewayRssBytes: null,
    gatewayHeapUsedBytes: null,
    gatewayMemoryLimitBytes: null,
    gatewayDiscordCacheCounts: null,
  };
}

function readGatewayHealthStatus(config = {}, deps = {}) {
  const file = getGatewayHealthPath(config);
  const authority = readReceiverAuthoritySnapshot(config, deps);
  const effective = authority.valid ? effectiveReceiverOwnership(authority, deps)?.record || null : null;
  const receiverPresent = Boolean(effective);
  const fsImpl = deps.fs || fs;
  let record;
  try {
    record = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (error) {
    return emptyStatus(
      file,
      error?.code === 'ENOENT' ? 'gateway_health_missing' : 'gateway_health_invalid',
      false,
      receiverPresent,
    );
  }
  const receiver = normalizedReceiver(record?.receiver);
  if (
    record?.version !== GATEWAY_HEALTH_VERSION ||
    !receiver ||
    typeof record.updatedAt !== 'string' ||
    !record.discord ||
    !record.structured ||
    !record.queue ||
    !record.resources ||
    !record.lastDrain
  ) {
    return emptyStatus(file, 'gateway_health_invalid', false, receiverPresent);
  }
  const updatedAtMs = Date.parse(record.updatedAt);
  const staleMs = Math.max(1000, Number(config.gatewayHealthStaleMs) || 180000);
  const expired = !Number.isFinite(updatedAtMs) || currentTimeMs(deps) - updatedAtMs > staleMs;
  const authorityMatches = Boolean(effective && sameReceiverOwnership(receiver, effective));
  const live = authorityMatches && !expired;
  const reason = live
    ? null
    : (authorityMatches && expired ? 'gateway_health_expired' : 'gateway_health_stale');
  const structured = normalizedStructured(record.structured);
  const resources = normalizedResources(record.resources);
  return {
    gatewayHealthPath: file,
    gatewayHealthValid: true,
    gatewayReceiverPresent: receiverPresent,
    gatewayLive: live,
    gatewayHealthReason: reason,
    gatewayPid: receiver.pid,
    gatewayGeneration: receiver.generation,
    gatewayUpdatedAt: record.updatedAt,
    gatewayDiscordStarted: live && Boolean(record.discord.started),
    gatewayDiscordReason: live ? (record.discord.reason || null) : reason,
    gatewayStructuredDeliveryState: live && record.discord.started && structured.available
      ? 'available'
      : 'unavailable',
    gatewaySharedAppServerConfigured: live && structured.configured,
    gatewaySharedAppServerAvailable: live && structured.available,
    gatewaySharedAppServerReason: live ? structured.reason : reason,
    gatewayLastDrainStatus: record.lastDrain.status || null,
    gatewayLastDrainReason: record.lastDrain.reason || null,
    gatewayLastDrainAt: record.lastDrain.at || null,
    gatewayObservedQueueDepth: Number.isInteger(record.queue.depth) ? record.queue.depth : null,
    gatewayObservedReadyCount: Number.isInteger(record.queue.ready) ? record.queue.ready : null,
    gatewayObservedUncertainCount: Number.isInteger(record.queue.uncertain)
      ? record.queue.uncertain
      : null,
    gatewayObservedBlockedReason: record.queue.blockedReason || null,
    gatewayRssBytes: resources.rssBytes,
    gatewayHeapUsedBytes: resources.heapUsedBytes,
    gatewayMemoryLimitBytes: Number.isInteger(record.memoryLimitBytes)
      ? record.memoryLimitBytes
      : null,
    gatewayDiscordCacheCounts: resources.caches,
  };
}

module.exports = {
  readGatewayHealthStatus,
  writeGatewayHealth,
};
