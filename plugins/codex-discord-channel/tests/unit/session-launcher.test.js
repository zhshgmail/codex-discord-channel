'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  parseAppServerProbeArgs,
  probeAppServer,
  probeUnixSocketListener,
  resolveSessionAppServerEndpoint,
} = require('../../bin/codex-discord-channel');

const LAUNCHER = path.resolve(__dirname, '..', '..', 'bin', 'codex-discord-session');

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function stopTrackedServer(pidFile) {
  if (!fs.existsSync(pidFile)) return;
  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function runLauncher(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(LAUNCHER, args, { env, encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('app-server readiness probe requires only an initialized protocol connection', async () => {
  const calls = [];
  const client = {
    async ensureConnected() {
      calls.push('connected');
    },
    destroy() {
      calls.push('destroyed');
    },
  };

  const result = await probeAppServer({
    endpoint: 'unix:///tmp/disposable.sock',
    timeoutMs: 321,
  }, {
    createClient(config) {
      assert.equal(config.appServerUrl, 'unix:///tmp/disposable.sock');
      assert.equal(config.appServerConnectTimeoutMs, 321);
      assert.equal(config.appServerRequestTimeoutMs, 321);
      return client;
    },
  });

  assert.deepEqual(result, { available: true });
  assert.deepEqual(calls, ['connected', 'destroyed']);
});

test('app-server probe arguments require one absolute Unix endpoint', () => {
  assert.deepEqual(parseAppServerProbeArgs([
    '--endpoint',
    'unix:///tmp/disposable.sock',
    '--timeout-ms',
    '4321',
  ]), {
    endpoint: 'unix:///tmp/disposable.sock',
    timeoutMs: 4321,
  });
  assert.throws(
    () => parseAppServerProbeArgs(['--endpoint', 'ws://127.0.0.1:4500']),
    /absolute Unix socket/,
  );
});

test('Unix listener probe checks socket ownership without app-server initialization', async () => {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  const resultPromise = probeUnixSocketListener({
    endpoint: 'unix:///tmp/disposable.sock',
    timeoutMs: 321,
  }, {
    createConnection(options) {
      assert.deepEqual(options, { path: '/tmp/disposable.sock' });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  });

  assert.deepEqual(await resultPromise, { available: true });
});

test('session endpoint uses the runtime path resolver and rejects endpoint drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-session-path-'));
  assert.equal(resolveSessionAppServerEndpoint({
    HOME: root,
    DISCORD_STATE_DIR: '${HOME}/shared state',
  }), `unix://${path.join(root, 'shared state', 'app-server.sock')}`);
  assert.throws(() => resolveSessionAppServerEndpoint({
    HOME: root,
    DISCORD_STATE_DIR: '${HOME}/shared state',
    CODEX_DISCORD_APP_SERVER_URL: 'unix:///tmp/different.sock',
  }), /must match the Discord state path/);
  assert.throws(() => resolveSessionAppServerEndpoint({
    HOME: root,
    DISCORD_STATE_DIR: `${root}/unsafe\u001b[31m`,
  }), /control bytes/);
});

test('future visible sessions share one state-path app-server and always attach with --remote', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-session-launcher-'));
  const codexHome = path.join(root, 'codex-home');
  const fakeCodex = path.join(root, 'fake-codex');
  const fakeProbe = path.join(root, 'fake-probe');
  const fakeSocketProbe = path.join(root, 'fake-socket-probe');
  const fakeSetsid = path.join(root, 'fake-setsid');
  const readyFile = path.join(root, 'ready');
  const serverArgsFile = path.join(root, 'server-args.json');
  const serverStartsFile = path.join(root, 'server-starts');
  const tuiArgsFile = path.join(root, 'tui-args.json');
  const setsidArgsFile = path.join(root, 'setsid-args.json');

  fs.mkdirSync(codexHome, { recursive: true });
  writeExecutable(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  fs.writeFileSync(process.env.FAKE_SERVER_ARGS, JSON.stringify(args));
  fs.appendFileSync(process.env.FAKE_SERVER_STARTS, 'start\\n');
  setTimeout(() => fs.writeFileSync(process.env.FAKE_READY, 'ready\\n'), 100);
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(process.env.FAKE_TUI_ARGS, JSON.stringify(args));
}
`);
  writeExecutable(fakeProbe, '#!/bin/sh\ntest -f "$FAKE_READY"\n');
  writeExecutable(fakeSocketProbe, '#!/bin/sh\ntest -f "$FAKE_LISTENER"\n');
  writeExecutable(fakeSetsid, '#!/bin/sh\nprintf \'["%s","%s","%s","%s"]\\n\' "$1" "$2" "$3" "$4" >"$FAKE_SETSID_ARGS"\nexec "$@"\n');

  const env = {
    ...process.env,
    HOME: root,
    CODEX_HOME: codexHome,
    DISCORD_INSTANCE: 'Visible 01',
    DISCORD_STATE_DIR: '${HOME}/shared state',
    CODEX_DISCORD_CODEX_BIN: fakeCodex,
    CODEX_DISCORD_SESSION_PROBE_BIN: fakeProbe,
    CODEX_DISCORD_SESSION_SOCKET_PROBE_BIN: fakeSocketProbe,
    CODEX_DISCORD_SETSID_BIN: fakeSetsid,
    CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '5000',
    CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '20',
    FAKE_READY: readyFile,
    FAKE_LISTENER: path.join(root, 'listener'),
    FAKE_SERVER_ARGS: serverArgsFile,
    FAKE_SERVER_STARTS: serverStartsFile,
    FAKE_TUI_ARGS: tuiArgsFile,
    FAKE_SETSID_ARGS: setsidArgsFile,
  };
  const stateDir = path.join(root, 'shared state');
  const endpoint = `unix://${path.join(stateDir, 'app-server.sock')}`;
  const socketPath = path.join(stateDir, 'app-server.sock');
  const pidFile = path.join(stateDir, 'app-server.pid');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`);
  fs.writeFileSync(socketPath, 'stale\n');
  t.after(() => stopTrackedServer(pidFile));

  const [first, concurrent] = await Promise.all([
    runLauncher(['resume', '--last'], env),
    runLauncher(['resume', '--last'], env),
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(concurrent.status, 0, concurrent.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(serverArgsFile, 'utf8')), [
    'app-server',
    '--listen',
    endpoint,
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(setsidArgsFile, 'utf8')), [
    fakeCodex,
    'app-server',
    '--listen',
    endpoint,
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(tuiArgsFile, 'utf8')), [
    '--remote',
    endpoint,
    'resume',
    '--last',
  ]);
  assert.equal(fs.readFileSync(serverStartsFile, 'utf8'), 'start\n');
  assert.match(fs.readFileSync(pidFile, 'utf8'), /^\d+\n$/);

  const second = await runLauncher([], env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(serverStartsFile, 'utf8'), 'start\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(tuiArgsFile, 'utf8')), [
    '--remote',
    endpoint,
  ]);
});

test('live Unix listener gets the full readiness window and is never replaced', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-session-listener-'));
  const stateDir = path.join(root, 'state');
  const fakeCodex = path.join(root, 'fake-codex');
  const fakeProbe = path.join(root, 'fake-probe');
  const fakeSocketProbe = path.join(root, 'fake-socket-probe');
  const readyFile = path.join(root, 'ready');
  const startsFile = path.join(root, 'starts');
  const tuiArgsFile = path.join(root, 'tui-args.json');
  const socketPath = path.join(stateDir, 'app-server.sock');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(socketPath, 'listener placeholder\n');
  writeExecutable(fakeProbe, '#!/bin/sh\ntest -f "$FAKE_READY"\n');
  writeExecutable(fakeSocketProbe, '#!/bin/sh\nexit 0\n');
  writeExecutable(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  fs.appendFileSync(process.env.FAKE_SERVER_STARTS, 'start\\n');
  fs.writeFileSync(process.env.FAKE_READY, 'ready\\n');
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(process.env.FAKE_TUI_ARGS, JSON.stringify(args));
}
`);
  const env = {
    ...process.env,
    HOME: root,
    DISCORD_STATE_DIR: stateDir,
    CODEX_DISCORD_CODEX_BIN: fakeCodex,
    CODEX_DISCORD_SESSION_PROBE_BIN: fakeProbe,
    CODEX_DISCORD_SESSION_SOCKET_PROBE_BIN: fakeSocketProbe,
    CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '1000',
    CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '20',
    FAKE_READY: readyFile,
    FAKE_SERVER_STARTS: startsFile,
    FAKE_TUI_ARGS: tuiArgsFile,
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const readyTimer = setTimeout(() => fs.writeFileSync(readyFile, 'ready\n'), 100);
  t.after(() => clearTimeout(readyTimer));
  const result = await runLauncher(['resume', '--last'], env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(startsFile), false);
  assert.equal(fs.readFileSync(socketPath, 'utf8'), 'listener placeholder\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(tuiArgsFile, 'utf8')), [
    '--remote',
    `unix://${socketPath}`,
    'resume',
    '--last',
  ]);
});

