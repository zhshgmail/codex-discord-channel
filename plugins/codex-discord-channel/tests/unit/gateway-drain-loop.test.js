'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDelivery } = require('../../src/delivery');
const { isCurrentReceiverOwnership } = require('../../src/receiver-state');

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
      const handle = {
        id: nextId,
        unref() {},
      };
      nextId += 1;
      pending.set(handle, { callback, delay });
      delays.push(delay);
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    pendingCount() {
      return pending.size;
    },
    peekNext() {
      return pending.values().next().value?.callback || null;
    },
    takeNext() {
      const entry = pending.entries().next().value;
      if (!entry) return null;
      const [handle, timer] = entry;
      pending.delete(handle);
      return timer.callback;
    },
    async runNext() {
      const callback = this.takeNext();
      if (!callback) return false;
      await callback();
      return true;
    },
  };
}

function discordMessage(messageId, content = messageId) {
  return {
    source: 'dm',
    channelId: 'dm-1',
    guildId: null,
    messageId,
    authorId: 'user-1',
    authorName: 'Alice',
    authorIsBot: false,
    content,
    attachments: [],
  };
}

function queueAt(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'pending-delivery.json'), 'utf8'));
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function deliveryFixture(options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-gateway-drain-'));
  const receiverOwnership = {
    version: 2,
    pid: process.pid,
    generation: options.generation || 'gateway-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
    fallback: null,
  };
  const instanceIdentity = {
    version: 1,
    fingerprint: `sha256:${'b'.repeat(64)}`,
  };
  const config = {
    instanceIdentity,
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
  fs.writeFileSync(config.paths.ownerPath, `${JSON.stringify({ instanceIdentity, pid: 200 })}\n`);

  let available = Boolean(options.available);
  let releaseTurn = null;
  let markTurnStarted = null;
  const requests = [];
  const targetAttempts = [];
  const turnStarted = new Promise((resolve) => { markTurnStarted = resolve; });
  const host = {
    async resolveTarget() {
      targetAttempts.push(available);
      return available
        ? { available: true, threadId: 'thread-current', status: 'idle' }
        : {
            available: false,
            status: 'unavailable',
            reason: options.unavailableReason || 'shared_app_server_no_loaded_thread',
          };
    },
    async startTurn(params) {
      requests.push(params);
      markTurnStarted();
      if (options.holdTurn) {
        await new Promise((resolve) => { releaseTurn = resolve; });
      }
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
        available,
        reason: available ? null : 'shared_app_server_no_loaded_thread',
      };
    },
    destroy() {},
  };
  const delivery = createDelivery(config, () => {}, { structuredHost: host });
  await settle();

  return {
    config,
    delivery,
    dir,
    receiverOwnership,
    requests,
    targetAttempts,
    turnStarted,
    releaseTurn() { releaseTurn?.(); },
    setAvailable(value) { available = value; },
  };
}

