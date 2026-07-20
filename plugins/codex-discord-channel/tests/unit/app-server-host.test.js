'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  AppServerRpcClient,
  createAppServerHost,
  endpointToWebSocket,
} = require('../../src/app-server-host');

class FakeRpcClient extends EventEmitter {
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

function createFakeWebSocket(server) {
  const sockets = [];

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;

    constructor() {
      super();
      this.readyState = 0;
      this.connectionIndex = sockets.length;
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.emit('open');
      });
    }

    send(text) {
      const request = JSON.parse(text);
      if (!Object.hasOwn(request, 'id')) return;
      Promise.resolve(server(request, this.connectionIndex)).then((reply) => {
        const result = Object.hasOwn(reply, 'afterResponse') ? reply.result : reply;
        this.emit('message', JSON.stringify({ id: request.id, result }));
        if (Object.hasOwn(reply, 'afterResponse')) reply.afterResponse(this);
      });
    }

    beginClose() {
      this.readyState = 2;
    }

    finishClose() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close');
    }

    close() {
      this.beginClose();
      this.finishClose();
    }

    terminate() {
      this.close();
    }
  }

  return { WebSocket: FakeWebSocket, sockets };
}

test('endpointToWebSocket maps the shared Unix endpoint to the app-server RPC route', () => {
  assert.deepEqual(endpointToWebSocket('unix:///tmp/codex01/app-server.sock'), {
    url: 'ws+unix:///tmp/codex01/app-server.sock:/rpc',
    socketPath: '/tmp/codex01/app-server.sock',
  });
  assert.deepEqual(endpointToWebSocket('ws://127.0.0.1:4500'), {
    url: 'ws://127.0.0.1:4500',
    socketPath: '',
  });
});

test('RPC client never answers app-server requests on behalf of the co-present TUI', () => {
  const client = new AppServerRpcClient({}, () => {});
  const sent = [];
  const seen = [];
  client.sendRaw = (payload) => sent.push(payload);
  client.on('serverRequest', (request) => seen.push(request));

  client.handleMessage(JSON.stringify({
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-current' },
  }));

  assert.deepEqual(sent, []);
  assert.deepEqual(seen, [{
    id: 'approval-1',
    method: 'item/commandExecution/requestApproval',
  }]);
});

test('host resolves the only loaded thread and refreshes it after thread rotation', async () => {
  let loadedThreadId = 'thread-before-compaction';
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') return { data: [loadedThreadId], nextCursor: null };
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: params.threadId.includes('before') ? 'active' : 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });

  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: 'thread-before-compaction',
    status: 'active',
  });
  loadedThreadId = 'thread-after-compaction';
  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: 'thread-after-compaction',
    status: 'idle',
  });
  assert.deepEqual(
    client.requests.filter((request) => request.method === 'thread/loaded/list').length,
    2,
  );
});

