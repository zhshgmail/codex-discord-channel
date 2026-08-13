'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAppServerHost } = require('../../src/app-server-host');
const { createDelivery } = require('../../src/delivery');
const { startGatewayDrainLoop } = require('../../src/gateway-drain-loop');
const { createAutomaticReplySender } = require('../../bin/codex-discord-channel');

class FakeRpcClient extends EventEmitter {
  constructor(handler) {
    super();
    this.handler = handler;
    this.requests = [];
  }

  async request(method, params) {
    this.requests.push({ method, params });
    return this.handler(method, params);
  }

  status() {
    return { configured: true, available: true, reason: null };
  }
}

function configAt(dir) {
  return {
    deliveryMode: 'app-server',
    deliveryActivationId: 'automatic-final-v1',
    appServerRequestTimeoutMs: 100,
    deliveryDrainIntervalMs: 10,
    deliveryDrainMaxBackoffMs: 40,
    paths: {
      stateDir: dir,
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      replyReceiptDir: path.join(dir, 'reply-receipts'),
    },
  };
}

function source(messageId = 'source-1') {
  return {
    source: 'dm',
    channelId: 'channel-1',
    guildId: null,
    messageId,
    authorId: 'user-1',
    authorName: 'User',
    authorIsBot: false,
    content: 'question',
    attachments: [],
  };
}

function hostForTurn(turnId = 'turn-A') {
  const listeners = new Set();
  return {
    async resolveTarget() {
      return { available: true, threadId: 'thread-A', status: 'idle' };
    },
    async startTurn() {
      return { turn: { id: turnId } };
    },
    async hasDelivered() { return true; },
    async readAssistantFinal() { return null; },
    onAssistantFinal(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onThreadIdle() { return () => {}; },
    onThreadActive() { return () => {}; },
    onReconnect() { return () => {}; },
    onThreadClosed() { return () => {}; },
    status() { return { configured: true, available: true, reason: null }; },
    destroy() {},
  };
}

function readQueue(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'pending-delivery.json'), 'utf8'));
}

function readyRecord(index) {
  return {
    channelId: 'channel-1',
    messageId: `source-${index}`,
    completedAt: '2026-08-13T00:00:00.000Z',
    source: { channelId: 'channel-1', messageId: `source-${index}` },
    delivery: {
      threadId: `thread-${index}`,
      turnId: `turn-${index}`,
      clientUserMessageId: `discord:channel-1:source-${index}`,
    },
    outbound: {
      status: 'ready',
      channelId: 'channel-1',
      sourceMessageId: `source-${index}`,
      itemId: `final-${index}`,
      text: `answer-${index}`,
      readyAt: '2026-08-13T00:00:01.000Z',
    },
  };
}

function writeReadyQueue(dir, records) {
  const config = configAt(dir);
  fs.writeFileSync(config.paths.deliveryQueuePath, `${JSON.stringify({
    version: 4,
    activation: { id: config.deliveryActivationId, activatedAt: '2026-08-13T00:00:00.000Z' },
    items: [],
    uncertain: [],
    completed: records,
    archived: [],
    blocked: null,
  }, null, 2)}\n`);
}

test('accepted source durably binds exact thread and turn with outbound waiting', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-binding-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const delivery = createDelivery(configAt(dir), () => {}, { structuredHost: hostForTurn() });
  t.after(() => delivery.destroy());

  const result = await delivery.deliver(source());
  assert.equal(result.status, 'delivered');
  const [completed] = readQueue(dir).completed;
  assert.deepEqual(completed.source, { channelId: 'channel-1', messageId: 'source-1' });
  assert.deepEqual(completed.delivery, {
    threadId: 'thread-A',
    turnId: 'turn-A',
    clientUserMessageId: 'discord:channel-1:source-1',
  });
  assert.deepEqual(completed.outbound, {
    status: 'waiting',
    channelId: 'channel-1',
    sourceMessageId: 'source-1',
  });
});

test('host emits only one exact nonempty final_answer and recovers it by exact readback', async (t) => {
  const client = new FakeRpcClient(async (method, params) => {
    assert.equal(method, 'thread/read');
    assert.deepEqual(params, { threadId: 'thread-A', includeTurns: true });
    return {
      thread: {
        id: 'thread-A',
        turns: [{
          id: 'turn-A',
          status: 'completed',
          items: [{ id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'done' }],
        }],
      },
    };
  });
  const host = createAppServerHost({}, () => {}, { client });
  t.after(() => host.destroy());
  const events = [];
  host.onAssistantFinal((event) => events.push(event));

  client.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: 'thread-A',
      turnId: 'turn-A',
      item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: 'working' },
    },
  });
  client.emit('notification', {
    method: 'item/completed',
    params: {
      threadId: 'thread-A',
      turnId: 'turn-A',
      item: { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'done' },
    },
  });
  assert.deepEqual(events, [{
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'done',
  }]);
  assert.deepEqual(await host.readAssistantFinal('thread-A', 'turn-A'), {
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'done',
  });
});

