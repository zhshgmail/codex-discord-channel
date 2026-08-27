'use strict';

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

async function settleBounded(label, operation, timeoutMs, logger = () => {}, deps = {}) {
  const scheduleTimeout = deps.setTimeout || setTimeout;
  const cancelTimeout = deps.clearTimeout || clearTimeout;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = scheduleTimeout(() => resolve({ completed: false, label }), timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation).then(
        (value) => ({ completed: true, label, value }),
        (error) => ({ completed: true, label, error }),
      ),
      timeout,
    ]);
    if (!result.completed) {
      logger('WARN', 'Discord gateway shutdown step exceeded its grace period', {
        step: label,
        timeoutMs,
      });
    } else if (result.error) {
      logger('WARN', 'Discord gateway shutdown step failed', {
        step: label,
        error: result.error instanceof Error ? result.error.message : String(result.error),
      });
    }
    return result;
  } finally {
    if (timer != null) cancelTimeout(timer);
  }
}

function gatewayShutdownTimeouts(config = {}) {
  const totalMs = positiveTimeout(config.gatewayShutdownGraceMs, 20000);
  return {
    totalMs,
    drainMs: Math.min(totalMs, positiveTimeout(config.gatewayDrainShutdownGraceMs, 5000)),
    discordMs: Math.min(totalMs, positiveTimeout(config.gatewayDiscordShutdownGraceMs, 5000)),
    releaseMs: Math.min(totalMs, positiveTimeout(config.gatewayReleaseShutdownGraceMs, 3000)),
  };
}

module.exports = {
  gatewayShutdownTimeouts,
  settleBounded,
};
