'use strict';

const { readDeliveryQueueStatus } = require('./delivery');
const { isCurrentReceiverOwnership } = require('./receiver-state');

const DEFAULT_DRAIN_INTERVAL_MS = 1000;
const DEFAULT_DRAIN_MAX_BACKOFF_MS = 30000;
const MAX_TIMER_DELAY_MS = (2 ** 31) - 1;

function positiveDelay(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_TIMER_DELAY_MS) : fallback;
}

function log(logger, level, message, meta) {
  if (typeof logger !== 'function') return;
  try {
    logger(level, message, meta);
  } catch {}
}

function startGatewayDrainLoop({
  config,
  delivery,
  receiverOwnership,
  logger = () => {},
  reportHealth = () => {},
  deps = {},
}) {
  if (typeof delivery?.flush !== 'function') {
    throw new Error('Discord gateway delivery does not provide structured queue draining.');
  }
  if (typeof delivery?.refreshTargetCheckpoint !== 'function') {
    throw new Error('Discord gateway delivery cannot refresh the TUI recovery target.');
  }
  const flushOutbound = typeof delivery?.flushOutbound === 'function'
    ? (options) => delivery.flushOutbound(options)
    : async () => ({ status: 'idle', reason: 'outbound_empty', deliveredCount: 0 });

  const baseDelayMs = positiveDelay(config?.deliveryDrainIntervalMs, DEFAULT_DRAIN_INTERVAL_MS);
  const maxBackoffMs = Math.max(
    baseDelayMs,
    positiveDelay(config?.deliveryDrainMaxBackoffMs, DEFAULT_DRAIN_MAX_BACKOFF_MS),
  );
  const scheduleTimeout = deps.setTimeout || setTimeout;
  const cancelTimeout = deps.clearTimeout || clearTimeout;
  const queueStatus = deps.readDeliveryQueueStatus || readDeliveryQueueStatus;
  const checkOwnership = deps.isCurrentReceiverOwnership || isCurrentReceiverOwnership;

  const report = async (result) => {
    try {
      await reportHealth(result);
    } catch (error) {
      log(logger, 'ERROR', 'Failed to persist Discord gateway health', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  };

  let stopped = false;
  let timer = null;
  let generation = 0;
  let activeTick = null;
  let retryDelayMs = baseDelayMs;

  const increaseBackoff = () => {
    retryDelayMs = Math.min(maxBackoffMs, retryDelayMs * 2);
    return retryDelayMs;
  };

  const drainOnce = async () => {
    const receiver = checkOwnership(config, receiverOwnership, deps);
    if (!receiver?.active) {
      stopped = true;
      generation += 1;
      log(logger, 'INFO', 'Stopping Discord queue drain after receiver ownership changed', {
        reason: receiver?.reason || 'gateway_generation_changed',
        activePid: receiver?.pid,
      });
      return baseDelayMs;
    }
    const status = queueStatus(config, deps);
    if (status.deliveryQueueDepth === 0) {
      try {
        await delivery.refreshTargetCheckpoint();
      } catch (error) {
        const reason = error?.code || 'shared_app_server_unavailable';
        log(logger, 'ERROR', 'Cannot refresh the Discord TUI recovery target', {
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
        await report({
          status: 'failed',
          reason,
          deliveredCount: 0,
          queueDepth: 0,
        });
        return increaseBackoff();
      }
      if (!checkOwnership(config, receiverOwnership, deps)?.active) {
        stopped = true;
        generation += 1;
        return baseDelayMs;
      }
      const outbound = await flushOutbound({
        verifyReceiverOwnership: () => checkOwnership(config, receiverOwnership, deps),
      });
      if (!checkOwnership(config, receiverOwnership, deps)?.active) {
        stopped = true;
        generation += 1;
        return baseDelayMs;
      }
      retryDelayMs = baseDelayMs;
      const result = outbound?.reason === 'outbound_empty'
        ? { status: 'idle', reason: 'queue_empty', deliveredCount: 0, queueDepth: 0 }
        : { ...outbound, queueDepth: 0 };
      await report(result);
      if (result?.status === 'failed') {
        return increaseBackoff();
      }
      return baseDelayMs;
    }
    if (!Number.isInteger(status.deliveryQueueDepth) || status.deliveryQueueDepth < 0) {
      log(logger, 'ERROR', 'Cannot inspect durable Discord delivery queue', {
        reason: status.deliveryBlockedReason || 'delivery_queue_unreadable',
      });
      await report({
        status: 'failed',
        reason: status.deliveryBlockedReason || 'delivery_queue_unreadable',
        deliveredCount: 0,
        queueDepth: null,
      });
      return increaseBackoff();
    }

    const inbound = await delivery.flush({
      verifyReceiverOwnership: () => checkOwnership(config, receiverOwnership, deps),
    });
    if (
      inbound?.status === 'queued' &&
      ['gateway_generation_changed', 'gateway_receiver_missing'].includes(inbound?.reason)
    ) {
      stopped = true;
      generation += 1;
      return baseDelayMs;
    }
    if (!checkOwnership(config, receiverOwnership, deps)?.active) {
      stopped = true;
      generation += 1;
      return baseDelayMs;
    }
    const outbound = await flushOutbound({
      verifyReceiverOwnership: () => checkOwnership(config, receiverOwnership, deps),
    });
    const result = ['outbound_empty', 'assistant_final_waiting'].includes(outbound?.reason)
      ? inbound
      : outbound;
    if (
      result?.status === 'queued' &&
      ['gateway_generation_changed', 'gateway_receiver_missing'].includes(result?.reason)
    ) {
      stopped = true;
      generation += 1;
      return baseDelayMs;
    }
    if (!checkOwnership(config, receiverOwnership, deps)?.active) {
      stopped = true;
      generation += 1;
      return baseDelayMs;
    }
    await report(result);
    if (
      result?.status === 'failed' ||
      (result?.status === 'queued' && ![
        'assistant_final_waiting',
        'outbound_ready',
      ].includes(result?.reason))
    ) {
      return increaseBackoff();
    }
    retryDelayMs = baseDelayMs;
    return baseDelayMs;
  };

  let runTick;
  const schedule = (delayMs) => {
    if (stopped) return;
    const expectedGeneration = ++generation;
    timer = scheduleTimeout(() => runTick(expectedGeneration), delayMs);
    if (typeof timer?.unref === 'function') timer.unref();
  };

  runTick = async (expectedGeneration) => {
    if (stopped || expectedGeneration !== generation || activeTick) return;
    timer = null;
    const operation = drainOnce();
    activeTick = operation;
    let nextDelayMs = retryDelayMs;
    try {
      nextDelayMs = await operation;
    } catch (error) {
      nextDelayMs = increaseBackoff();
      log(logger, 'ERROR', 'Periodic Discord queue drain failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await report({
        status: 'failed',
        reason: 'gateway_drain_failed',
        deliveredCount: 0,
        queueDepth: null,
      });
    } finally {
      if (activeTick === operation) activeTick = null;
      schedule(nextDelayMs);
    }
  };

  schedule(baseDelayMs);

  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        generation += 1;
        if (timer != null) cancelTimeout(timer);
        timer = null;
      }
      if (activeTick) await activeTick.catch(() => {});
    },
  };
}

module.exports = {
  startGatewayDrainLoop,
};
