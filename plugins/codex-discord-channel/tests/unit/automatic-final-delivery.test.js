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
const {
  contentDigest,
  receiptPath,
  replyNonce,
} = require('../../src/reply-delivery');
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

function bindTurnOwner(record, boundAt = '2026-08-13T00:00:00.000Z') {
  record.delivery.turnReplyOwner = true;
  record.delivery.turnReplyBoundAt = boundAt;
  return record;
}

function suppressOutbound(record, owner) {
  record.outbound = {
    status: 'suppressed',
    channelId: record.channelId,
    sourceMessageId: record.messageId,
    reason: 'turn_reply_owned_by_prior_source',
    ownerChannelId: owner.channelId,
    ownerSourceMessageId: owner.messageId,
    suppressedAt: '2026-08-13T00:00:04.000Z',
  };
  return record;
}

function writeReplyReceipt(dir, record, {
  version = 2,
  status,
  outboundMessageId = null,
  overrides = {},
} = {}) {
  const config = configAt(dir);
  const receipt = {
    version,
    status,
    channelId: record.channelId,
    sourceMessageId: record.messageId,
    contentSha256: contentDigest(record.outbound.text),
    nonce: replyNonce(record.channelId, record.messageId),
    operationId: `operation-${record.messageId}`,
    claimedAt: '2026-08-13T00:00:02.000Z',
    updatedAt: '2026-08-13T00:00:03.000Z',
    pid: process.pid,
    ...(outboundMessageId ? { outboundMessageId } : {}),
    ...overrides,
  };
  const file = receiptPath(config, record.channelId, record.messageId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
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
    turnReplyOwner: true,
    turnReplyBoundAt: completed.delivery.turnReplyBoundAt,
  });
  assert.equal(Number.isFinite(Date.parse(completed.delivery.turnReplyBoundAt)), true);
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

test('inbound-only mode never sends automatic final replies from autonomous callbacks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-inbound-only-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let assistantFinalListener = null;
  const host = hostForTurn();
  host.readAssistantFinal = async () => ({
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'done',
  });
  host.onAssistantFinal = (listener) => {
    assistantFinalListener = listener;
    return () => { assistantFinalListener = null; };
  };
  const sends = [];
  const config = {
    ...configAt(dir),
    automaticOutboundEnabled: false,
  };
  const delivery = createDelivery(config, () => {}, {
    structuredHost: host,
    async sendAutomaticReply(args) {
      sends.push(args);
      return {
        channelId: args.channelId,
        messageId: 'unexpected-outbound',
        sourceMessageId: args.replyTo,
        duplicateSuppressed: false,
      };
    },
  });
  t.after(() => delivery.destroy());
  await delivery.activateReceiver(() => ({ active: true }));
  await delivery.deliver(source());

  assert.equal(typeof assistantFinalListener, 'function');
  await assistantFinalListener({
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'done',
  });
  assert.deepEqual(sends, []);
  assert.deepEqual(await delivery.flushOutbound(), {
    status: 'idle', reason: 'automatic_outbound_disabled', deliveredCount: 0,
  });
  assert.equal(readQueue(dir).completed[0].outbound.status, 'waiting');
});

test('one aggregated top-level turn arms one source reply instead of fanning one final to sixteen sources', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-one-turn-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let resolveCount = 0;
  const host = hostForTurn('turn-A');
  host.resolveTarget = async () => {
    resolveCount += 1;
    return resolveCount === 1
      ? { available: true, threadId: 'thread-A', status: 'idle' }
      : {
        available: true,
        threadId: 'thread-A',
        status: 'active',
        activeTurnId: 'turn-A',
      };
  };
  host.readAssistantFinal = async () => ({
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'one answer',
  });
  const sends = [];
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: host,
    async sendAutomaticReply(args) {
      sends.push(args);
      return {
        channelId: args.channelId,
        messageId: `outbound-${sends.length}`,
        sourceMessageId: args.replyTo,
        duplicateSuppressed: false,
      };
    },
  });
  t.after(() => delivery.destroy());

  for (let index = 1; index <= 16; index += 1) {
    assert.equal((await delivery.deliver(source(`source-${index}`))).status, 'delivered');
  }
  for (let index = 0; index < 40; index += 1) await delivery.flushOutbound();

  assert.deepEqual(sends.map((entry) => entry.replyTo), ['source-1']);
  const [owner, ...aggregated] = readQueue(dir).completed;
  assert.equal(owner.outbound.status, 'confirmed');
  assert.equal(aggregated.length, 15);
  for (const record of aggregated) {
    assert.equal(record.outbound.status, 'suppressed');
    assert.equal(record.outbound.reason, 'turn_reply_owned_by_prior_source');
    assert.equal(record.outbound.ownerSourceMessageId, 'source-1');
  }
});

