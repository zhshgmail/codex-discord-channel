'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createDelivery,
  escapeAttr,
  formatEnvelope,
  normalizeDiscordMessage,
  readDeliveryQueueStatus,
  resolveReplyTarget,
  structuredSafeText,
} = require('../../src/delivery');
const {
  commitReceiverOwnership,
  isCurrentReceiverOwnership,
  readReceiverAuthoritySnapshot,
} = require('../../src/receiver-state');

function discordMessage(messageId, content = 'hello') {
  return {
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId,
    authorId: 'u1',
    authorName: 'alice',
    authorIsBot: false,
    repliedToAuthorId: '',
    repliedToContent: '',
    content,
    attachments: [],
  };
}

function deliveryConfig(dir, overrides = {}) {
  return {
    deliveryMode: 'app-server',
    paths: {
      instance: 'codex01',
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
    ...overrides,
  };
}

function activeReceiver() {
  return {
    active: true,
    reason: 'gateway_generation_match',
    pid: process.pid,
    generation: 'receiver-generation',
  };
}

function structuredFixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-delivery-'));
  const requests = [];
  let target = { available: true, threadId: 'thread-current', status: 'idle' };
  let idleListener = null;
  let ttyCalls = 0;
  const host = {
    async resolveTarget() {
      if (typeof overrides.resolveTarget === 'function') {
        return overrides.resolveTarget({ ...target });
      }
      return { ...target };
    },
    async startTurn(params) {
      requests.push(params);
      if (typeof overrides.onStartTurn === 'function') {
        return overrides.onStartTurn(params, {
          getTarget: () => ({ ...target }),
          setTarget: (next) => { target = { ...next }; },
        });
      }
      return { turn: { id: `turn-${requests.length}` } };
    },
    async hasDelivered(threadId, clientUserMessageId) {
      if (typeof overrides.hasDelivered === 'function') {
        return overrides.hasDelivered(threadId, clientUserMessageId);
      }
      return false;
    },
    onThreadIdle(listener) {
      idleListener = listener;
      return () => {
        if (idleListener === listener) idleListener = null;
      };
    },
    status() {
      if (typeof overrides.status === 'function') return overrides.status();
      return {
        configured: true,
        available: target.available !== false,
        reason: target.available === false ? target.reason : null,
      };
    },
  };
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    structuredHost: host,
    runTtyInjector: async () => { ttyCalls += 1; },
    injectIntoTty: async () => { ttyCalls += 1; },
  });
  void delivery.activateReceiver(activeReceiver);
  return {
    delivery,
    dir,
    requests,
    get ttyCalls() { return ttyCalls; },
    setTarget(next) { target = { ...next }; },
    async emitIdle() {
      assert.equal(typeof idleListener, 'function');
      return idleListener();
    },
  };
}

function readQueue(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'pending-delivery.json'), 'utf8'));
}

function writePendingQueue(dir, messages, options = {}) {
  fs.writeFileSync(path.join(dir, 'pending-delivery.json'), `${JSON.stringify({
    version: 1,
    items: messages.map((normalized) => ({
      version: 1,
      queuedAt: '2026-07-20T00:00:00.000Z',
      normalized,
    })),
    completed: options.completed || [],
    blocked: options.blocked || null,
  }, null, 2)}\n`);
}

function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  const delays = [];
  return {
    clearTimeout(id) { pending.delete(id); },
    delays,
    pendingCount() { return pending.size; },
    async runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [id, callback] = entry;
      pending.delete(id);
      await callback();
      return true;
    },
    setTimeout(callback, delay) {
      const id = nextId++;
      delays.push(delay);
      pending.set(id, callback);
      return id;
    },
  };
}

test('queue lock cleanup failure cannot negate an already committed ownership operation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-lock-cleanup-'));
  const config = deliveryConfig(dir);
  let failCleanup = false;
  const fsProxy = {
    ...fs,
    rmSync(target, options) {
      if (failCleanup && target === `${config.paths.deliveryQueuePath}.lock`) {
        failCleanup = false;
        const error = new Error('injected lock cleanup failure');
        error.code = 'EACCES';
        throw error;
      }
      return fs.rmSync(target, options);
    },
  };
  const delivery = createDelivery(config, () => {}, {
    fs: fsProxy,
    structuredHost: {
      async resolveTarget() { return { available: true, threadId: 'thread-current', status: 'idle' }; },
      onThreadIdle() { return () => {}; },
      onReconnect() { return () => {}; },
      onThreadClosed() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });
  await delivery.flush();
  failCleanup = true;

  const result = await delivery.coordinateReceiverOwnership(() => 'authority-committed');

  assert.equal(result, 'authority-committed');
  assert.equal(fs.existsSync(`${config.paths.deliveryQueuePath}.lock`), true);
  delivery.destroy();
});

