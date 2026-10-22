'use strict';

// These are current state-directory contracts, independent of the retired
// lease and automatic-final suites. Full-history RPCs are a causal failure.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAppServerHost } = require('../../src/app-server-host');
const { createDelivery } = require('../../src/delivery');

const THREAD = '019f3763-d308-7871-bedc-e6489b02190e';
const TURN = '019f3763-d308-7871-bedc-e6489b021910';
const CLIENT = 'discord:channel:source';
class Client extends EventEmitter {
  constructor(handler) { super(); this.handler = handler; this.requests = []; }
  request(method, params) { this.requests.push({ method, params }); return this.handler(method, params); }
  status() { return { configured: true, available: true, reason: null }; }
}
const user = (clientId = CLIENT) => ({ turnId: TURN, item: { type: 'userMessage', clientId } });

// A live turn page must omit all item bodies; its ordering is authoritative.
test('active discovery rejects missing malformed oversized or unavailable bounded turn pages', async (t) => {
  for (const [name, page] of [
    ['missing', {}], ['malformed', { data: 'not-an-array' }],
    ['oversized', { data: Array.from({ length: 9 }, () => ({ id: TURN, status: 'inProgress' })) }],
    ['no active turn', { data: [{ id: TURN, status: 'completed' }], nextCursor: 'older' }],
    ['unavailable', new Error('native turn page unavailable')],
  ]) await t.test(name, async (subtest) => {
    const client = new Client(async (method, params) => {
      if (method === 'thread/loaded/list') return { data: [THREAD] };
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false);
        return { thread: { id: THREAD, parentThreadId: null, threadSource: 'user', status: { type: 'active' } } };
      }
      assert.equal(method, 'thread/turns/list');
      assert.deepEqual(params, { threadId: THREAD, limit: 8, sortDirection: 'desc', itemsView: 'notLoaded' });
      if (page instanceof Error) throw page;
      return page;
    });
    const host = createAppServerHost({}, () => {}, { client });
    subtest.after(() => host.destroy());
    assert.equal((await host.resolveTarget()).available, false);
    assert.equal(client.requests.length, 3, 'Never falls back to full history or follows a cursor');
  });
});

test('three sequential sources pass a busy long-history FIFO with bounded native proof', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-bounded-sequence-'));
  const submitted = [];
  const client = new Client(async (method, params) => {
    if (method === 'thread/loaded/list') return { data: [THREAD] };
    if (method === 'thread/read') {
      if (params.includeTurns !== false) throw new Error('Max payload size exceeded');
      return { thread: { id: THREAD, threadSource: 'user', parentThreadId: null, status: { type: 'active' } } };
    }
    if (method === 'thread/turns/list') {
      assert.equal(params.itemsView, 'notLoaded');
      assert.equal(params.limit, 8);
      return { data: [{ id: TURN, status: 'inProgress', items: [] }], nextCursor: 'older-large-turns' };
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, TURN);
      submitted.push(params.clientUserMessageId);
      return { turnId: TURN };
    }
    assert.equal(method, 'thread/items/list');
    assert.deepEqual(params, { threadId: THREAD, limit: 32, sortDirection: 'desc' });
    return { data: submitted.map(user), nextCursor: 'older-large-items' };
  });
  const host = createAppServerHost({}, () => {}, { client, verifyRolloutDelivery: async () => false });
  const delivery = createDelivery({ deliveryMode: 'app-server', paths: {
    instance: 'bounded-fixture', stateDir: dir,
    deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    lastInboundPath: path.join(dir, 'last-inbound.json'),
  } }, () => {}, { structuredHost: host });
  t.after(() => { delivery.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 1; i <= 3; i += 1) {
    const source = { source: 'dm', channelId: 'channel', messageId: `source-${i}`, authorId: 'owner', content: 'bounded test', attachments: [] };
    assert.equal((await delivery.deliver(source)).status, 'delivered');
  }
  assert.deepEqual(submitted, [1, 2, 3].map((i) => `discord:channel:source-${i}`));
  const queue = JSON.parse(fs.readFileSync(path.join(dir, 'pending-delivery.json'), 'utf8'));
  assert.equal(queue.items.length, 0);
  assert.equal(queue.completed.length, 3);
  assert.equal(client.requests.filter((x) => x.method === 'thread/items/list').length, 3);
});

test('legacy exact-source proof is bounded and ignores large tool-output decoys and incomplete records', async (t) => {
  for (const [name, data, expected] of [
    ['exact UserMessage', [user()], true],
    ['large tool decoy', [{ turnId: TURN, item: { type: 'commandExecution', clientId: CLIENT, aggregatedOutput: 'x'.repeat(2 * 1024 * 1024) } }], false],
    ['missing turn identity', [{ item: user().item }], false],
    ['oversized page', Array.from({ length: 33 }, () => user()), false],
    ['wrong source', [user('discord:channel:other')], false],
  ]) await t.test(name, async (subtest) => {
    const client = new Client(async (method, params) => {
      assert.equal(method, 'thread/items/list');
      assert.deepEqual(params, { threadId: THREAD, limit: 32, sortDirection: 'desc' });
      return { data, nextCursor: 'older' };
    });
    const host = createAppServerHost({}, () => {}, { client, verifyRolloutDelivery: async () => false });
    subtest.after(() => host.destroy());
    assert.equal(await host.hasDelivered(THREAD, CLIENT), expected);
    assert.equal(client.requests.length, 1);
  });
});

test('exact final readback uses bounded turn-filtered items and rejects incomplete or conflicting pages', async (t) => {
  const final = { turnId: TURN, item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text: 'done' } };
  for (const [name, items, nextCursor, expected] of [
    ['complete', [final], null, { threadId: THREAD, turnId: TURN, itemId: 'f1', text: 'done' }],
    ['incomplete', [final], 'older', null],
    ['wrong turn', [{ ...final, turnId: 'other' }], null, null],
    ['duplicate finals', [final, { ...final, item: { ...final.item, id: 'f2' } }], null, null],
    ['oversized', Array.from({ length: 33 }, () => final), null, null],
  ]) await t.test(name, async (subtest) => {
    const client = new Client(async (method, params) => {
      if (method === 'thread/turns/list') {
        assert.deepEqual(params, { threadId: THREAD, limit: 8, sortDirection: 'desc', itemsView: 'notLoaded' });
        return { data: [{ id: TURN, status: 'completed', items: [] }] };
      }
      assert.equal(method, 'thread/items/list');
      assert.deepEqual(params, { threadId: THREAD, turnId: TURN, limit: 32, sortDirection: 'desc' });
      return { data: items, nextCursor };
    });
    const host = createAppServerHost({}, () => {}, { client });
    subtest.after(() => host.destroy());
    assert.deepEqual(await host.readAssistantFinal(THREAD, TURN), expected);
  });
});
