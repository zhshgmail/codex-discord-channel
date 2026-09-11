'use strict';

const path = require('node:path');
const { createDelivery } = require('../../src/delivery');

const stateDir = process.argv[2];
const delivery = createDelivery({
  deliveryQueueLockTimeoutMs: 1000,
  paths: {
    stateDir,
    deliveryQueuePath: path.join(stateDir, 'pending-delivery.json'),
  },
}, () => {}, {
  structuredHost: {
    status() { return { configured: true, available: true, reason: null }; },
    destroy() {},
  },
});

delivery.coordinateReceiverOwnership(async () => {
  process.stdout.write('LOCKED\n');
  await new Promise(() => {
    setInterval(() => {}, 1000);
  });
}).catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});