test('first durable turn binding owns the final when its uncertain ack completes after a later source', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-first-binding-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sourceOneAccepted = false;
  const host = hostForTurn('turn-A');
  host.resolveTarget = async () => ({
    available: true,
    threadId: 'thread-A',
    status: 'active',
    activeTurnId: 'turn-A',
  });
  host.startTurn = async (params) => {
    if (params.clientUserMessageId.endsWith(':source-1')) {
      const error = new Error('source-1 ack lost after active-turn binding');
      error.deliveryOutcome = 'uncertain';
      throw error;
    }
    return { turn: { id: 'turn-A' } };
  };
  host.hasDelivered = async (_threadId, clientUserMessageId) => (
    clientUserMessageId.endsWith(':source-2') || sourceOneAccepted
  );
  host.readAssistantFinal = async () => ({
    threadId: 'thread-A', turnId: 'turn-A', itemId: 'final-1', text: 'one answer',
  });
  const sends = [];
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: host,
    async sendAutomaticReply(args) {
      sends.push(args);
      return {
        channelId: args.channelId,
        messageId: `outbound-${sends.length}`,
        sourceMessageId: args.replyTo,
        duplicateSuppressed: false,
      };
    },
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.deliver(source('source-1'))).reason, 'structured_ack_uncertain');
  assert.equal((await delivery.deliver({
    ...source('source-2'),
    channelId: 'channel-2',
  })).status, 'delivered');
  for (let index = 0; index < 4; index += 1) await delivery.flushOutbound();
  assert.deepEqual(sends, []);

  sourceOneAccepted = true;
  assert.equal((await delivery.flush()).status, 'delivered');
  for (let index = 0; index < 4; index += 1) await delivery.flushOutbound();

  assert.deepEqual(sends.map(({ channelId, replyTo }) => ({ channelId, replyTo })), [{
    channelId: 'channel-1',
    replyTo: 'source-1',
  }]);
  const completed = readQueue(dir).completed;
  assert.equal(completed.find((record) => record.messageId === 'source-1').outbound.status, 'confirmed');
  assert.equal(completed.find((record) => record.messageId === 'source-2').outbound.status, 'suppressed');
});

test('restart suppresses persisted pre-repair ready fanout before any second source POST', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-persisted-fanout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  const owner = bindTurnOwner(readyRecord(1));
  const duplicate = readyRecord(2);
  duplicate.delivery.threadId = owner.delivery.threadId;
  duplicate.delivery.turnId = owner.delivery.turnId;
  writeReadyQueue(dir, [owner, duplicate]);
  const sends = [];
  const delivery = createDelivery(config, () => {}, {
    structuredHost: hostForTurn(),
    async sendAutomaticReply(args) {
      sends.push(args);
      return {
        channelId: args.channelId,
        messageId: `outbound-${sends.length}`,
        sourceMessageId: args.replyTo,
        duplicateSuppressed: false,
      };
    },
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_confirmed');
  for (let index = 0; index < 4; index += 1) await delivery.flushOutbound();

  assert.deepEqual(sends.map((entry) => entry.replyTo), ['source-1']);
  const [confirmed, suppressed] = readQueue(dir).completed;
  assert.equal(confirmed.outbound.status, 'confirmed');
  assert.equal(suppressed.outbound.status, 'suppressed');
  assert.equal(suppressed.outbound.ownerSourceMessageId, 'source-1');
});

test('restart treats a same-turn confirmed duplicate receipt as the one visible reply', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-confirmed-duplicate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = bindTurnOwner(readyRecord(1));
  const confirmed = readyRecord(2);
  confirmed.delivery.threadId = owner.delivery.threadId;
  confirmed.delivery.turnId = owner.delivery.turnId;
  writeReadyQueue(dir, [owner, confirmed]);
  writeReplyReceipt(dir, confirmed, {
    status: 'confirmed',
    outboundMessageId: 'discord-confirmed-2',
  });
  const receiptFile = receiptPath(configAt(dir), confirmed.channelId, confirmed.messageId);
  const receiptBytesBefore = fs.readFileSync(receiptFile);
  const sends = [];
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: hostForTurn(),
    async sendAutomaticReply(args) {
      sends.push(args);
      return {
        channelId: args.channelId,
        messageId: `outbound-${sends.length}`,
        sourceMessageId: args.replyTo,
        duplicateSuppressed: false,
      };
    },
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_empty');

  const records = new Map(readQueue(dir).completed.map((record) => [record.messageId, record]));
  assert.equal(records.get('source-1').outbound.status, 'suppressed');
  assert.deepEqual({
    status: records.get('source-2').outbound.status,
    outboundMessageId: records.get('source-2').outbound.outboundMessageId,
  }, {
    status: 'confirmed',
    outboundMessageId: 'discord-confirmed-2',
  });
  assert.deepEqual(sends, []);
  assert.deepEqual(fs.readFileSync(receiptFile), receiptBytesBefore);
});

