'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const WebSocket = require('ws');
const { connectRelay } = require('../../src/remote-permissions');

const permissions = { approvalPolicy: 'never', sandbox: 'danger-full-access' };
const LIMIT = 16 * 1024 * 1024;
const request = (id, method = 'thread/resume') => ({ id, method, params: { threadId: `native-${id}`, sandbox: 'read-only' } });

// Deterministic socket pressure and late-event injection. Production handlers
// are loaded unchanged; no real account, native process or Discord connection.
function controlledRelay() {
  class Socket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];
    constructor() {
      super();
      this.readyState = Socket.CONNECTING;
      this.bufferedAmount = 0;
      this.sent = [];
      this.terminations = 0;
      Socket.instances.push(this);
    }
    send(data, options, callback) {
      assert.equal(this.readyState, Socket.OPEN);
      this.sent.push({ data, options });
      if (this.holdWrites) this.bufferedAmount += Buffer.byteLength(data);
      if (this.afterSend) this.afterSend();
      callback?.();
    }
    terminate() {
      if (this.readyState === Socket.CLOSED) return;
      this.terminations += 1;
      this.readyState = Socket.CLOSED;
      this.emit('close');
    }
    open() { this.readyState = Socket.OPEN; this.emit('open'); }
    receive(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  }
  const file = path.resolve(__dirname, '../../src/remote-permissions.js');
  const sandbox = { module: { exports: {} }, Buffer, process,
    require: id => id === 'ws' ? Socket : require(id) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const state = { applied: false };
  const pairs = [];
  function pair({ open = true } = {}) {
    const front = new Socket();
    front.open();
    sandbox.module.exports.connectRelay(front, 'ws://fixture.invalid', permissions, state);
    const back = Socket.instances.at(-1);
    if (open) back.open();
    front.receive({ id: 'initialize', method: 'initialize', params: { clientInfo: { name: 'codex-tui' } } });
    const result = { front, back };
    pairs.push(result);
    return result;
  }
  return { pair, pairs, state, Socket };
}

const last = socket => JSON.parse(socket.sent.at(-1).data.toString());
const patched = socket => assert.equal(last(socket).params.approvalPolicy, 'never');
const unchanged = (socket, sent) => assert.deepEqual(last(socket), sent);

test('one pending permission request across pipelined and concurrent connections', () => {
  const relay = controlledRelay();
  const a = relay.pair(); const b = relay.pair();
  a.front.receive(request(2));
  patched(a.back);
  const wireId = last(a.back).id;
  const fork = request(3, 'thread/fork');
  a.front.receive(fork);
  unchanged(a.back, fork);
  const start = request(4, 'thread/start');
  b.front.receive(start);
  unchanged(b.back, start);
  a.back.receive({ id: wireId, result: { thread: { id: 'selected' } } });
  assert.deepEqual(last(a.front), { id: 2, result: { thread: { id: 'selected' } } });
  b.front.receive(request(5));
  unchanged(b.back, request(5));
  assert.equal(relay.state.applied, true);
  assert.ok(!JSON.stringify(relay.state).includes('selected'));
});

test('only a matching connection error releases the pending permission request', () => {
  const relay = controlledRelay();
  const a = relay.pair(); const b = relay.pair();
  a.front.receive(request(2));
  const originalWireId = last(a.back).id;
  b.front.receive(request(2, 'thread/fork'));
  unchanged(b.back, request(2, 'thread/fork'));
  b.back.receive({ id: 2, error: { code: -32600, message: 'other connection' } });
  b.front.receive(request(3));
  unchanged(b.back, request(3));
  b.back.receive({ id: 2, result: {} });
  a.back.receive({ id: originalWireId, error: { code: -32600, message: 'definitive rejection' } });
  assert.deepEqual(last(a.front), { id: 2, error: { code: -32600, message: 'definitive rejection' } });
  b.front.receive(request(4));
  patched(b.back);
  const nextWireId = last(b.back).id;
  // A duplicate late response from the prior owner cannot settle B's claim.
  a.back.receive({ id: originalWireId, result: {} });
  a.back.receive({ id: originalWireId, error: { code: -32600, message: 'late' } });
  a.front.receive(request(5));
  unchanged(a.back, request(5));
  b.back.receive({ id: nextWireId, result: {} });
  assert.deepEqual(last(b.front), { id: 4, result: {} });
  a.front.receive(request(6));
  unchanged(a.back, request(6));
});

for (const side of ['front', 'back']) {
  test(`ambiguous ${side} disconnect consumes eligibility despite late responses`, () => {
    const relay = controlledRelay();
    const a = relay.pair();
    a.front.receive(request(2));
    patched(a.back);
    const wireId = last(a.back).id;
    a[side].terminate();
    const b = relay.pair();
    // These events may already be queued when a transport closes.
    a.back.receive({ id: wireId, error: { code: -32600, message: 'late' } });
    a.back.receive({ id: wireId, result: {} });
    b.front.receive(request(2));
    unchanged(b.back, request(2));
    assert.equal(relay.state.applied, true);
  });
}

test('a disconnect after definitive rejection leaves the next request eligible', () => {
  const relay = controlledRelay(); const a = relay.pair();
  a.front.receive(request(2));
  a.back.receive({ id: last(a.back).id, error: { code: -32600, message: 'rejected' } });
  assert.deepEqual(last(a.front), { id: 2, error: { code: -32600, message: 'rejected' } });
  a.front.terminate();
  const b = relay.pair(); b.front.receive(request(3)); patched(b.back);
});

