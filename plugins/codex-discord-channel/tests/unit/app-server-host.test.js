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

const DELIVERY_THREAD_ID = '019f3763-d308-7871-bedc-e6489b02190e';
const OTHER_DELIVERY_THREAD_ID = '019f3763-d308-7871-bedc-e6489b02190f';

function sessionMeta(threadId = DELIVERY_THREAD_ID) {
  return { type: 'session_meta', payload: { id: threadId } };
}

function deliveredUserMessage(clientId) {
  return {
    type: 'event_msg',
    payload: { type: 'user_message', client_id: clientId },
  };
}

function userLifecycleSignal(method, threadId, clientId) {
  return {
    method,
    params: {
      threadId,
      turnId: 'turn-delivery-proof',
      item: { type: 'userMessage', clientId },
    },
  };
}

function createRolloutFixture(t, records, options = {}) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-rollout-proof-'));
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '31');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filenameThreadId = options.filenameThreadId || DELIVERY_THREAD_ID;
  const rolloutPath = path.join(
    sessionsDir,
    `rollout-2026-07-31T00-00-00-${filenameThreadId}.jsonl`,
  );
  const body = records
    .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
    .join('\n');
  fs.writeFileSync(rolloutPath, `${body}\n`);
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  return { codexHome, rolloutPath, sessionsDir };
}

function createSparseRolloutFixture(t, tailText, size = 160 * 1024 * 1024) {
  const fixture = createRolloutFixture(t, [sessionMeta()]);
  const handle = fs.openSync(fixture.rolloutPath, 'r+');
  try {
    fs.ftruncateSync(handle, size);
    const tail = Buffer.from(`\n${tailText}`, 'utf8');
    fs.writeSync(handle, tail, 0, tail.length, size - tail.length);
  } finally {
    fs.closeSync(handle);
  }
  return { ...fixture, size };
}

function createLocalRolloutHost(client, codexHome, deps = {}) {
  return createAppServerHost({
    appServerUrl: 'unix:///tmp/codex-discord-test.sock',
    env: { CODEX_HOME: codexHome, HOME: path.dirname(codexHome) },
  }, () => {}, { client, ...deps });
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

test('system-error root remains the structured target while a subagent is active', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-child', 'thread-root'], nextCursor: null };
    }
    if (method === 'thread/read') {
      const child = params.threadId === 'thread-child';
      return {
        thread: {
          id: params.threadId,
          parentThreadId: child ? 'thread-root' : null,
          status: child
            ? { type: 'active', activeFlags: [] }
            : { type: 'systemError' },
          turns: child
            ? [{ id: 'child-turn', status: 'inProgress', items: [] }]
            : [],
        },
      };
    }
    if (method === 'turn/start') return { turn: { id: 'root-recovery-turn' } };
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });

  const target = await host.resolveTarget();
  assert.deepEqual(target, {
    available: true,
    threadId: 'thread-root',
    status: 'systemError',
  });

  client.requests.length = 0;
  const params = {
    threadId: 'thread-root',
    clientUserMessageId: 'discord:c1:m-recover-root',
    input: [{ type: 'text', text: 'recover the owner thread' }],
  };
  assert.deepEqual(await host.startTurn(params, target), {
    turn: { id: 'root-recovery-turn' },
  });
  assert.deepEqual(client.requests, [{ method: 'turn/start', params }]);
});

test('system-error recovery fails closed when the root status changes before submission', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-root'], nextCursor: null };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: 'systemError' },
        },
      };
    }
    if (method === 'turn/start') return { turn: { id: 'must-not-start' } };
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });
  const target = await host.resolveTarget();

  client.emit('notification', {
    method: 'thread/status/changed',
    params: { threadId: 'thread-root', status: { type: 'idle' } },
  });

  await assert.rejects(
    host.startTurn({
      threadId: 'thread-root',
      clientUserMessageId: 'discord:c1:m-stale-system-error',
      input: [{ type: 'text', text: 'stale recovery' }],
    }, target),
    (error) => error.code === 'shared_app_server_thread_changed' &&
      error.deliveryOutcome === 'not_sent',
  );
  assert.equal(client.requests.some((request) => request.method === 'turn/start'), false);
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

test('request timeout fences the stale socket and schedules bounded reconnect', async (t) => {
  const timers = createManualTimers();
  const { WebSocket, sockets } = createFakeWebSocket(async (request, connectionIndex) => {
    if (request.method === 'initialize') return {};
    if (request.method === 'thread/loaded/list' && connectionIndex === 0) {
      return new Promise(() => {});
    }
    if (request.method === 'thread/loaded/list') return { data: [], nextCursor: null };
    throw new Error(`unexpected method ${request.method}`);
  });
  const client = new AppServerRpcClient({
    appServerUrl: 'ws://127.0.0.1:4500',
    appServerRequestTimeoutMs: 10,
  }, () => {}, {
    WebSocket,
    clearTimeout: timers.clearTimeout,
    reconnectInitialDelayMs: 15,
    reconnectMaxDelayMs: 30,
    setTimeout: timers.setTimeout,
  });
  t.after(() => client.destroy());

  await client.ensureConnected();
  await assert.rejects(
    client.request('thread/loaded/list', { limit: 100 }),
    (error) => error.code === 'shared_app_server_request_timeout' &&
      error.deliveryOutcome === 'uncertain',
  );

  assert.equal(sockets[0].readyState, 3);
  assert.deepEqual(client.status(), {
    configured: true,
    available: false,
    reason: 'shared_app_server_request_timeout',
  });
  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(timers.delays, [15]);

  await timers.runNext();

  assert.equal(sockets.length, 2);
  assert.deepEqual(client.status(), { configured: true, available: true, reason: null });
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
    ['thread-before-clear', 'thread-after-clear'],
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
    ['thread-before-clear', 'thread-before-clear', 'thread-after-clear'],
  );
});

