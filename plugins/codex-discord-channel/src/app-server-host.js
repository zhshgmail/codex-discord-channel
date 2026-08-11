'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseTuiLease } = require('./tui-recovery-target');

const TARGET_GENERATION = Symbol('appServerTargetGeneration');
const MAX_FRESH_THREAD_READS = 32;
const MAX_LOADED_THREAD_PAGES = 32;
const MAX_TARGET_RESOLUTION_RESTARTS = 4;
const MAX_VERIFIED_USER_MESSAGES = 256;
const MAX_ROLLOUT_SEARCH_DEPTH = 4;
const MAX_ROLLOUT_SEARCH_DIRECTORIES = 4096;
const MAX_ROLLOUT_SEARCH_ENTRIES = 65536;
const MAX_ROLLOUT_HEADER_BYTES = 1024 * 1024;
const MAX_ROLLOUT_TAIL_BYTES = 32 * 1024 * 1024;
const MAX_ROLLOUT_LINE_BYTES = 4 * 1024 * 1024;
const MAX_LIFECYCLE_PROOF_SIGNAL_BATCHES = 2;
const MAX_LIFECYCLE_PROOF_ATTEMPTS = 4;
const MAX_LIFECYCLE_PROOF_DELAY_MS = 250;
const DEFAULT_LIFECYCLE_PROOF_RETRY_DELAYS_MS = Object.freeze([0, 25, 75, 200]);
const TARGET_CHECKPOINT_VERSION = 3;
const CANONICAL_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVE_TURN_MISMATCH = /^expected active turn id `([0-9a-f-]+)` but found `([0-9a-f-]+)`$/;

function parseTargetCheckpoint(raw) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  const legacyActive = record?.version === 1 && record.status === 'active' &&
    typeof record.activeTurnId === 'string' && record.activeTurnId !== '';
  if (
    ![1, 2, TARGET_CHECKPOINT_VERSION].includes(record?.version) ||
    (record.version === 1 && !legacyActive) ||
    (record.version === TARGET_CHECKPOINT_VERSION && (
      typeof record.leaseId !== 'string' || record.leaseId === ''
    )) ||
    typeof record.threadId !== 'string' ||
    record.threadId === '' ||
    !Array.isArray(record.loadedThreadIds) ||
    record.loadedThreadIds.length === 0 ||
    record.loadedThreadIds.some((threadId) => typeof threadId !== 'string' || threadId === '')
  ) {
    return null;
  }
  const loadedThreadIds = [...new Set(record.loadedThreadIds)].sort();
  if (
    loadedThreadIds.length !== record.loadedThreadIds.length ||
    !loadedThreadIds.includes(record.threadId)
  ) {
    return null;
  }
  return {
    version: TARGET_CHECKPOINT_VERSION,
    threadId: record.threadId,
    loadedThreadIds,
    leaseId: record.version === TARGET_CHECKPOINT_VERSION ? record.leaseId : '',
  };
}