test('malformed or notification-shaped replies cannot release a reservation', () => {
  const relay = controlledRelay(); const a = relay.pair();
  a.front.receive(request(2));
  const wireId = last(a.back).id;
  for (const response of [{ id: wireId, error: null }, { id: wireId, error: 'uncertain' },
    { id: wireId, result: {}, error: { code: -1, message: 'contradictory' } },
    { id: wireId, method: 'notification', error: { code: -1, message: 'not a response' } },
    { id: 2, error: { code: -1, message: 'client id is not the backend attempt id' } }]) {
    a.back.receive(response);
    a.front.receive(request(3)); unchanged(a.back, request(3));
  }
  a.back.receive({ id: wireId, error: { code: -1, message: 'definitive' } });
  assert.deepEqual(last(a.front), { id: 2, error: { code: -1, message: 'definitive' } });
  a.front.receive(request(4)); patched(a.back);
});

test('a duplicate pending RPC id on one connection is ambiguous and cannot regrant permission', () => {
  const relay = controlledRelay(); const a = relay.pair();
  a.front.receive(request(2));
  const wireId = last(a.back).id;
  a.front.receive(request(2, 'thread/fork'));
  assert.equal(a.front.readyState, relay.Socket.CLOSED);
  assert.equal(a.back.readyState, relay.Socket.CLOSED);
  a.back.receive({ id: wireId, error: { code: -1, message: 'uncertain duplicate' } });
  const b = relay.pair(); b.front.receive(request(3)); unchanged(b.back, request(3));
});

for (const direction of ['to-backend', 'to-frontend']) {
  test(`OPEN ${direction} bounds pending bytes plus the next frame and closes only that pair`, () => {
    const relay = controlledRelay(); const a = relay.pair(); const b = relay.pair();
    const source = direction === 'to-backend' ? a.front : a.back;
    const destination = direction === 'to-backend' ? a.back : a.front;
    destination.bufferedAmount = LIMIT - 8;
    const before = destination.sent.length;
    source.emit('message', Buffer.alloc(16), true);
    assert.equal(destination.sent.length, before, 'overflow frame must not be queued');
    assert.equal(a.front.readyState, relay.Socket.CLOSED);
    assert.equal(a.back.readyState, relay.Socket.CLOSED);
    assert.equal(b.front.readyState, relay.Socket.OPEN);
    assert.equal(b.back.readyState, relay.Socket.OPEN);
  });
  test(`OPEN ${direction} catches highwater reached by send overhead`, () => {
    const relay = controlledRelay(); const a = relay.pair();
    const source = direction === 'to-backend' ? a.front : a.back;
    const destination = direction === 'to-backend' ? a.back : a.front;
    destination.afterSend = () => { destination.bufferedAmount = LIMIT + 1; };
    source.emit('message', Buffer.alloc(16), true);
    assert.equal(a.front.readyState, relay.Socket.CLOSED);
    assert.equal(a.back.readyState, relay.Socket.CLOSED);
  });
}

test('CONNECTING queue flush enforces OPEN highwater and clears the affected queue', () => {
  const relay = controlledRelay(); const a = relay.pair({ open: false });
  a.front.emit('message', Buffer.alloc(32), true);
  a.back.bufferedAmount = LIMIT - 8;
  a.back.open();
  assert.equal(a.back.sent.length, 0);
  assert.equal(a.front.readyState, relay.Socket.CLOSED);
  assert.equal(a.back.readyState, relay.Socket.CLOSED);
  a.back.bufferedAmount = 0;
  a.back.emit('open');
  assert.equal(a.back.sent.length, 0, 'closed queue must not replay');
});

test('CONNECTING queue overflow closes both sockets without forwarding queued data', () => {
  const relay = controlledRelay(); const a = relay.pair({ open: false });
  a.front.emit('message', Buffer.alloc(LIMIT), true);
  assert.equal(a.front.readyState, relay.Socket.CLOSED);
  assert.equal(a.back.readyState, relay.Socket.CLOSED);
  assert.equal(a.back.sent.length, 0);
});

for (const concurrent of [false, true]) {
  test(`real WebSocket ${concurrent ? 'cross-connection' : 'same-connection'} pipelining forwards permissions once`, { timeout: 5000 }, async t => {
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
    const seen = []; const arrivals = new EventEmitter();
    backWs.on('connection', back => back.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') back.send(JSON.stringify({ id: message.id, result: {} }));
      else { seen.push({ message, back }); arrivals.emit('request'); }
    }));
    async function client() {
      const socket = new WebSocket(`ws://127.0.0.1:${frontend.address().port}`); clients.push(socket);
      await once(socket, 'open');
      const ready = once(socket, 'message');
      socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-tui' } } }));
      await ready;
      return socket;
    }
    const a = await client(); const b = concurrent ? await client() : a;
    let arrived = once(arrivals, 'request');
    a.send(JSON.stringify(request(2))); await arrived;
    arrived = once(arrivals, 'request');
    b.send(JSON.stringify(request(3, 'thread/fork'))); await arrived;
    assert.equal(seen[0].message.params.approvalPolicy, 'never');
    assert.deepEqual(seen[1].message, request(3, 'thread/fork'));
    const response = once(a, 'message');
    seen[0].back.send(JSON.stringify({ id: seen[0].message.id, result: {} }));
    assert.deepEqual(JSON.parse((await response)[0]), { id: 2, result: {} });
    arrived = once(arrivals, 'request'); b.send(JSON.stringify(request(4))); await arrived;
    assert.deepEqual(seen[2].message, request(4));
  });
}