test('escapeAttr escapes unsafe attribute characters', () => {
  assert.equal(escapeAttr('"x<&'), '&quot;x&lt;&amp;');
});

test('formatEnvelope includes Discord metadata, content, and attachments', () => {
  const envelope = formatEnvelope({
    ...discordMessage('m1', '<@bot> hello'),
    guildId: 'g1',
    attachments: [{ id: 'a1', name: 'x.txt', url: 'https://example.test/x' }],
  });
  assert.match(envelope, /source="discord"/);
  assert.match(envelope, /channel_id="c1"/);
  assert.match(envelope, /guild_id="g1"/);
  assert.match(envelope, /message_id="m1"/);
  assert.match(envelope, /<@bot> hello/);
  assert.match(envelope, /x\.txt: https:\/\/example\.test\/x/);
});

test('normalizeDiscordMessage records resolved reply metadata only for an actual reference', () => {
  const normalized = normalizeDiscordMessage({
    channelId: 'c1',
    guildId: null,
    id: 'm1',
    author: { id: 'u1', username: 'alice', bot: false },
    reference: { messageId: 'm0' },
    content: 'reply',
    attachments: new Map(),
  }, {
    author: { id: 'u0' },
    content: 'parent',
  });
  assert.equal(normalized.repliedToAuthorId, 'u0');
  assert.equal(normalized.repliedToContent, 'parent');

  const withoutReference = normalizeDiscordMessage({
    channelId: 'c1',
    id: 'm2',
    author: { id: 'u1', username: 'alice' },
    content: 'plain',
    attachments: [],
  }, { author: { id: 'must-not-leak' }, content: 'must-not-leak' });
  assert.equal(withoutReference.repliedToAuthorId, '');
  assert.equal(withoutReference.repliedToContent, '');
});

test('structuredSafeText preserves Unicode while escaping every terminal control byte', () => {
  const input = 'CR\rLF\nTAB\tNUL\0ESC\x1b[200~CTRL\x03DEL\x7f汉字🙂';
  const output = structuredSafeText(input);
  const bytes = Buffer.from(output, 'utf8');
  assert.equal([...bytes].some((byte) => byte < 0x20 || byte === 0x7f), false);
  assert.match(output, /\\r/);
  assert.match(output, /\\n/);
  assert.match(output, /\\t/);
  assert.match(output, /\\0/);
  assert.match(output, /\\x1b\\x5b200~/);
  assert.match(output, /\\x03/);
  assert.match(output, /\\x7f/);
  assert.match(output, /汉字🙂/);
});

test('authorized Discord payload starts one structured turn without TTY or runtime overrides', async () => {
  const fixture = structuredFixture();
  const hostile = 'hello\x1b[200~\r\nnext\x03\x1b[201~';

  const first = await fixture.delivery.deliver(discordMessage('m-structured', hostile));
  const duplicate = await fixture.delivery.deliver(discordMessage('m-structured', hostile));

  assert.equal(first.status, 'delivered');
  assert.equal(first.reason, 'turn_accepted');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.ttyCalls, 0);
  const request = fixture.requests[0];
  assert.equal(request.threadId, 'thread-current');
  assert.equal(request.clientUserMessageId, 'discord:c1:m-structured');
  assert.deepEqual(Object.keys(request).sort(), [
    'clientUserMessageId',
    'input',
    'threadId',
  ]);
  for (const forbidden of ['model', 'effort', 'reasoningEffort', 'serviceTier', 'summary']) {
    assert.equal(Object.hasOwn(request, forbidden), false);
  }
  assert.equal(request.input.length, 1);
  assert.equal(request.input[0].type, 'text');
  const bytes = Buffer.from(request.input[0].text, 'utf8');
  assert.equal([...bytes].some((byte) => byte < 0x20 || byte === 0x7f), false);
  assert.match(request.input[0].text, /\\x1b\\x5b200~/);
  assert.match(request.input[0].text, /\\r\\n/);
  assert.match(request.input[0].text, /\\x03/);
});

