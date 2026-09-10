'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { permissionRequest, connectRelay } = require('../../src/remote-permissions');
const permissions = { approvalPolicy: 'never', sandbox: 'danger-full-access' };

async function attemptFixture(t) {
  const backend = http.createServer(); const backWs = new WebSocket.Server({ server: backend });
  const frontend = http.createServer(); const frontWs = new WebSocket.Server({ server: frontend });
  const clients = [];
  t.after(() => {
    for (const socket of [...clients, ...backWs.clients, ...frontWs.clients]) socket.terminate();
    backWs.close(); frontWs.close(); backend.close(); frontend.close();
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  frontend.listen(0, '127.0.0.1'); await once(frontend, 'listening');
  const state = { applied: false };
  frontWs.on('connection', front => connectRelay(front, `ws://127.0.0.1:${backend.address().port}`, permissions, state));
  const arrivals = new EventEmitter();
  backWs.on('connection', back => back.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.method === 'initialize') back.send(JSON.stringify({ id: message.id, result: {} }));
    else arrivals.emit('request', { message, back, raw });
  }));
  async function client() {
    const socket = new WebSocket(`ws://127.0.0.1:${frontend.address().port}`); clients.push(socket);
    await once(socket, 'open');
    const ready = once(socket, 'message');
    socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui' } } }));
    await ready;
    const received = []; const barriers = new EventEmitter();
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.method === 'fixture/barrier') barriers.emit('barrier');
      else received.push({ message, raw });
    });
    return { socket, received, barriers };
  }
  async function send(client, message) {
    const arrived = once(arrivals, 'request');
    client.socket.send(JSON.stringify(message));
    return (await arrived)[0];
  }
  async function deliver(client, back, message) {
    const barrier = once(client.barriers, 'barrier');
    back.send(JSON.stringify(message));
    // WebSocket ordering proves the prior response was processed, including
    // when it must be suppressed; no sleep or timeout is used as absence proof.
    back.send(JSON.stringify({ method: 'fixture/barrier' }));
    await barrier;
  }
  return { client, send, deliver, state };
}

for (const concurrent of [false, true]) {
  for (const id of [2, '2', null]) {
    test(`real WebSocket ${concurrent ? 'cross-connection' : 'same-connection'} retry isolates retired replies for ${JSON.stringify(id)}`, { timeout: 5000 }, async t => {
      const fixture = await attemptFixture(t);
      const a = await fixture.client(); const b = concurrent ? await fixture.client() : a;
      const request = method => ({ id, method, params: { sandbox: 'read-only' } });
      const original = await fixture.send(a, request('thread/resume'));
      const error = { code: -32600, message: 'definitive rejection' };
      await fixture.deliver(a, original.back, { id: original.message.id, error });
      assert.deepEqual(a.received.map(entry => entry.message), [{ id, error }], 'restore the original client ID on an explicit error');

      const retry = await fixture.send(b, request('thread/fork'));
      assert.equal(retry.message.params.approvalPolicy, 'never', 'an explicit error permits a retry with the same client ID');
      const before = a.received.length;
      await fixture.deliver(a, original.back, { id: original.message.id, error });
      const concurrentRequest = { id: 3, method: 'thread/start', params: { sandbox: 'read-only' } };
      const third = await fixture.send(b, concurrentRequest);
      assert.deepEqual(third.message, concurrentRequest, 'a retired error must not release the retry reservation');
      await fixture.deliver(a, original.back, { id: original.message.id, result: { obsolete: true } });
      assert.equal(a.received.length, before, 'retired errors and results must not be sent to a reused client ID');
      assert.notEqual(original.message.id, retry.message.id, 'each reservation has a different backend wire ID');
      assert.notEqual(retry.message.id, id, 'the backend must correlate the wire attempt, not the reusable client ID');

      await fixture.deliver(b, retry.back, { id: retry.message.id, error });
      assert.deepEqual(b.received.at(-1).message, { id, error });
      const finalAttempt = await fixture.send(b, request('thread/resume'));
      assert.equal(finalAttempt.message.params.approvalPolicy, 'never', 'a retired result must not consume a later explicit-error retry');
      assert.notEqual(finalAttempt.message.id, retry.message.id);
      await fixture.deliver(b, finalAttempt.back, { id: finalAttempt.message.id, result: { selected: true } });
      assert.deepEqual(b.received.at(-1).message, { id, result: { selected: true } }, 'restore the original client ID on success');
      assert.equal(fixture.state.applied, true);
      const later = await fixture.send(b, request('thread/fork'));
      assert.deepEqual(later.message, request('thread/fork'), 'success consumes the invocation override');
    });
  }
}