test('websocket reconnect after hidden thread rotation does not reuse the stale current thread', async (t) => {
  let loadedThreadIds = ['thread-before-clear'];
  const readThreadIds = [];
  const { WebSocket, sockets } = createFakeWebSocket(async (request) => {
    if (request.method === 'initialize') return {};
    if (request.method === 'thread/loaded/list') {
      return { data: loadedThreadIds, nextCursor: null };
    }
    if (request.method === 'thread/read') {
      readThreadIds.push(request.params.threadId);
      return {
        thread: {
          id: request.params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { WebSocket });
  t.after(() => host.destroy());

  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: 'thread-before-clear',
    status: 'idle',
  });

  sockets[0].close();
  loadedThreadIds = ['thread-before-clear', 'thread-after-clear'];

  assert.deepEqual(await host.resolveTarget(), {
    available: false,
    reason: 'shared_app_server_thread_ambiguous',
    status: 'unavailable',
  });
  assert.equal(sockets.length, 2);
  assert.deepEqual(readThreadIds, ['thread-before-clear']);
});

test('disconnect after a list response fails closed before reading that result on a new connection', async (t) => {
  let rotateWhileDisconnected = false;
  const readThreadIds = [];
  const { WebSocket, sockets } = createFakeWebSocket(async (request, connectionIndex) => {
    if (request.method === 'initialize') return {};
    if (request.method === 'thread/loaded/list') {
      if (rotateWhileDisconnected && connectionIndex === 0) {
        return {
          result: { data: ['thread-before-clear'], nextCursor: null },
          afterResponse: (socket) => socket.close(),
        };
      }
      return {
        data: rotateWhileDisconnected
          ? ['thread-before-clear', 'thread-after-clear']
          : ['thread-before-clear'],
        nextCursor: null,
      };
    }
    if (request.method === 'thread/read') {
      readThreadIds.push(request.params.threadId);
      return {
        thread: {
          id: request.params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { WebSocket });
  t.after(() => host.destroy());

  assert.equal((await host.resolveTarget()).threadId, 'thread-before-clear');
  rotateWhileDisconnected = true;

  assert.deepEqual(await host.resolveTarget(), {
    available: false,
    reason: 'shared_app_server_disconnected',
    status: 'unavailable',
  });
  assert.equal(sockets.length, 1);
  assert.deepEqual(readThreadIds, ['thread-before-clear']);
});

test('late close from a replaced websocket does not invalidate the active connection thread', async (t) => {
  let loadedThreadIds = ['thread-before-clear'];
  const { WebSocket, sockets } = createFakeWebSocket(async (request) => {
    if (request.method === 'initialize') return {};
    if (request.method === 'thread/loaded/list') {
      return { data: loadedThreadIds, nextCursor: null };
    }
    if (request.method === 'thread/read') {
      return {
        thread: {
          id: request.params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { WebSocket });
  t.after(() => host.destroy());

  assert.equal((await host.resolveTarget()).threadId, 'thread-before-clear');
  sockets[0].beginClose();
  loadedThreadIds = ['thread-after-clear'];
  assert.equal((await host.resolveTarget()).threadId, 'thread-after-clear');

  loadedThreadIds = ['thread-before-clear', 'thread-after-clear'];
  sockets[0].finishClose();

  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: 'thread-after-clear',
    status: 'idle',
  });
  assert.equal(sockets.length, 2);
});

test('latest top-level thread/started notification selects the rotated TUI thread among loaded history', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-before-clear', 'thread-after-clear'], nextCursor: null };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  client.emit('notification', {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-after-clear',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  });

  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: 'thread-after-clear',
    status: 'idle',
  });
  assert.deepEqual(
    client.requests.filter((request) => request.method === 'thread/read').map((request) => request.params.threadId),
    ['thread-after-clear'],
  );
});

test('rotated current thread remains selectable beyond the first loaded-thread page', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      if (!params.cursor) {
        return { data: ['thread-old-a', 'thread-old-b'], nextCursor: 'page-2' };
      }
      assert.equal(params.cursor, 'page-2');
      return { data: ['thread-current'], nextCursor: null };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  client.emit('notification', {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-current',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  });

  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: 'thread-current',
    status: 'idle',
  });
  assert.deepEqual(
    client.requests.filter((request) => request.method === 'thread/loaded/list').map((request) => request.params),
    [{ limit: 2 }, { limit: 2, cursor: 'page-2' }],
  );
});

test('host rejects a malformed cursor before accepting the current thread on that page', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-current'], nextCursor: {} };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  client.emit('notification', {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-current',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  });

  assert.deepEqual(await host.resolveTarget(), {
    available: false,
    reason: 'shared_app_server_thread_ambiguous',
    status: 'unavailable',
  });
  assert.equal(client.requests.some((request) => request.method === 'thread/read'), false);
});

