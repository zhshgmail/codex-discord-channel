'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const pluginRoot = process.env.CODEX_DISCORD_TEST_PLUGIN_ROOT || path.resolve(__dirname, '../..');
const relayModule = path.join(pluginRoot, 'src/remote-permissions.js');

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error('Timed out waiting for the test relay');
}

function startFixture(t, mode = 'normal') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-permission-lifecycle-'));
  const socket = path.join(directory, 'app.sock');
  const backendPidFile = path.join(directory, 'backend.pid');
  const backendScript = path.join(directory, 'backend.cjs');
  fs.writeFileSync(backendScript, `
    const fs = require('node:fs');
    const net = require('node:net');
    const mode = process.env.TEST_BACKEND_MODE;
    fs.writeFileSync(process.env.TEST_BACKEND_PID_FILE, String(process.pid));
    if (mode === 'no-socket') {
      setInterval(() => {}, 1000);
      process.on('SIGTERM', () => {});
    } else {
      const server = net.createServer();
      server.listen(process.argv[2].slice('unix://'.length));
      process.on('SIGTERM', () => {
        if (mode !== 'stubborn') server.close(() => process.exit(0));
      });
    }
  `);
  const runnerScript = path.join(directory, 'runner.cjs');
  fs.writeFileSync(runnerScript, `
    const { runPermissionRelay } = require(${JSON.stringify(relayModule)});
    runPermissionRelay({
      command: process.execPath,
      args: [${JSON.stringify(backendScript)}, ${JSON.stringify(`unix://${socket}`)}],
      env: process.env,
    }, ${JSON.stringify(`unix://${socket}`)}, {
      approvalPolicy: 'never', sandbox: 'danger-full-access',
    }).then(
      code => { process.exitCode = code; },
      error => { console.error(error.message); process.exitCode = 1; },
    );
  `);
  const relay = spawn(process.execPath, [runnerScript], {
    env: {
      ...process.env,
      TEST_BACKEND_MODE: mode,
      TEST_BACKEND_PID_FILE: backendPidFile,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  let stderr = '';
  relay.stderr.on('data', data => { stderr += data; });
  const exited = once(relay, 'exit');
  t.after(async () => {
    // This isolated group contains only this test's relay and its fake backend.
    try { process.kill(-relay.pid, 'SIGKILL'); } catch {}
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, socket, backendPidFile, relay, exited, stderr: () => stderr };
}

async function stopFixture(fixture) {
  const started = Date.now();
  fixture.relay.kill('SIGTERM');
  const [code, signal] = await fixture.exited;
  return { elapsedMs: Date.now() - started, code, signal };
}

function assertBackendGone(fixture) {
  const backendPid = Number(fs.readFileSync(fixture.backendPidFile, 'utf8'));
  assert.equal(fs.existsSync(`/proc/${backendPid}`), false);
}

function assertSocketsGone(fixture) {
  assert.equal(fs.existsSync(fixture.socket), false);
  assert.equal(fs.readdirSync(fixture.directory).some(name => name.startsWith('app.sock.')), false);
}

test('permission relay removes owned sockets and reaps its backend', { timeout: 7000 }, async t => {
  const fixture = startFixture(t);
  await waitFor(() => fs.existsSync(fixture.socket));
  const result = await stopFixture(fixture);
  assert.equal(result.code, 0, fixture.stderr());
  assert.ok(result.elapsedMs < 3500, JSON.stringify(result));
  assertBackendGone(fixture);
  assertSocketsGone(fixture);
});

test('permission relay preserves a replacement listener at its public socket path', { timeout: 7000 }, async t => {
  const fixture = startFixture(t);
  await waitFor(() => fs.existsSync(fixture.socket));
  fs.renameSync(fixture.socket, `${fixture.socket}.owned`);
  const replacement = net.createServer(client => client.end('replacement listener'));
  replacement.listen(fixture.socket);
  await once(replacement, 'listening');
  try {
    const expectedInode = fs.statSync(fixture.socket).ino;
    const result = await stopFixture(fixture);
    assert.equal(result.code, 1, fixture.stderr());
    assert.equal(fs.statSync(fixture.socket).ino, expectedInode);
    const connection = net.createConnection(fixture.socket);
    let response = '';
    connection.on('data', data => { response += data; });
    await once(connection, 'end');
    assert.equal(response, 'replacement listener');
    assertBackendGone(fixture);
  } finally {
    await new Promise(resolve => replacement.close(resolve));
  }
});

test('permission relay bounds shutdown when its backend ignores SIGTERM', { timeout: 7000 }, async t => {
  const fixture = startFixture(t, 'stubborn');
  await waitFor(() => fs.existsSync(fixture.socket));
  const result = await stopFixture(fixture);
  assert.equal(result.code, 0, fixture.stderr());
  assert.ok(result.elapsedMs < 3500, JSON.stringify(result));
  assertBackendGone(fixture);
  assertSocketsGone(fixture);
});

test('permission relay bounds shutdown before its backend publishes a socket', { timeout: 7000 }, async t => {
  const fixture = startFixture(t, 'no-socket');
  await waitFor(() => fs.existsSync(fixture.backendPidFile));
  const result = await stopFixture(fixture);
  assert.equal(result.code, 1, fixture.stderr());
  assert.ok(result.elapsedMs < 3500, JSON.stringify(result));
  assertBackendGone(fixture);
  assertSocketsGone(fixture);
});