test('busy target drains one FIFO item per idle transition and dynamically follows rotation', async () => {
  const fixture = structuredFixture({
    onStartTurn(_params, controls) {
      const current = controls.getTarget();
      controls.setTarget({ ...current, status: 'active' });
      return { turn: { id: 'accepted' } };
    },
  });
  fixture.setTarget({ available: true, threadId: 'thread-before-compaction', status: 'active' });

  const first = await fixture.delivery.deliver(discordMessage('m1', 'first'));
  const second = await fixture.delivery.deliver(discordMessage('m2', 'second'));
  assert.equal(first.status, 'queued');
  assert.equal(first.reason, 'thread_busy');
  assert.equal(second.status, 'queued');
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(readQueue(fixture.dir).items.map((item) => item.normalized.messageId), ['m1', 'm2']);

  fixture.setTarget({ available: true, threadId: 'thread-after-compaction', status: 'idle' });
  const firstDrain = await fixture.emitIdle();
  assert.equal(firstDrain.status, 'delivered');
  assert.deepEqual(fixture.requests.map((request) => request.clientUserMessageId), ['discord:c1:m1']);
  assert.equal(fixture.requests[0].threadId, 'thread-after-compaction');
  assert.deepEqual(readQueue(fixture.dir).items.map((item) => item.normalized.messageId), ['m2']);

  fixture.setTarget({ available: true, threadId: 'thread-after-compaction', status: 'idle' });
  const secondDrain = await fixture.emitIdle();
  assert.equal(secondDrain.status, 'delivered');
  assert.deepEqual(
    fixture.requests.map((request) => request.clientUserMessageId),
    ['discord:c1:m1', 'discord:c1:m2'],
  );
  const drained = readQueue(fixture.dir);
  assert.deepEqual(drained.items, []);
  assert.deepEqual(drained.completed.map((item) => item.messageId), ['m1', 'm2']);
});

test('missing shared app-server fails closed, persists FIFO, and never calls a TTY seam', async () => {
  const fixture = structuredFixture({
    resolveTarget: async () => ({
      available: false,
      reason: 'shared_app_server_socket_missing',
      status: 'unavailable',
    }),
    status: () => ({
      configured: true,
      available: false,
      reason: 'shared_app_server_socket_missing',
    }),
  });

  const result = await fixture.delivery.deliver(discordMessage('m-unavailable', 'retain me'));

  assert.equal(result.status, 'queued');
  assert.equal(result.reason, 'shared_app_server_socket_missing');
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.ttyCalls, 0);
  const queue = readQueue(fixture.dir);
  assert.deepEqual(queue.items.map((item) => item.normalized.messageId), ['m-unavailable']);
  assert.equal(queue.blocked.reason, 'shared_app_server_socket_missing');
  assert.deepEqual(queue.completed, []);
  assert.deepEqual(fixture.delivery.status(), {
    configured: true,
    available: false,
    reason: 'shared_app_server_socket_missing',
  });
});

test('constructor defers startup drain until receiver authority is activated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-startup-'));
  writePendingQueue(dir, [discordMessage('m-startup', 'persisted')]);
  const requests = [];
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    structuredHost: {
      async resolveTarget() {
        return { available: true, threadId: 'thread-current', status: 'idle' };
      },
      async startTurn(params) {
        requests.push(params);
        return { turn: { id: 'turn-startup' } };
      },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests, []);
  await delivery.activateReceiver(activeReceiver);

  assert.deepEqual(requests.map((request) => request.clientUserMessageId), ['discord:c1:m-startup']);
  assert.deepEqual(readQueue(dir).items, []);
  delivery.destroy();
});

