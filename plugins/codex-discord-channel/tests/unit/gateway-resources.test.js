'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  discordClientResourceOptions,
  gatewayResourceSnapshot,
  resourceRestartLimitBytes,
  startGatewayResourceMonitor,
} = require('../../src/gateway-resources');

test('Discord client uses small transient caches because the state-dir FIFO is durable', () => {
  let limits;
  const options = discordClientResourceOptions({
    Options: {
      DefaultMakeCacheSettings: { MessageManager: 200 },
      DefaultSweeperSettings: { threads: { interval: 3600, lifetime: 14400 } },
      cacheWithLimits(value) { limits = value; return 'bounded-cache-factory'; },
    },
  });
  assert.equal(options.makeCache, 'bounded-cache-factory');
  assert.equal(limits.MessageManager, 5);
  assert.equal(limits.PresenceManager, 0);
  assert.equal(limits.VoiceStateManager, 0);
  assert.deepEqual(options.sweepers.messages, { interval: 60, lifetime: 120 });
});

test('resource snapshot and threshold are explicit and bounded by host memory', () => {
  const snapshot = gatewayResourceSnapshot({
    guilds: { cache: { size: 2 } },
    channels: { cache: { size: 3 } },
    users: { cache: { size: 4 } },
  }, {
    memoryUsage: () => ({ rss: 900, heapTotal: 800, heapUsed: 700, external: 6, arrayBuffers: 5 }),
    totalmem: () => 1024 * 1024 * 1024,
  });
  assert.equal(snapshot.rssBytes, 900);
  assert.deepEqual(snapshot.caches, { guilds: 2, channels: 3, users: 4 });
  assert.equal(resourceRestartLimitBytes({ gatewayMemoryRestartMb: 2048 }, snapshot), 256 * 1024 * 1024);
});

test('sustained pressure triggers one supervised restart but a recovered sample resets the count', () => {
  const callbacks = [];
  let rss = 300 * 1024 * 1024;
  let triggers = 0;
  const monitor = startGatewayResourceMonitor({
    config: {
      gatewayMemoryRestartMb: 256,
      gatewayMemorySampleIntervalMs: 1000,
      gatewayMemoryPressureSamples: 2,
    },
    client: {},
    onPressure() { triggers += 1; },
    deps: {
      memoryUsage: () => ({ rss }),
      totalmem: () => 8 * 1024 * 1024 * 1024,
      setInterval(callback) { callbacks.push(callback); return 7; },
      clearInterval() {},
      now: () => 1,
    },
  });
  monitor.sample();
  rss = 100 * 1024 * 1024;
  monitor.sample();
  rss = 300 * 1024 * 1024;
  monitor.sample();
  assert.equal(triggers, 0);
  monitor.sample();
  monitor.sample();
  assert.equal(triggers, 1);
  monitor.stop();
  assert.equal(callbacks.length, 1);
});
