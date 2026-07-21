'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const modulePath = path.resolve(__dirname, '..', '..', 'src', 'session-launcher.js');
const contenderFixture = path.resolve(__dirname, '..', 'fixtures', 'startup-lock-contender.js');
const fakeCodex = path.resolve(__dirname, '..', 'fixtures', 'fake-codex.js');

function launcher() {
  assert.equal(fs.existsSync(modulePath), true, 'session launcher source must exist');
  return require(modulePath);
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(message));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function startContender(env) {
  const child = spawn(process.execPath, [contenderFixture], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    done: new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`contender exited ${code ?? signal}: ${stdout}\n${stderr}`));
      });
    }),
  };
}

function readTrace(tracePath) {
  if (!fs.existsSync(tracePath)) return [];
  return fs.readFileSync(tracePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function stopProcess(pid) {
  if (!processExists(pid)) return;
  process.kill(pid, 'SIGTERM');
  await waitFor(() => !processExists(pid), `app-server ${pid} did not stop`, 2000).catch(() => {});
  if (processExists(pid)) process.kill(pid, 'SIGKILL');
}

test('session endpoint is fixed to the isolated Discord state path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-session-state '));
  const stateDir = path.join(home, 'state with spaces');
  const { resolveSessionEndpoint } = launcher();
  assert.equal(
    resolveSessionEndpoint({ HOME: home, CODEX_HOME: path.join(home, '.codex'), DISCORD_STATE_DIR: stateDir }),
    `unix://${path.join(stateDir, 'app-server.sock')}`,
  );
  assert.throws(
    () => resolveSessionEndpoint({
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      DISCORD_STATE_DIR: stateDir,
      CODEX_DISCORD_APP_SERVER_URL: 'unix:///tmp/other.sock',
    }),
    /must match the Discord state path/,
  );
});

test('session launcher rejects caller-controlled remote attachment flags', () => {
  const { validateSessionArguments } = launcher();
  assert.deepEqual(validateSessionArguments(['resume', '--last']), ['resume', '--last']);
  for (const args of [
    ['--remote', 'unix:///tmp/other.sock'],
    ['--remote=unix:///tmp/other.sock'],
    ['--remote-auth-token-env', 'TOKEN'],
    ['--remote-auth-token-env=TOKEN'],
  ]) {
    assert.throws(() => validateSessionArguments(args), /managed by the Discord session launcher/);
  }
});

test('session timing settings are bounded positive integers', () => {
  const { sessionTiming } = launcher();
  assert.deepEqual(sessionTiming({}), { pollMs: 100, timeoutMs: 15000 });
  assert.deepEqual(sessionTiming({
    CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '25',
    CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '4000',
  }), { pollMs: 25, timeoutMs: 4000 });
  assert.throws(
    () => sessionTiming({ CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '1:2' }),
    /positive integer/,
  );
  assert.throws(
    () => sessionTiming({ CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '0' }),
    /positive integer/,
  );
});

test('concurrent startup cannot unlink a newly created lock before its owner record is committed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-startup-lock '));
  const stateDir = path.join(root, 'state');
  const lockPath = path.join(stateDir, 'app-server.start.lock');
  const tracePath = path.join(root, 'trace.jsonl');
  const barrierPath = path.join(root, 'owner-paused');
  const releasePath = path.join(root, 'release-owner');
  const protocolLog = path.join(root, 'protocol.jsonl');
  const loadedThread = path.join(root, 'loaded-thread.json');
  const visibleLog = path.join(root, 'visible.jsonl');
  const pidPath = path.join(stateDir, 'app-server.pid');
  let appServerPid = 0;
  let first;
  let second;

  t.after(async () => {
    await stopProcess(appServerPid);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const commonEnv = {
    ...process.env,
    CODEX_DISCORD_APP_SERVER_URL: `unix://${path.join(stateDir, 'app-server.sock')}`,
    CODEX_DISCORD_CODEX_BIN: fakeCodex,
    FAKE_CODEX_LOADED_THREAD: loadedThread,
    FAKE_CODEX_PROTOCOL_LOG: protocolLog,
    FAKE_CODEX_VISIBLE_LOG: visibleLog,
    SESSION_LAUNCHER_MODULE: modulePath,
    STARTUP_LOCK_BARRIER: barrierPath,
    STARTUP_LOCK_PATH: lockPath,
    STARTUP_LOCK_RELEASE: releasePath,
    STARTUP_LOCK_TRACE: tracePath,
  };

  try {
    first = startContender({
      ...commonEnv,
      STARTUP_LOCK_PAUSE_AFTER_ACQUIRE: '1',
      STARTUP_LOCK_RESULT: path.join(root, 'first-result.json'),
    });
    await waitFor(() => fs.existsSync(barrierPath), 'first contender did not pause after acquisition');

    second = startContender({
      ...commonEnv,
      STARTUP_LOCK_PAUSE_AFTER_ACQUIRE: '0',
      STARTUP_LOCK_RESULT: path.join(root, 'second-result.json'),
    });
    await waitFor(
      () => readTrace(tracePath).filter((entry) => entry.event === 'attempt').length >= 3,
      'second contender did not exercise the held startup lock twice',
    );

    const acquisitions = readTrace(tracePath).filter((entry) => entry.event === 'acquired');
    assert.equal(acquisitions.length, 1, 'exactly one contender may own startup coordination');
  } finally {
    fs.writeFileSync(releasePath, 'release\n', { mode: 0o600 });
    await Promise.allSettled([first?.done, second?.done].filter(Boolean));
    if (fs.existsSync(pidPath)) appServerPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  }
});

test('stale ownerless startup lock is recovered', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-stale-startup-lock '));
  const stateDir = path.join(root, 'state');
  const lockPath = path.join(stateDir, 'app-server.start.lock');
  const resultPath = path.join(root, 'result.json');
  const pidPath = path.join(stateDir, 'app-server.pid');
  let appServerPid = 0;

  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleTime, staleTime);

  t.after(async () => {
    await stopProcess(appServerPid);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const contender = startContender({
    ...process.env,
    CODEX_DISCORD_APP_SERVER_URL: `unix://${path.join(stateDir, 'app-server.sock')}`,
    CODEX_DISCORD_CODEX_BIN: fakeCodex,
    FAKE_CODEX_LOADED_THREAD: path.join(root, 'loaded-thread.json'),
    FAKE_CODEX_PROTOCOL_LOG: path.join(root, 'protocol.jsonl'),
    FAKE_CODEX_VISIBLE_LOG: path.join(root, 'visible.jsonl'),
    SESSION_LAUNCHER_MODULE: modulePath,
    STARTUP_LOCK_BARRIER: path.join(root, 'unused-barrier'),
    STARTUP_LOCK_PATH: lockPath,
    STARTUP_LOCK_PAUSE_AFTER_ACQUIRE: '0',
    STARTUP_LOCK_RELEASE: path.join(root, 'unused-release'),
    STARTUP_LOCK_RESULT: resultPath,
    STARTUP_LOCK_TIMEOUT_MS: '1000',
    STARTUP_LOCK_TRACE: path.join(root, 'trace.jsonl'),
  });

  await contender.done;
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(result.started, true);
  appServerPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  assert.equal(processExists(appServerPid), true);
});
