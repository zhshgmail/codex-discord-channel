'use strict';

const fs = require('node:fs');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

// The native TUI chooses the session. Never resolve --last ourselves or retain
// a thread ID: permission flags belong to this invocation, not Discord identity.
function permissionRequest(data, isTui, permissions) {
  let message;
  try { message = JSON.parse(data.toString()); } catch { return data; }
  if (!isTui || !['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) return data;
  return JSON.stringify({ ...message, params: { ...message.params, ...permissions } });
}

function connectRelay(front, backendUrl, permissions, startupState = { applied: false }) {
  const back = new WebSocket(backendUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
  let isTui = false;
  const startupRequests = new Set();
  let queued = [];
  let queuedBytes = 0;
  const close = () => { front.terminate(); back.terminate(); queued = []; };
  front.on('error', close);
  back.on('error', close);
  front.on('close', () => back.terminate());
  back.on('close', () => front.terminate());
  front.on('message', (data, binary) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch {}
    if (message?.method === 'initialize') {
      isTui = ['codex-tui', 'codex_cli_rs'].includes(message.params?.clientInfo?.name);
    }
    const outgoing = permissionRequest(data, isTui && !startupState.applied, permissions);
    if (outgoing !== data && message?.id !== undefined) startupRequests.add(message.id);
    if (back.readyState === WebSocket.OPEN) back.send(outgoing, { binary });
    else if (back.readyState === WebSocket.CONNECTING) {
      queuedBytes += Buffer.byteLength(outgoing);
      if (queuedBytes > 16 * 1024 * 1024) close();
      else queued.push([outgoing, binary]);
    }
  });
  back.on('open', () => {
    for (const [data, binary] of queued) back.send(data, { binary });
    queued = [];
    queuedBytes = 0;
  });
  back.on('message', (data, binary) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch {}
    if (startupRequests.delete(message?.id) && message.result !== undefined) {
      startupState.applied = true;
      startupRequests.clear();
    }
    if (front.readyState === WebSocket.OPEN) front.send(data, { binary });
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