test('waiting outbound recovers final and guarded confirmation without restarting ingress', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-egress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let starts = 0;
  const host = hostForTurn();
  host.startTurn = async () => {
    starts += 1;
    return { turn: { id: 'turn-A' } };
  };
  host.readAssistantFinal = async () => ({
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'done',
  });
  const sends = [];
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: host,
    async sendAutomaticReply(args) {
      sends.push(args);
      return {
        channelId: args.channelId,
        messageId: 'outbound-1',
        sourceMessageId: args.replyTo,
        duplicateSuppressed: false,
      };
    },
  });
  t.after(() => delivery.destroy());
  await delivery.deliver(source());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_ready');
  assert.equal((await delivery.flushOutbound()).reason, 'outbound_confirmed');
  assert.equal(starts, 1);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], {
    channelId: 'channel-1', replyTo: 'source-1', content: 'done',
  });
  const [completed] = readQueue(dir).completed;
  assert.equal(completed.outbound.status, 'confirmed');
  assert.equal(completed.outbound.outboundMessageId, 'outbound-1');
});

test('gateway tick checks bounded outbound work even when inbound depth is zero', async () => {
  let scheduled;
  let outboundCalls = 0;
  let refreshCalls = 0;
  const loop = startGatewayDrainLoop({
    config: { deliveryDrainIntervalMs: 10, deliveryDrainMaxBackoffMs: 40 },
    delivery: {
      async flush() { throw new Error('inbound flush must stay idle'); },
      async flushOutbound() {
        outboundCalls += 1;
        return { status: 'delivered', reason: 'outbound_confirmed', deliveredCount: 1 };
      },
      async refreshTargetCheckpoint() { refreshCalls += 1; },
    },
    receiverOwnership: {},
    deps: {
      isCurrentReceiverOwnership: () => ({ active: true }),
      readDeliveryQueueStatus: () => ({ deliveryQueueDepth: 0 }),
      setTimeout(callback) { scheduled = callback; return { unref() {} }; },
      clearTimeout() {},
    },
  });
  await scheduled();
  assert.equal(outboundCalls, 1);
  assert.equal(refreshCalls, 1);
  await loop.stop();
});

test('legacy completed records without exact turn binding are never retroactively replied', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  fs.writeFileSync(config.paths.deliveryQueuePath, `${JSON.stringify({
    version: 3,
    activation: { id: config.deliveryActivationId, activatedAt: '2026-08-13T00:00:00.000Z' },
    items: [],
    uncertain: [],
    completed: Array.from({ length: 14 }, (_, index) => ({
      channelId: 'channel-legacy',
      messageId: `legacy-${index}`,
      completedAt: '2026-08-13T00:00:00.000Z',
    })),
    archived: [],
    blocked: null,
  }, null, 2)}\n`);
  let sends = 0;
  const delivery = createDelivery(config, () => {}, {
    structuredHost: hostForTurn(),
    async sendAutomaticReply() { sends += 1; },
  });
  t.after(() => delivery.destroy());

  const result = await delivery.flushOutbound();
  assert.equal(result.reason, 'outbound_empty');
  assert.equal(sends, 0);
});

test('turn/completed recovers a missed item notification exactly once', (t) => {
  const client = new FakeRpcClient(async () => ({ thread: { id: 'thread-A', turns: [] } }));
  const host = createAppServerHost({}, () => {}, { client });
  t.after(() => host.destroy());
  const events = [];
  host.onAssistantFinal((event) => events.push(event));
  const notification = {
    method: 'turn/completed',
    params: {
      threadId: 'thread-A',
      turn: {
        id: 'turn-A',
        status: 'completed',
        items: [{ id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'done' }],
      },
    },
  };
  client.emit('notification', notification);
  client.emit('notification', notification);
  assert.deepEqual(events, [{
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'done',
  }]);
});