test('slow live listener readiness is bounded by elapsed startup time', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-session-deadline-'));
  const stateDir = path.join(root, 'state');
  const fakeProbe = path.join(root, 'fake-probe');
  const fakeSocketProbe = path.join(root, 'fake-socket-probe');
  const probeCallsFile = path.join(root, 'probe-calls');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'app-server.sock'), 'listener placeholder\n');
  writeExecutable(fakeProbe, '#!/bin/sh\nprintf call\\n >>"$FAKE_PROBE_CALLS"\nsleep 0.05\nexit 1\n');
  writeExecutable(fakeSocketProbe, '#!/bin/sh\nexit 0\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const startedAt = Date.now();
  const result = await runLauncher([], {
    ...process.env,
    HOME: root,
    DISCORD_STATE_DIR: stateDir,
    CODEX_DISCORD_SESSION_PROBE_BIN: fakeProbe,
    CODEX_DISCORD_SESSION_SOCKET_PROBE_BIN: fakeSocketProbe,
    CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '150',
    CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '10',
    FAKE_PROBE_CALLS: probeCallsFile,
  });
  const elapsedMs = Date.now() - startedAt;
  const probeCalls = fs.readFileSync(probeCallsFile, 'utf8').trim().split('\n').length;

  assert.equal(result.status, 2);
  assert.match(result.stderr, /listener did not become protocol-ready/);
  assert.ok(probeCalls <= 7, `expected at most 7 probes, saw ${probeCalls}`);
  assert.ok(elapsedMs < 1000, `expected bounded startup, took ${elapsedMs}ms`);
});

test('launcher rejects a caller-supplied remote endpoint', () => {
  const result = spawnSync(LAUNCHER, ['--remote', 'unix:///tmp/other.sock'], {
    env: {
      ...process.env,
      CODEX_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-session-home-')),
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /managed from the Discord instance state path/);
});

test('launcher does not reflect control bytes from an invalid state path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-session-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(LAUNCHER, [], {
    env: {
      ...process.env,
      DISCORD_STATE_DIR: `${root}/unsafe\u001b[31m`,
      CODEX_DISCORD_CODEX_BIN: '/bin/false',
      CODEX_DISCORD_SESSION_PROBE_BIN: '/bin/false',
      CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '20',
      CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '10',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unable to resolve a safe state-path app-server endpoint/);
  assert.doesNotMatch(result.stderr, /\u001b/);
});