test('restart preserves a legacy sent duplicate id and never POSTs the owner', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-legacy-sent-duplicate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = bindTurnOwner(readyRecord(1));
  const sent = readyRecord(2);
  sent.delivery.threadId = owner.delivery.threadId;
  sent.delivery.turnId = owner.delivery.turnId;
  writeReadyQueue(dir, [owner, sent]);
  writeReplyReceipt(dir, sent, {
    version: 1,
    status: 'sent',
    outboundMessageId: 'discord-sent-2',
  });
  const receiptFile = receiptPath(configAt(dir), sent.channelId, sent.messageId);
  const receiptBytesBefore = fs.readFileSync(receiptFile);
  let posts = 0;
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: hostForTurn(),
    async sendAutomaticReply() { posts += 1; },
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_empty');
  assert.equal(posts, 0);
  const records = new Map(readQueue(dir).completed.map((record) => [record.messageId, record]));
  assert.equal(records.get('source-1').outbound.status, 'suppressed');
  assert.deepEqual({
    status: records.get('source-2').outbound.status,
    outboundMessageId: records.get('source-2').outbound.outboundMessageId,
  }, {
    status: 'confirmed',
    outboundMessageId: 'discord-sent-2',
  });
  assert.deepEqual(fs.readFileSync(receiptFile), receiptBytesBefore);
});

test('restart reconciles an uncertain receipt without a second POST before suppressing a no-receipt duplicate', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-receipt-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  const owner = bindTurnOwner(readyRecord(1));
  const uncertain = readyRecord(2);
  const noReceipt = readyRecord(3);
  for (const record of [uncertain, noReceipt]) {
    record.delivery.threadId = owner.delivery.threadId;
    record.delivery.turnId = owner.delivery.turnId;
  }
  writeReadyQueue(dir, [owner, uncertain, noReceipt]);
  writeReplyReceipt(dir, uncertain, {
    status: 'uncertain',
    outboundMessageId: 'discord-uncertain-2',
  });
  let posts = 0;
  let reconciliations = 0;
  const automaticSender = createAutomaticReplySender(config, {}, {
    async prepareDiscordMessageSend() { return { prepared: true }; },
    async sendDiscordMessage() {
      posts += 1;
      return { channelId: 'channel-1', messageId: 'unexpected-post' };
    },
    async confirmDiscordMessage() {
      throw new Error('confirmation is not the reconciliation path');
    },
    async reconcileDiscordMessage(_client, _args, _prepared, receipt) {
      reconciliations += 1;
      return {
        found: true,
        channelId: receipt.channelId,
        messageId: receipt.outboundMessageId,
      };
    },
  });
  const delivery = createDelivery(config, () => {}, {
    structuredHost: hostForTurn(),
    sendAutomaticReply: automaticSender,
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_confirmed');
  assert.equal(posts, 0);
  assert.equal(reconciliations, 1);
  const records = new Map(readQueue(dir).completed.map((record) => [record.messageId, record]));
  assert.equal(records.get('source-1').outbound.status, 'suppressed');
  assert.equal(records.get('source-2').outbound.status, 'confirmed');
  assert.equal(records.get('source-3').outbound.status, 'suppressed');
  const receipt = JSON.parse(fs.readFileSync(
    receiptPath(config, uncertain.channelId, uncertain.messageId),
    'utf8',
  ));
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.outboundMessageId, 'discord-uncertain-2');
});