function parseProcessStartTicks(raw) {
  const text = String(raw || '');
  const commandEnd = text.lastIndexOf(')');
  if (commandEnd < 0) return '';
  const fields = text.slice(commandEnd + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  return /^\d+$/.test(startTicks || '') ? startTicks : '';
}

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

function deliveryProofKey(threadId, clientUserMessageId) {
  return JSON.stringify([threadId, clientUserMessageId]);
}

function isLocalAppServer(endpoint) {
  const value = String(endpoint || '').trim();
  if (value.startsWith('unix://')) return true;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

function authoritativeActiveTurnMismatch(endpoint, pending, message) {
  if (
    !isLocalAppServer(endpoint) ||
    pending?.method !== 'turn/steer' ||
    typeof pending.params?.expectedTurnId !== 'string'
  ) {
    return null;
  }
  const match = ACTIVE_TURN_MISMATCH.exec(String(message || ''));
  if (!match) return null;
  const [, expectedTurnId, activeTurnId] = match;
  if (
    !CANONICAL_TURN_ID.test(expectedTurnId) ||
    !CANONICAL_TURN_ID.test(activeTurnId) ||
    expectedTurnId !== pending.params.expectedTurnId ||
    activeTurnId === expectedTurnId
  ) {
    return null;
  }
  return Object.freeze({
    expectedTurnId,
    activeTurnId,
    provenance: 'trusted_local_app_server_rejection',
  });
}

function rolloutSessionsDir(config, deps) {
  if (typeof deps.rolloutSessionsDir === 'string' && deps.rolloutSessionsDir !== '') {
    return path.resolve(deps.rolloutSessionsDir);
  }
  const env = config.env || process.env;
  const home = env.HOME || os.homedir();
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  return path.resolve(codexHome, 'sessions');
}

function lifecycleProofRetryDelays(value) {
  const delays = Array.isArray(value) && value.length > 0
    ? value
    : DEFAULT_LIFECYCLE_PROOF_RETRY_DELAYS_MS;
  return delays.slice(0, MAX_LIFECYCLE_PROOF_ATTEMPTS).map((delay) => (
    Math.min(MAX_LIFECYCLE_PROOF_DELAY_MS, Math.max(0, Number(delay) || 0))
  ));
}

async function findExactRolloutPath(sessionsDir, threadId, fsPromises) {
  if (!CANONICAL_THREAD_ID.test(threadId)) return null;
  const expectedSuffix = `-${threadId}.jsonl`;
  const pending = [{ directory: sessionsDir, depth: 0 }];
  const candidates = [];
  let directoryCount = 0;
  let entryCount = 0;

  while (pending.length > 0) {
    const current = pending.shift();
    directoryCount += 1;
    if (directoryCount > MAX_ROLLOUT_SEARCH_DIRECTORIES) return null;
    let directory;
    try {
      directory = await fsPromises.opendir(current.directory);
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > MAX_ROLLOUT_SEARCH_ENTRIES) return null;
        const entryPath = path.join(current.directory, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < MAX_ROLLOUT_SEARCH_DEPTH) {
            pending.push({ directory: entryPath, depth: current.depth + 1 });
          }
          continue;
        }
        if (
          entry.isFile() &&
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith(expectedSuffix)
        ) {
          candidates.push(entryPath);
          if (candidates.length > 1) return null;
        }
      }
    } catch {
      return null;
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function parseRolloutLine(line) {
  if (line.length === 0 || line.length > MAX_ROLLOUT_LINE_BYTES) return null;
  const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
  let record;
  try {
    record = JSON.parse(normalized.toString('utf8'));
  } catch {
    return null;
  }
  return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
}

async function readBoundedRange(handle, offset, length) {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
    if (bytesRead <= 0) return null;
    total += bytesRead;
  }
  return buffer;
}

async function rolloutContainsUserMessage(
  rolloutPath,
  threadId,
  clientUserMessageId,
  fsPromises,
) {
  let handle;
  try {
    handle = await fsPromises.open(rolloutPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || !Number.isSafeInteger(stat.size)) return false;

    const headerLength = Math.min(stat.size, MAX_ROLLOUT_HEADER_BYTES);
    const header = await readBoundedRange(handle, 0, headerLength);
    if (!header) return false;
    const headerEnd = header.indexOf(0x0a);
    if (headerEnd === -1) return false;
    const sessionMeta = parseRolloutLine(header.subarray(0, headerEnd));
    if (
      sessionMeta?.type !== 'session_meta' ||
      !sessionMeta.payload ||
      typeof sessionMeta.payload !== 'object' ||
      Array.isArray(sessionMeta.payload) ||
      sessionMeta.payload.id !== threadId
    ) {
      return false;
    }

    const tailLength = Math.min(stat.size, MAX_ROLLOUT_TAIL_BYTES);
    const tailOffset = stat.size - tailLength;
    const tail = await readBoundedRange(handle, tailOffset, tailLength);
    if (!tail) return false;
    let lowerBound = 0;
    if (tailOffset > 0) {
      const leadingNewline = tail.indexOf(0x0a);
      if (leadingNewline === -1) return false;
      lowerBound = leadingNewline + 1;
    }
    let completeEnd = tail.length;
    if (tail.at(-1) !== 0x0a) {
      const trailingNewline = tail.lastIndexOf(0x0a);
      if (trailingNewline < lowerBound) return false;
      completeEnd = trailingNewline + 1;
    }
    let lineEnd = completeEnd - 1;
    while (lineEnd >= lowerBound) {
      const previousNewline = tail.lastIndexOf(0x0a, lineEnd - 1);
      const lineStart = Math.max(lowerBound, previousNewline + 1);
      const record = parseRolloutLine(tail.subarray(lineStart, lineEnd));
      const payload = record?.payload;
      const item = payload?.item;
      const legacyUserMessage = (
        payload?.type === 'user_message' &&
        payload.client_id === clientUserMessageId
      );
      const completedUserMessage = (
        payload?.type === 'item_completed' &&
        payload.thread_id === threadId &&
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        item.type === 'UserMessage' &&
        item.client_id === clientUserMessageId
      );
      if (
        record?.type === 'event_msg' &&
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        (legacyUserMessage || completedUserMessage)
      ) {
        return true;
      }
      if (previousNewline < lowerBound) break;
      lineEnd = previousNewline;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {}
    }
  }
}

async function verifyLocalRolloutDelivery(
  sessionsDir,
  threadId,
  clientUserMessageId,
  fsPromises = fs.promises,
) {
  if (
    !CANONICAL_THREAD_ID.test(threadId) ||
    typeof clientUserMessageId !== 'string' ||
    clientUserMessageId === ''
  ) {
    return false;
  }
  const rolloutPath = await findExactRolloutPath(sessionsDir, threadId, fsPromises);
  if (!rolloutPath) return false;
  return rolloutContainsUserMessage(
    rolloutPath,
    threadId,
    clientUserMessageId,
    fsPromises,
  );
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
          version: '0.3.6',
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
        const mismatch = authoritativeActiveTurnMismatch(
          this.endpoint,
          pending,
          message.error.message,
        );
        const error = deliveryError(
          message.error.message || 'Shared app-server rejected the request.',
          mismatch || /active|busy|in progress/i.test(message.error.message || '')
            ? 'thread_busy'
            : 'shared_app_server_request_rejected',
          'rejected',
        );
        error.rpcCode = message.error.code;
        if (mismatch) error.authoritativeActiveTurnMismatch = mismatch;
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

  requestConnected(method, params, options = {}) {
    const id = String(this.nextId++);
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      const signal = options.signal || null;
      let abortListener = null;
      const cleanup = () => {
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(id);
        if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      };
      const pending = {
        method,
        params,
        timer: null,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      pending.timer = setTimeout(() => {
        if (this.pending.get(id) !== pending) return;
        const timeoutError = deliveryError(
          `Shared app-server request timed out: ${method}`,
          'shared_app_server_request_timeout',
          'uncertain',
        );
        pending.reject(timeoutError);
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
      this.pending.set(id, pending);
      if (signal) {
        abortListener = () => {
          if (this.pending.get(id) !== pending) return;
          pending.reject(deliveryError(
            `Shared app-server request cancelled: ${method}`,
            'shared_app_server_request_cancelled',
          ));
        };
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) {
          abortListener();
          return;
        }
      }
      try {
        this.sendRaw({ id, method, params });
      } catch (error) {
        pending.reject(error);
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
    signal = null,
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
    const result = await this.requestConnected(method, params, { signal });
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
    this.logger = logger;
    this.fs = deps.fs || fs;
    this.targetCheckpointPath = config.paths?.appServerTargetPath || (
      config.paths?.stateDir
        ? path.join(config.paths.stateDir, 'app-server-target.json')
        : ''
    );
    this.targetInvalidationPath = config.paths?.appServerTargetInvalidationPath || (
      config.paths?.stateDir
        ? path.join(config.paths.stateDir, 'app-server-target.invalidated.json')
        : ''
    );
    this.requireTuiLease = config.requireTuiLease === true;
    this.tuiLeasePath = config.paths?.stateDir
      ? path.join(config.paths.stateDir, 'tui-recovery-target.json')
      : '';
    this.tuiLeaseStaleMs = Math.max(1000, Number(config.tuiLeaseStaleMs) || 3000);
    this.now = deps.now || Date.now;
    this.readProcessStartTicks = deps.readProcessStartTicks || ((pid) => {
      try {
        return parseProcessStartTicks(this.fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      } catch {
        return '';
      }
    });
    this.hasRemoteTuiChild = deps.hasRemoteTuiChild || ((pid) => {
      let children;
      try {
        children = this.fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
      } catch {
        return false;
      }
      for (const childPid of children.trim().split(/\s+/).filter(Boolean)) {
        let argv;
        try {
          argv = this.fs.readFileSync(`/proc/${childPid}/cmdline`)
            .toString('utf8')
            .split('\0')
            .filter(Boolean);
        } catch {
          continue;
        }
        const remoteIndex = argv.indexOf('--remote');
        if (remoteIndex >= 0 && argv[remoteIndex + 1] === config.appServerUrl) return true;
      }
      return false;
    });
    this.client = deps.client || new AppServerRpcClient(config, logger, deps);
    this.lastStatus = this.client.status();
    this.hasConnected = Boolean(this.lastStatus.available);
    this.connectionWasLost = false;
    this.currentThreadId = '';
    this.threadSelectionRevision = 0;
    this.threadStatuses = new Map();
    this.activeTurnIds = new Map();
    this.activeTurnProvenance = new Map();
    this.knownLoadedThreadIds = new Set();
    this.verifiedUserMessages = new Map();
    this.deliveryWaiters = new Map();
    this.destroyed = false;
    this.lifecycleProofRetryDelaysMs = lifecycleProofRetryDelays(
      deps.lifecycleProofRetryDelaysMs,
    );
    const fsPromises = deps.rolloutFsPromises || fs.promises;
    const sessionsDir = rolloutSessionsDir(config, deps);
    this.verifyRolloutDelivery = typeof deps.verifyRolloutDelivery === 'function'
      ? deps.verifyRolloutDelivery
      : (isLocalAppServer(config.appServerUrl)
        ? (threadId, clientUserMessageId) => verifyLocalRolloutDelivery(
          sessionsDir,
          threadId,
          clientUserMessageId,
          fsPromises,
        )
        : async () => false);
    this.loadedInventoryProven = false;
    this.restoredTargetCheckpoint = this.loadTargetCheckpoint();
    this.observedTuiLeaseTarget = null;
    if (this.requireTuiLease && this.restoredTargetCheckpoint) {
      const checkpoint = this.restoredTargetCheckpoint;
      const lease = this.readTuiLease(checkpoint.threadId);
      if (!lease.available || lease.record.leaseId !== checkpoint.leaseId) {
        this.restoredTargetCheckpoint = null;
      }
    }
    if (this.restoredTargetCheckpoint) {
      const checkpoint = this.restoredTargetCheckpoint;
      this.currentThreadId = checkpoint.threadId;
      this.knownLoadedThreadIds = new Set(checkpoint.loadedThreadIds);
      if (this.requireTuiLease && checkpoint.leaseId) {
        this.observedTuiLeaseTarget = {
          leaseId: checkpoint.leaseId,
          threadId: checkpoint.threadId,
        };
      }
    }
    this.timeoutRecoveryTarget = null;
    this.onNotification = (notification) => {
      if (
        notification?.method === 'item/started' ||
        notification?.method === 'item/completed'
      ) {
        const threadId = notification.params?.threadId;
        const item = notification.params?.item;
        if (
          typeof threadId === 'string' &&
          threadId !== '' &&
          item?.type === 'userMessage' &&
          typeof item.clientId === 'string' &&
          item.clientId !== ''
        ) {
          this.wakeDeliveryWaiters(threadId, item.clientId);
        }
        return;
      }
      if (notification?.method === 'thread/started') {
        const thread = notification.params?.thread;
        if (thread?.id) {
          this.threadSelectionRevision += 1;
        }
        if (thread?.id && !thread.parentThreadId) {
          const lease = this.readTuiLease();
          const sameProvenRoot = thread.id === this.currentThreadId && (
            (
              this.loadedInventoryProven &&
              this.knownLoadedThreadIds.has(thread.id)
            ) || this.restoredTargetCheckpoint?.threadId === thread.id
          );
          const sameLease = !this.requireTuiLease || (
            lease.available &&
            lease.record &&
            this.observedTuiLeaseTarget?.leaseId === lease.record.leaseId &&
            this.observedTuiLeaseTarget.threadId === thread.id
          );
          if (sameProvenRoot && sameLease) {
            if (!this.threadStatuses.has(thread.id)) {
              this.threadStatuses.set(thread.id, thread.status?.type || 'unavailable');
            }
            if (
              thread.status?.type === 'idle' &&
              this.threadStatuses.get(thread.id) === 'idle'
            ) {
              this.emit('idle', { threadId: thread.id });
            }
            return;
          }
          this.observedTuiLeaseTarget = lease.available && lease.record
            ? { leaseId: lease.record.leaseId, threadId: thread.id }
            : null;
          this.loadedInventoryProven = false;
          this.invalidateTargetCheckpoint('top_level_thread_started');
          this.restoredTargetCheckpoint = null;
          this.activeTurnIds.delete(thread.id);
          this.activeTurnProvenance.delete(thread.id);
          this.currentThreadId = thread.id;
          this.threadStatuses.set(thread.id, thread.status?.type || 'unavailable');
          if (thread.status?.type === 'idle') this.emit('idle', { threadId: thread.id });
        }
        return;
      }
      if (notification?.method === 'turn/started') {
        const threadId = notification.params?.threadId;
        const turnId = notification.params?.turn?.id;
        if (!threadId || !turnId) return;
        this.threadStatuses.set(threadId, 'active');
        this.activeTurnIds.set(threadId, turnId);
        this.activeTurnProvenance.set(threadId, 'turn_started_notification');
        if (threadId === this.currentThreadId) {
          this.threadSelectionRevision += 1;
          this.persistTargetCheckpoint();
          this.emit('active', { threadId, turnId });
        }
        return;
      }
      if (notification?.method === 'turn/completed') {
        const threadId = notification.params?.threadId;
        const turnId = notification.params?.turn?.id;
        if (!threadId) return;
        if (!turnId || this.activeTurnIds.get(threadId) === turnId) {
          this.activeTurnIds.delete(threadId);
          this.activeTurnProvenance.delete(threadId);
        }
        if (
          this.timeoutRecoveryTarget?.threadId === threadId &&
          (!turnId || this.timeoutRecoveryTarget.turnId === turnId)
        ) {
          this.timeoutRecoveryTarget = null;
        }
        if (threadId === this.currentThreadId) {
          this.threadSelectionRevision += 1;
          this.persistTargetCheckpoint();
        }
        return;
      }
      if (
        notification?.method === 'thread/status/changed' &&
        notification.params?.threadId
      ) {
        const { threadId, status } = notification.params;
        const statusType = status?.type || 'unavailable';
        this.threadStatuses.set(threadId, statusType);
        if (statusType === 'idle') {
          this.activeTurnIds.delete(threadId);
          this.activeTurnProvenance.delete(threadId);
          if (this.timeoutRecoveryTarget?.threadId === threadId) {
            this.timeoutRecoveryTarget = null;
          }
          if (threadId === this.currentThreadId) {
            this.persistTargetCheckpoint();
          }
        } else if (statusType === 'active' && threadId === this.currentThreadId) {
          this.persistTargetCheckpoint();
        }
        if (threadId === this.currentThreadId) this.threadSelectionRevision += 1;
        if (threadId === this.currentThreadId && status?.type === 'idle') {
          this.emit('idle', { threadId });
        }
        return;
      }
      if (notification?.method === 'thread/closed') {
        const threadId = notification.params?.threadId;
        if (!threadId) return;
        this.threadSelectionRevision += 1;
        if (this.loadedInventoryProven) this.knownLoadedThreadIds.delete(threadId);
        this.threadStatuses.delete(threadId);
        this.activeTurnIds.delete(threadId);
        this.activeTurnProvenance.delete(threadId);
        if (this.timeoutRecoveryTarget?.threadId === threadId) {
          this.timeoutRecoveryTarget = null;
        }
        if (this.currentThreadId === threadId) {
          if (this.observedTuiLeaseTarget?.threadId === threadId) {
            this.observedTuiLeaseTarget = null;
          }
          this.loadedInventoryProven = false;
          this.currentThreadId = '';
          this.invalidateTargetCheckpoint('current_thread_closed');
          this.restoredTargetCheckpoint = null;
        }
        this.wakeThreadDeliveryWaiters(threadId);
        this.emit('threadClosed', { threadId });
      }
    };
    this.onConnectionChanged = (event) => {
      this.threadSelectionRevision += 1;
      this.loadedInventoryProven = false;
      this.lastStatus = this.client.status();
      if (
        !this.lastStatus.available &&
        this.lastStatus.reason === 'shared_app_server_request_timeout'
      ) {
        const turnId = this.activeTurnIds.get(this.currentThreadId);
        this.timeoutRecoveryTarget = (
          this.currentThreadId &&
          this.threadStatuses.get(this.currentThreadId) === 'active' &&
          turnId
        ) ? { threadId: this.currentThreadId, turnId } : null;
      }
      const retainTimeoutTarget = Boolean(this.timeoutRecoveryTarget) && (
        this.lastStatus.available ||
        this.lastStatus.reason === 'shared_app_server_request_timeout'
      );
      if (this.restoredTargetCheckpoint) {
        const checkpoint = this.restoredTargetCheckpoint;
        this.currentThreadId = checkpoint.threadId;
        this.threadStatuses.clear();
        this.activeTurnIds.clear();
        this.activeTurnProvenance.clear();
      } else if (retainTimeoutTarget) {
        const { threadId, turnId } = this.timeoutRecoveryTarget;
        this.currentThreadId = threadId;
        this.threadStatuses.clear();
        this.threadStatuses.set(threadId, 'active');
        this.activeTurnIds.clear();
        this.activeTurnIds.set(threadId, turnId);
        this.activeTurnProvenance.clear();
        this.activeTurnProvenance.set(threadId, 'timeout_recovery');
      } else {
        this.timeoutRecoveryTarget = null;
        this.currentThreadId = '';
        this.threadStatuses.clear();
        this.activeTurnIds.clear();
        this.activeTurnProvenance.clear();
        this.knownLoadedThreadIds.clear();
        this.clearTargetCheckpoint();
        this.restoredTargetCheckpoint = null;
      }
      const reconnected = this.lastStatus.available && (this.connectionWasLost || event?.recovered);
      if (this.lastStatus.available) {
        this.hasConnected = true;
        this.connectionWasLost = false;
      } else if (this.hasConnected) {
        this.connectionWasLost = true;
      }
      this.wakeAllDeliveryWaiters();
      if (reconnected) this.emit('reconnect', event);
    };
    this.client.on('notification', this.onNotification);
    this.client.on('connectionChanged', this.onConnectionChanged);
  }

  rememberVerifiedUserMessage(threadId, clientUserMessageId) {
    const key = deliveryProofKey(threadId, clientUserMessageId);
    this.verifiedUserMessages.delete(key);
    this.verifiedUserMessages.set(key, true);
    while (this.verifiedUserMessages.size > MAX_VERIFIED_USER_MESSAGES) {
      this.verifiedUserMessages.delete(this.verifiedUserMessages.keys().next().value);
    }
  }

  addDeliveryWaiter(key, waiter) {
    let waiters = this.deliveryWaiters.get(key);
    if (!waiters) {
      waiters = new Set();
      this.deliveryWaiters.set(key, waiters);
    }
    waiters.add(waiter);
  }

  removeDeliveryWaiter(key, waiter) {
    const waiters = this.deliveryWaiters.get(key);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) this.deliveryWaiters.delete(key);
  }

  wakeDeliveryWaiters(threadId, clientUserMessageId) {
    const waiters = this.deliveryWaiters.get(deliveryProofKey(threadId, clientUserMessageId));
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.verify();
  }

  wakeThreadDeliveryWaiters(threadId) {
    for (const waiters of this.deliveryWaiters.values()) {
      for (const waiter of [...waiters]) {
        if (waiter.threadId === threadId) waiter.verify();
      }
    }
  }

  wakeAllDeliveryWaiters() {
    for (const waiters of this.deliveryWaiters.values()) {
      for (const waiter of [...waiters]) waiter.verify();
    }
  }

  loadTargetCheckpoint() {
    if (!this.targetCheckpointPath) return null;
    try {
      return parseTargetCheckpoint(this.fs.readFileSync(this.targetCheckpointPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger('WARN', 'Unable to read app-server target checkpoint', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  }

  clearTargetCheckpoint() {
    if (!this.targetCheckpointPath) return;
    try {
      this.fs.unlinkSync(this.targetCheckpointPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger('WARN', 'Unable to clear app-server target checkpoint', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  clearTargetInvalidation() {
    if (!this.targetInvalidationPath) return;
    try {
      this.fs.unlinkSync(this.targetInvalidationPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger('WARN', 'Unable to clear app-server target invalidation', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  invalidateTargetCheckpoint(reason) {
    if (this.targetInvalidationPath) {
      const directory = path.dirname(this.targetInvalidationPath);
      const tempPath = `${this.targetInvalidationPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.fs.writeFileSync(tempPath, `${JSON.stringify({
          version: 1,
          reason,
          invalidatedAt: new Date().toISOString(),
        }, null, 2)}\n`, { mode: 0o600 });
        this.fs.renameSync(tempPath, this.targetInvalidationPath);
        this.fs.chmodSync(this.targetInvalidationPath, 0o600);
      } catch (error) {
        try {
          this.fs.unlinkSync(tempPath);
        } catch {}
        this.logger('WARN', 'Unable to persist app-server target invalidation', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.clearTargetCheckpoint();
  }

  persistTargetCheckpoint() {
    if (!this.targetCheckpointPath) return;
    const threadId = this.currentThreadId;
    if (
      !threadId ||
      !this.loadedInventoryProven ||
      !this.knownLoadedThreadIds.has(threadId)
    ) {
      return;
    }
    const lease = this.readTuiLease(threadId);
    if (!lease.available) return;
    const record = {
      version: this.requireTuiLease ? TARGET_CHECKPOINT_VERSION : 2,
      threadId,
      loadedThreadIds: [...this.knownLoadedThreadIds].sort(),
    };
    if (this.requireTuiLease) record.leaseId = lease.record.leaseId;
    const directory = path.dirname(this.targetCheckpointPath);
    const tempPath = `${this.targetCheckpointPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      this.fs.renameSync(tempPath, this.targetCheckpointPath);
      this.fs.chmodSync(this.targetCheckpointPath, 0o600);
      this.clearTargetInvalidation();
    } catch (error) {
      try {
        this.fs.unlinkSync(tempPath);
      } catch {}
      this.logger('WARN', 'Unable to persist app-server target checkpoint', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  status() {
    const status = { ...this.lastStatus };
    if (!status.available) return status;
    if (this.requireTuiLease && !this.currentThreadId) {
      return {
        configured: true,
        available: false,
        reason: 'shared_app_server_tui_lease_unbound',
      };
    }
    const lease = this.readTuiLease(this.currentThreadId);
    if (!lease.available) {
      return { configured: true, available: false, reason: lease.reason };
    }
    return status;
  }

  readTuiLease(expectedThreadId = '') {
    if (!this.requireTuiLease) return { available: true, record: null };
    if (!this.tuiLeasePath) {
      return { available: false, reason: 'shared_app_server_tui_lease_missing' };
    }

    let descriptor;
    try {
      descriptor = this.fs.openSync(this.tuiLeasePath, 'r');
      const stat = this.fs.fstatSync(descriptor);
      const record = parseTuiLease(this.fs.readFileSync(descriptor, 'utf8'));
      if (!record) {
        return { available: false, reason: 'shared_app_server_tui_lease_invalid' };
      }
      const ageMs = this.now() - stat.mtimeMs;
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.tuiLeaseStaleMs) {
        return { available: false, reason: 'shared_app_server_tui_lease_stale' };
      }
      const actualStartTicks = this.readProcessStartTicks(record.supervisorPid);
      if (!actualStartTicks) {
        return { available: false, reason: 'shared_app_server_tui_supervisor_missing' };
      }
      if (actualStartTicks !== record.supervisorStartTicks) {
        return { available: false, reason: 'shared_app_server_tui_supervisor_reused' };
      }
      if (!this.hasRemoteTuiChild(record.supervisorPid)) {
        return { available: false, reason: 'shared_app_server_tui_process_missing' };
      }
      if (expectedThreadId) {
        const activeMatch = record.phase === 'active' && record.threadId === expectedThreadId;
        const observedMatch = record.phase === 'launching'
          && this.observedTuiLeaseTarget?.leaseId === record.leaseId
          && this.observedTuiLeaseTarget.threadId === expectedThreadId;
        if (!activeMatch && !observedMatch) {
          const reason = record.phase === 'active'
            ? 'shared_app_server_tui_lease_mismatch'
            : 'shared_app_server_tui_lease_unbound';
          return { available: false, reason };
        }
      }
      return { available: true, record };
    } catch (error) {
      return {
        available: false,
        reason: error?.code === 'ENOENT'
          ? 'shared_app_server_tui_lease_missing'
          : 'shared_app_server_tui_lease_unreadable',
      };
    } finally {
      if (descriptor !== undefined) {
        try {
          this.fs.closeSync(descriptor);
        } catch {}
      }
    }
  }

  rememberAcceptedTurn(threadId, result, connectionGeneration = null) {
    const turnId = result?.turn?.id || result?.turnId;
    if (!threadId || typeof turnId !== 'string' || !turnId) return;
    if (
      connectionGeneration != null &&
      this.client.connectionGeneration !== connectionGeneration
    ) {
      return;
    }
    this.threadSelectionRevision += 1;
    this.currentThreadId = threadId;
    this.threadStatuses.set(threadId, 'active');
    this.activeTurnIds.set(threadId, turnId);
    this.activeTurnProvenance.set(threadId, 'turn_start_response');
    this.persistTargetCheckpoint();
    this.emit('active', { threadId, turnId });
  }

  async resolveTarget() {
    return this.resolveTargetAttempt({ revisionRestarts: 0 });
  }

  async resolveTargetAttempt(resolutionBudget) {
    const initialLease = this.readTuiLease();
    if (!initialLease.available) {
      const { reason } = initialLease;
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    if (
      this.requireTuiLease &&
      initialLease.record?.phase === 'launching' &&
      this.observedTuiLeaseTarget?.leaseId &&
      this.observedTuiLeaseTarget.leaseId !== initialLease.record.leaseId
    ) {
      this.threadSelectionRevision += 1;
      this.currentThreadId = '';
      this.threadStatuses.clear();
      this.activeTurnIds.clear();
      this.activeTurnProvenance.clear();
      this.knownLoadedThreadIds.clear();
      this.loadedInventoryProven = false;
      this.observedTuiLeaseTarget = null;
      this.invalidateTargetCheckpoint('tui_lease_replaced');
      this.restoredTargetCheckpoint = null;
    }
    this.loadedInventoryProven = false;
    const threadSelectionRevision = this.threadSelectionRevision;
    const restoredTargetCheckpoint = this.restoredTargetCheckpoint;
    const provenLoadedThreadIds = new Set(this.knownLoadedThreadIds);
    const threadIds = [];
    const seenThreadIds = new Set();
    let cursor = '';
    let connectionGeneration = null;
    const seenCursors = new Set();
    let loadedPageCount = 0;
    const retryAfterRevision = () => {
      resolutionBudget.revisionRestarts += 1;
      if (resolutionBudget.revisionRestarts > MAX_TARGET_RESOLUTION_RESTARTS) {
        const reason = 'shared_app_server_thread_ambiguous';
        this.lastStatus = { configured: true, available: false, reason };
        return { available: false, reason, status: 'unavailable' };
      }
      return this.resolveTargetAttempt(resolutionBudget);
    };
    const rejectUnprovableTopology = () => {
      const reason = 'shared_app_server_thread_unprovable';
      this.invalidateTargetCheckpoint(reason);
      this.restoredTargetCheckpoint = null;
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    };
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
        loadedPageCount += 1;
        if (loadedPageCount > MAX_LOADED_THREAD_PAGES) {
          const reason = 'shared_app_server_thread_ambiguous';
          this.lastStatus = { configured: true, available: false, reason };
          return { available: false, reason, status: 'unavailable' };
        }
        const params = { limit: 2 };
        if (cursor) params.cursor = cursor;
        const loaded = await requestForTarget('thread/loaded/list', params);
        if (this.threadSelectionRevision !== threadSelectionRevision) {
          return retryAfterRevision();
        }
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
        if (
          !Array.isArray(loaded?.data) ||
          loaded.data.some((threadId) => (
            typeof threadId !== 'string' || threadId.trim() === ''
          ))
        ) {
          const reason = 'shared_app_server_thread_ambiguous';
          this.lastStatus = { configured: true, available: false, reason };
          return { available: false, reason, status: 'unavailable' };
        }
        for (const threadId of loaded.data) {
          if (!seenThreadIds.has(threadId)) {
            seenThreadIds.add(threadId);
            threadIds.push(threadId);
            if (threadIds.length > MAX_FRESH_THREAD_READS) {
              const reason = 'shared_app_server_thread_ambiguous';
              this.lastStatus = { configured: true, available: false, reason };
              return { available: false, reason, status: 'unavailable' };
            }
          }
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
      if (restoredTargetCheckpoint) {
        this.currentThreadId = '';
        this.threadStatuses.clear();
        this.activeTurnIds.clear();
        this.activeTurnProvenance.clear();
        this.invalidateTargetCheckpoint('no_loaded_thread');
        this.restoredTargetCheckpoint = null;
      }
      const reason = 'shared_app_server_no_loaded_thread';
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    const loadedThreadIds = new Set(threadIds);
    const trustedThreadIds = restoredTargetCheckpoint
      ? new Set(restoredTargetCheckpoint.loadedThreadIds)
      : provenLoadedThreadIds;
    const validatedAddedResponses = new Map();
    let targetInvalid = Boolean(
      restoredTargetCheckpoint &&
      !loadedThreadIds.has(restoredTargetCheckpoint.threadId),
    );
    if (trustedThreadIds.size > 0) {
      const addedThreadIds = threadIds.filter((threadId) => !trustedThreadIds.has(threadId));
      const addedParents = new Map();
      const addedTopLevelThreadIds = new Set();
      try {
        for (const addedThreadId of addedThreadIds) {
          const addedResponse = await requestForTarget('thread/read', {
            threadId: addedThreadId,
            includeTurns: false,
          });
          if (this.threadSelectionRevision !== threadSelectionRevision) {
            return retryAfterRevision();
          }
          const addedThread = addedResponse?.thread;
          if (!addedThread || addedThread.id !== addedThreadId) {
            return rejectUnprovableTopology();
          }
          if (addedThread.parentThreadId == null) {
            addedTopLevelThreadIds.add(addedThreadId);
            addedParents.set(addedThreadId, null);
          } else if (
            typeof addedThread.parentThreadId !== 'string' ||
            addedThread.parentThreadId.trim() === ''
          ) {
            return rejectUnprovableTopology();
          } else {
            addedParents.set(addedThreadId, addedThread.parentThreadId);
          }
          validatedAddedResponses.set(addedThreadId, addedResponse);
        }
        for (const addedThreadId of addedThreadIds) {
          const lineage = new Set();
          let descendantId = addedThreadId;
          while (!trustedThreadIds.has(descendantId)) {
            if (lineage.has(descendantId)) {
              return rejectUnprovableTopology();
            }
            lineage.add(descendantId);
            const parentThreadId = addedParents.get(descendantId);
            if (parentThreadId == null) break;
            if (
              typeof parentThreadId !== 'string' ||
              !loadedThreadIds.has(parentThreadId)
            ) {
              return rejectUnprovableTopology();
            }
            descendantId = parentThreadId;
          }
        }
        if (
          addedTopLevelThreadIds.size > 0 &&
          (
            restoredTargetCheckpoint ||
            (
              !trustedThreadIds.has(this.currentThreadId) &&
              !addedTopLevelThreadIds.has(this.currentThreadId)
            )
          )
        ) {
          targetInvalid = true;
        }
      } catch (error) {
        const reason = error?.code || 'shared_app_server_thread_unreadable';
        this.lastStatus = { configured: true, available: false, reason };
        return { available: false, reason, status: 'unavailable' };
      }
    }
    if (restoredTargetCheckpoint || targetInvalid) {
      if (targetInvalid) {
        this.currentThreadId = '';
        this.threadStatuses.clear();
        this.activeTurnIds.clear();
        this.activeTurnProvenance.clear();
        this.invalidateTargetCheckpoint('restored_target_invalid');
      }
      this.restoredTargetCheckpoint = null;
    }
    let threadId = '';
    let response;
    if (
      this.currentThreadId &&
      threadIds.includes(this.currentThreadId) &&
      (
        trustedThreadIds.has(this.currentThreadId) ||
        validatedAddedResponses.has(this.currentThreadId)
      )
    ) {
      threadId = this.currentThreadId;
      response = validatedAddedResponses.get(threadId);
    } else {
      const topLevelThreads = [];
      const candidateParents = new Map();
      try {
        for (const candidateThreadId of threadIds) {
          const candidateResponse = await requestForTarget('thread/read', {
            threadId: candidateThreadId,
            includeTurns: false,
          });
          if (this.threadSelectionRevision !== threadSelectionRevision) {
            return retryAfterRevision();
          }
          const candidate = candidateResponse?.thread;
          if (!candidate || candidate.id !== candidateThreadId) {
            return rejectUnprovableTopology();
          }
          if (candidate.parentThreadId == null) {
            candidateParents.set(candidateThreadId, null);
            topLevelThreads.push({ threadId: candidateThreadId, response: candidateResponse });
          } else if (
            typeof candidate.parentThreadId !== 'string' ||
            candidate.parentThreadId.trim() === ''
          ) {
            return rejectUnprovableTopology();
          } else {
            candidateParents.set(candidateThreadId, candidate.parentThreadId);
          }
        }
        if (topLevelThreads.length > 0) {
          const rootThreadIds = new Set(topLevelThreads.map((candidate) => candidate.threadId));
          for (const candidateThreadId of threadIds) {
            const lineage = new Set();
            let descendantId = candidateThreadId;
            while (!rootThreadIds.has(descendantId)) {
              if (lineage.has(descendantId)) {
                return rejectUnprovableTopology();
              }
              lineage.add(descendantId);
              const parentThreadId = candidateParents.get(descendantId);
              if (
                typeof parentThreadId !== 'string' ||
                !loadedThreadIds.has(parentThreadId)
              ) {
                return rejectUnprovableTopology();
              }
              descendantId = parentThreadId;
            }
          }
        }
      } catch (error) {
        const reason = error?.code || 'shared_app_server_thread_unreadable';
        this.lastStatus = { configured: true, available: false, reason };
        return { available: false, reason, status: 'unavailable' };
      }
      const notifiedTarget = topLevelThreads.find((candidate) => (
        candidate.threadId === this.currentThreadId
      ));
      if (notifiedTarget) {
        ({ threadId, response } = notifiedTarget);
      } else if (topLevelThreads.length === 1) {
        [{ threadId, response }] = topLevelThreads;
        if (
          initialLease.record?.phase === 'launching' &&
          !this.currentThreadId &&
          !this.observedTuiLeaseTarget
        ) {
          this.observedTuiLeaseTarget = {
            leaseId: initialLease.record.leaseId,
            threadId,
          };
        }
      } else {
        const reason = topLevelThreads.length > 1
          ? 'shared_app_server_thread_ambiguous'
          : 'shared_app_server_thread_unprovable';
        if (reason === 'shared_app_server_thread_unprovable') {
          return rejectUnprovableTopology();
        }
        this.lastStatus = { configured: true, available: false, reason };
        return { available: false, reason, status: 'unavailable' };
      }
    }

    const cachedActiveTurnId = !response &&
      this.threadStatuses.get(threadId) === 'active' &&
      this.activeTurnIds.get(threadId);
    if (cachedActiveTurnId) {
      response = {
        thread: {
          id: threadId,
          parentThreadId: null,
          status: { type: 'active' },
          turns: [{
            id: cachedActiveTurnId,
            status: 'inProgress',
            items: [],
          }],
        },
      };
    }
    if (!response || (response?.thread?.status?.type === 'active' && !cachedActiveTurnId)) {
      try {
        response = await requestForTarget('thread/read', {
          threadId,
          includeTurns: true,
        });
      } catch (error) {
        const reason = error?.code || 'shared_app_server_thread_unreadable';
        this.lastStatus = { configured: true, available: false, reason };
        return { available: false, reason, status: 'unavailable' };
      }
    }
    if (this.threadSelectionRevision !== threadSelectionRevision) {
      return retryAfterRevision();
    }
    const thread = response?.thread;
    if (!thread || thread.id !== threadId || thread.parentThreadId) {
      return rejectUnprovableTopology();
    }
    const status = thread.status?.type || 'unavailable';
    if (!['idle', 'active', 'systemError'].includes(status)) {
      const reason = 'shared_app_server_thread_unavailable';
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    const matchingLease = this.readTuiLease(thread.id);
    if (!matchingLease.available) {
      const { reason } = matchingLease;
      this.lastStatus = { configured: true, available: false, reason };
      return { available: false, reason, status: 'unavailable' };
    }
    if (this.requireTuiLease && matchingLease.record) {
      this.observedTuiLeaseTarget = {
        leaseId: matchingLease.record.leaseId,
        threadId: thread.id,
      };
    }
    this.knownLoadedThreadIds = new Set(threadIds);
    this.loadedInventoryProven = true;
    this.currentThreadId = thread.id;
    this.threadStatuses.set(thread.id, status);
    if (status === 'active') {
      const latestInProgressTurnId = (Array.isArray(thread.turns) ? thread.turns : [])
        .filter((turn) => turn?.status === 'inProgress' && typeof turn.id === 'string' && turn.id)
        .map((turn) => turn.id)
        .at(-1);
      if (latestInProgressTurnId) {
        this.activeTurnIds.set(thread.id, latestInProgressTurnId);
        this.activeTurnProvenance.set(thread.id, 'thread_read');
      } else {
        this.activeTurnIds.delete(thread.id);
        this.activeTurnProvenance.delete(thread.id);
      }
    } else {
      this.activeTurnIds.delete(thread.id);
      this.activeTurnProvenance.delete(thread.id);
    }
    this.lastStatus = { configured: true, available: true, reason: null };
    const target = { available: true, threadId: thread.id, status };
    const activeTurnId = status === 'active' ? this.activeTurnIds.get(thread.id) : '';
    if (activeTurnId) target.activeTurnId = activeTurnId;
    this.persistTargetCheckpoint();
    Object.defineProperty(target, TARGET_GENERATION, {
      value: Object.freeze({
        connectionGeneration,
        threadSelectionRevision,
        threadId: thread.id,
        leaseId: matchingLease.record?.leaseId || '',
        activeTurnProvenance: this.activeTurnProvenance.get(thread.id) || '',
      }),
    });
    return target;
  }

  async startTurn(params, target) {
    const validateTarget = (candidate) => {
      const generation = candidate?.[TARGET_GENERATION];
      const lease = this.readTuiLease(params.threadId);
      if (!lease.available) {
        throw deliveryError(
          'The supervised TUI lease is no longer fresh for structured delivery.',
          lease.reason,
        );
      }
      const statusChanged = candidate?.status === 'active'
        ? !candidate.activeTurnId ||
          this.activeTurnIds.get(params.threadId) !== candidate.activeTurnId
        : this.threadStatuses.get(params.threadId) !== candidate?.status;
      const connectionChanged = generation?.connectionGeneration != null &&
        this.client.connectionGeneration !== generation.connectionGeneration;
      if (
        !generation ||
        connectionChanged ||
        generation.threadSelectionRevision !== this.threadSelectionRevision ||
        generation.threadId !== params.threadId ||
        generation.leaseId !== (lease.record?.leaseId || '') ||
        candidate.threadId !== params.threadId ||
        this.currentThreadId !== params.threadId ||
        statusChanged
      ) {
        throw deliveryError(
          'The current app-server thread changed before structured turn submission.',
          'shared_app_server_thread_changed',
        );
      }
      return lease;
    };

    const submit = async (candidate) => {
      const generation = candidate[TARGET_GENERATION];
      validateTarget(candidate);
      const method = candidate.status === 'active' ? 'turn/steer' : 'turn/start';
      const requestParams = candidate.status === 'active'
        ? { ...params, expectedTurnId: candidate.activeTurnId }
        : params;
      if (typeof this.client.requestOnConnection === 'function') {
        const response = await this.client.requestOnConnection(
          method,
          requestParams,
          generation.connectionGeneration,
          () => validateTarget(candidate),
          true,
        );
        return {
          method,
          result: response.result,
          acceptedGeneration: response.generation,
        };
      }
      return {
        method,
        result: await this.client.request(method, requestParams),
        acceptedGeneration: null,
      };
    };

    const rejectedWithoutSubmissionUncertainty = (error) => (
      error?.deliveryOutcome === 'rejected' || error?.deliveryOutcome === 'not_sent'
    );

    const invalidateChangedLease = (candidate) => {
      const generation = candidate?.[TARGET_GENERATION];
      if (!this.requireTuiLease || !generation || this.currentThreadId !== params.threadId) {
        return false;
      }
      const lease = this.readTuiLease(params.threadId);
      if (
        !lease.available ||
        !lease.record ||
        lease.record.leaseId === generation.leaseId
      ) {
        return false;
      }
      this.threadSelectionRevision += 1;
      this.timeoutRecoveryTarget = null;
      this.currentThreadId = '';
      this.threadStatuses.clear();
      this.activeTurnIds.clear();
      this.activeTurnProvenance.clear();
      this.knownLoadedThreadIds.clear();
      this.loadedInventoryProven = false;
      this.observedTuiLeaseTarget = null;
      this.invalidateTargetCheckpoint('tui_lease_replaced');
      this.restoredTargetCheckpoint = null;
      return true;
    };

    const clearUnprovenActiveTurn = (candidate) => {
      if (
        candidate?.status !== 'active' ||
        this.currentThreadId !== params.threadId ||
        this.activeTurnIds.get(params.threadId) !== candidate.activeTurnId
      ) {
        return;
      }
      this.threadSelectionRevision += 1;
      this.timeoutRecoveryTarget = null;
      this.threadStatuses.set(params.threadId, 'active');
      this.activeTurnIds.delete(params.threadId);
      this.activeTurnProvenance.delete(params.threadId);
      this.persistTargetCheckpoint();
    };

    const rebindAuthoritativeTurn = (candidate, error) => {
      const mismatch = error?.authoritativeActiveTurnMismatch;
      if (
        candidate?.status !== 'active' ||
        !rejectedWithoutSubmissionUncertainty(error) ||
        mismatch?.provenance !== 'trusted_local_app_server_rejection' ||
        mismatch.expectedTurnId !== candidate.activeTurnId ||
        !CANONICAL_TURN_ID.test(mismatch.activeTurnId) ||
        mismatch.activeTurnId === candidate.activeTurnId
      ) {
        return null;
      }
      let lease;
      try {
        lease = validateTarget(candidate);
      } catch {
        invalidateChangedLease(candidate);
        return null;
      }
      const generation = candidate[TARGET_GENERATION];
      this.threadSelectionRevision += 1;
      this.timeoutRecoveryTarget = null;
      this.currentThreadId = params.threadId;
      this.threadStatuses.set(params.threadId, 'active');
      this.activeTurnIds.set(params.threadId, mismatch.activeTurnId);
      this.activeTurnProvenance.set(
        params.threadId,
        mismatch.provenance,
      );
      this.persistTargetCheckpoint();
      const rebound = {
        available: true,
        threadId: params.threadId,
        status: 'active',
        activeTurnId: mismatch.activeTurnId,
      };
      Object.defineProperty(rebound, TARGET_GENERATION, {
        value: Object.freeze({
          connectionGeneration: generation.connectionGeneration,
          threadSelectionRevision: this.threadSelectionRevision,
          threadId: params.threadId,
          leaseId: lease.record?.leaseId || '',
          activeTurnProvenance: mismatch.provenance,
        }),
      });
      return rebound;
    };

    let submitted;
    try {
      submitted = await submit(target);
    } catch (error) {
      if (target?.status !== 'active') throw error;
      const rebound = rebindAuthoritativeTurn(target, error);
      if (!rebound) {
        if (rejectedWithoutSubmissionUncertainty(error)) {
          if (!invalidateChangedLease(target)) clearUnprovenActiveTurn(target);
        }
        throw error;
      }
      try {
        submitted = await submit(rebound);
      } catch (retryError) {
        const nextAuthoritative = rebindAuthoritativeTurn(rebound, retryError);
        if (nextAuthoritative) {
          retryError.code = 'thread_busy';
          throw retryError;
        }
        if (rejectedWithoutSubmissionUncertainty(retryError)) {
          if (!invalidateChangedLease(rebound)) clearUnprovenActiveTurn(rebound);
        }
        throw retryError;
      }
    }
    if (submitted.method === 'turn/start') {
      this.rememberAcceptedTurn(
        params.threadId,
        submitted.result,
        submitted.acceptedGeneration,
      );
    }
    return submitted.result;
  }

  async readDeliveredUserMessage(threadId, clientUserMessageId, signal = null) {
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
        null,
        false,
        signal,
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
    const thread = response?.thread;
    if (thread?.id !== threadId || !Array.isArray(thread.turns)) return false;
    return thread.turns.some((turn) => (
      (Array.isArray(turn?.items) ? turn.items : []).some((item) => (
        item?.type === 'userMessage' && item.clientId === clientUserMessageId
      ))
    ));
  }

  async hasDelivered(threadId, clientUserMessageId) {
    if (
      typeof threadId !== 'string' ||
      threadId === '' ||
      typeof clientUserMessageId !== 'string' ||
      clientUserMessageId === ''
    ) {
      return false;
    }
    const proofKey = deliveryProofKey(threadId, clientUserMessageId);
    if (this.verifiedUserMessages.has(proofKey)) return true;

    let durableProofResolved = false;
    let resolveDurableProof;
    const durableProof = new Promise((resolve) => {
      resolveDurableProof = () => {
        if (durableProofResolved) return;
        durableProofResolved = true;
        resolve({ kind: 'durable_proof' });
      };
    });
    let closedResolved = false;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = () => {
        if (closedResolved) return;
        closedResolved = true;
        resolve({ kind: 'closed' });
      };
    });
    let waiterActive = true;
    let verificationPromise = null;
    const requestVerification = () => {
      if (this.destroyed || !waiterActive) return Promise.resolve(false);
      if (verificationPromise) return verificationPromise;
      const currentVerification = (async () => {
        try {
          const verified = await this.verifyRolloutDelivery(threadId, clientUserMessageId);
          if (verified) {
            this.rememberVerifiedUserMessage(threadId, clientUserMessageId);
            resolveDurableProof();
          }
          return verified;
        } catch {
          return false;
        }
      })();
      verificationPromise = currentVerification;
      void currentVerification.finally(() => {
        if (verificationPromise === currentVerification) verificationPromise = null;
      });
      return currentVerification;
    };
    const retryWaits = new Set();
    const waitForRetry = (delayMs) => {
      if (this.destroyed || !waiterActive) return Promise.resolve(false);
      if (delayMs <= 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const wait = {
          timer: null,
          resolve: (ready) => {
            if (!retryWaits.delete(wait)) return;
            resolve(ready);
          },
        };
        wait.timer = setTimeout(() => wait.resolve(true), delayMs);
        retryWaits.add(wait);
      });
    };
    let signalVerificationRequested = false;
    let signalVerificationBatches = 0;
    let signalVerificationPromise = null;
    const requestSignalVerification = () => {
      if (this.destroyed || !waiterActive) return Promise.resolve(false);
      signalVerificationRequested = true;
      if (signalVerificationPromise) return signalVerificationPromise;
      const currentSignalVerification = (async () => {
        while (
          signalVerificationRequested &&
          signalVerificationBatches < MAX_LIFECYCLE_PROOF_SIGNAL_BATCHES &&
          !this.destroyed &&
          waiterActive
        ) {
          signalVerificationRequested = false;
          signalVerificationBatches += 1;
          for (const delayMs of this.lifecycleProofRetryDelaysMs) {
            if (!await waitForRetry(delayMs)) return false;
            if (await requestVerification()) return true;
          }
        }
        return false;
      })();
      signalVerificationPromise = currentSignalVerification;
      void currentSignalVerification.finally(() => {
        if (signalVerificationPromise === currentSignalVerification) {
          signalVerificationPromise = null;
        }
      });
      return currentSignalVerification;
    };
    const waiter = {
      threadId,
      verify: () => { void requestSignalVerification(); },
      close: resolveClosed,
    };
    this.addDeliveryWaiter(proofKey, waiter);
    const AbortControllerClass = globalThis.AbortController;
    const readAbort = AbortControllerClass ? new AbortControllerClass() : null;

    try {
      if (this.verifiedUserMessages.has(proofKey)) return true;
      if (await requestVerification()) return true;
      if (this.destroyed) return false;

      const readOutcome = this.readDeliveredUserMessage(
        threadId,
        clientUserMessageId,
        readAbort?.signal || null,
      ).then(
        (delivered) => ({ kind: 'thread_read', delivered }),
        (error) => ({ kind: 'thread_read_error', error }),
      );
      const outcome = await Promise.race([readOutcome, durableProof, closed]);
      if (outcome.kind === 'durable_proof') return true;
      if (outcome.kind === 'closed') return false;
      if (outcome.kind === 'thread_read' && outcome.delivered) {
        this.rememberVerifiedUserMessage(threadId, clientUserMessageId);
        return true;
      }

      if (signalVerificationPromise) await signalVerificationPromise;
      if (verificationPromise) await verificationPromise;
      if (this.verifiedUserMessages.has(proofKey)) return true;
      if (outcome.kind === 'thread_read_error') throw outcome.error;
      return false;
    } finally {
      waiterActive = false;
      for (const wait of [...retryWaits]) {
        clearTimeout(wait.timer);
        wait.resolve(false);
      }
      if (readAbort) readAbort.abort();
      this.removeDeliveryWaiter(proofKey, waiter);
    }
  }

  onThreadIdle(listener) {
    this.on('idle', listener);
    return () => this.off('idle', listener);
  }

  onThreadActive(listener) {
    this.on('active', listener);
    return () => this.off('active', listener);
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
    this.destroyed = true;
    for (const waiters of this.deliveryWaiters.values()) {
      for (const waiter of [...waiters]) waiter.close();
    }
    this.deliveryWaiters.clear();
    this.verifiedUserMessages.clear();
    this.activeTurnProvenance.clear();
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
