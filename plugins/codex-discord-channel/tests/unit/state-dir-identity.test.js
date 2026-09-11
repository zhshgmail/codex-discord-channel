'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAppServerHost } = require('../../src/app-server-host');
const { createDelivery } = require('../../src/delivery');

const THREAD_A = '019f3763-d308-7871-bedc-e6489b02190e';
const THREAD_B = '019f3763-d308-7871-bedc-e6489b02190f';

class FakeClient extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.requests = [];
  }

  async request(method, params) {
    this.requests.push({ method, params });
    return this.handler(method, params, this.requests);
  }

  status() {
    return { configured: true, available: true, reason: null };
  }
}

function rootThread(id, status = 'idle', turns = []) {
  return {
    thread: {
      id,
      parentThreadId: null,
      status: { type: status },
      turns,
    },
  };
}

function deliveryMessage(messageId, content = messageId) {
  return {
    source: 'dm',
    channelId: 'discord-channel',
    guildId: null,
    messageId,
    authorId: 'human-owner',
    authorName: 'owner',
    authorIsBot: false,
    repliedToAuthorId: '',
    repliedToContent: '',
    content,
    attachments: [],
  };
}

function deliveryConfig(stateDir, activationId = 'state-dir-release-a') {
  return {
    deliveryMode: 'app-server',
    deliveryActivationId: activationId,
    paths: {
      instance: 'codex-test',
      stateDir,
      lastInboundPath: path.join(stateDir, 'last-inbound.json'),
      deliveryQueuePath: path.join(stateDir, 'pending-delivery.json'),
    },
  };
}

function activeReceiver() {
  return { active: true, reason: 'gateway_generation_match', pid: process.pid };
}

test('DISCORD_STATE_DIR ignores a stale thread checkpoint and selects the live app-server root', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-state-dir-host-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const checkpoint = path.join(stateDir, 'app-server-target.json');
  fs.writeFileSync(checkpoint, `${JSON.stringify({
    version: 1,
    threadId: THREAD_A,
    loadedThreadIds: [THREAD_A],
  })}\n`);
  const client = new FakeClient((method, params) => {
    if (method === 'thread/loaded/list') return { data: [THREAD_B, THREAD_A] };
    if (method === 'thread/read') return rootThread(params.threadId);
    throw new Error(`unexpected ${method}`);
  });
  const host = createAppServerHost({
    appServerUrl: 'unix:///tmp/cdc-state-dir.sock',
    paths: { stateDir },
    requireTuiLease: false,
  }, () => {}, { client });

  assert.equal(fs.existsSync(checkpoint), false);
  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: THREAD_B,
    status: 'idle',
  });
  assert.equal(fs.existsSync(checkpoint), false);
  host.destroy();
});

test('a restarted host follows live recency instead of a persisted session or thread id', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-state-dir-rotate-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let order = [THREAD_A, THREAD_B];
  const makeHost = () => createAppServerHost({
    appServerUrl: 'unix:///tmp/cdc-state-dir.sock',
    paths: { stateDir },
    requireTuiLease: false,
  }, () => {}, {
    client: new FakeClient((method, params) => {
      if (method === 'thread/loaded/list') return { data: order };
      if (method === 'thread/read') return rootThread(params.threadId);
      throw new Error(`unexpected ${method}`);
    }),
  });
  const first = makeHost();
  assert.equal((await first.resolveTarget()).threadId, THREAD_A);
  first.destroy();
  order = [THREAD_B, THREAD_A];
  const second = makeHost();
  assert.equal((await second.resolveTarget()).threadId, THREAD_B);
  second.destroy();
});