test('thread read failure after connection fencing returns unavailable without recursive retry', async () => {
  let readCount = 0;
  const client = new FakeRpcClient(async (method) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-current'], nextCursor: null };
    }
    if (method === 'thread/read') {
      readCount += 1;
      client.emit('connectionChanged', { generation: readCount });
      const error = new Error('thread/read timed out');
      error.code = 'shared_app_server_request_timeout';
      throw error;
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(
    { appServerUrl: 'ws://127.0.0.1:4500' },
    () => {},
    { client },
  );

  assert.deepEqual(await host.resolveTarget(), {
    available: false,
    reason: 'shared_app_server_request_timeout',
    status: 'unavailable',
  });
  assert.equal(readCount, 1);
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
    ['thread-before-clear', 'thread-after-clear'],
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

test('host rejects malformed loaded-thread page data after a valid target page', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      if (!params.cursor) {
        return { data: ['thread-current'], nextCursor: 'page-2' };
      }
      assert.equal(params.cursor, 'page-2');
      return { data: {}, nextCursor: null };
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

test('accepted turn response keeps active delivery available when its notification is missed', async () => {
  let turnStarted = false;
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
    }
    if (method === 'thread/read') {
      if (turnStarted) throw new Error('active thread/read must not be required');
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    if (method === 'turn/start') {
      turnStarted = true;
      return { turn: { id: 'turn-from-response' } };
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, 'turn-from-response');
      return { turnId: params.expectedTurnId };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(
    { appServerUrl: 'ws://127.0.0.1:4500' },
    () => {},
    { client },
  );

  const idleTarget = await host.resolveTarget();
  await host.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-start',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);

  client.requests.length = 0;
  const activeTarget = await host.resolveTarget();
  assert.equal(activeTarget.available, true);
  assert.equal(activeTarget.threadId, 'thread-a');
  assert.equal(activeTarget.status, 'active');
  assert.equal(activeTarget.activeTurnId, 'turn-from-response');
  assert.equal(
    client.requests.some((request) => request.method === 'thread/read'),
    false,
  );

  await host.startTurn({
    threadId: activeTarget.threadId,
    clientUserMessageId: 'discord:c1:m-steer',
    input: [{ type: 'text', text: 'steer the active work' }],
  }, activeTarget);
  assert.equal(
    client.requests.some((request) => (
      request.method === 'turn/steer' &&
      request.params.expectedTurnId === 'turn-from-response'
    )),
    true,
  );
});

test('request-timeout reconnect retains the exact accepted active turn', async () => {
  let turnStarted = false;
  let clientStatus = { configured: true, available: true, reason: null };
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
    }
    if (method === 'thread/read') {
      if (turnStarted) throw new Error('reconnect must not reread the active thread');
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    if (method === 'turn/start') {
      turnStarted = true;
      return { turn: { id: 'turn-before-timeout' } };
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, 'turn-before-timeout');
      return { turnId: params.expectedTurnId };
    }
    throw new Error(`unexpected method ${method}`);
  });
  client.status = () => clientStatus;
  const host = createAppServerHost(
    { appServerUrl: 'ws://127.0.0.1:4500' },
    () => {},
    { client },
  );

  const idleTarget = await host.resolveTarget();
  await host.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-start',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);

  clientStatus = {
    configured: true,
    available: false,
    reason: 'shared_app_server_request_timeout',
  };
  client.emit('connectionChanged', { generation: 2 });
  clientStatus = { configured: true, available: true, reason: null };
  client.emit('connectionChanged', { generation: 3, recovered: true });

  client.requests.length = 0;
  const activeTarget = await host.resolveTarget();
  assert.equal(activeTarget.available, true);
  assert.equal(activeTarget.threadId, 'thread-a');
  assert.equal(activeTarget.status, 'active');
  assert.equal(activeTarget.activeTurnId, 'turn-before-timeout');
  assert.equal(
    client.requests.some((request) => request.method === 'thread/read'),
    false,
  );

  await host.startTurn({
    threadId: activeTarget.threadId,
    clientUserMessageId: 'discord:c1:m-after-timeout',
    input: [{ type: 'text', text: 'continue after reconnect' }],
  }, activeTarget);
});

test('rejected timeout-recovery turn is discarded before the next target resolution', async () => {
  let turnStarted = false;
  let rejectRecoveredTurn = false;
  let clientStatus = { configured: true, available: true, reason: null };
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
    if (method === 'turn/start') {
      turnStarted = true;
      return { turn: { id: 'turn-before-timeout' } };
    }
    if (method === 'turn/steer' && rejectRecoveredTurn) {
      const error = new Error('expected turn is no longer active');
      error.code = 'shared_app_server_request_rejected';
      error.deliveryOutcome = 'rejected';
      throw error;
    }
    throw new Error(`unexpected method ${method}`);
  });
  client.status = () => clientStatus;
  const host = createAppServerHost(
    { appServerUrl: 'ws://127.0.0.1:4500' },
    () => {},
    { client },
  );

  const idleTarget = await host.resolveTarget();
  await host.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-start',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);
  assert.equal(turnStarted, true);

  clientStatus = {
    configured: true,
    available: false,
    reason: 'shared_app_server_request_timeout',
  };
  client.emit('connectionChanged', { generation: 2 });
  clientStatus = { configured: true, available: true, reason: null };
  client.emit('connectionChanged', { generation: 3, recovered: true });

  const recoveredTarget = await host.resolveTarget();
  rejectRecoveredTurn = true;
  await assert.rejects(
    host.startTurn({
      threadId: recoveredTarget.threadId,
      clientUserMessageId: 'discord:c1:m-stale-recovery',
      input: [{ type: 'text', text: 'stale recovery' }],
    }, recoveredTarget),
    (error) => error.deliveryOutcome === 'rejected',
  );

  client.requests.length = 0;
  const idleAfterRejection = await host.resolveTarget();
  assert.equal(idleAfterRejection.status, 'idle');
  assert.equal(
    client.requests.some((request) => request.method === 'thread/read'),
    true,
  );
});

