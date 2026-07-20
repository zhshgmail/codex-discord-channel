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

test('concurrent receivers persist and submit a Discord identity only once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-structured-concurrent-'));
  const config = deliveryConfig(dir);
  const requests = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const host = {
    async resolveTarget() {
      return { available: true, threadId: 'thread-current', status: 'idle' };
    },
    async startTurn(params) {
      requests.push(params);
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
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 1);
  release();
  const results = await Promise.all(deliveries);

  assert.equal(results.some((result) => result.status === 'delivered'), true);
  assert.equal(requests.length, 1);
  assert.deepEqual(readQueue(dir).completed.map((item) => item.messageId), ['m-once']);
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
  const sourceFiles = fs.readdirSync(path.join(root, 'src'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(root, 'src', name), 'utf8'))
    .join('\n');
  for (const forbidden of [
    'TIOCSTI',
    'runTtyInjector',
    'injectIntoTty',
    'BRACKETED_PASTE',
    '\\x1b[200~',
    '\\x1b[201~',
  ]) {
    assert.equal(sourceFiles.includes(forbidden), false, `forbidden delivery primitive remains: ${forbidden}`);
  }
});