test('Codex 0.150 target discovery does not request full turn hydration', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-state-dir-list-turns-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const client = new FakeClient((method, params) => {
    if (method === 'thread/loaded/list') return { data: [THREAD_A] };
    if (method === 'thread/read' && params.includeTurns === true) {
      const error = new Error('list_turns is not supported yet');
      error.code = 'shared_app_server_request_rejected';
      error.rpcCode = -32601;
      throw error;
    }
    if (method === 'thread/read') return rootThread(THREAD_A);
    throw new Error(`unexpected ${method}`);
  });
  const host = createAppServerHost({
    appServerUrl: 'unix:///tmp/cdc-state-dir.sock',
    paths: { stateDir },
    requireTuiLease: false,
  }, () => {}, { client });
  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: THREAD_A,
    status: 'idle',
  });
  assert.deepEqual(client.requests.map(({ method, params }) => [method, Boolean(params.includeTurns)]), [
    ['thread/loaded/list', false],
    ['thread/read', false],
  ]);
  host.destroy();
});

test('a rejected transient route is rediscovered once without making it instance identity', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-state-dir-retry-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let current = THREAD_A;
  let starts = 0;
  const client = new FakeClient((method, params) => {
    if (method === 'thread/loaded/list') return { data: [current] };
    if (method === 'thread/read') return rootThread(params.threadId);
    if (method === 'turn/start') {
      starts += 1;
      if (starts === 1) {
        current = THREAD_B;
        const error = new Error('transient thread rotated');
        error.deliveryOutcome = 'rejected';
        throw error;
      }
      return { turn: { id: 'turn-current' } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const host = createAppServerHost({
    appServerUrl: 'unix:///tmp/cdc-state-dir.sock',
    paths: { stateDir },
    requireTuiLease: false,
  }, () => {}, { client });
  const target = await host.resolveTarget();
  const result = await host.startTurn({
    threadId: target.threadId,
    clientUserMessageId: 'discord:c:m',
    input: [{ type: 'text', text: 'hello' }],
  }, target);
  assert.deepEqual(result, { turn: { id: 'turn-current' } });
  assert.deepEqual(
    client.requests.filter((entry) => entry.method === 'turn/start').map((entry) => entry.params.threadId),
    [THREAD_A, THREAD_B],
  );
  host.destroy();
});

test('v4 thread-bound uncertainty is archived and never replayed while ready FIFO drains', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-state-dir-v4-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const oldUncertain = {
    version: 4,
    activationId: 'old-release',
    queuedAt: '2026-08-27T00:00:00.000Z',
    normalized: deliveryMessage('old-uncertain'),
    delivery: {
      state: 'structured_ack_uncertain',
      threadId: THREAD_A,
      turnId: 'old-turn',
      clientUserMessageId: 'discord:discord-channel:old-uncertain',
    },
  };
  fs.writeFileSync(path.join(stateDir, 'pending-delivery.json'), `${JSON.stringify({
    version: 4,
    activation: { id: 'old-release', activatedAt: '2026-08-27T00:00:00.000Z' },
    items: [{
      version: 4,
      activationId: 'old-release',
      queuedAt: '2026-08-27T00:01:00.000Z',
      normalized: deliveryMessage('old-ready'),
    }],
    uncertain: [oldUncertain],
    completed: [],
    archived: [],
    blocked: { reason: 'structured_ack_uncertain', threadId: THREAD_A },
  }, null, 2)}\n`);
  const submitted = [];
  let hasDeliveredCalls = 0;
  const host = {
    async resolveTarget() {
      return { available: true, threadId: THREAD_B, status: 'idle' };
    },
    async startTurn(params) {
      submitted.push(params);
      return { turn: { id: `turn-${submitted.length}` } };
    },
    async hasDelivered() {
      hasDeliveredCalls += 1;
      return true;
    },
    status() { return { configured: true, available: true, reason: null }; },
  };
  const delivery = createDelivery(deliveryConfig(stateDir, 'new-release'), () => {}, {
    structuredHost: host,
  });
  await delivery.activateReceiver(activeReceiver);
  while ((await delivery.flush()).status !== 'idle') {}
  const queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'pending-delivery.json'), 'utf8'));
  assert.equal(queue.version, 5);
  assert.deepEqual(queue.uncertain, []);
  assert.equal(queue.blocked, null);
  assert.deepEqual(submitted.map((params) => params.clientUserMessageId), [
    'discord:discord-channel:old-ready',
  ]);
  assert.equal(queue.archived.length, 1);
  assert.equal(queue.archived[0].reason, 'legacy_ack_uncertain_no_auto_replay');
  assert.equal(queue.archived[0].normalized.content, 'old-uncertain');
  assert.deepEqual(Object.keys(queue.completed[0]).sort(), [
    'channelId',
    'clientUserMessageId',
    'completedAt',
    'messageId',
  ]);
  assert.equal(JSON.stringify(queue.completed[0]).includes('threadId'), false);
  assert.equal(JSON.stringify(queue.completed[0]).includes('turnId'), false);
  assert.equal(hasDeliveredCalls, 1);
  delivery.destroy();
});