test('startup drain advances a crashed accepted head and submits the next FIFO item', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-crash-drain-'));
  writePendingQueue(dir, [
    discordMessage('m-crashed', 'accepted before crash'),
    discordMessage('m-next', 'next in fifo'),
  ], {
    blocked: {
      reason: 'structured_delivery_in_progress',
      at: '2026-07-20T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      messageId: 'm-crashed',
      threadId: 'thread-current',
      clientUserMessageId: 'discord:c1:m-crashed',
      pid: process.pid,
      attemptId: 'crashed-attempt',
    },
  });
  const reconciliations = [];
  const requests = [];
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    structuredHost: {
      async resolveTarget() {
        return { available: true, threadId: 'thread-current', status: 'idle' };
      },
      async startTurn(params) {
        requests.push(params);
        return { turn: { id: 'turn-next' } };
      },
      async hasDelivered(threadId, clientUserMessageId) {
        reconciliations.push({ threadId, clientUserMessageId });
        return clientUserMessageId === 'discord:c1:m-crashed';
      },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });
  await delivery.activateReceiver(activeReceiver);

  assert.deepEqual(reconciliations, [{
    threadId: 'thread-current',
    clientUserMessageId: 'discord:c1:m-crashed',
  }]);
  assert.deepEqual(requests.map((request) => request.clientUserMessageId), ['discord:c1:m-next']);
  assert.deepEqual(readQueue(dir).items, []);
  assert.deepEqual(
    readQueue(dir).completed.map((item) => item.messageId),
    ['m-crashed', 'm-next'],
  );
  delivery.destroy();
});

test('startup drain probes an unreconciled crashed head once and remains blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-crash-blocked-'));
  writePendingQueue(dir, [discordMessage('m-crashed', 'unknown after crash')], {
    blocked: {
      reason: 'structured_delivery_in_progress',
      at: '2026-07-20T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      messageId: 'm-crashed',
      threadId: 'thread-current',
      clientUserMessageId: 'discord:c1:m-crashed',
      pid: process.pid,
      attemptId: 'crashed-attempt',
    },
  });
  let reconciliationCount = 0;
  let starts = 0;
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    structuredHost: {
      async resolveTarget() {
        return { available: true, threadId: 'thread-current', status: 'idle' };
      },
      async startTurn() {
        starts += 1;
        return { turn: { id: 'must-not-replay' } };
      },
      async hasDelivered() {
        reconciliationCount += 1;
        return false;
      },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });
  await delivery.activateReceiver(activeReceiver);

  assert.equal(reconciliationCount, 1);
  assert.equal(starts, 0);
  assert.equal(readQueue(dir).blocked.reason, 'structured_ack_uncertain');
  delivery.destroy();
});

test('restart retries a lease abandoned before target resolution without replay ambiguity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-pre-target-crash-'));
  writePendingQueue(dir, [discordMessage('m-pre-target', 'not submitted')], {
    blocked: {
      reason: 'structured_delivery_in_progress',
      phase: 'resolving_target',
      at: '2026-07-20T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:01.000Z',
      messageId: 'm-pre-target',
      threadId: '',
      clientUserMessageId: '',
      pid: 424242,
      attemptId: 'abandoned-pre-target-attempt',
    },
  });
  const requests = [];
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    isProcessAlive: () => false,
    structuredHost: {
      async resolveTarget() {
        return { available: true, threadId: 'thread-current', status: 'idle' };
      },
      async startTurn(params) {
        requests.push(params);
        return { turn: { id: 'turn-after-restart' } };
      },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });

  await delivery.activateReceiver(activeReceiver);

  assert.deepEqual(requests.map((request) => request.clientUserMessageId), [
    'discord:c1:m-pre-target',
  ]);
  assert.deepEqual(readQueue(dir).items, []);
  assert.deepEqual(readQueue(dir).completed.map((item) => item.messageId), ['m-pre-target']);
  delivery.destroy();
});

test('foreign delivery lease schedules one expiry wake and drains without replay', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-foreign-lease-'));
  const timers = createManualTimers();
  let now = Date.parse('2026-07-20T00:00:00.000Z');
  const expiresAt = now + 100;
  writePendingQueue(dir, [discordMessage('m-foreign', 'accepted by another gateway')], {
    blocked: {
      reason: 'structured_delivery_in_progress',
      at: new Date(now - 100).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      messageId: 'm-foreign',
      threadId: 'thread-current',
      clientUserMessageId: 'discord:c1:m-foreign',
      pid: 424242,
      attemptId: 'foreign-attempt',
    },
  });
  const reconciliations = [];
  let starts = 0;
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    clearTimeout: timers.clearTimeout,
    isProcessAlive: () => true,
    now: () => now,
    setTimeout: timers.setTimeout,
    structuredHost: {
      async resolveTarget() {
        return { available: true, threadId: 'thread-current', status: 'idle' };
      },
      async startTurn() {
        starts += 1;
        return { turn: { id: 'must-not-replay' } };
      },
      async hasDelivered(threadId, clientUserMessageId) {
        reconciliations.push({ threadId, clientUserMessageId });
        return true;
      },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });
  await delivery.activateReceiver(activeReceiver);

  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(timers.delays, [100]);
  await delivery.flush();
  await delivery.flush();
  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(timers.delays, [100]);

  now = expiresAt;
  await timers.runNext();

  assert.deepEqual(reconciliations, [{
    threadId: 'thread-current',
    clientUserMessageId: 'discord:c1:m-foreign',
  }]);
  assert.equal(starts, 0);
  assert.deepEqual(readQueue(dir).items, []);
  assert.deepEqual(readQueue(dir).completed.map((item) => item.messageId), ['m-foreign']);
  assert.equal(timers.pendingCount(), 0);
  delivery.destroy();
});

