'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');

const TARGET_GENERATION = Symbol('appServerTargetGeneration');
const MAX_FRESH_THREAD_READS = 32;

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

function reconnectableError(error) {
  return [
    'shared_app_server_connect_failed',
    'shared_app_server_connect_timeout',
    'shared_app_server_disconnected',
    'shared_app_server_socket_missing',
  ].includes(error?.code);
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
    this.destroyed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.reconnectInitialDelayMs = Math.max(1, Number(deps.reconnectInitialDelayMs) || 250);
    this.reconnectMaxDelayMs = Math.max(
      this.reconnectInitialDelayMs,
      Number(deps.reconnectMaxDelayMs) || 5000,
    );
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
    if (this.destroyed) {
      throw deliveryError('Shared app-server client is shut down.', 'shared_app_server_disconnected');
    }
    const WebSocket = this.deps.WebSocket || require('ws');
    if (this.ws?.readyState === WebSocket.OPEN && this.state.available) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect(WebSocket);
    try {
      await this.connecting;
    } catch (error) {
      if (reconnectableError(error)) this.scheduleReconnect();
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  cancelReconnect() {
    if (this.reconnectTimer == null) return;
    (this.deps.clearTimeout || clearTimeout)(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  scheduleReconnect() {
    if (this.destroyed || !this.endpoint || this.reconnectTimer != null) return;
    const delay = Math.min(
      this.reconnectInitialDelayMs * (2 ** this.reconnectAttempt),
      this.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;
    const schedule = this.deps.setTimeout || setTimeout;
    this.reconnectTimer = schedule(async () => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
      try {
        await this.ensureConnected();
      } catch (error) {
        this.logger('WARN', 'Shared app-server reconnect failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
      }
    }, delay);
    if (typeof this.reconnectTimer?.unref === 'function') this.reconnectTimer.unref();
  }

  fenceConnection(ws, reason, pendingError, closeSocket = true) {
    if (this.ws !== ws) return false;
    this.ws = null;
    this.connectionGeneration += 1;
    this.state = { configured: true, available: false, reason };
    this.emit('connectionChanged', { generation: this.connectionGeneration });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pendingError);
    }
    this.pending.clear();
    if (closeSocket) {
      try {
        ws.close();
      } catch {}
    }
    this.scheduleReconnect();
    return true;
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

    const options = {
      handshakeTimeout: this.connectTimeoutMs,
      perMessageDeflate: false,
    };
    if (transport.socketPath) {
      options.createConnection = () => net.createConnection({ path: transport.socketPath });
    }
    const ws = new WebSocket(transport.url, options);
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

    if (this.destroyed) {
      ws.close();
      throw deliveryError('Shared app-server client is shut down.', 'shared_app_server_disconnected');
    }

    this.ws = ws;
    this.connectionGeneration += 1;
    const generation = this.connectionGeneration;
    ws.on('message', (data) => {
      if (this.ws !== ws || this.connectionGeneration !== generation) return;
      this.handleMessage(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    });
    ws.on('error', (error) => {
      this.logger('WARN', 'Shared app-server websocket error', { error: error.message });
    });
    ws.once('close', () => {
      const error = deliveryError(
        'Shared app-server disconnected before acknowledging the request.',
        'shared_app_server_disconnected',
        'uncertain',
      );
      this.fenceConnection(ws, 'shared_app_server_disconnected', error, false);
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
      const recovered = this.reconnectAttempt > 0;
      this.reconnectAttempt = 0;
      this.cancelReconnect();
      this.emit('connectionChanged', { generation, recovered });
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
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const timeoutError = deliveryError(
          `Shared app-server request timed out: ${method}`,
          'shared_app_server_request_timeout',
          'uncertain',
        );
        reject(timeoutError);
        this.fenceConnection(
          ws,
          'shared_app_server_request_timeout',
          deliveryError(
            'Shared app-server connection was fenced after a request timeout.',
            'shared_app_server_disconnected',
            'uncertain',
          ),
        );
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

  async requestOnConnection(
    method,
    params,
    expectedGeneration = null,
    beforeSend = null,
    acceptCompletedResponse = false,
  ) {
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
    if (typeof beforeSend === 'function') beforeSend();
    const result = await this.requestConnected(method, params);
    if (this.connectionGeneration !== generation && !acceptCompletedResponse) {
      throw deliveryError(
        'Shared app-server connection changed during target resolution.',
        'shared_app_server_disconnected',
      );
    }
    return { generation, result };
  }

  destroy() {
    this.destroyed = true;
    this.cancelReconnect();
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

class AppServerHost extends EventEmitter {
  constructor(config = {}, logger = () => {}, deps = {}) {
    super();
    this.client = deps.client || new AppServerRpcClient(config, logger, deps);
    this.lastStatus = this.client.status();
    this.hasConnected = Boolean(this.lastStatus.available);
    this.connectionWasLost = false;
    this.currentThreadId = '';
    this.threadSelectionRevision = 0;
    this.threadStatuses = new Map();
    this.onNotification = (notification) => {
      if (notification?.method === 'thread/started') {
        const thread = notification.params?.thread;
        if (thread?.id && !thread.parentThreadId) {
          this.threadSelectionRevision += 1;
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
        if (!threadId) return;
        this.threadSelectionRevision += 1;
        this.threadStatuses.delete(threadId);
        if (this.currentThreadId === threadId) {
          this.currentThreadId = '';
        }
        this.emit('threadClosed', { threadId });
      }
    };
    this.onConnectionChanged = (event) => {
      this.threadSelectionRevision += 1;
      this.currentThreadId = '';
      this.threadStatuses.clear();
      this.lastStatus = this.client.status();
      const reconnected = this.lastStatus.available && (this.connectionWasLost || event?.recovered);
      if (this.lastStatus.available) {
        this.hasConnected = true;
        this.connectionWasLost = false;
      } else if (this.hasConnected) {
        this.connectionWasLost = true;
      }
      if (reconnected) this.emit('reconnect', event);
    };
    this.client.on('notification', this.onNotification);
    this.client.on('connectionChanged', this.onConnectionChanged);
  }

  status() {
    return { ...this.lastStatus };
  }

  async resolveTarget() {
    const threadSelectionRevision = this.threadSelectionRevision;
    const threadIds = [];
    const seenThreadIds = new Set();
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
        if (this.threadSelectionRevision !== threadSelectionRevision) return this.resolveTarget();
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
        if (Array.isArray(loaded?.data)) {
          for (const threadId of loaded.data) {
            if (!seenThreadIds.has(threadId)) {
              seenThreadIds.add(threadId);
              threadIds.push(threadId);
            }
          }
        }
        if (this.currentThreadId && threadIds.includes(this.currentThreadId)) break;
        if (!this.currentThreadId && threadIds.length > MAX_FRESH_THREAD_READS) {
          const reason = 'shared_app_server_thread_ambiguous';
          this.lastStatus = { configured: true, available: false, reason };
          return { available: false, reason, status: 'unavailable' };
        }
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
    let response;
    if (this.currentThreadId && threadIds.includes(this.currentThreadId)) {
      threadId = this.currentThreadId;
    } else {
      const topLevelThreads = [];
      try {
        for (const candidateThreadId of threadIds) {
          const candidateResponse = await requestForTarget('thread/read', {
            threadId: candidateThreadId,
            includeTurns: false,
          });
          if (this.threadSelectionRevision !== threadSelectionRevision) return this.resolveTarget();
          const candidate = candidateResponse?.thread;
          if (!candidate || candidate.id !== candidateThreadId) {
            const reason = 'shared_app_server_thread_unprovable';
            this.lastStatus = { configured: true, available: false, reason };
            return { available: false, reason, status: 'unavailable' };
          }
          if (!candidate.parentThreadId) {
            topLevelThreads.push({ threadId: candidateThreadId, response: candidateResponse });
            if (topLevelThreads.length > 1) {
              const reason = 'shared_app_server_thread_ambiguous';
              this.lastStatus = { configured: true, available: false, reason };
              return { available: false, reason, status: 'unavailable' };
            }
          }
        }
      } catch (error) {
        if (this.threadSelectionRevision !== threadSelectionRevision) return this.resolveTarget();
        const reason = error?.code || 'shared_app_server_thread_unreadable';
        this.lastStatus = { configured: true, available: false, reason };
        return { available: false, reason, status: 'unavailable' };
      }
      if (topLevelThreads.length !== 1) {
        const reason = 'shared_app_server_thread_unprovable';
        this.lastStatus = { configured: true, available: false, reason };
        return { available: false, reason, status: 'unavailable' };
      }
      [{ threadId, response }] = topLevelThreads;
    }

    if (!response) {
      try {
        response = await requestForTarget('thread/read', {
          threadId,
          includeTurns: false,
        });
      } catch (error) {
        if (this.threadSelectionRevision !== threadSelectionRevision) return this.resolveTarget();
        const reason = error?.code || 'shared_app_server_thread_unreadable';
        this.lastStatus = { configured: true, available: false, reason };
        return { available: false, reason, status: 'unavailable' };
      }
    }
    if (this.threadSelectionRevision !== threadSelectionRevision) return this.resolveTarget();
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
    const target = { available: true, threadId: thread.id, status };
    Object.defineProperty(target, TARGET_GENERATION, {
      value: Object.freeze({ connectionGeneration, threadSelectionRevision }),
    });
    return target;
  }

  async startTurn(params, target) {
    const generation = target?.[TARGET_GENERATION];
    const validateTarget = () => {
      if (
        !generation ||
        generation.threadSelectionRevision !== this.threadSelectionRevision ||
        target.threadId !== params.threadId ||
        this.currentThreadId !== params.threadId
      ) {
        throw deliveryError(
          'The current app-server thread changed before turn/start.',
          'shared_app_server_thread_changed',
        );
      }
    };
    validateTarget();
    if (typeof this.client.requestOnConnection === 'function') {
      const response = await this.client.requestOnConnection(
        'turn/start',
        params,
        generation.connectionGeneration,
        validateTarget,
        true,
      );
      return response.result;
    }
    return this.client.request('turn/start', params);
  }

  async hasDelivered(threadId, clientUserMessageId) {
    const params = { threadId, includeTurns: true };
    let threadSelectionRevision;
    let response;
    if (typeof this.client.requestOnConnection === 'function') {
      await this.client.ensureConnected();
      threadSelectionRevision = this.threadSelectionRevision;
      response = (await this.client.requestOnConnection(
        'thread/read',
        params,
        this.client.connectionGeneration,
      )).result;
    } else {
      threadSelectionRevision = this.threadSelectionRevision;
      response = await this.client.request('thread/read', params);
    }
    if (this.threadSelectionRevision !== threadSelectionRevision) {
      throw deliveryError(
        'The current app-server thread changed during delivery reconciliation.',
        'shared_app_server_thread_changed',
      );
    }
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

  onReconnect(listener) {
    this.on('reconnect', listener);
    return () => this.off('reconnect', listener);
  }

  onThreadClosed(listener) {
    this.on('threadClosed', listener);
    return () => this.off('threadClosed', listener);
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