test('accepted active target survives a gateway process restart through a durable checkpoint', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-active-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  let turnStarted = false;
  const firstClient = new FakeRpcClient(async (method, params) => {
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
    if (method === 'turn/start') {
      turnStarted = true;
      return { turn: { id: 'turn-across-restart' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  const idleTarget = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-start',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);
  assert.equal(turnStarted, true);
  firstHost.destroy();

  const secondClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
    }
    if (method === 'thread/read') {
      throw new Error('restart recovery must not reread the unchanged active thread');
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, 'turn-across-restart');
      return { turnId: params.expectedTurnId };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const secondHost = createAppServerHost(config, () => {}, { client: secondClient });
  t.after(() => secondHost.destroy());

  const recoveredTarget = await secondHost.resolveTarget();
  assert.equal(recoveredTarget.available, true);
  assert.equal(recoveredTarget.threadId, 'thread-a');
  assert.equal(recoveredTarget.status, 'active');
  assert.equal(recoveredTarget.activeTurnId, 'turn-across-restart');
  await secondHost.startTurn({
    threadId: recoveredTarget.threadId,
    clientUserMessageId: 'discord:c1:m-after-restart',
    input: [{ type: 'text', text: 'continue after restart' }],
  }, recoveredTarget);
});

async function createDurableTarget(config, turnId = 'turn-before-restart') {
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
    if (method === 'turn/start') return { turn: { id: turnId } };
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(config, () => {}, { client });
  const target = await host.resolveTarget();
  await host.startTurn({
    threadId: target.threadId,
    clientUserMessageId: `discord:c1:${turnId}`,
    input: [{ type: 'text', text: 'start active work' }],
  }, target);
  host.destroy();
}

test('durable target checkpoint records every bounded loaded-thread page', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-complete-pagination-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const firstClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      if (!params.cursor) {
        return { data: ['thread-current'], nextCursor: 'page-2' };
      }
      assert.equal(params.cursor, 'page-2');
      return { data: ['thread-older-root'], nextCursor: null };
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
    if (method === 'turn/start') {
      return { turn: { id: 'turn-complete-pagination' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  firstClient.emit('notification', {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-current',
        parentThreadId: null,
        status: { type: 'idle' },
      },
    },
  });
  const target = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: target.threadId,
    clientUserMessageId: 'discord:c1:m-complete-pagination',
    input: [{ type: 'text', text: 'persist the complete loaded inventory' }],
  }, target);
  firstHost.destroy();

  const checkpoint = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'app-server-target.json'), 'utf8'),
  );
  assert.deepEqual(
    checkpoint.loadedThreadIds,
    ['thread-current', 'thread-older-root'],
  );
});

test('notifications cannot persist a target before loaded-thread inventory is proven', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-notification-only-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const client = new FakeRpcClient(async (method) => {
    throw new Error(`notification-only path must not request ${method}`);
  });
  const host = createAppServerHost(config, () => {}, { client });
  t.after(() => host.destroy());

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
  client.emit('notification', {
    method: 'turn/started',
    params: {
      threadId: 'thread-current',
      turn: { id: 'turn-notification-only' },
    },
  });

  assert.equal(
    fs.existsSync(path.join(stateDir, 'app-server-target.json')),
    false,
  );
  assert.equal(
    client.requests.filter((request) => request.method === 'thread/loaded/list').length,
    0,
  );
});

test('gateway restart retains a durable active target when an unrelated loaded child closed', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-closed-child-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const firstClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a', 'thread-worker'], nextCursor: null };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: params.threadId === 'thread-worker' ? 'thread-a' : null,
          status: { type: 'idle' },
        },
      };
    }
    if (method === 'turn/start') {
      return { turn: { id: 'turn-after-worker-close' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  const idleTarget = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-before-worker-close',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);
  firstHost.destroy();

  const secondClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
    }
    if (method === 'thread/read') {
      throw new Error('worker closure must not force a read of the unchanged active thread');
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, 'turn-after-worker-close');
      return { turnId: params.expectedTurnId };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const secondHost = createAppServerHost(config, () => {}, { client: secondClient });
  t.after(() => secondHost.destroy());

  const recoveredTarget = await secondHost.resolveTarget();
  assert.equal(recoveredTarget.available, true);
  assert.equal(recoveredTarget.threadId, 'thread-a');
  assert.equal(recoveredTarget.status, 'active');
  assert.equal(recoveredTarget.activeTurnId, 'turn-after-worker-close');
  await secondHost.startTurn({
    threadId: recoveredTarget.threadId,
    clientUserMessageId: 'discord:c1:m-after-worker-close',
    input: [{ type: 'text', text: 'continue after worker close' }],
  }, recoveredTarget);
});