test('reconnect drain reconciles an accepted head before submitting the next FIFO item', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-reconnect-drain-'));
  writePendingQueue(dir, [
    discordMessage('m-accepted', 'accepted before disconnect'),
    discordMessage('m-next', 'next after reconnect'),
  ], {
    blocked: {
      reason: 'structured_ack_uncertain',
      at: '2026-07-20T00:00:00.000Z',
      messageId: 'm-accepted',
      threadId: 'thread-current',
      clientUserMessageId: 'discord:c1:m-accepted',
    },
  });
  let online = false;
  let reconnectListener = null;
  const requests = [];
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    structuredHost: {
      async resolveTarget() {
        return online
          ? { available: true, threadId: 'thread-current', status: 'idle' }
          : { available: false, reason: 'shared_app_server_disconnected', status: 'unavailable' };
      },
      async startTurn(params) {
        requests.push(params);
        return { turn: { id: 'turn-next' } };
      },
      async hasDelivered(_threadId, clientUserMessageId) {
        if (!online) throw new Error('disconnected');
        return clientUserMessageId === 'discord:c1:m-accepted';
      },
      onThreadIdle() { return () => {}; },
      onReconnect(listener) {
        reconnectListener = listener;
        return () => { reconnectListener = null; };
      },
      status() {
        return {
          configured: true,
          available: online,
          reason: online ? null : 'shared_app_server_disconnected',
        };
      },
      destroy() {},
    },
  });
  await delivery.activateReceiver(activeReceiver);
  assert.deepEqual(requests, []);

  online = true;
  await reconnectListener();

  assert.deepEqual(requests.map((request) => request.clientUserMessageId), ['discord:c1:m-next']);
  assert.deepEqual(readQueue(dir).items, []);
  assert.deepEqual(
    readQueue(dir).completed.map((item) => item.messageId),
    ['m-accepted', 'm-next'],
  );
  delivery.destroy();
});

test('persisted accepted message drains autonomously when the host reconnects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-reconnect-'));
  writePendingQueue(dir, [discordMessage('m-reconnect', 'persisted')]);
  const requests = [];
  let availableListener = null;
  let target = {
    available: false,
    reason: 'shared_app_server_disconnected',
    status: 'unavailable',
  };
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    structuredHost: {
      async resolveTarget() { return { ...target }; },
      async startTurn(params) {
        requests.push(params);
        return { turn: { id: 'turn-reconnect' } };
      },
      onThreadIdle() { return () => {}; },
      onReconnect(listener) {
        availableListener = listener;
        return () => { availableListener = null; };
      },
      status() { return { configured: true, available: target.available, reason: target.reason || null }; },
      destroy() {},
    },
  });
  await delivery.activateReceiver(activeReceiver);
  assert.deepEqual(requests, []);
  assert.equal(typeof availableListener, 'function');

  target = { available: true, threadId: 'thread-current', status: 'idle' };
  await availableListener();

  assert.deepEqual(requests.map((request) => request.clientUserMessageId), ['discord:c1:m-reconnect']);
  assert.deepEqual(readQueue(dir).items, []);
  delivery.destroy();
});