test('exact final readback rejects wrong thread turn ambiguity commentary and empty text', async (t) => {
  const cases = [
    { name: 'wrong thread', thread: { id: 'thread-B', turns: [] } },
    { name: 'missing turn', thread: { id: 'thread-A', turns: [] } },
    {
      name: 'duplicate turn',
      thread: { id: 'thread-A', turns: [
        { id: 'turn-A', status: 'completed', items: [] },
        { id: 'turn-A', status: 'completed', items: [] },
      ] },
    },
    {
      name: 'multiple finals',
      thread: { id: 'thread-A', turns: [{
        id: 'turn-A', status: 'completed', items: [
          { id: 'f1', type: 'agentMessage', phase: 'final_answer', text: 'one' },
          { id: 'f2', type: 'agentMessage', phase: 'final_answer', text: 'two' },
        ],
      }] },
    },
    {
      name: 'commentary only',
      thread: { id: 'thread-A', turns: [{
        id: 'turn-A', status: 'completed', items: [
          { id: 'c1', type: 'agentMessage', phase: 'commentary', text: 'working' },
        ],
      }] },
    },
    {
      name: 'empty final',
      thread: { id: 'thread-A', turns: [{
        id: 'turn-A', status: 'completed', items: [
          { id: 'f1', type: 'agentMessage', phase: 'final_answer', text: '  ' },
        ],
      }] },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const client = new FakeRpcClient(async () => ({ thread: scenario.thread }));
      const host = createAppServerHost({}, () => {}, { client });
      try {
        assert.equal(await host.readAssistantFinal('thread-A', 'turn-A'), null);
      } finally {
        host.destroy();
      }
    });
  }
});

test('active-turn uncertain restart retains exact turn and becomes waiting only after proof', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-active-uncertain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  const uncertainHost = hostForTurn('turn-active');
  uncertainHost.resolveTarget = async () => ({
    available: true,
    threadId: 'thread-A',
    status: 'active',
    activeTurnId: 'turn-active',
  });
  uncertainHost.startTurn = async () => {
    const error = new Error('disconnect after active steer');
    error.deliveryOutcome = 'uncertain';
    throw error;
  };
  const first = createDelivery(config, () => {}, { structuredHost: uncertainHost });
  assert.equal((await first.deliver(source('source-active'))).reason, 'structured_ack_uncertain');
  first.destroy();
  assert.equal(readQueue(dir).uncertain[0].delivery.turnId, 'turn-active');

  const recoveredHost = hostForTurn('turn-active');
  recoveredHost.hasDelivered = async () => true;
  const recovered = createDelivery(config, () => {}, { structuredHost: recoveredHost });
  t.after(() => recovered.destroy());
  assert.equal((await recovered.flush()).status, 'delivered');
  const [completed] = readQueue(dir).completed;
  assert.equal(completed.delivery.turnId, 'turn-active');
  assert.equal(completed.outbound.status, 'waiting');
});

test('ready state survives guarded uncertainty and confirms after same-identity reconciliation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-guarded-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = hostForTurn();
  host.readAssistantFinal = async () => ({
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'done',
  });
  let guardedCalls = 0;
  let remotePosts = 0;
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: host,
    async sendAutomaticReply(args) {
      guardedCalls += 1;
      if (guardedCalls === 1) {
        remotePosts += 1;
        const error = new Error('POST response lost after durable receipt claim');
        error.code = 'reply_send_uncertain';
        throw error;
      }
      return {
        channelId: args.channelId,
        sourceMessageId: args.replyTo,
        messageId: 'outbound-1',
        duplicateSuppressed: false,
        reconciled: true,
      };
    },
  });
  t.after(() => delivery.destroy());
  await delivery.deliver(source());
  await delivery.flushOutbound();
  assert.equal((await delivery.flushOutbound()).reason, 'reply_send_uncertain');
  assert.equal(readQueue(dir).completed[0].outbound.status, 'ready');
  assert.equal((await delivery.flushOutbound()).reason, 'outbound_confirmed');
  assert.equal(remotePosts, 1);
  assert.equal(readQueue(dir).completed[0].outbound.status, 'confirmed');
});

test('automatic sender delegates exact source and content to existing guarded protocol', async () => {
  const calls = [];
  const sender = createAutomaticReplySender(
    { paths: { stateDir: '/not-used' } },
    { name: 'rest-client' },
    {
      async sendDiscordReplyOnce(options) {
        calls.push(options);
        return {
          channelId: options.args.channelId,
          sourceMessageId: options.args.replyTo,
          messageId: 'outbound-1',
        };
      },
    },
  );
  const result = await sender({ channelId: 'channel-1', replyTo: 'source-1', content: 'done' });
  assert.equal(result.messageId, 'outbound-1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, {
    channelId: 'channel-1', replyTo: 'source-1', followup: false,
  });
  assert.equal(calls[0].content, 'done');
  assert.equal(typeof calls[0].preflight, 'function');
  assert.equal(typeof calls[0].sender, 'function');
  assert.equal(typeof calls[0].confirmer, 'function');
  assert.equal(typeof calls[0].reconciler, 'function');
});