test('plugin activation changes preserve every queued Discord source', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-state-dir-activation-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateDir, 'pending-delivery.json'), `${JSON.stringify({
    version: 5,
    activation: { id: 'release-before-restart', activatedAt: '2026-08-27T00:00:00.000Z' },
    items: [{
      version: 5,
      activationId: 'release-before-restart',
      queuedAt: '2026-08-27T00:01:00.000Z',
      normalized: deliveryMessage('queued-before-restart'),
    }],
    uncertain: [],
    completed: [],
    archived: [],
    blocked: null,
  }, null, 2)}\n`);
  const submitted = [];
  const host = {
    async resolveTarget() {
      return { available: true, threadId: THREAD_B, status: 'idle' };
    },
    async startTurn(params) {
      submitted.push(params.clientUserMessageId);
      return { turn: { id: 'turn-after-restart' } };
    },
    async hasDelivered(_threadId, clientUserMessageId) {
      return submitted.includes(clientUserMessageId);
    },
    status() { return { configured: true, available: true, reason: null }; },
  };
  const delivery = createDelivery(deliveryConfig(stateDir, 'release-after-restart'), () => {}, {
    structuredHost: host,
  });
  await delivery.activateReceiver(activeReceiver);
  assert.deepEqual(submitted, ['discord:discord-channel:queued-before-restart']);
  const queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'pending-delivery.json'), 'utf8'));
  assert.deepEqual(queue.items, []);
  assert.deepEqual(queue.archived, []);
  assert.deepEqual(queue.completed.map((item) => item.messageId), ['queued-before-restart']);
  delivery.destroy();
});

test('RPC response loss stays ready and retries the same Discord source against the current route', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-state-dir-loss-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let current = THREAD_A;
  const calls = [];
  const host = {
    async resolveTarget() {
      return { available: true, threadId: current, status: 'idle' };
    },
    async startTurn(params, target) {
      calls.push({ params, target });
      if (calls.length === 1) {
        current = THREAD_B;
        const error = new Error('response lost');
        error.deliveryOutcome = 'uncertain';
        throw error;
      }
      return { turn: { id: 'turn-ok' } };
    },
    async hasDelivered(_threadId, clientUserMessageId) {
      return calls.some((entry) => entry.params.clientUserMessageId === clientUserMessageId)
        && calls.length > 1;
    },
    status() { return { configured: true, available: true, reason: null }; },
  };
  const delivery = createDelivery(deliveryConfig(stateDir), () => {}, { structuredHost: host });
  await delivery.activateReceiver(activeReceiver);
  const first = await delivery.deliver(deliveryMessage('response-loss'));
  assert.equal(first.reason, 'shared_app_server_retry');
  let queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'pending-delivery.json'), 'utf8'));
  assert.equal(queue.items.length, 1);
  assert.deepEqual(queue.uncertain, []);
  assert.equal(queue.blocked, null);
  assert.equal(JSON.stringify(queue).includes(THREAD_A), false);
  const second = await delivery.flush();
  assert.equal(second.status, 'delivered');
  assert.equal(calls[0].params.clientUserMessageId, calls[1].params.clientUserMessageId);
  assert.deepEqual(calls.map((entry) => entry.target.threadId), [THREAD_A, THREAD_B]);
  queue = JSON.parse(fs.readFileSync(path.join(stateDir, 'pending-delivery.json'), 'utf8'));
  assert.equal(queue.items.length, 0);
  delivery.destroy();
});