test('restart waits on a live same-turn in-flight duplicate receipt without POSTing the owner', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-live-in-flight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = bindTurnOwner(readyRecord(1));
  const inFlight = readyRecord(2);
  inFlight.delivery.threadId = owner.delivery.threadId;
  inFlight.delivery.turnId = owner.delivery.turnId;
  writeReadyQueue(dir, [owner, inFlight]);
  writeReplyReceipt(dir, inFlight, {
    status: 'in_flight',
    overrides: { updatedAt: new Date().toISOString(), pid: process.pid },
  });
  let posts = 0;
  const automaticSender = createAutomaticReplySender(configAt(dir), {}, {
    async prepareDiscordMessageSend() { return { prepared: true }; },
    async sendDiscordMessage() {
      posts += 1;
      return { channelId: 'channel-1', messageId: 'unexpected-post' };
    },
    async confirmDiscordMessage() {
      throw new Error('live in-flight receipt must not enter confirmation');
    },
    async reconcileDiscordMessage() {
      throw new Error('live in-flight receipt must not be reclaimed');
    },
    isProcessAlive(pid) { return pid === process.pid; },
  });
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: hostForTurn(),
    sendAutomaticReply: automaticSender,
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_reply_unconfirmed');
  assert.equal(posts, 0);
  const records = new Map(readQueue(dir).completed.map((record) => [record.messageId, record]));
  assert.equal(records.get('source-1').outbound.status, 'ready');
  assert.equal(records.get('source-2').outbound.status, 'ready');
});

