'use strict';

const fs = require('node:fs');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

// The native TUI chooses the session. Never resolve --last ourselves or retain
// a thread ID: permission flags belong to this invocation, not Discord identity.
function permissionRequest(data, isTui, permissions) {
  let message;
  try { message = JSON.parse(data.toString()); } catch { return data; }
  if (!isTui || !message || typeof message !== 'object' || Array.isArray(message)
    || message.id === undefined
    || !['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)
    || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return data;
  return JSON.stringify({ ...message, params: { ...message.params, ...permissions } });
}

function connectRelay(front, backendUrl, permissions, startupState = { applied: false }) {
  const back = new WebSocket(backendUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
  // A client may reuse its RPC id after an explicit error. Give each override
  // attempt a one-use backend id; the prefix retires old replies without an
  // ever-growing id history. This is transport state, never session identity.
  const wirePrefix = `codex-permission:${randomBytes(16).toString('hex')}:`;
  let attempt = 0;
  const isWireId = id => typeof id === 'string' && id.startsWith(wirePrefix);
  let isTui = false;
  let pendingRequest;
  let closed = false;
  let queued = [];
  let queuedBytes = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    // A lost reply cannot prove that the backend rejected the override. This
    // invocation stays consumed across reconnects; retain no thread identity.
    if (pendingRequest && startupState.pending === pendingRequest) {
      startupState.applied = true;
      startupState.pending = null;
    }
    pendingRequest = undefined;
    queued = [];
    queuedBytes = 0;
    front.terminate();
    back.terminate();
  };
  const forward = (socket, data, binary) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED_BYTES) {
      close();
      return false;
    }
    try {
      socket.send(data, { binary }, error => { if (error) close(); });
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) close();
    } catch { close(); }
    return !closed;
  };
  front.on('error', close);
  back.on('error', close);
  front.on('close', close);
  back.on('close', close);
  front.on('message', (data, binary) => {
    if (closed) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch {}
    if (message?.method === 'initialize') {
      isTui = ['codex-tui', 'codex_cli_rs'].includes(message.params?.clientInfo?.name);
    }
    if (typeof message?.method === 'string'
      && (isWireId(message.id) || (pendingRequest && message.id === pendingRequest.id))) {
      // Reusing an in-flight client id or this connection's private backend
      // namespace is ambiguous. Server-request replies have no method and
      // remain transparent, even if their ids happen to use that namespace.
      close();
      return;
    }
    let outgoing = permissionRequest(data, isTui && !startupState.applied && !startupState.pending, permissions);
    if (outgoing !== data) {
      // Reserve before forwarding, including while the backend is connecting.
      if (attempt === Number.MAX_SAFE_INTEGER) { close(); return; }
      pendingRequest = { id: message.id, wireId: `${wirePrefix}${++attempt}` };
      startupState.pending = pendingRequest;
      outgoing = JSON.stringify({ ...JSON.parse(outgoing), id: pendingRequest.wireId });
    }
    if (back.readyState === WebSocket.OPEN) forward(back, outgoing, binary);
    else if (back.readyState === WebSocket.CONNECTING) {
      queuedBytes += Buffer.byteLength(outgoing);
      if (queuedBytes > MAX_BUFFERED_BYTES) close();
      else queued.push([outgoing, binary]);
    }
  });
  back.on('open', () => {
    for (const [data, binary] of queued) {
      if (!forward(back, data, binary)) break;
    }
    queued = [];
    queuedBytes = 0;
  });
  back.on('message', (data, binary) => {
    if (closed) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch {}
    let outgoing = data;
    if (message?.method === undefined && isWireId(message?.id)) {
      // Retired responses must neither settle the current reservation nor
      // reach a client that may have reused the original id for a new request.
      if (!pendingRequest || message.id !== pendingRequest.wireId) return;
      outgoing = JSON.stringify({ ...message, id: pendingRequest.id });
    }
    if (pendingRequest && startupState.pending === pendingRequest
      && message?.id === pendingRequest.wireId && message.method === undefined) {
      const hasResult = Object.hasOwn(message, 'result');
      const hasError = Object.hasOwn(message, 'error');
      const explicitError = hasError && message.error && !Array.isArray(message.error)
        && Number.isInteger(message.error.code) && typeof message.error.message === 'string';
      if ((hasResult && !hasError) || (explicitError && !hasResult)) {
        if (hasResult) startupState.applied = true;
        startupState.pending = null;
        pendingRequest = undefined;
      }
    }
    forward(front, outgoing, binary);
  });
}

async function runPermissionRelay(launch, endpoint, permissions) {
  if (!endpoint.startsWith('unix://')) throw new Error('Permission forwarding requires the instance Unix socket');
  const socket = endpoint.slice('unix://'.length);
  const nativeSocket = `${socket}.${process.pid}-${randomBytes(4).toString('hex')}`;
  if (Buffer.byteLength(nativeSocket) >= 108) throw new Error('Instance socket path is too long for permission forwarding');
  if (fs.existsSync(nativeSocket)) throw new Error('Native permission-forwarding socket already exists');
  const args = launch.args.map(arg => arg === endpoint ? `unix://${nativeSocket}` : arg);
  const child = spawn(launch.command, args, { env: launch.env, stdio: 'inherit' });
  const server = http.createServer();
  const sockets = new WebSocket.Server({ server, perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
  let nativeIdentity;
  let publicIdentity;
  let childError;
  const childExit = new Promise(resolve => {
    child.once('error', error => { childError = error; resolve(1); });
    child.once('exit', code => resolve(code ?? 1));
  });
  let resolveShutdown;
  let shutdownRequested = false;
  const shutdown = new Promise(resolve => { resolveShutdown = resolve; });
  const stop = () => { shutdownRequested = true; child.kill('SIGTERM'); resolveShutdown(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const identity = file => { try { const s = fs.statSync(file); return `${s.dev}:${s.ino}`; } catch { return null; } };
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(nativeSocket)) {
      if (shutdownRequested) throw new Error('Native app server startup cancelled');
      if (childError || child.exitCode !== null || child.signalCode !== null) throw childError || new Error('Native app server exited during startup');
      if (Date.now() >= deadline) throw new Error('Native app server socket startup timed out');
      await delay(25);
    }
    nativeIdentity = identity(nativeSocket);
    const startupState = { applied: false };
    sockets.on('connection', front => connectRelay(front, `ws+unix://${nativeSocket}:/rpc`, permissions, startupState));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    publicIdentity = identity(socket);
    fs.chmodSync(socket, 0o600);
    return await Promise.race([childExit, shutdown]);
  } finally {
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    // Both close() and natural libuv teardown unlink the original Unix path.
    // On replacement, finish owned cleanup then exit without libuv teardown.
    const replacedPublicSocket = publicIdentity && identity(socket) !== publicIdentity;
    if (publicIdentity && !replacedPublicSocket) server.close();
    else { server.closeAllConnections(); server.unref(); }
    stop();
    await Promise.race([childExit, delay(2000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await childExit;
    }
    for (const [file, expected] of [[nativeSocket, nativeIdentity], [socket, publicIdentity]]) {
      if (expected && identity(file) === expected) fs.unlinkSync(file);
    }
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (replacedPublicSocket) {
      fs.writeSync(2, 'Permission relay socket changed; preserved replacement and stopped owned backend.\n');
      process.exit(1);
    }
  }
}

module.exports = { permissionRequest, connectRelay, runPermissionRelay };