function startLoop(fixture, timers) {
  assert.equal(typeof startGatewayDrainLoop, 'function');
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

test('pending queue without a target survives periodic retries with bounded backoff diagnostics', async () => {
  const fixture = await deliveryFixture();
  await fixture.delivery.enqueue(discordMessage('message-pending'));
  const timers = createManualTimers();
  const loop = startLoop(fixture, timers);

  assert.deepEqual(timers.delays, [10]);
  await timers.runNext();
  await timers.runNext();

  const queue = queueAt(fixture.dir);
  assert.deepEqual(queue.items.map((item) => item.normalized.messageId), ['message-pending']);
  assert.deepEqual(queue.completed, []);
  assert.equal(queue.blocked.reason, 'shared_app_server_no_loaded_thread');
  assert.deepEqual(Object.keys(queue.blocked).sort(), ['at', 'reason']);
  assert.deepEqual(timers.delays, [10, 20, 40]);
  assert.equal(fixture.requests.length, 0);

  await loop.stop();
  fixture.delivery.destroy();
});

test('each drain attempt reports a sanitized result for durable gateway health', async () => {
  const fixture = await deliveryFixture();
  await fixture.delivery.enqueue(discordMessage('message-health'));
  const timers = createManualTimers();
  const reports = [];
  const loop = startGatewayDrainLoop({
    config: fixture.config,
    delivery: fixture.delivery,
    receiverOwnership: fixture.receiverOwnership,
    logger: () => {},
    reportHealth(result) {
      reports.push(result);
    },
    deps: {
      clearTimeout: timers.clearTimeout,
      setTimeout: timers.setTimeout,
    },
  });

  await timers.runNext();

  assert.deepEqual(reports, [{
    status: 'queued',
    reason: 'shared_app_server_no_loaded_thread',
    deliveredCount: 0,
    queueDepth: 1,
  }]);
  await loop.stop();
  fixture.delivery.destroy();
});

test('empty queue resolves the live target before reporting idle', async () => {
  const fixture = await deliveryFixture({ available: true });
  const timers = createManualTimers();
  const reports = [];
  const loop = startGatewayDrainLoop({
    config: fixture.config,
    delivery: fixture.delivery,
    receiverOwnership: fixture.receiverOwnership,
    logger: () => {},
    reportHealth(result) {
      reports.push(result);
    },
    deps: {
      clearTimeout: timers.clearTimeout,
      setTimeout: timers.setTimeout,
    },
  });

  await timers.runNext();

  assert.deepEqual(fixture.targetAttempts, [true]);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(reports, [{
    status: 'idle',
    reason: 'queue_empty',
    deliveredCount: 0,
    queueDepth: 0,
  }]);
  await loop.stop();
  fixture.delivery.destroy();
});

test('a superseded receiver neither drains nor overwrites gateway health', async () => {
  const fixture = await deliveryFixture();
  const timers = createManualTimers();
  const reports = [];
  const loop = startGatewayDrainLoop({
    config: fixture.config,
    delivery: fixture.delivery,
    receiverOwnership: fixture.receiverOwnership,
    logger: () => {},
    reportHealth(result) {
      reports.push(result);
    },
    deps: {
      clearTimeout: timers.clearTimeout,
      setTimeout: timers.setTimeout,
      isCurrentReceiverOwnership() {
        return { active: false, reason: 'gateway_generation_changed' };
      },
    },
  });

  await timers.runNext();
  assert.deepEqual(reports, []);
  assert.equal(timers.pendingCount(), 0);
  await loop.stop();
  fixture.delivery.destroy();
});

test('periodic retry drains automatically when the structured target becomes available', async () => {
  const fixture = await deliveryFixture();
  await fixture.delivery.enqueue(discordMessage('message-recovers'));
  const timers = createManualTimers();
  const loop = startLoop(fixture, timers);

  await timers.runNext();
  fixture.setAvailable(true);
  await timers.runNext();

  assert.deepEqual(
    fixture.requests.map((request) => request.clientUserMessageId),
    ['discord:dm-1:message-recovers'],
  );
  assert.deepEqual(queueAt(fixture.dir).items, []);
  assert.deepEqual(queueAt(fixture.dir).completed.map((item) => item.messageId), ['message-recovers']);
  assert.deepEqual(timers.delays, [10, 20, 10]);

  await loop.stop();
  fixture.delivery.destroy();
});

test('duplicate timer callback invocation cannot duplicate an in-flight structured turn', async () => {
  const fixture = await deliveryFixture({ available: true, holdTurn: true });
  await fixture.delivery.enqueue(discordMessage('message-once'));
  const timers = createManualTimers();
  const loop = startLoop(fixture, timers);
  const tick = timers.takeNext();

  const firstTick = tick();
  const duplicateTick = tick();
  await fixture.turnStarted;
  assert.equal(fixture.requests.length, 1);
  fixture.releaseTurn();
  await Promise.all([firstTick, duplicateTick]);
  await tick();

  assert.deepEqual(
    fixture.requests.map((request) => request.clientUserMessageId),
    ['discord:dm-1:message-once'],
  );
  assert.deepEqual(queueAt(fixture.dir).completed.map((item) => item.messageId), ['message-once']);

  await loop.stop();
  fixture.delivery.destroy();
});

test('gateway loop restart resumes a persisted queue through the same durable state path', async () => {
  const first = await deliveryFixture();
  await first.delivery.enqueue(discordMessage('message-restart'));
  const firstTimers = createManualTimers();
  const firstLoop = startLoop(first, firstTimers);
  await firstTimers.runNext();
  await firstLoop.stop();
  first.delivery.destroy();

  const second = await deliveryFixture({ dir: first.dir, generation: 'gateway-generation' });
  const secondTimers = createManualTimers();
  const secondLoop = startLoop(second, secondTimers);
  second.setAvailable(true);
  await secondTimers.runNext();

  assert.deepEqual(
    second.requests.map((request) => request.clientUserMessageId),
    ['discord:dm-1:message-restart'],
  );
  assert.deepEqual(queueAt(second.dir).items, []);
  assert.deepEqual(queueAt(second.dir).completed.map((item) => item.messageId), ['message-restart']);

  await secondLoop.stop();
  second.delivery.destroy();
});

test('periodic drain stops permanently after durable receiver authority moves away', async () => {
  const fixture = await deliveryFixture({ available: true });
  await fixture.delivery.enqueue(discordMessage('message-authority'));
  fs.writeFileSync(fixture.config.paths.gatewayPidPath, `${JSON.stringify({
    ...fixture.receiverOwnership,
    generation: 'successor-generation',
  })}\n`);
  const timers = createManualTimers();
  const loop = startLoop(fixture, timers);

  await timers.runNext();
  assert.equal(fixture.targetAttempts.length, 0);
  assert.deepEqual(queueAt(fixture.dir).items.map((item) => item.normalized.messageId), [
    'message-authority',
  ]);

  fs.writeFileSync(
    fixture.config.paths.gatewayPidPath,
    `${JSON.stringify(fixture.receiverOwnership)}\n`,
  );
  await timers.runNext();

  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(queueAt(fixture.dir).items.map((item) => item.normalized.messageId), [
    'message-authority',
  ]);
  assert.equal(timers.pendingCount(), 0);

  await loop.stop();
  fixture.delivery.destroy();
});

test('authority transfer between the periodic check and delivery lease fences the stale drain', async () => {
  const fixture = await deliveryFixture({ available: true });
  await fixture.delivery.enqueue(discordMessage('message-raced-authority'));
  const successor = {
    ...fixture.receiverOwnership,
    generation: 'successor-generation',
  };
  const timers = createManualTimers();
  let ownershipChecks = 0;
  const loop = startGatewayDrainLoop({
    config: fixture.config,
    delivery: fixture.delivery,
    receiverOwnership: fixture.receiverOwnership,
    logger: () => {},
    deps: {
      clearTimeout: timers.clearTimeout,
      setTimeout: timers.setTimeout,
      isCurrentReceiverOwnership(config, expected, deps) {
        ownershipChecks += 1;
        if (ownershipChecks === 1) {
          fs.writeFileSync(config.paths.gatewayPidPath, `${JSON.stringify(successor)}\n`);
          return {
            active: true,
            reason: 'gateway_generation_match',
            pid: expected.pid,
            generation: expected.generation,
          };
        }
        return isCurrentReceiverOwnership(config, expected, deps);
      },
    },
  });

  await timers.runNext();

  assert.equal(ownershipChecks, 2);
  assert.equal(fixture.targetAttempts.length, 0);
  assert.equal(fixture.requests.length, 0);
  const queue = queueAt(fixture.dir);
  assert.deepEqual(queue.items.map((item) => item.normalized.messageId), [
    'message-raced-authority',
  ]);
  assert.deepEqual(queue.completed, []);

  await loop.stop();
  fixture.delivery.destroy();
});

test('gateway loop shutdown cancels its timer and fences a stale callback', async () => {
  const fixture = await deliveryFixture();
  await fixture.delivery.enqueue(discordMessage('message-after-stop'));
  const timers = createManualTimers();
  const loop = startLoop(fixture, timers);
  const staleTick = timers.peekNext();

  assert.equal(timers.pendingCount(), 1);
  await loop.stop();
  await loop.stop();
  assert.equal(timers.pendingCount(), 0);
  await staleTick();

  assert.equal(fixture.targetAttempts.length, 0);
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(queueAt(fixture.dir).items.map((item) => item.normalized.messageId), [
    'message-after-stop',
  ]);
  fixture.delivery.destroy();
});

test('gateway loop clamps configured delays to the Node timer maximum', async () => {
  const timers = createManualTimers();
  assert.equal(typeof startGatewayDrainLoop, 'function');
  const loop = startGatewayDrainLoop({
    config: {
      deliveryDrainIntervalMs: 3_000_000_000,
      deliveryDrainMaxBackoffMs: 4_000_000_000,
    },
    delivery: { async flush() {}, async refreshTargetCheckpoint() {} },
    receiverOwnership: {},
    deps: {
      clearTimeout: timers.clearTimeout,
      setTimeout: timers.setTimeout,
    },
  });

  assert.deepEqual(timers.delays, [(2 ** 31) - 1]);
  await loop.stop();
});