test('restart revives a suppressed same-turn uncertain receipt for reconciliation before owner POST', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-suppressed-uncertain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  const owner = bindTurnOwner(readyRecord(1));
  owner.outbound.text = 'one answer';
  const uncertain = readyRecord(2);
  uncertain.outbound.text = 'one answer';
  uncertain.delivery.threadId = owner.delivery.threadId;
  uncertain.delivery.turnId = owner.delivery.turnId;
  writeReplyReceipt(dir, uncertain, {
    status: 'uncertain',
    outboundMessageId: 'discord-uncertain-2',
  });
  const receiptFile = receiptPath(config, uncertain.channelId, uncertain.messageId);
  const receiptBefore = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  suppressOutbound(uncertain, owner);
  writeReadyQueue(dir, [owner, uncertain]);
  const host = hostForTurn();
  host.readAssistantFinal = async () => ({
    threadId: owner.delivery.threadId,
    turnId: owner.delivery.turnId,
    itemId: 'final-1',
    text: 'one answer',
  });
  let posts = 0;
  let reconciliations = 0;
  const automaticSender = createAutomaticReplySender(config, {}, {
    async prepareDiscordMessageSend() { return { prepared: true }; },
    async sendDiscordMessage() {
      posts += 1;
      return { channelId: 'channel-1', messageId: 'unexpected-post' };
    },
    async confirmDiscordMessage() {
      throw new Error('confirmation is not the reconciliation path');
    },
    async reconcileDiscordMessage(_client, _args, _prepared, receipt) {
      reconciliations += 1;
      return {
        found: true,
        channelId: receipt.channelId,
        messageId: receipt.outboundMessageId,
      };
    },
  });
  const delivery = createDelivery(config, () => {}, {
    structuredHost: host,
    sendAutomaticReply: automaticSender,
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_ready');
  assert.equal((await delivery.flushOutbound()).reason, 'outbound_confirmed');
  assert.equal(posts, 0);
  assert.equal(reconciliations, 1);
  const records = new Map(readQueue(dir).completed.map((record) => [record.messageId, record]));
  assert.equal(records.get('source-1').outbound.status, 'suppressed');
  assert.equal(records.get('source-2').outbound.status, 'confirmed');
  assert.equal(records.get('source-2').outbound.outboundMessageId, 'discord-uncertain-2');
  const receiptAfter = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  assert.deepEqual({
    channelId: receiptAfter.channelId,
    sourceMessageId: receiptAfter.sourceMessageId,
    contentSha256: receiptAfter.contentSha256,
    nonce: receiptAfter.nonce,
    outboundMessageId: receiptAfter.outboundMessageId,
  }, {
    channelId: receiptBefore.channelId,
    sourceMessageId: receiptBefore.sourceMessageId,
    contentSha256: receiptBefore.contentSha256,
    nonce: receiptBefore.nonce,
    outboundMessageId: receiptBefore.outboundMessageId,
  });
});

test('restart proves a cross-channel suppressed receipt absent before the durable owner alone POSTs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-suppressed-absent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  const owner = bindTurnOwner(readyRecord(1));
  owner.outbound.text = 'one answer';
  const uncertain = readyRecord(2);
  uncertain.channelId = 'channel-2';
  uncertain.source.channelId = 'channel-2';
  uncertain.delivery.clientUserMessageId = 'discord:channel-2:source-2';
  uncertain.outbound.channelId = 'channel-2';
  uncertain.outbound.text = 'one answer';
  uncertain.delivery.threadId = owner.delivery.threadId;
  uncertain.delivery.turnId = owner.delivery.turnId;
  const now = new Date().toISOString();
  writeReplyReceipt(dir, uncertain, {
    status: 'uncertain',
    overrides: { claimedAt: now, updatedAt: now },
  });
  const receiptFile = receiptPath(config, uncertain.channelId, uncertain.messageId);
  suppressOutbound(uncertain, owner);
  writeReadyQueue(dir, [owner, uncertain]);
  const host = hostForTurn();
  host.readAssistantFinal = async () => ({
    threadId: owner.delivery.threadId,
    turnId: owner.delivery.turnId,
    itemId: 'final-1',
    text: 'one answer',
  });
  const posts = [];
  const reconciliations = [];
  const automaticSender = createAutomaticReplySender(config, {}, {
    async prepareDiscordMessageSend(_client, args) { return { args }; },
    async sendDiscordMessage(_client, args) {
      posts.push({ channelId: args.channelId, replyTo: args.replyTo });
      return { channelId: args.channelId, messageId: `posted-${args.replyTo}` };
    },
    async confirmDiscordMessage(_client, _args, _prepared, sent) { return sent; },
    async reconcileDiscordMessage(_client, args) {
      reconciliations.push({ channelId: args.channelId, replyTo: args.replyTo });
      return { found: false };
    },
  });
  const delivery = createDelivery(config, () => {}, {
    structuredHost: host,
    sendAutomaticReply: automaticSender,
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_ready');
  assert.equal((await delivery.flushOutbound()).reason, 'outbound_receipt_released');
  assert.equal((await delivery.flushOutbound()).reason, 'outbound_confirmed');
  assert.deepEqual(reconciliations, [{ channelId: 'channel-2', replyTo: 'source-2' }]);
  assert.deepEqual(posts, [{ channelId: 'channel-1', replyTo: 'source-1' }]);
  assert.equal(fs.existsSync(receiptFile), false);
  const records = new Map(readQueue(dir).completed.map((record) => [record.messageId, record]));
  assert.equal(records.get('source-1').outbound.status, 'confirmed');
  assert.equal(records.get('source-1').outbound.outboundMessageId, 'posted-source-1');
  assert.equal(records.get('source-2').outbound.status, 'suppressed');
  assert.equal(records.get('source-2').outbound.reason, 'turn_reply_receipt_proven_absent');
});

test('restart drains multiple suppressed pending receipts before the durable owner POSTs once', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-multiple-pending-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  const owner = bindTurnOwner(readyRecord(1));
  owner.outbound.text = 'one answer';
  const siblings = [2, 3].map((index) => {
    const record = readyRecord(index);
    record.channelId = `channel-${index}`;
    record.source.channelId = `channel-${index}`;
    record.delivery.clientUserMessageId = `discord:channel-${index}:source-${index}`;
    record.outbound.channelId = `channel-${index}`;
    record.outbound.text = 'one answer';
    record.delivery.threadId = owner.delivery.threadId;
    record.delivery.turnId = owner.delivery.turnId;
    const now = new Date().toISOString();
    writeReplyReceipt(dir, record, {
      status: 'uncertain',
      overrides: { claimedAt: now, updatedAt: now },
    });
    suppressOutbound(record, owner);
    return record;
  });
  writeReadyQueue(dir, [owner, ...siblings]);
  const host = hostForTurn();
  host.readAssistantFinal = async () => ({
    threadId: owner.delivery.threadId,
    turnId: owner.delivery.turnId,
    itemId: 'final-1',
    text: 'one answer',
  });
  const posts = [];
  const reconciliations = [];
  const automaticSender = createAutomaticReplySender(config, {}, {
    async prepareDiscordMessageSend(_client, args) { return { args }; },
    async sendDiscordMessage(_client, args) {
      posts.push({ channelId: args.channelId, replyTo: args.replyTo });
      return { channelId: args.channelId, messageId: `posted-${args.replyTo}` };
    },
    async confirmDiscordMessage(_client, _args, _prepared, sent) { return sent; },
    async reconcileDiscordMessage(_client, args) {
      reconciliations.push({ channelId: args.channelId, replyTo: args.replyTo });
      return { found: false };
    },
  });
  const delivery = createDelivery(config, () => {}, {
    structuredHost: host,
    sendAutomaticReply: automaticSender,
  });
  t.after(() => delivery.destroy());

  const reasons = [];
  for (let index = 0; index < 5; index += 1) {
    reasons.push((await delivery.flushOutbound()).reason);
  }
  assert.deepEqual(reasons, [
    'outbound_ready',
    'outbound_receipt_released',
    'outbound_ready',
    'outbound_receipt_released',
    'outbound_confirmed',
  ]);
  assert.deepEqual(reconciliations, [
    { channelId: 'channel-2', replyTo: 'source-2' },
    { channelId: 'channel-3', replyTo: 'source-3' },
  ]);
  assert.deepEqual(posts, [{ channelId: 'channel-1', replyTo: 'source-1' }]);
  const records = new Map(readQueue(dir).completed.map((record) => [record.messageId, record]));
  assert.equal(records.get('source-1').outbound.status, 'confirmed');
  assert.equal(records.get('source-2').outbound.status, 'suppressed');
  assert.equal(records.get('source-3').outbound.status, 'suppressed');
});

test('restart keeps a suppressed same-turn live in-flight receipt ahead of owner without POST', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-suppressed-in-flight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = configAt(dir);
  const owner = bindTurnOwner(readyRecord(1));
  owner.outbound.text = 'one answer';
  const inFlight = readyRecord(2);
  inFlight.outbound.text = 'one answer';
  inFlight.delivery.threadId = owner.delivery.threadId;
  inFlight.delivery.turnId = owner.delivery.turnId;
  writeReplyReceipt(dir, inFlight, {
    status: 'in_flight',
    overrides: { updatedAt: new Date().toISOString(), pid: process.pid },
  });
  const receiptFile = receiptPath(config, inFlight.channelId, inFlight.messageId);
  const receiptBytesBefore = fs.readFileSync(receiptFile);
  suppressOutbound(inFlight, owner);
  writeReadyQueue(dir, [owner, inFlight]);
  const host = hostForTurn();
  host.readAssistantFinal = async () => ({
    threadId: owner.delivery.threadId,
    turnId: owner.delivery.turnId,
    itemId: 'final-1',
    text: 'one answer',
  });
  let posts = 0;
  const automaticSender = createAutomaticReplySender(config, {}, {
    async prepareDiscordMessageSend() { return { prepared: true }; },
    async sendDiscordMessage() {
      posts += 1;
      return { channelId: 'channel-1', messageId: 'unexpected-post' };
    },
    async confirmDiscordMessage() {
      throw new Error('live in-flight receipt must not enter confirmation');
    },
    async reconcileDiscordMessage() {
      throw new Error('live in-flight receipt must not be reclaimed');
    },
    isProcessAlive(pid) { return pid === process.pid; },
  });
  const delivery = createDelivery(config, () => {}, {
    structuredHost: host,
    sendAutomaticReply: automaticSender,
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_ready');
  assert.equal((await delivery.flushOutbound()).reason, 'outbound_reply_unconfirmed');
  assert.equal(posts, 0);
  const records = new Map(readQueue(dir).completed.map((record) => [record.messageId, record]));
  assert.equal(records.get('source-1').outbound.status, 'ready');
  assert.equal(records.get('source-2').outbound.status, 'ready');
  assert.deepEqual(fs.readFileSync(receiptFile), receiptBytesBefore);
});

test('restart lets the owner POST when a suppressed same-turn sibling has no receipt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-suppressed-no-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = bindTurnOwner(readyRecord(1));
  const noReceipt = readyRecord(2);
  noReceipt.delivery.threadId = owner.delivery.threadId;
  noReceipt.delivery.turnId = owner.delivery.turnId;
  suppressOutbound(noReceipt, owner);
  writeReadyQueue(dir, [owner, noReceipt]);
  const sends = [];
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: hostForTurn(),
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

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_confirmed');
  assert.deepEqual(sends.map((entry) => entry.replyTo), ['source-1']);
  assert.equal(readQueue(dir).completed[0].outbound.status, 'confirmed');
});

test('restart fails the whole turn closed on an unreadable duplicate receipt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-unreadable-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = bindTurnOwner(readyRecord(1));
  const unreadable = readyRecord(2);
  unreadable.delivery.threadId = owner.delivery.threadId;
  unreadable.delivery.turnId = owner.delivery.turnId;
  writeReadyQueue(dir, [owner, unreadable]);
  const file = receiptPath(configAt(dir), unreadable.channelId, unreadable.messageId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not-json\n');
  let posts = 0;
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: hostForTurn(),
    async sendAutomaticReply() { posts += 1; },
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_empty');
  assert.equal(posts, 0);
  assert.deepEqual(readQueue(dir).completed.map((record) => ({
    status: record.outbound.status,
    reason: record.outbound.reason,
  })), [
    { status: 'blocked', reason: 'turn_reply_receipt_indeterminate' },
    { status: 'blocked', reason: 'turn_reply_receipt_indeterminate' },
  ]);
});

test('restart fails the whole turn closed on a wrong-identity duplicate receipt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-wrong-receipt-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owner = bindTurnOwner(readyRecord(1));
  const wrongIdentity = readyRecord(2);
  wrongIdentity.delivery.threadId = owner.delivery.threadId;
  wrongIdentity.delivery.turnId = owner.delivery.turnId;
  writeReadyQueue(dir, [owner, wrongIdentity]);
  writeReplyReceipt(dir, wrongIdentity, {
    status: 'uncertain',
    overrides: { channelId: 'wrong-channel' },
  });
  let posts = 0;
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: hostForTurn(),
    async sendAutomaticReply() { posts += 1; },
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_empty');
  assert.equal(posts, 0);
  assert.deepEqual(readQueue(dir).completed.map((record) => ({
    status: record.outbound.status,
    reason: record.outbound.reason,
  })), [
    { status: 'blocked', reason: 'turn_reply_receipt_indeterminate' },
    { status: 'blocked', reason: 'turn_reply_receipt_indeterminate' },
  ]);
});

