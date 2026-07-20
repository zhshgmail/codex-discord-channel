'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');

function endpointToWebSocket(endpoint) {
  const value = String(endpoint || '').trim();
  if (value.startsWith('unix://')) {
    const socketPath = value.slice('unix://'.length);
    if (!socketPath.startsWith('/')) throw new Error('Shared app-server Unix socket must be absolute.');
    return { url: `ws+unix://${socketPath}:/rpc`, socketPath };
  }
  if (value.startsWith('ws://') || value.startsWith('wss://')) {
    return { url: value, socketPath: '' };
  }
  throw new Error('Shared app-server endpoint must use unix://, ws://, or wss://.');
}

function deliveryError(message, code, outcome = 'not_sent') {
  const error = new Error(message);
  error.code = code;
  error.deliveryOutcome = outcome;
  return error;
}

class AppServerRpcClient extends EventEmitter {
  constructor(config = {}, logger = () => {}, deps = {}) {
    super();
    this.endpoint = String(config.appServerUrl || '').trim();
    this.connectTimeoutMs = Number(config.appServerConnectTimeoutMs) || 10000;
    this.requestTimeoutMs = Number(config.appServerRequestTimeoutMs) || 30000;
    this.logger = logger;
    this.deps = deps;
    this.ws = null;
    this.connecting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connectionGeneration = 0;
    this.state = {
      configured: this.endpoint !== '',
      available: false,
      reason: this.endpoint ? 'shared_app_server_not_connected' : 'shared_app_server_unconfigured',
    };
    if (this.endpoint) {
      try {
        const { socketPath } = endpointToWebSocket(this.endpoint);
        if (socketPath && !(deps.fs || fs).existsSync(socketPath)) {
          this.state.reason = 'shared_app_server_socket_missing';
        }
      } catch {
        this.state.reason = 'shared_app_server_endpoint_invalid';
      }
    }
  }

  status() {
    return { ...this.state };
  }

