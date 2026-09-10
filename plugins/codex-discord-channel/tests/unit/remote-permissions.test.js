'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');
const { permissionRequest, connectRelay } = require('../../src/remote-permissions');
const permissions = { approvalPolicy: 'never', sandbox: 'danger-full-access' };

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
