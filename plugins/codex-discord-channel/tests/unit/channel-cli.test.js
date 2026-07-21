'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { boundedGatewayProbe } = require('../../src/channel-cli');

test('gateway probe enforces one total timeout and destroys the pending host', async () => {
  let destroyed = false;
  const host = {
    destroy() {
      destroyed = true;
    },
    resolveTarget() {
      return new Promise(() => {});
    },
  };
  const startedAt = Date.now();
  await assert.rejects(
    () => boundedGatewayProbe(host, { exerciseTurn: false, timeoutMs: 20 }),
    /timed out after 20 ms/,
  );
  assert.equal(destroyed, true);
  assert.ok(Date.now() - startedAt < 500, 'probe must use one wall-clock deadline');
});
