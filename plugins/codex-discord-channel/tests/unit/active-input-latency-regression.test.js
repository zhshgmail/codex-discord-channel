'use strict';

// Offline reproduction: real delivery queue and host; only the app-server RPC
// boundary is replaced. No Discord account, paid model, or live alias is used.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createAppServerHost } = require('../../src/app-server-host');
const { createDelivery } = require('../../src/delivery');

const ROOT = path.resolve(__dirname, '../..');
const THREAD = '019f3763-d308-7871-bedc-e6489b02190e';
const TURN = '019f3763-d308-7871-bedc-e6489b021910';
const CLIENT = 'discord:fixture-channel:fixture-source';

function fixture(t, { nativeProof = false, proofEntries = null, rotateOnProof = false, proofThrows = false } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'fixture-'));
  const sessions = path.join(dir, 'sessions/2026/09/10');
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, `rollout-2026-09-10T00-00-00-${THREAD}.jsonl`);
  fs.writeFileSync(rollout, JSON.stringify({
    type: 'session_meta', payload: { id: THREAD, thread_source: 'user' },
  }) + '\n');
  let now = Date.parse('2026-09-10T00:00:00Z');
  let status = 'active';
  let accepted = false;
  const submissions = [];
  const requests = [];
  const logs = [];
  const client = new EventEmitter();
  client.status = () => ({ configured: true, available: true, reason: null });
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === 'thread/loaded/list') return { data: [THREAD], nextCursor: null };
    if (method === 'thread/read') {
      assert.equal(params.includeTurns, false, 'No full-history hydration is allowed');
      return { thread: {
        id: THREAD, parentThreadId: null, threadSource: 'user',
        status: { type: status, activeFlags: [] }, turns: [],
      } };
    }
    if (method === 'thread/turns/list') {
      assert.deepEqual(params, { threadId: THREAD, limit: 8, sortDirection: 'desc', itemsView: 'notLoaded' });
      return { data: [{ id: TURN, status: status === 'active' ? 'inProgress' : 'completed', items: [] }], nextCursor: null };
    }
    if (method === 'thread/items/list') {
      assert.deepEqual(params, { threadId: THREAD, limit: 32, sortDirection: 'desc' });
      if (proofThrows) throw new Error('Synthetic native proof service unavailable');
      if (rotateOnProof) client.emit('notification', {
        method: 'thread/started', params: { thread: {
          id: '019f3763-d308-7871-bedc-e6489b02190f', parentThreadId: null,
          threadSource: 'user', status: { type: 'active' },
        } },
      });
      return { data: proofEntries || (nativeProof && accepted ? [{ turnId: TURN, item: { type: 'userMessage', clientId: CLIENT } }] : []), nextCursor: null };
    }
    if (method === 'turn/start' || method === 'turn/steer') {
      submissions.push({ method, clientId: params.clientUserMessageId, expectedTurnId: params.expectedTurnId });
      accepted = true;
      if (status === 'idle') fs.appendFileSync(rollout, JSON.stringify({
        type: 'event_msg', payload: {
          type: 'item_completed', thread_id: THREAD, turn_id: TURN,
          item: { type: 'UserMessage', client_id: params.clientUserMessageId },
        },
      }) + '\n');
      return method === 'turn/steer' ? { turnId: TURN } : { turn: { id: TURN } };
    }
    throw new Error(`Unexpected RPC method ${method}`);
  };
  const host = createAppServerHost({
    appServerUrl: `unix://${dir}/unused.sock`, env: { CODEX_HOME: dir },
  }, (level, message, fields) => logs.push({ level, message, fields }), { client });
  const config = {
    deliveryMode: 'app-server', deliveryProofRetryDelayMs: 2000,
    paths: {
      stateDir: dir, instance: 'offline-fixture',
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
      lastInboundPath: path.join(dir, 'last-inbound.json'),
    },
  };
  const delivery = createDelivery(config, () => {}, {
    structuredHost: host, now: () => now,
    // Drive retry time explicitly, without a real waiting process.
    setTimeout: () => ({ unref() {} }), clearTimeout: () => {},
  });
  t.after(() => { delivery.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    delivery, host, submissions, requests, logs,
    advance(ms) { now += ms; },
    idle() { status = 'idle'; },
    queue() { return JSON.parse(fs.readFileSync(config.paths.deliveryQueuePath, 'utf8')); },
    source: {
      source: 'dm', channelId: 'fixture-channel', messageId: 'fixture-source',
      authorId: 'fixture-owner', authorName: 'fixture-owner', authorIsBot: false,
      guildId: null, content: 'Offline synthetic user instruction', attachments: [],
    },
  };
}