test('persisted message retries autonomously after a loaded child thread closes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-child-close-'));
  writePendingQueue(dir, [discordMessage('m-child-close', 'persisted')]);
  const requests = [];
  let childClosedListener = null;
  let target = {
    available: false,
    reason: 'shared_app_server_thread_ambiguous',
    status: 'unavailable',
  };
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    structuredHost: {
      async resolveTarget() { return { ...target }; },
      async startTurn(params) {
        requests.push(params);
        return { turn: { id: 'turn-after-child-close' } };
      },
      onThreadIdle() { return () => {}; },
      onThreadClosed(listener) {
        childClosedListener = listener;
        return () => { childClosedListener = null; };
      },
      status() { return { configured: true, available: target.available, reason: target.reason || null }; },
      destroy() {},
    },
  });
  await delivery.activateReceiver(activeReceiver);
  assert.deepEqual(requests, []);
  assert.equal(typeof childClosedListener, 'function');

  target = { available: true, threadId: 'thread-root', status: 'idle' };
  await childClosedListener({ threadId: 'thread-child' });

  assert.deepEqual(requests.map((request) => request.clientUserMessageId), [
    'discord:c1:m-child-close',
  ]);
  assert.deepEqual(readQueue(dir).items, []);
  delivery.destroy();
  assert.equal(childClosedListener, null);
});

test('concurrent receivers persist and submit a Discord identity only once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-concurrent-'));
  const config = deliveryConfig(dir);
  const requests = [];
  let release;
  let markStarted;
  const pending = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const host = {
    async resolveTarget() {
      return { available: true, threadId: 'thread-current', status: 'idle' };
    },
    async startTurn(params) {
      requests.push(params);
      markStarted();
      await pending;
      return { turn: { id: 'turn-1' } };
    },
    onThreadIdle() { return () => {}; },
    status() { return { configured: true, available: true, reason: null }; },
  };
  const first = createDelivery(config, () => {}, { structuredHost: host });
  const second = createDelivery(config, () => {}, { structuredHost: host });

  const deliveries = [
    first.deliver(discordMessage('m-once', 'once')),
    second.deliver(discordMessage('m-once', 'once')),
  ];
  const startedBeforeTimeout = await Promise.race([
    started.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  release();
  const results = await Promise.all(deliveries);

  assert.equal(startedBeforeTimeout, true);
  assert.equal(results.some((result) => result.status === 'delivered'), true);
  assert.equal(requests.length, 1);
  assert.deepEqual(readQueue(dir).completed.map((item) => item.messageId), ['m-once']);
});

test('receiver handoff waits for the incumbent delivery lease before committing authority', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-authority-handoff-'));
  const config = deliveryConfig(dir, {
    appServerRequestTimeoutMs: 100,
    paths: {
      ...deliveryConfig(dir).paths,
      gatewayPidPath: path.join(dir, 'session-gateway.pid'),
    },
  });
  const incumbent = {
    version: 2,
    pid: process.pid,
    generation: 'incumbent-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
    fallback: null,
  };
  fs.writeFileSync(config.paths.gatewayPidPath, `${JSON.stringify(incumbent)}\n`);
  let releaseTurn;
  let markTurnStarted;
  const turnStarted = new Promise((resolve) => { markTurnStarted = resolve; });
  const turnReleased = new Promise((resolve) => { releaseTurn = resolve; });
  const requests = [];
  const host = {
    async resolveTarget() {
      return { available: true, threadId: 'thread-current', status: 'idle' };
    },
    async startTurn(params) {
      requests.push(params);
      markTurnStarted();
      await turnReleased;
      return { turn: { id: 'turn-incumbent' } };
    },
    onThreadIdle() { return () => {}; },
    onReconnect() { return () => {}; },
    onThreadClosed() { return () => {}; },
    status() { return { configured: true, available: true, reason: null }; },
    destroy() {},
  };
  const incumbentDelivery = createDelivery(config, () => {}, { structuredHost: host });
  const successorDelivery = createDelivery(config, () => {}, { structuredHost: host });
  await incumbentDelivery.enqueue(discordMessage('m-handoff', 'once'));
  const incumbentDrain = incumbentDelivery.flush({
    verifyReceiverOwnership: () => isCurrentReceiverOwnership(config, incumbent),
  });
  await turnStarted;

  const snapshot = readReceiverAuthoritySnapshot(config);
  const successor = {
    ...incumbent,
    generation: 'successor-generation',
    claimedAt: '2026-07-20T00:01:00.000Z',
  };
  let handoffCommitted = false;
  const handoff = successorDelivery.coordinateReceiverOwnership(() => {
    const result = commitReceiverOwnership(config, snapshot, successor);
    handoffCommitted = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handoffCommitted, false);
  assert.equal(readReceiverAuthoritySnapshot(config).record.generation, incumbent.generation);

  releaseTurn();
  await incumbentDrain;
  await handoff;

  assert.equal(readReceiverAuthoritySnapshot(config).record.generation, successor.generation);
  assert.deepEqual(requests.map((request) => request.clientUserMessageId), ['discord:c1:m-handoff']);
  assert.deepEqual(readQueue(dir).items, []);
  assert.deepEqual(readQueue(dir).completed.map((item) => item.messageId), ['m-handoff']);
  incumbentDelivery.destroy();
  successorDelivery.destroy();
});

