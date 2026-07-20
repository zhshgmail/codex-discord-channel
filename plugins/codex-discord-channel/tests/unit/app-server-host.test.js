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

function createFakeWebSocket(server, options = {}) {
  const sockets = [];

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;

    constructor() {
      super();
      this.readyState = 0;
      this.connectionIndex = sockets.length;
      sockets.push(this);
      queueMicrotask(() => {
        if (options.failConnections?.includes(this.connectionIndex)) {
          this.readyState = 3;
          this.emit('error', new Error(`connection ${this.connectionIndex} failed`));
          return;
        }
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

function createManualTimers() {
  let nextId = 1;
  const pending = new Map();
  const delays = [];
  return {
    clearTimeout(id) {
      pending.delete(id);
    },
    delays,
    pendingCount() {
      return pending.size;
    },
    async runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [id, timer] = entry;
      pending.delete(id);
      await timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      return true;
    },
    setTimeout(callback, delay) {
      const id = nextId++;
      delays.push(delay);
      pending.set(id, { callback, delay });
      return id;
    },
  };
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

test('fresh recovery selects the unique top-level root among loaded subagent threads', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-child', 'thread-root'], nextCursor: null };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: params.threadId === 'thread-child' ? 'thread-root' : null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });

  assert.deepEqual(await host.resolveTarget(), {
    available: true,
    threadId: 'thread-root',
    status: 'idle',
  });
  assert.deepEqual(
    client.requests.filter((request) => request.method === 'thread/read')
      .map((request) => request.params.threadId),
    ['thread-child', 'thread-root'],
  );
});

test('fresh recovery still fails closed after proving multiple loaded roots', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-root-a', 'thread-root-b'], nextCursor: null };
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

  assert.deepEqual(await host.resolveTarget(), {
    available: false,
    reason: 'shared_app_server_thread_ambiguous',
    status: 'unavailable',
  });
  assert.deepEqual(
    client.requests.filter((request) => request.method === 'thread/read')
      .map((request) => request.params.threadId),
    ['thread-root-a', 'thread-root-b'],
  );
});

test('fresh recovery bounds loaded-thread parent inspection at 32 candidates', async (t) => {
  const createCandidateHost = (candidateCount) => {
    const ids = [
      'thread-root',
      ...Array.from({ length: candidateCount - 1 }, (_, index) => `thread-child-${index + 1}`),
    ];
    const client = new FakeRpcClient(async (method, params) => {
      if (method === 'thread/loaded/list') {
        const offset = Number(params.cursor || 0);
        const end = Math.min(offset + 2, ids.length);
        return {
          data: ids.slice(offset, end),
          nextCursor: end < ids.length ? String(end) : null,
        };
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: params.threadId,
            parentThreadId: params.threadId === 'thread-root' ? null : 'thread-root',
            status: { type: 'idle' },
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    return {
      client,
      host: createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client }),
    };
  };

  await t.test('accepts the inclusive bound', async () => {
    const { client, host } = createCandidateHost(32);
    assert.deepEqual(await host.resolveTarget(), {
      available: true,
      threadId: 'thread-root',
      status: 'idle',
    });
    assert.equal(
      client.requests.filter((request) => request.method === 'thread/read').length,
      32,
    );
  });

  await t.test('fails closed above the bound', async () => {
    const { client, host } = createCandidateHost(33);
    assert.deepEqual(await host.resolveTarget(), {
      available: false,
      reason: 'shared_app_server_thread_ambiguous',
      status: 'unavailable',
    });
    assert.equal(
      client.requests.filter((request) => request.method === 'thread/read').length,
      0,
    );
  });
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
  assert.deepEqual(readThreadIds, [
    'thread-before-clear',
    'thread-before-clear',
    'thread-after-clear',
  ]);
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

test('messages from a replaced websocket cannot mutate the active connection thread', async (t) => {
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
  sockets[0].emit('message', JSON.stringify({
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-before-clear',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  }));
  assert.equal((await host.resolveTarget()).threadId, 'thread-after-clear');

  loadedThreadIds.push('thread-current');
  sockets[1].emit('message', JSON.stringify({
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-current',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  }));
  assert.equal((await host.resolveTarget()).threadId, 'thread-current');
});

test('host reports available status after reconnect initialization completes', async (t) => {
  const { WebSocket, sockets } = createFakeWebSocket(async (request) => {
    assert.equal(request.method, 'initialize');
    return {};
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { WebSocket });
  t.after(() => host.destroy());

  await host.client.ensureConnected();
  sockets[0].close();
  assert.deepEqual(host.status(), {
    configured: true,
    available: false,
    reason: 'shared_app_server_disconnected',
  });

  await host.client.ensureConnected();
  assert.equal(sockets.length, 2);
  assert.deepEqual(host.status(), {
    configured: true,
    available: true,
    reason: null,
  });
});

test('websocket close autonomously reconnects and emits reconnect without later traffic', async (t) => {
  const timers = createManualTimers();
  const { WebSocket, sockets } = createFakeWebSocket(async (request) => {
    assert.equal(request.method, 'initialize');
    return {};
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, {
    WebSocket,
    clearTimeout: timers.clearTimeout,
    reconnectInitialDelayMs: 10,
    reconnectMaxDelayMs: 40,
    setTimeout: timers.setTimeout,
  });
  t.after(() => host.destroy());
  const reconnects = [];
  host.onReconnect((event) => reconnects.push(event));

  await host.client.ensureConnected();
  sockets[0].close();

  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(timers.delays, [10]);
  assert.equal(sockets.length, 1);

  await timers.runNext();

  assert.equal(sockets.length, 2);
  assert.equal(reconnects.length, 1);
  assert.deepEqual(host.status(), {
    configured: true,
    available: true,
    reason: null,
  });
});

test('failed autonomous reconnect backs off and destroy cancels the next retry', async () => {
  const timers = createManualTimers();
  const { WebSocket, sockets } = createFakeWebSocket(async (request) => {
    assert.equal(request.method, 'initialize');
    return {};
  }, { failConnections: [1] });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, {
    WebSocket,
    clearTimeout: timers.clearTimeout,
    reconnectInitialDelayMs: 10,
    reconnectMaxDelayMs: 40,
    setTimeout: timers.setTimeout,
  });

  await host.client.ensureConnected();
  sockets[0].close();
  await timers.runNext();

  assert.equal(sockets.length, 2);
  assert.deepEqual(timers.delays, [10, 20]);
  assert.equal(timers.pendingCount(), 1);

  host.destroy();
  assert.equal(timers.pendingCount(), 0);
  assert.equal(await timers.runNext(), false);
  assert.equal(sockets.length, 2);
});

test('initial websocket failure retries autonomously and emits recovery without later traffic', async (t) => {
  const timers = createManualTimers();
  const { WebSocket, sockets } = createFakeWebSocket(async (request) => {
    assert.equal(request.method, 'initialize');
    return {};
  }, { failConnections: [0] });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, {
    WebSocket,
    clearTimeout: timers.clearTimeout,
    reconnectInitialDelayMs: 10,
    reconnectMaxDelayMs: 40,
    setTimeout: timers.setTimeout,
  });
  t.after(() => host.destroy());
  const reconnects = [];
  host.onReconnect((event) => reconnects.push(event));

  await assert.rejects(host.client.ensureConnected(), { code: 'shared_app_server_connect_failed' });
  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(timers.delays, [10]);

  await timers.runNext();

  assert.equal(sockets.length, 2);
  assert.equal(reconnects.length, 1);
  assert.deepEqual(host.status(), {
    configured: true,
    available: true,
    reason: null,
  });
});

test('host emits reconnect only when availability returns after a live connection was lost', () => {
  let status = { configured: true, available: false, reason: 'shared_app_server_not_connected' };
  const client = new FakeRpcClient(async () => { throw new Error('not used'); });
  client.status = () => ({ ...status });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  const seen = [];
  const unsubscribe = host.onReconnect((event) => seen.push(event));

  status = { configured: true, available: true, reason: null };
  client.emit('connectionChanged', { generation: 1 });
  status = { configured: true, available: false, reason: 'shared_app_server_disconnected' };
  client.emit('connectionChanged', { generation: 2 });
  status = { configured: true, available: true, reason: null };
  client.emit('connectionChanged', { generation: 3 });

  assert.deepEqual(seen, [{ generation: 3 }]);
  unsubscribe();
  host.destroy();
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

test('in-flight thread read cannot overwrite a newer top-level thread notification', async () => {
  let loadedThreadIds = ['thread-before-clear'];
  let releaseFirstRead;
  let markFirstReadStarted;
  const firstReadStarted = new Promise((resolve) => { markFirstReadStarted = resolve; });
  const firstReadReleased = new Promise((resolve) => { releaseFirstRead = resolve; });
  let firstRead = true;
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: loadedThreadIds, nextCursor: null };
    }
    if (method === 'thread/read') {
      if (firstRead) {
        firstRead = false;
        markFirstReadStarted();
        await firstReadReleased;
      }
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
        id: 'thread-before-clear',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  });

  const resolving = host.resolveTarget();
  await firstReadStarted;
  loadedThreadIds = ['thread-before-clear', 'thread-after-clear'];
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
  releaseFirstRead();

  assert.deepEqual(await resolving, {
    available: true,
    threadId: 'thread-after-clear',
    status: 'idle',
  });
  assert.deepEqual(
    client.requests.filter((request) => request.method === 'thread/read').map((request) => request.params.threadId),
    ['thread-before-clear', 'thread-after-clear'],
  );
});

test('in-flight loaded-thread list cannot restore an older thread after rotation', async () => {
  let loadedThreadIds = ['thread-before-clear'];
  let releaseFirstList;
  let markFirstListStarted;
  const firstListStarted = new Promise((resolve) => { markFirstListStarted = resolve; });
  const firstListReleased = new Promise((resolve) => { releaseFirstList = resolve; });
  let firstList = true;
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      if (firstList) {
        firstList = false;
        const staleThreadIds = [...loadedThreadIds];
        markFirstListStarted();
        await firstListReleased;
        return { data: staleThreadIds, nextCursor: null };
      }
      return { data: loadedThreadIds, nextCursor: null };
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
        id: 'thread-before-clear',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  });

  const resolving = host.resolveTarget();
  await firstListStarted;
  loadedThreadIds = ['thread-before-clear', 'thread-after-clear'];
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
  releaseFirstList();

  assert.deepEqual(await resolving, {
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
      const client = new FakeRpcClient(async (method, params) => {
        if (method === 'thread/loaded/list') return { data, nextCursor };
        if (method === 'thread/read' && name === 'multiple loaded') {
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

test('host exposes loaded-thread closure as a persisted recovery transition', () => {
  const client = new FakeRpcClient(async () => { throw new Error('not used'); });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  const seen = [];
  const unsubscribe = host.onThreadClosed((event) => seen.push(event));

  client.emit('notification', {
    method: 'thread/closed',
    params: { threadId: 'thread-child' },
  });

  assert.deepEqual(seen, [{ threadId: 'thread-child' }]);
  unsubscribe();
});

test('startTurn forwards only the structured caller payload', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
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
  const target = await host.resolveTarget();
  client.requests.length = 0;
  assert.deepEqual(await host.startTurn(params, target), { turn: { id: 'turn-1' } });
  assert.deepEqual(client.requests, [{ method: 'turn/start', params }]);
});

test('startTurn rejects a resolved target after a newer thread generation is selected', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
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
    if (method === 'turn/start') return { turn: { id: 'must-not-start' } };
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  const target = await host.resolveTarget();
  client.emit('notification', {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-b',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  });

  await assert.rejects(
    host.startTurn({
      threadId: target.threadId,
      clientUserMessageId: 'discord:c1:m-stale',
      input: [{ type: 'text', text: 'stale' }],
    }, target),
    (error) => error.code === 'shared_app_server_thread_changed' &&
      error.deliveryOutcome === 'not_sent',
  );
  assert.equal(client.requests.some((request) => request.method === 'turn/start'), false);
});

test('accepted turn response remains definitive when the websocket closes immediately after it', async (t) => {
  const { WebSocket } = createFakeWebSocket(async (request) => {
    if (request.method === 'initialize') return {};
    if (request.method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
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
    if (request.method === 'turn/start') {
      return {
        result: { turn: { id: 'turn-accepted' } },
        afterResponse: (socket) => socket.close(),
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { WebSocket });
  t.after(() => host.destroy());
  const target = await host.resolveTarget();

  assert.deepEqual(await host.startTurn({
    threadId: target.threadId,
    clientUserMessageId: 'discord:c1:m-accepted',
    input: [{ type: 'text', text: 'accepted' }],
  }, target), { turn: { id: 'turn-accepted' } });
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

test('hasDelivered reconciles on the first connection without invalidating its own read', async (t) => {
  const { WebSocket } = createFakeWebSocket(async (request) => {
    if (request.method === 'initialize') return {};
    if (request.method === 'thread/read') {
      return {
        thread: {
          turns: [{
            items: [{ type: 'userMessage', clientId: 'discord:c1:m-first-connect' }],
          }],
        },
      };
    }
    throw new Error(`unexpected method ${request.method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { WebSocket });
  t.after(() => host.destroy());

  assert.equal(await host.hasDelivered('thread-a', 'discord:c1:m-first-connect'), true);
});