test('host rejects a repeated cursor before accepting the current thread on that page', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      if (!params.cursor) {
        return { data: ['thread-old'], nextCursor: 'page-2' };
      }
      assert.equal(params.cursor, 'page-2');
      return { data: ['thread-current'], nextCursor: 'page-2' };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  client.emit('notification', {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-current',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  });

  assert.deepEqual(await host.resolveTarget(), {
    available: false,
    reason: 'shared_app_server_thread_ambiguous',
    status: 'unavailable',
  });
  assert.equal(client.requests.some((request) => request.method === 'thread/read'), false);
});

test('host fails closed when the shared app-server has no exact loaded thread', async (t) => {
  for (const [name, data, nextCursor, reason] of [
    ['none loaded', [], null, 'shared_app_server_no_loaded_thread'],
    ['multiple loaded', ['thread-a', 'thread-b'], null, 'shared_app_server_thread_ambiguous'],
    ['more pages', ['thread-a'], 'next', 'shared_app_server_thread_ambiguous'],
    ['malformed cursor', ['thread-a'], {}, 'shared_app_server_thread_ambiguous'],
  ]) {
    await t.test(name, async () => {
      const client = new FakeRpcClient(async (method) => {
        assert.equal(method, 'thread/loaded/list');
        return { data, nextCursor };
      });
      const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
      assert.deepEqual(await host.resolveTarget(), {
        available: false,
        reason,
        status: 'unavailable',
      });
    });
  }
});

test('host reports a missing shared Unix socket without starting a private app-server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-app-host-'));
  const host = createAppServerHost({
    appServerUrl: `unix://${path.join(dir, 'missing.sock')}`,
    appServerConnectTimeoutMs: 10,
  });

  assert.deepEqual(await host.resolveTarget(), {
    available: false,
    reason: 'shared_app_server_socket_missing',
    status: 'unavailable',
  });
  assert.deepEqual(host.status(), {
    configured: true,
    available: false,
    reason: 'shared_app_server_socket_missing',
  });
});

test('host emits idle only when the current app-server thread becomes idle', async () => {
  const client = new FakeRpcClient(async () => { throw new Error('not used'); });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  const seen = [];
  const unsubscribe = host.onThreadIdle((event) => seen.push(event));

  client.emit('notification', {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-b',
        parentThreadId: null,
        status: { type: 'active', activeFlags: [] },
      },
    },
  });
  client.emit('notification', {
    method: 'thread/status/changed',
    params: { threadId: 'thread-a', status: { type: 'idle' } },
  });
  client.emit('notification', {
    method: 'thread/status/changed',
    params: { threadId: 'thread-b', status: { type: 'idle' } },
  });
  assert.deepEqual(seen, [{ threadId: 'thread-b' }]);

  unsubscribe();
  client.emit('notification', {
    method: 'thread/status/changed',
    params: { threadId: 'thread-c', status: { type: 'idle' } },
  });
  assert.equal(seen.length, 1);
});

test('startTurn forwards only the structured caller payload', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    assert.equal(method, 'turn/start');
    assert.equal(Object.hasOwn(params, 'model'), false);
    assert.equal(Object.hasOwn(params, 'effort'), false);
    return { turn: { id: 'turn-1' } };
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  const params = {
    threadId: 'thread-a',
    clientUserMessageId: 'discord:c1:m1',
    input: [{ type: 'text', text: 'hello' }],
  };
  assert.deepEqual(await host.startTurn(params), { turn: { id: 'turn-1' } });
  assert.deepEqual(client.requests, [{ method: 'turn/start', params }]);
});

test('hasDelivered finds the echoed client user message id without starting another turn', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    assert.equal(method, 'thread/read');
    assert.deepEqual(params, { threadId: 'thread-a', includeTurns: true });
    return {
      thread: {
        turns: [
          { items: [{ type: 'userMessage', clientId: 'discord:c1:m1' }] },
        ],
      },
    };
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  assert.equal(await host.hasDelivered('thread-a', 'discord:c1:m1'), true);
  assert.equal(await host.hasDelivered('thread-a', 'discord:c1:missing'), false);
});