test('uncertain structured acknowledgement blocks replay and later FIFO items', async () => {
  let starts = 0;
  const fixture = structuredFixture({
    onStartTurn() {
      starts += 1;
      const error = new Error('connection closed after request write');
      error.deliveryOutcome = 'uncertain';
      throw error;
    },
  });

  const first = await fixture.delivery.deliver(discordMessage('m1', 'first'));
  const second = await fixture.delivery.deliver(discordMessage('m2', 'second'));

  assert.equal(first.status, 'failed');
  assert.equal(first.reason, 'structured_ack_uncertain');
  assert.equal(second.status, 'failed');
  assert.equal(second.reason, 'structured_ack_uncertain');
  assert.equal(starts, 1);
  const queue = readQueue(fixture.dir);
  assert.deepEqual(queue.items.map((item) => item.normalized.messageId), ['m1', 'm2']);
  assert.equal(queue.blocked.reason, 'structured_ack_uncertain');
});

test('uncertain acknowledgement reconciles by client id without replaying turn/start', async () => {
  let accepted = false;
  const fixture = structuredFixture({
    onStartTurn() {
      accepted = true;
      const error = new Error('response lost');
      error.deliveryOutcome = 'uncertain';
      throw error;
    },
    hasDelivered(_threadId, clientUserMessageId) {
      return accepted && clientUserMessageId === 'discord:c1:m-reconcile';
    },
  });

  const uncertain = await fixture.delivery.deliver(discordMessage('m-reconcile', 'once'));
  const reconciled = await fixture.delivery.flush();

  assert.equal(uncertain.reason, 'structured_ack_uncertain');
  assert.equal(reconciled.status, 'delivered');
  assert.equal(reconciled.reason, 'turn_already_accepted');
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(readQueue(fixture.dir).items, []);
  assert.deepEqual(readQueue(fixture.dir).completed.map((item) => item.messageId), ['m-reconcile']);
});

test('post-accept uncertainty persists replay identity and reconciles after restart', async () => {
  let fixture;
  fixture = structuredFixture({
    onStartTurn() {
      const queue = readQueue(fixture.dir);
      queue.blocked.attemptId = 'superseded-checkpoint';
      fs.writeFileSync(
        path.join(fixture.dir, 'pending-delivery.json'),
        `${JSON.stringify(queue, null, 2)}\n`,
      );
      return { turn: { id: 'turn-accepted-before-checkpoint-change' } };
    },
  });

  const uncertain = await fixture.delivery.deliver(discordMessage('m-post-accept', 'once'));
  const persisted = readQueue(fixture.dir);

  assert.equal(uncertain.status, 'failed');
  assert.equal(uncertain.reason, 'structured_ack_uncertain');
  assert.equal(persisted.blocked.threadId, 'thread-current');
  assert.equal(persisted.blocked.clientUserMessageId, 'discord:c1:m-post-accept');
  fixture.delivery.destroy();

  const reconciliations = [];
  let replayStarts = 0;
  const recovered = createDelivery(deliveryConfig(fixture.dir), () => {}, {
    structuredHost: {
      async resolveTarget() {
        return { available: true, threadId: 'thread-current', status: 'idle' };
      },
      async startTurn() {
        replayStarts += 1;
        return { turn: { id: 'must-not-replay' } };
      },
      async hasDelivered(threadId, clientUserMessageId) {
        reconciliations.push({ threadId, clientUserMessageId });
        return threadId === 'thread-current' &&
          clientUserMessageId === 'discord:c1:m-post-accept';
      },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });
  await recovered.activateReceiver(activeReceiver);

  assert.deepEqual(reconciliations, [{
    threadId: 'thread-current',
    clientUserMessageId: 'discord:c1:m-post-accept',
  }]);
  assert.equal(replayStarts, 0);
  assert.deepEqual(readQueue(fixture.dir).items, []);
  assert.deepEqual(readQueue(fixture.dir).completed.map((item) => item.messageId), ['m-post-accept']);
  recovered.destroy();
});

test('delivery fails loudly without a network call when durable persistence fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-fail-'));
  let starts = 0;
  const delivery = createDelivery(deliveryConfig(dir, {
    paths: {
      instance: 'codex01',
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  }), () => {}, {
    fs: {
      ...fs,
      writeFileSync(destination, ...args) {
        if (String(destination).includes('pending-delivery.json')) {
          const error = new Error('read-only storage');
          error.code = 'EROFS';
          throw error;
        }
        return fs.writeFileSync(destination, ...args);
      },
    },
    structuredHost: {
      async resolveTarget() { return { available: true, threadId: 'thread-current', status: 'idle' }; },
      async startTurn() { starts += 1; },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
    },
  });

  const result = await delivery.deliver(discordMessage('m-persist-fail'));
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'delivery_queue_persist_failed');
  assert.equal(starts, 0);
});