test('real WebSocket keeps server requests, notifications and client replies transparent during an attempt', { timeout: 5000 }, async t => {
  const fixture = await attemptFixture(t); const client = await fixture.client();
  const id = 'codex-permission:client-selected:1';
  const pending = await fixture.send(client, { id, method: 'thread/resume', params: {} });
  for (const message of [
    { id: pending.message.id, method: 'server/request', params: { question: true } },
    { id, method: 'server/request', params: { question: true } },
    { id: pending.message.id, method: 'server/notification', error: { code: -1, message: 'not a reply' } },
    { method: 'thread/started', params: { observed: true } },
  ]) {
    await fixture.deliver(client, pending.back, message);
    assert.deepEqual(client.received.at(-1).raw, Buffer.from(JSON.stringify(message)));
  }
  for (const replyId of [id, pending.message.id]) {
    const reply = { id: replyId, result: { accepted: true } };
    const received = await fixture.send(client, reply);
    assert.deepEqual(received.raw, Buffer.from(JSON.stringify(reply)));
  }
  const concurrent = { id: 3, method: 'thread/fork', params: {} };
  assert.deepEqual((await fixture.send(client, concurrent)).message, concurrent, 'server traffic cannot release the reservation');
  await fixture.deliver(client, pending.back, { id: pending.message.id, result: {} });
  assert.deepEqual(client.received.at(-1).message, { id, result: {} });
  const before = client.received.length;
  await fixture.deliver(client, pending.back, { id: pending.message.id, error: { code: -1, message: 'late after success' } });
  await fixture.deliver(client, pending.back, { id: pending.message.id, result: {} });
  assert.equal(client.received.length, before, 'success also retires the wire ID');
});

for (const settled of [false, true]) {
  test(`real WebSocket closes a client request colliding with a ${settled ? 'retired' : 'pending'} private wire ID`, { timeout: 5000 }, async t => {
    const fixture = await attemptFixture(t); const client = await fixture.client();
    const pending = await fixture.send(client, { id: 2, method: 'thread/resume', params: {} });
    if (settled) await fixture.deliver(client, pending.back, { id: pending.message.id, error: { code: -1, message: 'rejected' } });
    const frontClosed = once(client.socket, 'close'); const backClosed = once(pending.back, 'close');
    const forwarded = [];
    pending.back.on('message', raw => forwarded.push(raw));
    client.socket.send(JSON.stringify({ id: pending.message.id, method: 'thread/fork', params: {} }));
    await Promise.all([frontClosed, backClosed]);
    assert.deepEqual(forwarded, [], 'the ambiguous request is never forwarded');
    const next = await fixture.client();
    const request = { id: 2, method: 'thread/start', params: { sandbox: 'read-only' } };
    const retry = await fixture.send(next, request);
    if (settled) {
      assert.equal(retry.message.params.approvalPolicy, 'never', 'a prior definitive error still permits an ordinary retry');
      assert.notEqual(retry.message.id, pending.message.id);
    } else {
      assert.deepEqual(retry.message, request, 'an ambiguous pending disconnect consumes the override');
    }
  });
}

test('permission forwarding patches the actual native selection without changing its identity or filters', () => {
  for (const method of ['thread/start', 'thread/resume', 'thread/fork']) {
    const request = { id: 'request-7', method, params: { threadId: 'native-selected', cwd: '/work', config: { model: 'chosen' }, approvalPolicy: 'on-request' } };
    const output = JSON.parse(permissionRequest(Buffer.from(JSON.stringify(request)), true, permissions));
    assert.deepEqual(output, { ...request, params: { ...request.params, ...permissions } });
  }
});