test('characterization: positive ACK with absent proof waits through ten active minutes and recovers at idle', async (t) => {
  const f = fixture(t);
  const first = await f.delivery.deliver(f.source);
  assert.equal(first.reason, 'delivery_proof_pending');
  f.advance(10 * 60 * 1000);
  for (let i = 0; i < 3; i += 1) assert.equal((await f.delivery.flush()).reason, 'delivery_proof_pending');
  assert.deepEqual(f.submissions, [{ method: 'turn/steer', clientId: CLIENT, expectedTurnId: TURN }]);
  assert.equal(f.queue().items.length, 1);
  f.idle();
  assert.equal((await f.delivery.flush()).status, 'delivered');
  assert.deepEqual(f.submissions.map((x) => x.method), ['turn/steer', 'turn/start']);
  assert.equal(f.queue().items.length, 0);
});

test('regression: current native UserMessage proof must release FIFO without waiting for rollout flush or idle', async (t) => {
  // Break caught: the source proof path ignores exact native UserMessage
  // evidence while a rollout flush is delayed, keeping the active FIFO stuck.
  const f = fixture(t, { nativeProof: true });
  await f.delivery.deliver(f.source);
  const result = await f.delivery.flush();
  assert.equal(f.queue().items.length, 0,
    `A proven native UserMessage remains blocked: ${result.reason}`);
  assert.equal(f.queue().completed[0].clientUserMessageId, CLIENT);
  assert.equal(f.submissions.length, 1, 'Native proof reconciliation must not replay the user source');
});

test('native source proof rejects decoys, oversized pages, route changes, and unavailable reads', async (t) => {
  const exact = { turnId: TURN, item: { type: 'userMessage', clientId: CLIENT } };
  const cases = [
    ['different source', { proofEntries: [{ turnId: TURN, item: { type: 'userMessage', clientId: 'discord:other:source' } }] }],
    ['non-user item', { proofEntries: [{ turnId: TURN, item: { type: 'agentMessage', clientId: CLIENT } }] }],
    ['oversized page', { proofEntries: Array.from({ length: 33 }, () => exact) }],
    ['changed selected root', { nativeProof: true, rotateOnProof: true }],
    ['unavailable native read', { proofThrows: true }],
  ];
  for (const [name, options] of cases) await t.test(name, async (subtest) => {
    const f = fixture(subtest, options);
    assert.equal((await f.delivery.deliver(f.source)).reason, 'delivery_proof_pending');
    assert.equal(f.queue().items.length, 1);
    assert.deepEqual(f.queue().completed, []);
    assert.equal(f.submissions.length, 1);
  });
});

test('submission diagnostics distinguish steer from start without recording input text', async (t) => {
  const f = fixture(t);
  await f.delivery.deliver(f.source);
  f.advance(3000);
  f.idle();
  await f.delivery.flush();
  const accepted = f.logs.filter((entry) => Object.hasOwn(entry.fields, 'acceptedTurnId'));
  assert.deepEqual(accepted.map((entry) => entry.fields), [
    { clientUserMessageId: CLIENT, method: 'turn/steer', targetStatus: 'active', threadId: THREAD, expectedTurnId: TURN, acceptedTurnId: TURN },
    { clientUserMessageId: CLIENT, method: 'turn/start', targetStatus: 'idle', threadId: THREAD, expectedTurnId: null, acceptedTurnId: TURN },
  ]);
  assert.equal(JSON.stringify(f.logs).includes(f.source.content), false);
});
