#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');

function appendEvent(event) {
  fs.appendFileSync(process.env.FAKE_CODEX_PROTOCOL_LOG, `${JSON.stringify(event)}\n`, 'utf8');
}

function loadedThread() {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_LOADED_THREAD, 'utf8'));
  } catch {
    return null;
  }
}

function sendResult(socket, message, result) {
  socket.send(JSON.stringify({ id: message.id, result }));
}

function runAppServer(endpoint) {
  if (!endpoint.startsWith('unix:///')) throw new Error(`unexpected endpoint: ${endpoint}`);
  const socketPath = endpoint.slice('unix://'.length);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const server = http.createServer();
  const webSocketServer = new WebSocketServer({ server });
  webSocketServer.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      appendEvent({ process: 'app-server', method: message.method, params: message.params || null });
      if (!Object.hasOwn(message, 'id')) return;
      if (message.method === 'initialize') {
        sendResult(socket, message, { capabilities: {}, serverInfo: { name: 'fake-codex' } });
        return;
      }
      if (message.method === 'thread/loaded/list') {
        const thread = loadedThread();
        sendResult(socket, message, { data: thread ? [thread.id] : [], nextCursor: null });
        return;
      }
      if (message.method === 'thread/read') {
        const thread = loadedThread();
        sendResult(socket, message, { thread });
        return;
      }
      if (message.method === 'turn/start') {
        sendResult(socket, message, { turn: { id: 'turn-from-installed-probe' } });
        return;
      }
      socket.send(JSON.stringify({
        id: message.id,
        error: { code: -32601, message: `unsupported method: ${message.method}` },
      }));
    });
  });

  server.listen(socketPath, () => appendEvent({ process: 'app-server', event: 'listening', endpoint }));
  const stop = () => {
    for (const socket of webSocketServer.clients) socket.terminate();
    webSocketServer.close();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

function runVisibleSession(args) {
  const remoteIndex = args.indexOf('--remote');
  if (remoteIndex < 0 || !args[remoteIndex + 1]?.startsWith('unix:///')) {
    throw new Error(`visible session was not attached to the shared app-server: ${args.join(' ')}`);
  }
  const endpoint = args[remoteIndex + 1];
  const thread = {
    id: 'thread-loaded-by-visible-session',
    parentThreadId: null,
    status: { type: 'idle' },
    turns: [],
  };
  fs.writeFileSync(process.env.FAKE_CODEX_LOADED_THREAD, `${JSON.stringify(thread)}\n`, 'utf8');
  fs.appendFileSync(
    process.env.FAKE_CODEX_VISIBLE_LOG,
    `${JSON.stringify({ args, endpoint, threadId: thread.id })}\n`,
    'utf8',
  );
  appendEvent({ process: 'visible-session', event: 'loaded', endpoint, threadId: thread.id });
}

const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  const listenIndex = args.indexOf('--listen');
  runAppServer(args[listenIndex + 1] || '');
} else {
  runVisibleSession(args);
}