test('permission forwarding preserves non-TUI traffic and unrelated requests byte for byte', () => {
  for (const message of [
    '{ "id": 1, "method": "thread/resume", "params": {"threadId":"gateway"} }',
    '{ "id": 2, "method": "turn/start", "params": {"input":[]} }',
    '{ "id": 3, "method": "account/rateLimits/read" }',
    'null',
    '[]',
    '{"method":"thread/start","params":{}}',
    '{"id":4,"method":"thread/start","params":null}',
    '{"id":5,"method":"thread/start","params":[]}',
    'non-json payload',
  ]) {
    const data = Buffer.from(message);
    assert.equal(permissionRequest(data, false, permissions), data);
    if (!message.includes('thread/resume')) assert.equal(permissionRequest(data, true, permissions), data);
  }
});

for (const clientName of ['codex-tui', 'codex_cli_rs', 'codex-discord-channel', 'another-client']) {
  test(`relay keeps replies, notifications, and per-client permission scope: ${clientName}`, { timeout: 5000 }, async t => {
    const backend = http.createServer();
    const backWs = new WebSocket.Server({ server: backend });
    backend.listen(0, '127.0.0.1');
    await once(backend, 'listening');
    const frontend = http.createServer();
    const frontWs = new WebSocket.Server({ server: frontend });
    frontend.listen(0, '127.0.0.1');
    await once(frontend, 'listening');
    const clients = new Set();
    t.after(async () => {
      for (const client of clients) client.terminate();
      for (const client of backWs.clients) client.terminate();
      for (const client of frontWs.clients) client.terminate();
      backWs.close(); frontWs.close(); backend.close(); frontend.close();
    });
    const startupState = { applied: false };
    frontWs.on('connection', front => connectRelay(front, `ws://127.0.0.1:${backend.address().port}`, permissions, startupState));
    backWs.on('connection', back => back.on('message', raw => {
      const request = JSON.parse(raw);
      if (request.params?.threadId === 'rejected') {
        back.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'fixture rejection' } }));
        return;
      }
      back.send(JSON.stringify({ id: request.id, result: request.params }));
    }));
    const client = new WebSocket(`ws://127.0.0.1:${frontend.address().port}`);
    clients.add(client);
    await once(client, 'open');
    async function roundTrip(request) {
      const response = once(client, 'message');
      client.send(JSON.stringify(request));
      return JSON.parse((await response)[0]);
    }
    await roundTrip({ id: 1, method: 'initialize', params: { clientInfo: { name: clientName } } });
    assert.deepEqual(await roundTrip({ id: 0, method: 'thread/resume', params: { threadId: 'rejected' } }),
      { id: 0, error: { code: -32600, message: 'fixture rejection' } });
    for (let id = 2; id <= 4; id += 1) {
      const result = await roundTrip({ id, method: 'thread/resume', params: { threadId: `native-choice-${id}` } });
      const isTui = ['codex-tui', 'codex_cli_rs'].includes(clientName);
      assert.deepEqual(result, { id, result: { threadId: `native-choice-${id}`, ...(isTui && id === 2 ? permissions : {}) } });
    }
    const updated = { threadId: 'same-connection', approvalPolicy: 'on-request', sandbox: 'read-only' };
    assert.deepEqual(await roundTrip({ id: 5, method: 'thread/resume', params: updated }), { id: 5, result: updated });
    const notification = Buffer.from('{ "method": "item/completed", "params": {"text":"unchanged"} }');
    const received = once(client, 'message');
    [...backWs.clients][0].send(notification);
    assert.deepEqual((await received)[0], notification);
    const reconnected = new WebSocket(`ws://127.0.0.1:${frontend.address().port}`);
    clients.add(reconnected);
    await once(reconnected, 'open');
    let response = once(reconnected, 'message');
    reconnected.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: clientName } } }));
    await response;
    response = once(reconnected, 'message');
    const narrower = { threadId: 'after-reconnect', approvalPolicy: 'on-request', sandbox: 'read-only' };
    reconnected.send(JSON.stringify({ id: 2, method: 'thread/resume', params: narrower }));
    assert.deepEqual(JSON.parse((await response)[0]), { id: 2, result: narrower });
  });
}
