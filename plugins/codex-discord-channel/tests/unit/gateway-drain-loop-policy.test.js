'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDelivery } = require('../../src/delivery');

let startGatewayDrainLoop;
try {
  ({ startGatewayDrainLoop } = require('../../src/gateway-drain-loop'));
} catch {}

function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  const delays = [];

  return {
    delays,
    setTimeout(callback, delay) {
      const handle = { id: nextId, unref() {} };
      nextId += 1;
      pending.set(handle, callback);
      delays.push(delay);
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    async runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [handle, callback] = entry;
      pending.delete(handle);
      await callback();
      return true;
    },
  };
}

function normalizedMessage({ source, channelId, guildId, messageId, authorId, authorName }) {
  return {
    source,
    channelId,
    guildId,
    messageId,
    authorId,
    authorName,
    authorIsBot: false,
    content: messageId,
    attachments: [],
  };
}

function readQueue(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'pending-delivery.json'), 'utf8'));
}

function createFixture(options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-drain-policy-'));
  const receiverOwnership = {
    version: 2,
    pid: process.pid,
    generation: 'durable-gateway-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
    fallback: null,
  };
  const config = {
    ownerId: options.ownerId || 'session-before-compaction',
    deliveryMode: 'app-server',
    appServerRequestTimeoutMs: 100,
    deliveryDrainIntervalMs: 10,
    deliveryDrainMaxBackoffMs: 40,
    paths: {
      stateDir: dir,
      ownerPath: path.join(dir, 'owner.json'),
      gatewayPidPath: path.join(dir, 'session-gateway.pid'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
      lastInboundPath: path.join(dir, 'last-inbound.json'),
    },
  };
  fs.writeFileSync(config.paths.gatewayPidPath, `${JSON.stringify(receiverOwnership)}\n`);
  fs.writeFileSync(config.paths.ownerPath, `${JSON.stringify({ ownerId: config.ownerId })}\n`);

  const requests = [];
  let targetAttempts = 0;
  const host = {
    async resolveTarget() {
      targetAttempts += 1;
      if (!options.available) {
        return {
          available: false,
          status: 'unavailable',
          reason: 'shared_app_server_no_loaded_thread',
        };
      }
      return {
        available: true,
        threadId: options.threadId || 'thread-current',
        status: 'idle',
      };
    },
    async startTurn(params) {
      requests.push(params);
      return { turn: { id: `turn-${requests.length}` } };
    },
    async hasDelivered(_threadId, clientUserMessageId) {
      return requests.some((request) => request.clientUserMessageId === clientUserMessageId);
    },
    onThreadIdle() { return () => {}; },
    onReconnect() { return () => {}; },
    onThreadClosed() { return () => {}; },
    status() {
      return {
        configured: true,
        available: Boolean(options.available),
        reason: options.available ? null : 'shared_app_server_no_loaded_thread',
      };
    },
    destroy() {},
  };
  const delivery = createDelivery(config, () => {}, { structuredHost: host });

  return {
    config,
    delivery,
    dir,
    receiverOwnership,
    requests,
    targetAttempts: () => targetAttempts,
  };
}

function startLoop(fixture, timers) {
  assert.equal(
    typeof startGatewayDrainLoop,
    'function',
    'standalone gateway needs a durable periodic structured-drain loop',
  );
  return startGatewayDrainLoop({
    config: fixture.config,
    delivery: fixture.delivery,
    receiverOwnership: fixture.receiverOwnership,
    logger: () => {},
    deps: {
      clearTimeout: timers.clearTimeout,
      setTimeout: timers.setTimeout,
    },
  });
}

test('empty durable queue refreshes the recovery target without flushing', async () => {
  const fixture = createFixture({ available: true });
  const timers = createManualTimers();
  const originalFlush = fixture.delivery.flush.bind(fixture.delivery);
  let flushes = 0;
  fixture.delivery.flush = (...args) => {
    flushes += 1;
    return originalFlush(...args);
  };
  const loop = startLoop(fixture, timers);

  assert.deepEqual(timers.delays, [10]);
  assert.equal(await timers.runNext(), true);
  assert.equal(flushes, 0);
  assert.equal(fixture.targetAttempts(), 1);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(timers.delays, [10, 10]);

  await loop.stop();
  fixture.delivery.destroy();
});

test('restart drains owner DM and group FIFO after session and thread binding rotate', async () => {
  const first = createFixture({ available: false });
  const ownerDm = normalizedMessage({
    source: 'dm',
    channelId: 'owner-dm',
    guildId: null,
    messageId: 'owner-dm-message',
    authorId: 'configured-owner',
    authorName: 'Owner',
  });
  const group = normalizedMessage({
    source: 'guild',
    channelId: 'allowed-group',
    guildId: 'allowed-guild',
    messageId: 'group-message',
    authorId: 'allowed-peer',
    authorName: 'Peer',
  });
  await first.delivery.enqueue(ownerDm);
  await first.delivery.enqueue(group);
  const firstTimers = createManualTimers();
  const firstLoop = startLoop(first, firstTimers);

  await firstTimers.runNext();
  assert.deepEqual(
    readQueue(first.dir).items.map((item) => item.normalized.messageId),
    ['owner-dm-message', 'group-message'],
  );
  assert.deepEqual(firstTimers.delays, [10, 20]);
  await firstLoop.stop();
  first.delivery.destroy();

  fs.writeFileSync(
    first.config.paths.ownerPath,
    `${JSON.stringify({ ownerId: 'session-after-compaction' })}\n`,
  );
  const second = createFixture({
    available: true,
    dir: first.dir,
    ownerId: 'session-after-compaction',
    threadId: 'thread-after-compaction',
  });
  const secondTimers = createManualTimers();
  const secondLoop = startLoop(second, secondTimers);

  await secondTimers.runNext();
  await secondTimers.runNext();

  assert.deepEqual(
    second.requests.map((request) => request.clientUserMessageId),
    [
      'discord:owner-dm:owner-dm-message',
      'discord:allowed-group:group-message',
    ],
  );
  assert.deepEqual(
    second.requests.map((request) => request.threadId),
    ['thread-after-compaction', 'thread-after-compaction'],
  );
  assert.equal(second.requests[0].input[0].text.includes('guild_id='), false);
  assert.equal(
    second.requests[1].input[0].text.includes('guild_id="allowed-guild"'),
    true,
  );
  assert.deepEqual(readQueue(second.dir).items, []);
  assert.deepEqual(
    readQueue(second.dir).completed.map((item) => item.messageId),
    ['owner-dm-message', 'group-message'],
  );

  await secondLoop.stop();
  second.delivery.destroy();
});
