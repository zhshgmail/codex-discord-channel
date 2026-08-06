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
  deps = {},
}) {
  if (typeof delivery?.flush !== 'function') {
    throw new Error('Discord gateway delivery does not provide structured queue draining.');
  }

  const baseDelayMs = positiveDelay(config?.deliveryDrainIntervalMs, DEFAULT_DRAIN_INTERVAL_MS);
  const maxBackoffMs = Math.max(
    baseDelayMs,
    positiveDelay(config?.deliveryDrainMaxBackoffMs, DEFAULT_DRAIN_MAX_BACKOFF_MS),
  );
  const scheduleTimeout = deps.setTimeout || setTimeout;
  const cancelTimeout = deps.clearTimeout || clearTimeout;
  const queueStatus = deps.readDeliveryQueueStatus || readDeliveryQueueStatus;
  const checkOwnership = deps.isCurrentReceiverOwnership || isCurrentReceiverOwnership;

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
    const status = queueStatus(config, deps);
    if (!Number.isInteger(status.deliveryQueueDepth) || status.deliveryQueueDepth < 0) {
      log(logger, 'ERROR', 'Cannot inspect durable Discord delivery queue', {
        reason: status.deliveryBlockedReason || 'delivery_queue_unreadable',
      });
      return increaseBackoff();
    }

    const receiver = checkOwnership(config, receiverOwnership, deps);
    if (!receiver?.active) {
      log(logger, 'INFO', 'Deferring Discord queue drain because receiver ownership changed', {
        reason: receiver?.reason || 'gateway_generation_changed',
        activePid: receiver?.pid,
        queueDepth: status.deliveryQueueDepth,
      });
      return increaseBackoff();
    }

    if (typeof delivery.flushReplies === 'function') {
      const replyResult = await delivery.flushReplies();
      if (replyResult?.status === 'failed') return increaseBackoff();
    }
    if (status.deliveryQueueDepth === 0) {
      retryDelayMs = baseDelayMs;
      return baseDelayMs;
    }

    const result = await delivery.flush({
      verifyReceiverOwnership: () => checkOwnership(config, receiverOwnership, deps),
    });
    if (result?.reason === 'structured_ack_uncertain') {
      retryDelayMs = baseDelayMs;
      return baseDelayMs;
    }
    if (result?.status === 'queued' || result?.status === 'failed') {
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