test('gateway restart retains a durable active target when an unrelated loaded child started', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-started-child-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const firstClient = new FakeRpcClient(async (method, params) => {
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
    if (method === 'turn/start') {
      return { turn: { id: 'turn-before-worker-start' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  const idleTarget = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-before-worker-start',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);
  firstHost.destroy();

  const secondClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a', 'thread-worker'], nextCursor: null };
    }
    if (method === 'thread/read' && params.threadId === 'thread-worker') {
      return {
        thread: {
          id: 'thread-worker',
          parentThreadId: 'thread-a',
          status: { type: 'active' },
        },
      };
    }
    if (method === 'thread/read') {
      throw new Error('child addition must not force a read of the unchanged active root');
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, 'turn-before-worker-start');
      return { turnId: params.expectedTurnId };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const secondHost = createAppServerHost(config, () => {}, { client: secondClient });
  t.after(() => secondHost.destroy());

  const recoveredTarget = await secondHost.resolveTarget();
  assert.equal(recoveredTarget.available, true);
  assert.equal(recoveredTarget.threadId, 'thread-a');
  assert.equal(recoveredTarget.status, 'active');
  assert.equal(recoveredTarget.activeTurnId, 'turn-before-worker-start');
  assert.equal(
    secondClient.requests.some((request) => (
      request.method === 'thread/read' &&
      request.params.threadId === 'thread-worker' &&
      request.params.includeTurns === false
    )),
    true,
  );
});

test('gateway restart rejects malformed parent lineage for an added thread', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-malformed-child-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  await createDurableTarget(config, 'turn-before-malformed-child');

  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a', 'thread-malformed'], nextCursor: null };
    }
    if (method === 'thread/read' && params.threadId === 'thread-malformed') {
      return {
        thread: {
          id: 'thread-malformed',
          parentThreadId: {},
          status: { type: 'active' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(config, () => {}, { client });
  t.after(() => host.destroy());

  const target = await host.resolveTarget();
  assert.equal(target.available, false);
  assert.equal(target.reason, 'shared_app_server_thread_unprovable');
});

test('gateway restart rejects self-parent and orphan lineage for an added thread', async (t) => {
  for (const [name, parentThreadId] of [
    ['self parent', 'thread-added'],
    ['orphan parent', 'thread-missing'],
  ]) {
    await t.test(name, async (t) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-unanchored-child-target-'));
      t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
      const config = {
        appServerUrl: 'ws://127.0.0.1:4500',
        paths: { stateDir },
      };
      await createDurableTarget(config, `turn-before-${name.replace(' ', '-')}`);

      const client = new FakeRpcClient(async (method, params) => {
        if (method === 'thread/loaded/list') {
          return { data: ['thread-a', 'thread-added'], nextCursor: null };
        }
        if (method === 'thread/read' && params.threadId === 'thread-added') {
          return {
            thread: {
              id: 'thread-added',
              parentThreadId,
              status: { type: 'active' },
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      });
      const host = createAppServerHost(config, () => {}, { client });
      t.after(() => host.destroy());

      const target = await host.resolveTarget();
      assert.equal(target.available, false);
      assert.equal(target.reason, 'shared_app_server_thread_unprovable');
    });
  }
});

test('gateway restart rejects a multi-node cycle in added thread lineage', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-cyclic-child-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  await createDurableTarget(config, 'turn-before-cyclic-children');

  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a', 'thread-added-a', 'thread-added-b'], nextCursor: null };
    }
    if (method === 'thread/read' && params.threadId === 'thread-added-a') {
      return {
        thread: {
          id: 'thread-added-a',
          parentThreadId: 'thread-added-b',
          status: { type: 'active' },
        },
      };
    }
    if (method === 'thread/read' && params.threadId === 'thread-added-b') {
      return {
        thread: {
          id: 'thread-added-b',
          parentThreadId: 'thread-added-a',
          status: { type: 'active' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(config, () => {}, { client });
  t.after(() => host.destroy());

  const target = await host.resolveTarget();
  assert.equal(target.available, false);
  assert.equal(target.reason, 'shared_app_server_thread_unprovable');
});

test('same-runtime topology refresh rejects a multi-node cycle before replacing its checkpoint', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-live-cyclic-child-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  let loadedThreadIds = ['thread-a'];
  let addedThreadReads = 0;
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: loadedThreadIds, nextCursor: null };
    }
    if (method === 'thread/read' && params.threadId === 'thread-a') {
      return {
        thread: {
          id: 'thread-a',
          parentThreadId: null,
          status: { type: 'active' },
          turns: [{ id: 'turn-live-cycle', status: 'inProgress', items: [] }],
        },
      };
    }
    if (method === 'thread/read' && params.threadId === 'thread-added-a') {
      addedThreadReads += 1;
      return {
        thread: {
          id: 'thread-added-a',
          parentThreadId: 'thread-added-b',
          status: { type: 'active' },
        },
      };
    }
    if (method === 'thread/read' && params.threadId === 'thread-added-b') {
      addedThreadReads += 1;
      return {
        thread: {
          id: 'thread-added-b',
          parentThreadId: 'thread-added-a',
          status: { type: 'active' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(config, () => {}, { client });
  t.after(() => host.destroy());

  assert.equal((await host.resolveTarget()).available, true);
  loadedThreadIds = ['thread-a', 'thread-added-a', 'thread-added-b'];
  for (const [id, parentThreadId] of [
    ['thread-added-a', 'thread-added-b'],
    ['thread-added-b', 'thread-added-a'],
  ]) {
    client.emit('notification', {
      method: 'thread/started',
      params: {
        thread: {
          id,
          parentThreadId,
          status: { type: 'active' },
        },
      },
    });
  }

  const target = await host.resolveTarget();
  assert.equal(target.available, false);
  assert.equal(target.reason, 'shared_app_server_thread_unprovable');
  assert.equal(addedThreadReads, 2);
  assert.equal(fs.existsSync(path.join(stateDir, 'app-server-target.json')), false);
});

test('topology revision retries share one bounded resolution budget', async (t) => {
  let loadedListRequests = 0;
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      loadedListRequests += 1;
      if (loadedListRequests <= 40) {
        queueMicrotask(() => {
          client.emit('notification', {
            method: 'thread/started',
            params: {
              thread: {
                id: `thread-worker-${loadedListRequests}`,
                parentThreadId: 'thread-a',
                status: { type: 'active' },
              },
            },
          });
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
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
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(
    { appServerUrl: 'ws://127.0.0.1:4500' },
    () => {},
    { client },
  );
  t.after(() => host.destroy());

  const target = await host.resolveTarget();
  assert.equal(target.available, false);
  assert.equal(target.reason, 'shared_app_server_thread_ambiguous');
  assert.ok(loadedListRequests <= 8, `expected a bounded retry budget, got ${loadedListRequests}`);
});

test('failed added-thread proof cannot be persisted by a later active notification', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-unproven-child-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  await createDurableTarget(config, 'turn-before-unproven-child');

  const failedClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a', 'thread-unproven'], nextCursor: null };
    }
    if (method === 'thread/read' && params.threadId === 'thread-unproven') {
      return { thread: null };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const failedHost = createAppServerHost(config, () => {}, { client: failedClient });
  const failedTarget = await failedHost.resolveTarget();
  assert.equal(failedTarget.available, false);
  assert.equal(failedTarget.reason, 'shared_app_server_thread_unprovable');
  failedClient.emit('notification', {
    method: 'thread/status/changed',
    params: {
      threadId: 'thread-a',
      status: { type: 'active' },
    },
  });
  failedHost.destroy();

  let addedThreadReads = 0;
  let rootThreadReads = 0;
  const recoveredClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a', 'thread-unproven'], nextCursor: null };
    }
    if (method === 'thread/read' && params.threadId === 'thread-unproven') {
      addedThreadReads += 1;
      return {
        thread: {
          id: 'thread-unproven',
          parentThreadId: 'thread-a',
          status: { type: 'active' },
        },
      };
    }
    if (method === 'thread/read' && params.threadId === 'thread-a') {
      rootThreadReads += 1;
      return {
        thread: {
          id: 'thread-a',
          parentThreadId: null,
          status: { type: 'active' },
          turns: [{
            id: 'turn-before-unproven-child',
            status: 'inProgress',
            items: [],
          }],
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const recoveredHost = createAppServerHost(config, () => {}, { client: recoveredClient });
  t.after(() => recoveredHost.destroy());

  const recoveredTarget = await recoveredHost.resolveTarget();
  assert.equal(recoveredTarget.available, true);
  assert.equal(recoveredTarget.threadId, 'thread-a');
  assert.equal(recoveredTarget.activeTurnId, 'turn-before-unproven-child');
  assert.equal(addedThreadReads, 1);
  assert.equal(rootThreadReads, 2);
});

test('gateway restart bounds added-thread lineage reads', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-bounded-child-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  await createDurableTarget(config, 'turn-before-many-children');

  const threadIds = [
    'thread-a',
    ...Array.from({ length: 33 }, (_, index) => `thread-child-${index + 1}`),
  ];
  let listCalls = 0;
  let lineageReads = 0;
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      listCalls += 1;
      const offset = params.cursor ? Number(params.cursor) : 0;
      const data = threadIds.slice(offset, offset + 2);
      const nextOffset = offset + data.length;
      return {
        data,
        nextCursor: nextOffset < threadIds.length ? String(nextOffset) : null,
      };
    }
    if (method === 'thread/read') {
      lineageReads += 1;
      return {
        thread: {
          id: params.threadId,
          parentThreadId: 'thread-a',
          status: { type: 'active' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(config, () => {}, { client });
  t.after(() => host.destroy());

  const target = await host.resolveTarget();
  assert.equal(target.available, false);
  assert.equal(target.reason, 'shared_app_server_thread_ambiguous');
  assert.equal(lineageReads, 0);
  assert.ok(listCalls <= 17);
});

test('gateway restart bounds unique empty pagination cursors', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-bounded-pagination-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  await createDurableTarget(config, 'turn-before-empty-pages');

  let listCalls = 0;
  const client = new FakeRpcClient(async (method) => {
    if (method === 'thread/loaded/list') {
      listCalls += 1;
      if (listCalls > 40) {
        const error = new Error('pagination exceeded the regression fail-safe');
        error.code = 'test_pagination_unbounded';
        throw error;
      }
      return {
        data: listCalls === 1 ? ['thread-a'] : [],
        nextCursor: `page-${listCalls}`,
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createAppServerHost(config, () => {}, { client });
  t.after(() => host.destroy());

  const target = await host.resolveTarget();
  assert.equal(target.available, false);
  assert.equal(target.reason, 'shared_app_server_thread_ambiguous');
  assert.ok(listCalls <= 33);
});

test('gateway restart discards a durable active target when a new top-level root appeared', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-new-root-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const firstClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-old'], nextCursor: null };
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
    if (method === 'turn/start') {
      return { turn: { id: 'turn-before-clear' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  const idleTarget = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-before-clear',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);
  firstHost.destroy();

  const secondClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-old', 'thread-after-clear'], nextCursor: null };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: params.threadId === 'thread-old' ? 'active' : 'idle' },
        },
      };
    }
    if (method === 'turn/steer') {
      throw new Error('stale root must not receive a structured turn');
    }
    throw new Error(`unexpected method ${method}`);
  });
  const secondHost = createAppServerHost(config, () => {}, { client: secondClient });
  t.after(() => secondHost.destroy());

  const target = await secondHost.resolveTarget();
  assert.equal(target.available, false);
  assert.equal(target.reason, 'shared_app_server_thread_ambiguous');
  assert.equal(fs.existsSync(path.join(stateDir, 'app-server-target.json')), false);
});

test('gateway restart discards a durable active target when the target thread is no longer loaded', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-stale-active-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const firstClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-old'], nextCursor: null };
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
    if (method === 'turn/start') {
      return { turn: { id: 'turn-old' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  const oldTarget = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: oldTarget.threadId,
    clientUserMessageId: 'discord:c1:m-old',
    input: [{ type: 'text', text: 'old thread work' }],
  }, oldTarget);
  assert.equal(
    fs.existsSync(path.join(stateDir, 'app-server-target.json')),
    true,
  );
  firstHost.destroy();

  const secondClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-new'], nextCursor: null };
    }
    if (method === 'thread/read') {
      assert.equal(params.threadId, 'thread-new');
      return {
        thread: {
          id: 'thread-new',
          parentThreadId: null,
          status: { type: 'idle' },
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const secondHost = createAppServerHost(config, () => {}, { client: secondClient });
  t.after(() => secondHost.destroy());

  const freshTarget = await secondHost.resolveTarget();
  assert.equal(freshTarget.available, true);
  assert.equal(freshTarget.threadId, 'thread-new');
  assert.equal(freshTarget.status, 'idle');
  assert.equal(
    secondClient.requests.some((request) => request.method === 'thread/read'),
    true,
  );
});

test('gateway restart clears a durable active target when no thread remains loaded', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-no-thread-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const firstClient = new FakeRpcClient(async (method, params) => {
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
    if (method === 'turn/start') {
      return { turn: { id: 'turn-before-close' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  const idleTarget = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-before-close',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);
  firstHost.destroy();

  const secondClient = new FakeRpcClient(async (method) => {
    if (method === 'thread/loaded/list') {
      return { data: [], nextCursor: null };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const secondHost = createAppServerHost(config, () => {}, { client: secondClient });
  t.after(() => secondHost.destroy());

  const target = await secondHost.resolveTarget();
  assert.equal(target.available, false);
  assert.equal(target.reason, 'shared_app_server_no_loaded_thread');
  assert.equal(fs.existsSync(path.join(stateDir, 'app-server-target.json')), false);
});

test('rejected durable active target is cleared before fresh thread resolution', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-rejected-durable-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const firstClient = new FakeRpcClient(async (method, params) => {
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
    if (method === 'turn/start') {
      return { turn: { id: 'turn-stale-after-restart' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  const idleTarget = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-create-durable',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);
  firstHost.destroy();

  const secondClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
    }
    if (method === 'turn/steer') {
      const error = new Error('expected turn is no longer active');
      error.code = 'shared_app_server_request_rejected';
      error.deliveryOutcome = 'rejected';
      throw error;
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
  const secondHost = createAppServerHost(config, () => {}, { client: secondClient });
  t.after(() => secondHost.destroy());

  const staleTarget = await secondHost.resolveTarget();
  await assert.rejects(
    secondHost.startTurn({
      threadId: staleTarget.threadId,
      clientUserMessageId: 'discord:c1:m-reject-durable',
      input: [{ type: 'text', text: 'must reject stale turn' }],
    }, staleTarget),
    (error) => error.deliveryOutcome === 'rejected',
  );
  assert.equal(fs.existsSync(path.join(stateDir, 'app-server-target.json')), false);

  secondClient.requests.length = 0;
  const freshTarget = await secondHost.resolveTarget();
  assert.equal(freshTarget.status, 'idle');
  assert.equal(
    secondClient.requests.some((request) => request.method === 'thread/read'),
    true,
  );
});

test('durable active target survives the initial app-server connection event after restart', async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-connect-active-target-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    appServerUrl: 'ws://127.0.0.1:4500',
    paths: { stateDir },
  };
  const firstClient = new FakeRpcClient(async (method, params) => {
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
    if (method === 'turn/start') {
      return { turn: { id: 'turn-after-connect' } };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const firstHost = createAppServerHost(config, () => {}, { client: firstClient });
  const idleTarget = await firstHost.resolveTarget();
  await firstHost.startTurn({
    threadId: idleTarget.threadId,
    clientUserMessageId: 'discord:c1:m-start',
    input: [{ type: 'text', text: 'start active work' }],
  }, idleTarget);
  firstHost.destroy();

  let clientStatus = {
    configured: true,
    available: false,
    reason: 'shared_app_server_not_connected',
  };
  const secondClient = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-a'], nextCursor: null };
    }
    if (method === 'thread/read') {
      throw new Error('initial connection must not discard the restart checkpoint');
    }
    if (method === 'turn/steer') {
      assert.equal(params.expectedTurnId, 'turn-after-connect');
      return { turnId: params.expectedTurnId };
    }
    throw new Error(`unexpected method ${method}`);
  });
  secondClient.status = () => clientStatus;
  const secondHost = createAppServerHost(config, () => {}, { client: secondClient });
  t.after(() => secondHost.destroy());

  clientStatus = { configured: true, available: true, reason: null };
  secondClient.emit('connectionChanged', { generation: 1 });

  const recoveredTarget = await secondHost.resolveTarget();
  assert.equal(recoveredTarget.available, true);
  assert.equal(recoveredTarget.activeTurnId, 'turn-after-connect');
});

test('active goal turn recovered from thread/read accepts input with an exact turn precondition', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    if (method === 'thread/loaded/list') {
      return { data: ['thread-goal'], nextCursor: null };
    }
    if (method === 'thread/read') {
      return {
        thread: {
          id: params.threadId,
          parentThreadId: null,
          status: { type: 'active', activeFlags: [] },
          turns: [{
            id: 'goal-continuation-2',
            status: 'inProgress',
            items: [],
          }],
        },
      };
    }
    assert.equal(method, 'turn/steer');
    return { turnId: params.expectedTurnId };
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });

  const target = await host.resolveTarget();
  assert.equal(
    client.requests.filter((request) => request.method === 'thread/read').at(-1).params.includeTurns,
    true,
  );
  assert.equal(target.activeTurnId, 'goal-continuation-2');
  client.requests.length = 0;
  const params = {
    threadId: 'thread-goal',
    clientUserMessageId: 'discord:c1:m-goal',
    input: [{ type: 'text', text: 'prioritize this input' }],
  };

  assert.deepEqual(await host.startTurn(params, target), { turnId: 'goal-continuation-2' });
  assert.deepEqual(client.requests, [{
    method: 'turn/steer',
    params: {
      ...params,
      expectedTurnId: 'goal-continuation-2',
    },
  }]);
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

test('signal before hasDelivered plus exact rollout proof completes without thread/read', async (t) => {
  const clientId = 'discord:c1:m-signal-before';
  const { codexHome } = createRolloutFixture(t, [
    sessionMeta(),
    deliveredUserMessage(clientId),
  ]);
  const client = new FakeRpcClient(async (method) => {
    throw new Error(`durable rollout proof must not request ${method}`);
  });
  const host = createLocalRolloutHost(client, codexHome);
  t.after(() => host.destroy());

  client.emit('notification', userLifecycleSignal(
    'item/started',
    DELIVERY_THREAD_ID,
    clientId,
  ));

  assert.equal(await host.hasDelivered(DELIVERY_THREAD_ID, clientId), true);
  assert.deepEqual(client.requests, []);
});

test('lifecycle signal without durable rollout evidence does not prove delivery', async (t) => {
  const clientId = 'discord:c1:m-signal-only';
  const { codexHome } = createRolloutFixture(t, [sessionMeta()]);
  const client = new FakeRpcClient(async (method, params) => {
    assert.equal(method, 'thread/read');
    return { thread: { id: params.threadId, turns: [] } };
  });
  const host = createLocalRolloutHost(client, codexHome);
  t.after(() => host.destroy());
  client.emit('notification', userLifecycleSignal(
    'item/completed',
    DELIVERY_THREAD_ID,
    clientId,
  ));

  assert.equal(await host.hasDelivered(DELIVERY_THREAD_ID, clientId), false);
  assert.deepEqual(client.requests, [{
    method: 'thread/read',
    params: { threadId: DELIVERY_THREAD_ID, includeTurns: true },
  }]);
});

test('late lifecycle signal verifies new rollout proof while thread/read hangs', async (t) => {
  const clientId = 'discord:c1:m-late-proof';
  const { codexHome, rolloutPath } = createRolloutFixture(t, [sessionMeta()]);
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const client = new FakeRpcClient(async (method) => {
    if (method === 'thread/read') {
      readStarted();
      return new Promise(() => {});
    }
    throw new Error(`unexpected method ${method}`);
  });
  const host = createLocalRolloutHost(client, codexHome);
  t.after(() => host.destroy());

  const deliveryProof = host.hasDelivered(DELIVERY_THREAD_ID, clientId);
  await started;
  fs.appendFileSync(rolloutPath, `${JSON.stringify(deliveredUserMessage(clientId))}\n`);
  client.emit('notification', userLifecycleSignal(
    'item/completed',
    DELIVERY_THREAD_ID,
    clientId,
  ));

  const result = await Promise.race([
    deliveryProof,
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);

  assert.equal(result, true);
  assert.equal(client.requests.length, 1);
});

test('late lifecycle signal without rollout proof cannot complete a hanging read', async (t) => {
  const clientId = 'discord:c1:m-late-signal-only';
  const { codexHome } = createRolloutFixture(t, [sessionMeta()]);
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const client = new FakeRpcClient(async (method) => {
    assert.equal(method, 'thread/read');
    readStarted();
    return new Promise(() => {});
  });
  const host = createLocalRolloutHost(client, codexHome);

  const deliveryProof = host.hasDelivered(DELIVERY_THREAD_ID, clientId);
  await started;
  client.emit('notification', userLifecycleSignal(
    'item/completed',
    DELIVERY_THREAD_ID,
    clientId,
  ));
  const result = await Promise.race([
    deliveryProof,
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
  ]);

  assert.equal(result, 'timed-out');
  host.destroy();
  assert.equal(await deliveryProof, false);
});

test('unrelated client ids, threads, and non-user lifecycle items do not wake exact proof', async (t) => {
  const clientId = 'discord:c1:m-exact-signal';
  const { codexHome, rolloutPath } = createRolloutFixture(t, [sessionMeta()]);
  let readStarted;
  const started = new Promise((resolve) => { readStarted = resolve; });
  const client = new FakeRpcClient(async (method) => {
    assert.equal(method, 'thread/read');
    readStarted();
    return new Promise(() => {});
  });
  const host = createLocalRolloutHost(client, codexHome);
  t.after(() => host.destroy());

  const deliveryProof = host.hasDelivered(DELIVERY_THREAD_ID, clientId);
  await started;
  fs.appendFileSync(rolloutPath, `${JSON.stringify(deliveredUserMessage(clientId))}\n`);
  for (const signal of [
    userLifecycleSignal('item/completed', DELIVERY_THREAD_ID, 'discord:c1:other'),
    userLifecycleSignal('item/completed', OTHER_DELIVERY_THREAD_ID, clientId),
    {
      method: 'item/completed',
      params: {
        threadId: DELIVERY_THREAD_ID,
        item: { type: 'agentMessage', clientId },
      },
    },
  ]) {
    client.emit('notification', signal);
  }

  assert.equal(await Promise.race([
    deliveryProof,
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 50)),
  ]), 'timed-out');

  client.emit('notification', userLifecycleSignal(
    'item/completed',
    DELIVERY_THREAD_ID,
    clientId,
  ));
  assert.equal(await deliveryProof, true);
  assert.equal(client.requests.length, 1);
});

test('exact rollout parser rejects wrong identity, wrong item, malformed data, and decoys', async (t) => {
  const clientId = 'discord:c1:m-parser-target';
  const cases = [
    {
      name: 'wrong thread rollout filename',
      records: [sessionMeta(OTHER_DELIVERY_THREAD_ID), deliveredUserMessage(clientId)],
      options: { filenameThreadId: OTHER_DELIVERY_THREAD_ID },
    },
    {
      name: 'wrong thread session identity',
      records: [sessionMeta(OTHER_DELIVERY_THREAD_ID), deliveredUserMessage(clientId)],
    },
    {
      name: 'wrong client id',
      records: [sessionMeta(), deliveredUserMessage('discord:c1:other')],
    },
    {
      name: 'non-user event',
      records: [
        sessionMeta(),
        { type: 'event_msg', payload: { type: 'agent_message', client_id: clientId } },
      ],
    },
    {
      name: 'malformed JSON only',
      records: ['{"type":"session_meta"', `{"client_id":"${clientId}"`],
    },
    {
      name: 'substring decoy in command and tool text',
      records: [
        sessionMeta(),
        { type: 'event_msg', payload: { type: 'exec_command_begin', command: `echo ${clientId}` } },
        { type: 'response_item', payload: { type: 'function_call', arguments: clientId } },
      ],
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const { codexHome } = createRolloutFixture(subtest, entry.records, entry.options);
      const client = new FakeRpcClient(async (_method, params) => ({
        thread: { id: params.threadId, turns: [] },
      }));
      const host = createLocalRolloutHost(client, codexHome);
      subtest.after(() => host.destroy());

      assert.equal(await host.hasDelivered(DELIVERY_THREAD_ID, clientId), false);
      assert.equal(client.requests.length, 1);
    });
  }
});

test('bounded tail verifier handles sparse rollouts larger than 128 MiB', async (t) => {
  const clientId = 'discord:c1:m-large-tail';
  await t.test('finds an exact recent user event without reading the full file', async (subtest) => {
    const { codexHome, size } = createSparseRolloutFixture(
      subtest,
      `${JSON.stringify(deliveredUserMessage(clientId))}\n`,
    );
    let bytesRead = 0;
    const rolloutFsPromises = {
      opendir: (...args) => fs.promises.opendir(...args),
      open: async (...args) => {
        const handle = await fs.promises.open(...args);
        return {
          close: () => handle.close(),
          stat: () => handle.stat(),
          async read(...readArgs) {
            const result = await handle.read(...readArgs);
            bytesRead += result.bytesRead;
            return result;
          },
        };
      },
    };
    const client = new FakeRpcClient(async (method) => {
      throw new Error(`large rollout proof must not request ${method}`);
    });
    const host = createLocalRolloutHost(client, codexHome, { rolloutFsPromises });
    subtest.after(() => host.destroy());

    assert.equal(size > 128 * 1024 * 1024, true);
    assert.equal(await host.hasDelivered(DELIVERY_THREAD_ID, clientId), true);
    assert.equal(bytesRead <= 33 * 1024 * 1024, true);
    assert.equal(bytesRead < size, true);
    assert.deepEqual(client.requests, []);
  });

  await t.test('falls back when the exact event is older than the bounded tail', async (subtest) => {
    const fixture = createRolloutFixture(subtest, [
      sessionMeta(),
      deliveredUserMessage(clientId),
    ]);
    const size = 160 * 1024 * 1024;
    const handle = fs.openSync(fixture.rolloutPath, 'r+');
    try {
      fs.ftruncateSync(handle, size);
      const recent = Buffer.from(`\n${JSON.stringify(deliveredUserMessage('discord:c1:recent'))}\n`);
      fs.writeSync(handle, recent, 0, recent.length, size - recent.length);
    } finally {
      fs.closeSync(handle);
    }
    const client = new FakeRpcClient(async (_method, params) => ({
      thread: { id: params.threadId, turns: [] },
    }));
    const host = createLocalRolloutHost(client, fixture.codexHome);
    subtest.after(() => host.destroy());

    assert.equal(await host.hasDelivered(DELIVERY_THREAD_ID, clientId), false);
    assert.equal(client.requests.length, 1);
  });

  for (const entry of [
    {
      name: 'rejects wrong id and substring decoys in the recent tail',
      tail: [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'exec_command_begin', command: `printf ${clientId}` },
        }),
        JSON.stringify(deliveredUserMessage('discord:c1:wrong-large-tail')),
        '',
      ].join('\n'),
    },
    {
      name: 'ignores an exact event in an incomplete trailing append',
      tail: JSON.stringify(deliveredUserMessage(clientId)),
    },
  ]) {
    await t.test(entry.name, async (subtest) => {
      const { codexHome } = createSparseRolloutFixture(subtest, entry.tail);
      const client = new FakeRpcClient(async (_method, params) => ({
        thread: { id: params.threadId, turns: [] },
      }));
      const host = createLocalRolloutHost(client, codexHome);
      subtest.after(() => host.destroy());

      assert.equal(await host.hasDelivered(DELIVERY_THREAD_ID, clientId), false);
      assert.equal(client.requests.length, 1);
    });
  }
});

test('local rollout verification fails closed on ambiguous exact filenames', async (t) => {
  const clientId = 'discord:c1:m-ambiguous';
  const first = createRolloutFixture(t, [sessionMeta(), deliveredUserMessage(clientId)]);
  const secondDir = path.join(first.codexHome, 'sessions', '2026', '07', '30');
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(
    path.join(secondDir, `rollout-2026-07-30T00-00-00-${DELIVERY_THREAD_ID}.jsonl`),
    `${JSON.stringify(sessionMeta())}\n${JSON.stringify(deliveredUserMessage(clientId))}\n`,
  );
  const client = new FakeRpcClient(async (_method, params) => ({
    thread: { id: params.threadId, turns: [] },
  }));
  const host = createLocalRolloutHost(client, first.codexHome);
  t.after(() => host.destroy());

  assert.equal(await host.hasDelivered(DELIVERY_THREAD_ID, clientId), false);
  assert.equal(client.requests.length, 1);
});

test('only verified durable results populate the bounded proof cache', async (t) => {
  const client = new FakeRpcClient(async (method) => {
    throw new Error(`verified cache test must not request ${method}`);
  });
  const host = createAppServerHost({}, () => {}, {
    client,
    verifyRolloutDelivery: async () => true,
  });
  t.after(() => host.destroy());

  for (let index = 0; index < 300; index += 1) {
    const suffix = index.toString(16).padStart(12, '0');
    const threadId = `019f3763-d308-7871-bedc-${suffix}`;
    client.emit('notification', userLifecycleSignal(
      'item/completed',
      threadId,
      `discord:c1:signal-${index}`,
    ));
  }
  assert.equal(host.verifiedUserMessages.size, 0);

  for (let index = 0; index < 300; index += 1) {
    const suffix = index.toString(16).padStart(12, '0');
    assert.equal(await host.hasDelivered(
      `019f3763-d308-7871-bedc-${suffix}`,
      `discord:c1:verified-${index}`,
    ), true);
  }
  assert.equal(host.verifiedUserMessages.size, 256);
  assert.equal(host.deliveryWaiters.size, 0);
});

test('restart without a lifecycle signal recovers from exact local rollout proof', async (t) => {
  const clientId = 'discord:c1:m-restart-proof';
  const { codexHome } = createRolloutFixture(t, [
    sessionMeta(),
    deliveredUserMessage(clientId),
  ]);
  const client = new FakeRpcClient(async (method) => {
    throw new Error(`restart rollout proof must not request ${method}`);
  });
  const host = createLocalRolloutHost(client, codexHome);
  t.after(() => host.destroy());

  assert.equal(await host.hasDelivered(DELIVERY_THREAD_ID, clientId), true);
  assert.deepEqual(client.requests, []);
});

test('hasDelivered falls back to exact structured thread/read after a missed notification', async () => {
  const client = new FakeRpcClient(async (method, params) => {
    assert.equal(method, 'thread/read');
    assert.deepEqual(params, { threadId: 'thread-a', includeTurns: true });
    return {
      thread: {
        id: 'thread-a',
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

test('hasDelivered rejects malformed or unsupported recovery instead of producing proof', async () => {
  let unsupported = false;
  const client = new FakeRpcClient(async (method) => {
    assert.equal(method, 'thread/read');
    if (unsupported) {
      const error = new Error('Unsupported method: thread/read');
      error.code = 'shared_app_server_request_rejected';
      throw error;
    }
    return {
      thread: {
        id: 'thread-other',
        turns: [{
          items: [{ type: 'userMessage', clientId: 'discord:c1:m-malformed' }],
        }],
      },
    };
  });
  const host = createAppServerHost({ appServerUrl: 'ws://127.0.0.1:4500' }, () => {}, { client });

  assert.equal(await host.hasDelivered('thread-a', 'discord:c1:m-malformed'), false);
  unsupported = true;
  await assert.rejects(
    host.hasDelivered('thread-a', 'discord:c1:m-unsupported'),
    (error) => error.code === 'shared_app_server_request_rejected',
  );
});

test('hasDelivered reconciles on the first connection without invalidating its own read', async (t) => {
  const { WebSocket } = createFakeWebSocket(async (request) => {
    if (request.method === 'initialize') return {};
    if (request.method === 'thread/read') {
      return {
        thread: {
          id: request.params.threadId,
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