test('returned message id without exact readback never confirms automatic outbound', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-false-confirm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  writeReadyQueue(dir, [readyRecord(1)]);

  let posts = 0;
  let exactReadbacks = 0;
  const automaticSender = createAutomaticReplySender(config, {}, {
    async prepareDiscordMessageSend() { return { prepared: true }; },
    async sendDiscordMessage() {
      posts += 1;
      return { channelId: 'channel-1', messageId: 'discord-out-1' };
    },
    async confirmDiscordMessage() {
      exactReadbacks += 1;
      throw new Error('exact readback unavailable');
    },
    async reconcileDiscordMessage() {
      exactReadbacks += 1;
      return { found: false };
    },
  });
  const delivery = createDelivery(config, () => {}, {
    structuredHost: hostForTurn(),
    sendAutomaticReply: automaticSender,
  });
  t.after(() => delivery.destroy());

  const first = await delivery.flushOutbound();
  const second = await delivery.flushOutbound();
  const receiptName = fs.readdirSync(config.paths.replyReceiptDir)
    .find((name) => name.endsWith('.json'));
  const receipt = JSON.parse(fs.readFileSync(
    path.join(config.paths.replyReceiptDir, receiptName),
    'utf8',
  ));
  assert.deepEqual({
    firstReason: first.reason,
    secondReason: second.reason,
    queueStatus: readQueue(dir).completed[0].outbound.status,
    guardedReceiptStatus: receipt.status,
    posts,
    exactReadbacks,
  }, {
    firstReason: 'outbound_reply_unconfirmed',
    secondReason: 'outbound_reply_unconfirmed',
    queueStatus: 'ready',
    guardedReceiptStatus: 'uncertain',
    posts: 1,
    exactReadbacks: 2,
  });
});

test('one failing ready outbound does not starve the next exact source', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-ready-fair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  writeReadyQueue(dir, [readyRecord(1), readyRecord(2)]);
  const attempts = [];
  const deps = {
    structuredHost: hostForTurn(),
    async sendAutomaticReply(args) {
      attempts.push(args.replyTo);
      if (args.replyTo === 'source-1') throw new Error('source-1 remains unavailable');
      return {
        channelId: args.channelId,
        sourceMessageId: args.replyTo,
        messageId: 'discord-out-2',
        duplicateSuppressed: false,
      };
    },
  };
  const firstProcess = createDelivery(config, () => {}, deps);
  await firstProcess.flushOutbound();
  firstProcess.destroy();
  assert.equal(readQueue(dir).completed[0].outbound.sendAttemptCount, 1);

  const restarted = createDelivery(config, () => {}, deps);
  t.after(() => restarted.destroy());
  await restarted.flushOutbound();
  assert.deepEqual(attempts, ['source-1', 'source-2']);
});

test('only exact guarded confirmation outcomes can terminally confirm outbound', async (t) => {
  const cases = [
    {
      name: 'explicit uncertain direct result',
      sent: { duplicateSuppressed: false, receiptStatus: 'uncertain' },
      expected: 'outbound_reply_unconfirmed',
    },
    {
      name: 'suppressed in-progress result',
      sent: {
        duplicateSuppressed: true,
        receiptStatus: 'in_flight',
        reason: 'source_message_reply_in_progress',
      },
      expected: 'outbound_reply_unconfirmed',
    },
    {
      name: 'suppressed already-confirmed receipt',
      sent: {
        duplicateSuppressed: true,
        receiptStatus: 'confirmed',
        reason: 'source_message_already_replied',
      },
      expected: 'outbound_confirmed',
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-confirm-contract-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      writeReadyQueue(dir, [readyRecord(1)]);
      const delivery = createDelivery(configAt(dir), () => {}, {
        structuredHost: hostForTurn(),
        async sendAutomaticReply(args) {
          return {
            channelId: args.channelId,
            sourceMessageId: args.replyTo,
            messageId: 'discord-out-1',
            ...scenario.sent,
          };
        },
      });
      t.after(() => delivery.destroy());
      assert.equal((await delivery.flushOutbound()).reason, scenario.expected);
      assert.equal(
        readQueue(dir).completed[0].outbound.status,
        scenario.expected === 'outbound_confirmed' ? 'confirmed' : 'ready',
      );
    });
  }
});