test('restart without durable turn owner fails closed instead of choosing completed order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-owner-unproven-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const firstCompleted = readyRecord(1);
  const secondCompleted = readyRecord(2);
  secondCompleted.delivery.threadId = firstCompleted.delivery.threadId;
  secondCompleted.delivery.turnId = firstCompleted.delivery.turnId;
  writeReadyQueue(dir, [firstCompleted, secondCompleted]);
  let sends = 0;
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: hostForTurn(),
    async sendAutomaticReply() { sends += 1; },
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.flushOutbound()).reason, 'outbound_empty');
  assert.equal(sends, 0);
  assert.deepEqual(
    readQueue(dir).completed.map((record) => ({
      status: record.outbound.status,
      reason: record.outbound.reason,
    })),
    [
      { status: 'blocked', reason: 'turn_reply_owner_unproven' },
      { status: 'blocked', reason: 'turn_reply_owner_unproven' },
    ],
  );
});

test('separate top-level turns retain one automatic reply for each source', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-auto-final-separate-turns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let turn = 0;
  const host = hostForTurn();
  host.startTurn = async () => ({ turn: { id: `turn-${++turn}` } });
  host.readAssistantFinal = async (_threadId, turnId) => ({
    threadId: 'thread-A', turnId, itemId: `final-${turnId}`, text: `answer-${turnId}`,
  });
  const sends = [];
  const delivery = createDelivery(configAt(dir), () => {}, {
    structuredHost: host,
    async sendAutomaticReply(args) {
      sends.push(args);
      return {
        channelId: args.channelId,
        messageId: `outbound-${sends.length}`,
        sourceMessageId: args.replyTo,
        duplicateSuppressed: false,
      };
    },
  });
  t.after(() => delivery.destroy());

  assert.equal((await delivery.deliver(source('source-1'))).status, 'delivered');
  assert.equal((await delivery.deliver(source('source-2'))).status, 'delivered');
  for (let index = 0; index < 8; index += 1) await delivery.flushOutbound();

  assert.deepEqual(sends.map((entry) => entry.replyTo), ['source-1', 'source-2']);
  assert.deepEqual(
    readQueue(dir).completed.map((entry) => entry.outbound.status),
    ['confirmed', 'confirmed'],
  );
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