test('stale receiver generation is rejected inside durable queue admission', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-stale-receiver-'));
  let starts = 0;
  let ownershipChecks = 0;
  const delivery = createDelivery(deliveryConfig(dir), () => {}, {
    structuredHost: {
      async resolveTarget() {
        return { available: true, threadId: 'thread-current', status: 'idle' };
      },
      async startTurn() {
        starts += 1;
        return { turn: { id: 'must-not-start' } };
      },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });

  const result = await delivery.deliver(discordMessage('m-stale'), {
    verifyReceiverOwnership() {
      ownershipChecks += 1;
      return { active: false, reason: 'gateway_generation_changed' };
    },
  });

  assert.equal(result.status, 'ignored');
  assert.equal(result.reason, 'gateway_generation_changed');
  assert.equal(ownershipChecks, 1);
  assert.equal(starts, 0);
  assert.equal(fs.existsSync(path.join(dir, 'pending-delivery.json')), false);
  delivery.destroy();
});

test('off delivery returns unsupported without writing the queue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-off-'));
  const delivery = createDelivery(deliveryConfig(dir, { deliveryMode: 'off' }), () => {});
  const result = await delivery.deliver(discordMessage('m-off'));
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'delivery_disabled');
  assert.equal(fs.existsSync(path.join(dir, 'pending-delivery.json')), false);
});

test('delivery status sanitizes malformed queue content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-status-'));
  fs.writeFileSync(path.join(dir, 'pending-delivery.json'), '{broken');
  assert.deepEqual(readDeliveryQueueStatus(deliveryConfig(dir)), {
    deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    deliveryQueueDepth: null,
    deliveryBlockedReason: 'delivery_queue_unreadable',
    deliveryBlockedAt: null,
    deliveryQueueError: 'Unable to read persistent Discord delivery queue.',
  });
});

test('resolveReplyTarget defaults to the durable last inbound context', async () => {
  const fixture = structuredFixture();
  await fixture.delivery.deliver(discordMessage('m-last', 'remember'));
  assert.deepEqual(resolveReplyTarget({}, deliveryConfig(fixture.dir)), {
    channelId: 'c1',
    replyTo: 'm-last',
    usedLastInbound: true,
  });
});

test('production source contains no raw TTY or terminal-control injection path', () => {
  const root = path.resolve(__dirname, '..', '..');
  const productionFiles = fs.readdirSync(path.join(root, 'src'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(root, 'src', name));
  productionFiles.push(...fs.readdirSync(path.join(root, 'bin'))
    .map((name) => path.join(root, 'bin', name))
    .filter((file) => fs.statSync(file).isFile()));
  const source = productionFiles
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  for (const forbidden of [
    'TIOCSTI',
    'node:child_process',
    'tty-detect',
    'runTtyInjector',
    'injectIntoTty',
    'CODEX_DISCORD_TTY',
    'CODEX_DISCORD_TTY_AUTO_SUBMIT_COMPAT',
    '/dev/pts/',
    'BRACKETED_PASTE',
    '\\x1b[200~',
    '\\x1b[201~',
    'process.stdin.setRawMode',
    'String.fromCharCode(13)',
    'String.fromCharCode(27)',
    'Buffer.from([13',
    'Buffer.from([27',
    'sendKeypress',
    'sendTerminalKey',
  ]) {
    assert.equal(source.includes(forbidden), false, `forbidden delivery primitive remains: ${forbidden}`);
  }
});
