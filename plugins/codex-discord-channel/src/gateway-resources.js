'use strict';

const os = require('node:os');

const MIB = 1024 * 1024;
const DEFAULT_RESTART_MIB = 2048;
const DEFAULT_SAMPLE_INTERVAL_MS = 30000;
const DEFAULT_PRESSURE_SAMPLES = 3;

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function collectionSize(value) {
  return finiteNonNegative(value?.cache?.size) ?? 0;
}

function gatewayResourceSnapshot(client, deps = {}) {
  const memoryUsage = (deps.memoryUsage || process.memoryUsage)();
  const totalMemoryBytes = finiteNonNegative(
    typeof deps.totalmem === 'function' ? deps.totalmem() : os.totalmem(),
  );
  return {
    rssBytes: finiteNonNegative(memoryUsage?.rss),
    heapTotalBytes: finiteNonNegative(memoryUsage?.heapTotal),
    heapUsedBytes: finiteNonNegative(memoryUsage?.heapUsed),
    externalBytes: finiteNonNegative(memoryUsage?.external),
    arrayBuffersBytes: finiteNonNegative(memoryUsage?.arrayBuffers),
    totalMemoryBytes,
    caches: {
      guilds: collectionSize(client?.guilds),
      channels: collectionSize(client?.channels),
      users: collectionSize(client?.users),
    },
  };
}

function discordClientResourceOptions(discord = {}) {
  const Options = discord.Options;
  if (!Options || typeof Options.cacheWithLimits !== 'function') return {};
  return {
    // Inbound messages are persisted immediately in the state-dir FIFO.  The
    // gateway therefore needs only a tiny transient Discord cache; delivery,
    // replay and handoff never depend on this process-local cache.
    makeCache: Options.cacheWithLimits({
      ...(Options.DefaultMakeCacheSettings || {}),
      MessageManager: 5,
      ReactionManager: 0,
      ReactionUserManager: 0,
      GuildMemberManager: 8,
      PresenceManager: 0,
      VoiceStateManager: 0,
      ThreadMemberManager: 0,
      UserManager: 32,
    }),
    sweepers: {
      ...(Options.DefaultSweeperSettings || {}),
      messages: { interval: 60, lifetime: 120 },
      threads: { interval: 300, lifetime: 900 },
    },
  };
}

function resourceRestartLimitBytes(config = {}, snapshot = {}) {
  const configuredMiB = Math.max(
    256,
    finiteNonNegative(config.gatewayMemoryRestartMb) || DEFAULT_RESTART_MIB,
  );
  const configuredBytes = configuredMiB * MIB;
  const totalBytes = finiteNonNegative(snapshot.totalMemoryBytes);
  if (!totalBytes) return configuredBytes;
  return Math.min(configuredBytes, Math.max(256 * MIB, Math.floor(totalBytes * 0.25)));
}

function startGatewayResourceMonitor({
  config = {},
  client,
  logger = () => {},
  onPressure = () => {},
  deps = {},
}) {
  const intervalMs = Math.max(
    1000,
    finiteNonNegative(config.gatewayMemorySampleIntervalMs) || DEFAULT_SAMPLE_INTERVAL_MS,
  );
  const requiredSamples = Math.max(
    1,
    finiteNonNegative(config.gatewayMemoryPressureSamples) || DEFAULT_PRESSURE_SAMPLES,
  );
  const scheduleInterval = deps.setInterval || setInterval;
  const cancelInterval = deps.clearInterval || clearInterval;
  let pressureSamples = 0;
  let triggered = false;
  let lastWarningAt = 0;

  const sample = () => {
    const snapshot = gatewayResourceSnapshot(client, deps);
    const limitBytes = resourceRestartLimitBytes(config, snapshot);
    const rssBytes = snapshot.rssBytes || 0;
    if (rssBytes < limitBytes) {
      pressureSamples = 0;
      return { snapshot, limitBytes, pressureSamples, triggered };
    }
    pressureSamples += 1;
    const now = typeof deps.now === 'function' ? deps.now() : Date.now();
    if (now - lastWarningAt >= 300000 || lastWarningAt === 0) {
      lastWarningAt = now;
      logger('WARN', 'Discord gateway memory pressure detected', {
        rssBytes,
        limitBytes,
        pressureSamples,
        requiredSamples,
        caches: snapshot.caches,
      });
    }
    if (!triggered && pressureSamples >= requiredSamples) {
      triggered = true;
      onPressure({ snapshot, limitBytes, pressureSamples });
    }
    return { snapshot, limitBytes, pressureSamples, triggered };
  };

  const timer = scheduleInterval(sample, intervalMs);
  if (typeof timer?.unref === 'function') timer.unref();
  return {
    sample,
    stop() { cancelInterval(timer); },
  };
}

module.exports = {
  discordClientResourceOptions,
  gatewayResourceSnapshot,
  resourceRestartLimitBytes,
  startGatewayResourceMonitor,
};