  async ensureConnected() {
    const WebSocket = this.deps.WebSocket || require('ws');
    if (this.ws?.readyState === WebSocket.OPEN && this.state.available) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect(WebSocket);
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connect(WebSocket) {
    if (!this.endpoint) {
      throw deliveryError(
        'No shared app-server endpoint is configured.',
        'shared_app_server_unconfigured',
      );
    }
    let transport;
    try {
      transport = endpointToWebSocket(this.endpoint);
    } catch (error) {
      this.state = { configured: true, available: false, reason: 'shared_app_server_endpoint_invalid' };
      throw deliveryError(error.message, 'shared_app_server_endpoint_invalid');
    }
    if (transport.socketPath && !(this.deps.fs || fs).existsSync(transport.socketPath)) {
      this.state = { configured: true, available: false, reason: 'shared_app_server_socket_missing' };
      throw deliveryError(
        'The shared app-server Unix socket does not exist.',
        'shared_app_server_socket_missing',
      );
    }

    const ws = new WebSocket(transport.url, {
      handshakeTimeout: this.connectTimeoutMs,
      perMessageDeflate: false,
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(deliveryError(
          'Timed out connecting to the shared app-server.',
          'shared_app_server_connect_timeout',
        ));
      }, this.connectTimeoutMs);
      ws.once('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(deliveryError(
          `Unable to connect to the shared app-server: ${error.message}`,
          'shared_app_server_connect_failed',
        ));
      });
    });

    this.ws = ws;
    this.connectionGeneration += 1;
    const generation = this.connectionGeneration;
    this.emit('connectionChanged', { generation: this.connectionGeneration });
    ws.on('message', (data) => {
      if (this.ws !== ws || this.connectionGeneration !== generation) return;
      this.handleMessage(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    });
    ws.on('error', (error) => {
      this.logger('WARN', 'Shared app-server websocket error', { error: error.message });
    });
    ws.once('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connectionGeneration += 1;
      this.state = { configured: true, available: false, reason: 'shared_app_server_disconnected' };
      this.emit('connectionChanged', { generation: this.connectionGeneration });
      const error = deliveryError(
        'Shared app-server disconnected before acknowledging the request.',
        'shared_app_server_disconnected',
        'uncertain',
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });

    try {
      await this.requestConnected('initialize', {
        clientInfo: {
          name: 'codex-discord-channel',
          title: 'Discord Channel Gateway',
          version: '0.2.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            'command/exec/outputDelta',
            'item/commandExecution/outputDelta',
            'process/outputDelta',
            'item/fileChange/outputDelta',
            'item/reasoning/summaryTextDelta',
            'item/reasoning/textDelta',
            'item/plan/delta',
          ],
        },
      });
      this.sendRaw({ method: 'initialized' });
      this.state = { configured: true, available: true, reason: null };
    } catch (error) {
      ws.close();
      throw error;
    }
  }

  handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || message.error)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error) {
        const error = deliveryError(
          message.error.message || 'Shared app-server rejected the request.',
          /active|busy|in progress/i.test(message.error.message || '')
            ? 'thread_busy'
            : 'shared_app_server_request_rejected',
          'rejected',
        );
        error.rpcCode = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.emit('serverRequest', {
        id: message.id,
        method: message.method,
      });
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  sendRaw(payload) {
    const WebSocket = this.deps.WebSocket || require('ws');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw deliveryError('Shared app-server websocket is not open.', 'shared_app_server_disconnected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  requestConnected(method, params) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(deliveryError(
          `Shared app-server request timed out: ${method}`,
          'shared_app_server_request_timeout',
          'uncertain',
        ));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendRaw({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params) {
    await this.ensureConnected();
    return this.requestConnected(method, params);
  }

  async requestOnConnection(method, params, expectedGeneration = null) {
    if (expectedGeneration != null && this.connectionGeneration !== expectedGeneration) {
      throw deliveryError(
        'Shared app-server connection changed during target resolution.',
        'shared_app_server_disconnected',
      );
    }
    await this.ensureConnected();
    const generation = this.connectionGeneration;
    if (expectedGeneration != null && generation !== expectedGeneration) {
      throw deliveryError(
        'Shared app-server connection changed during target resolution.',
        'shared_app_server_disconnected',
      );
    }
    const result = await this.requestConnected(method, params);
    if (this.connectionGeneration !== generation) {
      throw deliveryError(
        'Shared app-server connection changed during target resolution.',
        'shared_app_server_disconnected',
      );
    }
    return { generation, result };
  }

  destroy() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

class AppServerHost extends EventEmitter {
  constructor(config = {}, logger = () => {}, deps = {}) {
    super();
    this.client = deps.client || new AppServerRpcClient(config, logger, deps);
    this.lastStatus = this.client.status();
    this.currentThreadId = '';
    this.threadStatuses = new Map();
    this.onNotification = (notification) => {
      if (notification?.method === 'thread/started') {
        const thread = notification.params?.thread;
        if (thread?.id && !thread.parentThreadId) {
          this.currentThreadId = thread.id;
          this.threadStatuses.set(thread.id, thread.status?.type || 'unavailable');
          if (thread.status?.type === 'idle') this.emit('idle', { threadId: thread.id });
        }
        return;
      }
      if (
        notification?.method === 'thread/status/changed' &&
        notification.params?.threadId
      ) {
        const { threadId, status } = notification.params;
        this.threadStatuses.set(threadId, status?.type || 'unavailable');
        if (threadId === this.currentThreadId && status?.type === 'idle') {
          this.emit('idle', { threadId });
        }
        return;
      }
      if (notification?.method === 'thread/closed') {
        const threadId = notification.params?.threadId;
        this.threadStatuses.delete(threadId);
        if (this.currentThreadId === threadId) this.currentThreadId = '';
      }
    };
    this.onConnectionChanged = () => {
      this.currentThreadId = '';
      this.threadStatuses.clear();
      this.lastStatus = this.client.status();
    };
    this.client.on('notification', this.onNotification);
    this.client.on('connectionChanged', this.onConnectionChanged);
  }

  status() {
    return { ...this.lastStatus };
  }

  async resolveTarget() {
    const threadIds = [];
    let cursor = '';
    let connectionGeneration = null;
    const seenCursors = new Set();
    const requestForTarget = async (method, params) => {
      if (typeof this.client.requestOnConnection !== 'function') {
        return this.client.request(method, params);
      }
      const response = await this.client.requestOnConnection(
        method,
        params,
        connectionGeneration,
      );
      connectionGeneration = response.generation;
      return response.result;
    };
    try {
      do {
        const params = { limit: 2 };
        if (cursor) params.cursor = cursor;
        const loaded = await requestForTarget('thread/loaded/list', params);
        if (loaded?.nextCursor != null && typeof loaded.nextCursor !== 'string') {
          const reason = 'shared_app_server_thread_ambiguous';
          this.lastStatus = { configured: true, available: false, reason };
          return { available: false, reason, status: 'unavailable' };
        }
        const nextCursor = loaded?.nextCursor || '';
        if (nextCursor && seenCursors.has(nextCursor)) {
          const reason = 'shared_app_server_thread_ambiguous';
          this.lastStatus = { configured: true, available: false, reason };
          return { available: false, reason, status: 'unavailable' };
        }
        if (Array.isArray(loaded?.data)) threadIds.push(...loaded.data);
        if (this.currentThreadId && threadIds.includes(this.currentThreadId)) break;
        cursor = nextCursor;
        if (cursor) seenCursors.add(cursor);
      } while (cursor);
    } catch (error) {
      const reason = error?.code || 'shared_app_server_unavailable';
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    if (threadIds.length === 0) {
      const reason = 'shared_app_server_no_loaded_thread';
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    let threadId = '';
    if (this.currentThreadId && threadIds.includes(this.currentThreadId)) {
      threadId = this.currentThreadId;
    } else if (threadIds.length === 1) {
      threadId = threadIds[0];
    } else {
      const reason = 'shared_app_server_thread_ambiguous';
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }

    let response;
    try {
      response = await requestForTarget('thread/read', {
        threadId,
        includeTurns: false,
      });
    } catch (error) {
      const reason = error?.code || 'shared_app_server_thread_unreadable';
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    const thread = response?.thread;
    if (!thread || thread.id !== threadId || thread.parentThreadId) {
      const reason = 'shared_app_server_thread_unprovable';
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    const status = thread.status?.type || 'unavailable';
    if (!['idle', 'active'].includes(status)) {
      const reason = 'shared_app_server_thread_unavailable';
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    this.currentThreadId = thread.id;
    this.threadStatuses.set(thread.id, status);
    this.lastStatus = { configured: true, available: true, reason: null };
    return { available: true, threadId: thread.id, status };
  }

  startTurn(params) {
    return this.client.request('turn/start', params);
  }

  async hasDelivered(threadId, clientUserMessageId) {
    const response = await this.client.request('thread/read', {
      threadId,
      includeTurns: true,
    });
    return (response?.thread?.turns || []).some((turn) => (
      (turn.items || []).some((item) => (
        item?.type === 'userMessage' && item.clientId === clientUserMessageId
      ))
    ));
  }

  onThreadIdle(listener) {
    this.on('idle', listener);
    return () => this.off('idle', listener);
  }

  destroy() {
    this.client.off('notification', this.onNotification);
    this.client.off('connectionChanged', this.onConnectionChanged);
    if (typeof this.client.destroy === 'function') this.client.destroy();
  }
}

function createAppServerHost(config = {}, logger = () => {}, deps = {}) {
  return new AppServerHost(config, logger, deps);
}

module.exports = {
  AppServerHost,
  AppServerRpcClient,
  createAppServerHost,
  endpointToWebSocket,
};
