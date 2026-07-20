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
