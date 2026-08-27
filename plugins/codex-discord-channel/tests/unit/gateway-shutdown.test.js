'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { gatewayShutdownTimeouts, settleBounded } = require('../../src/gateway-shutdown');

test('gateway shutdown has a long total handoff grace and bounded component waits', () => {
  assert.deepEqual(gatewayShutdownTimeouts({}), {
    totalMs: 20000,
    drainMs: 5000,
    discordMs: 5000,
    releaseMs: 3000,
  });
});

test('a hung shutdown step times out without discarding later handoff work', async () => {
  const timers = [];
  const warnings = [];
  const pending = new Promise(() => {});
  const resultPromise = settleBounded('queue_drain', () => pending, 5000, (level, message, meta) => {
    warnings.push({ level, message, meta });
  }, {
    setTimeout(callback) { timers.push(callback); return 1; },
    clearTimeout() {},
  });
  timers[0]();
  const result = await resultPromise;
  assert.deepEqual(result, { completed: false, label: 'queue_drain' });
  assert.equal(warnings[0].meta.step, 'queue_drain');
});
