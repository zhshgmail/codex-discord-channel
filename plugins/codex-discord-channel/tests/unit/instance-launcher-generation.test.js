'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const sourceLauncher = path.join(pluginRoot, 'bin', 'codex-discord-instance');
const sourceGenerationHelper = path.join(pluginRoot, 'bin', 'codex-discord-generation');

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

function proc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return {
      state: tail[0],
      ppid: Number(tail[1]),
      pgid: Number(tail[2]),
      startTicks: tail[19],
    };
  } catch {
    return null;
  }
}

function alive(pid) {
  const state = proc(pid)?.state;
  return Boolean(state && state !== 'Z');
}

async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PID ${child.pid} did not exit`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function recordedProcesses(setup) {
  if (!fs.existsSync(setup.processTrace)) return [];
  return fs.readFileSync(setup.processTrace, 'utf8').trim().split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertRecordedDead(records, context) {
  for (const record of records) {
    const current = proc(record.pid);
    let command = '';
    if (current?.startTicks === record.startTicks) {
      try { command = fs.readFileSync(`/proc/${record.pid}/cmdline`).toString('utf8').replaceAll('\0', ' '); } catch {}
    }
    assert.equal(
      Boolean(current && current.startTicks === record.startTicks && current.state !== 'Z'),
      false,
      `${record.role} PID ${record.pid} survived ${context}: ${command}`,
    );
  }
}

function killFixtureProcesses(setup) {
  const ownGroup = proc(process.pid)?.pgid;
  const groups = new Set();
  const records = recordedProcesses(setup);
  for (const record of records) {
    const info = proc(record.pid);
    if (info && info.startTicks === record.startTicks && info.pgid === record.pgid
      && info.pgid > 1 && info.pgid !== ownGroup) groups.add(info.pgid);
  }
  for (const pgid of groups) {
    try { process.kill(-pgid, 'SIGKILL'); } catch {}
  }
  for (const record of records) {
    const info = proc(record.pid);
    if (record.pid !== process.pid && info && info.startTicks === record.startTicks) {
      try { process.kill(record.pid, 'SIGKILL'); } catch {}
    }
  }
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-generation-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  const plugin = path.join(home, 'plugin');
  const binDir = path.join(plugin, 'bin');
  const runtimeDir = path.join(plugin, 'runtime');
  const codexHome = path.join(home, '.codex-account-02');
  const launcher = path.join(binDir, 'codex-discord-instance');
  const generationHelper = path.join(binDir, 'codex-discord-generation');
  const channel = path.join(runtimeDir, 'channel.cjs');
  const codexWrapper = path.join(home, 'codex-wrapper.js');
  const nativeListener = path.join(home, 'native-listener.py');
  const tuiDescendant = path.join(home, 'tui-descendant.py');
  const processTrace = path.join(home, 'processes.jsonl');
  const socketPath = path.join(stateDir, 'app-server.sock');
  const manifestPath = path.join(stateDir, 'instance-generation.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.copyFileSync(sourceLauncher, launcher);
  fs.chmodSync(launcher, 0o700);
  if (fs.existsSync(sourceGenerationHelper)) {
    fs.copyFileSync(sourceGenerationHelper, generationHelper);
    fs.chmodSync(generationHelper, 0o700);
  }

  executable(channel, String.raw`#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] || '';
}
function procInfo() {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid: process.pid, ppid: Number(tail[1]), pgid: Number(tail[2]), startTicks: tail[19] };
}
function record(role) {
  fs.appendFileSync(process.env.PROCESS_TRACE, JSON.stringify({ role, ...procInfo() }) + '\n');
}
const command = process.argv[2];
if (command === 'tui-login-state' || command === 'tui-check' || command === 'live-check') process.exit(0);
if (command === 'tui-recovery-target') {
  const action = process.argv[3];
  const stateDir = value('--state-dir');
  const target = stateDir + '/tui-recovery-target.json';
  if (action === 'begin') fs.writeFileSync(target, '{}\n');
  if (action === 'clear' || action === 'clear-owned') fs.rmSync(target, { force: true });
  if (action === 'read') process.exit(10);
  process.exit(0);
}
if (command === 'gateway') {
  record('gateway');
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGHUP', () => process.exit(0));
  setInterval(() => {}, 1000);
} else if (command === 'app-server') {
  record('channel-wrapper');
  const stateDir = value('--state-dir');
  const endpoint = 'unix://' + stateDir + '/app-server.sock';
  process.execve(process.execPath, [
    process.execPath,
    process.env.FIXTURE_CODEX_BIN,
    'app-server',
    '--listen',
    endpoint,
  ], process.env);
} else {
  process.exit(2);
}
`);

  executable(codexWrapper, String.raw`#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
function procInfo() {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid: process.pid, ppid: Number(tail[1]), pgid: Number(tail[2]), startTicks: tail[19] };
}
function record(role, extra = {}) {
  fs.appendFileSync(process.env.PROCESS_TRACE, JSON.stringify({ role, ...procInfo(), ...extra }) + '\n');
}
if (process.argv[2] === 'app-server') {
  record('app-wrapper');
  const endpoint = process.argv[process.argv.indexOf('--listen') + 1];
  const socketPath = endpoint.replace(/^unix:\/\//, '');
  const native = spawn('python3', [process.env.NATIVE_LISTENER, socketPath], {
    env: process.env,
    stdio: 'ignore',
  });
  native.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  const onSignal = () => {
    if (process.env.APP_WRAPPER_TERM === 'ignore') return;
    if (process.env.APP_WRAPPER_TERM === 'delay') {
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    process.exit(0);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGHUP', onSignal);
  setInterval(() => {}, 1000);
} else if (process.argv.includes('--remote')) {
  record('tui');
  if (process.env.TUI_LEAVE_DESCENDANT === '1') {
    spawn('python3', [process.env.TUI_DESCENDANT], { env: process.env, stdio: 'ignore' });
  }
  if (process.env.TUI_STAY_ACTIVE === '1') {
    const stop = () => process.exit(0);
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('SIGHUP', stop);
    setInterval(() => {}, 1000);
  } else {
    setTimeout(() => process.exit(0), Number(process.env.TUI_EXIT_DELAY_MS || 100));
  }
} else {
  process.exit(0);
}
`);

  executable(tuiDescendant, String.raw`#!/usr/bin/env python3
import json, os, signal, time
def stop(_signum, _frame):
    if os.environ.get('TUI_DESCENDANT_IGNORE_TERM') == '1':
        return
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGHUP, stop)
with open(os.environ['PROCESS_TRACE'], 'a', encoding='utf-8') as out:
    stat = open('/proc/self/stat', encoding='utf-8').read()
    tail = stat[stat.rfind(')') + 2:].split()
    out.write(json.dumps({'role': 'tui-native-descendant', 'pid': os.getpid(), 'ppid': os.getppid(), 'pgid': os.getpgrp(), 'startTicks': tail[19]}) + '\n')
while True:
    time.sleep(0.1)
`);

  executable(nativeListener, String.raw`#!/usr/bin/env python3
import json, os, signal, socket, sys, time
path = sys.argv[1]
try:
    os.unlink(path)
except FileNotFoundError:
    pass
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(path)
sock.listen(1)
def stop(_signum, _frame):
    if os.environ.get('NATIVE_IGNORE_TERM') == '1':
        return
    sock.close()
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGHUP, stop)
with open(os.environ['PROCESS_TRACE'], 'a', encoding='utf-8') as out:
    stat = open('/proc/self/stat', encoding='utf-8').read()
    tail = stat[stat.rfind(')') + 2:].split()
    out.write(json.dumps({'role': 'native-listener', 'pid': os.getpid(), 'ppid': os.getppid(), 'pgid': os.getpgrp(), 'startTicks': tail[19]}) + '\n')
while True:
    time.sleep(0.1)
`);

  fs.writeFileSync(path.join(stateDir, 'account.env'), [
    `CODEX_HOME=${codexHome}`,
    `CODEX_BIN=${codexWrapper}`,
    `NODE_BIN=${process.execPath}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(stateDir, '.env'), '\n');
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}\n');
  fs.writeFileSync(path.join(codexHome, 'discord-instance.env'), [
    'DISCORD_INSTANCE=codex02',
    `DISCORD_CONFIG_DIR=${stateDir}`,
    '',
  ].join('\n'));

  const setup = {
    channel,
    codexHome,
    codexWrapper,
    generationHelper,
    home,
    launcher,
    manifestPath,
    nativeListener,
    processTrace,
    socketPath,
    stateDir,
    tuiDescendant,
  };
  t.after(() => {
    killFixtureProcesses(setup);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return setup;
}

function env(setup, overrides = {}) {
  return {
    ...process.env,
    APP_WRAPPER_TERM: 'ignore',
    CODEX_DISCORD_START_TIMEOUT_SECONDS: '3',
    CODEX_DISCORD_STOP_TIMEOUT_MS: '150',
    DISCORD_BOT_TOKEN: 'fixture-secret',
    DISCORD_BOT_USER_ID: 'fixture-bot',
    FIXTURE_CODEX_BIN: setup.codexWrapper,
    HOME: setup.home,
    NATIVE_LISTENER: setup.nativeListener,
    PROCESS_TRACE: setup.processTrace,
    TUI_DESCENDANT: setup.tuiDescendant,
    TUI_EXIT_DELAY_MS: '100',
    ...overrides,
  };
}

function launch(setup, overrides = {}) {
  const child = spawn(setup.launcher, ['codex02'], {
    env: env(setup, overrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  return child;
}

async function readyLauncher(setup, overrides = {}) {
  const child = launch(setup, { TUI_STAY_ACTIVE: '1', ...overrides });
  await waitFor(() => fs.existsSync(setup.socketPath), 'app-server socket');
  await waitFor(
    () => recordedProcesses(setup).some((item) => item.role === 'native-listener'),
    'native listener process',
  );
  return child;
}

async function orphanReadyGeneration(setup, overrides = {}) {
  const launcher = await readyLauncher(setup, {
    CODEX_DISCORD_STOP_TIMEOUT_MS: '5000',
    NATIVE_IGNORE_TERM: '1',
    ...overrides,
  });
  await waitFor(() => {
    if (!fs.existsSync(setup.manifestPath)) return false;
    return JSON.parse(fs.readFileSync(setup.manifestPath, 'utf8')).endpoint?.ino;
  }, 'ready generation manifest');
  const records = recordedProcesses(setup);
  process.kill(launcher.pid, 'SIGKILL');
  await waitForExit(launcher);
  return { manifest: JSON.parse(fs.readFileSync(setup.manifestPath, 'utf8')), records };
}

function bindForeignListener(setup) {
  const child = spawn('python3', ['-c', String.raw`
import os, signal, socket, sys, time
path = sys.argv[1]
try:
    os.unlink(path)
except FileNotFoundError:
    pass
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(path)
sock.listen(1)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True:
    time.sleep(0.1)
`, setup.socketPath], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  const identity = proc(child.pid);
  fs.appendFileSync(setup.processTrace, `${JSON.stringify({
    role: 'foreign',
    pid: child.pid,
    pgid: identity?.pgid,
    startTicks: identity?.startTicks,
  })}\n`);
  return child;
}

test('SIGKILLed launcher generation is reclaimed on immediate relaunch with no descendants left', async (t) => {
  const setup = fixture(t);
  const first = launch(setup, {
    APP_WRAPPER_TERM: 'exit',
    CODEX_DISCORD_STOP_TIMEOUT_MS: '5000',
    NATIVE_IGNORE_TERM: '1',
  });
  await waitFor(() => fs.existsSync(setup.socketPath), 'app-server socket');
  const gateway = await waitFor(
    () => recordedProcesses(setup).find((item) => item.role === 'gateway'),
    'gateway process',
  );
  await waitFor(() => !alive(gateway.pid) && alive(first.pid), 'launcher waiting on app cleanup');
  const firstProcesses = recordedProcesses(setup);
  process.kill(first.pid, 'SIGKILL');
  await waitForExit(first);
  assert.equal(fs.existsSync(setup.socketPath), true, 'the real native listener remains bound');

  const relaunched = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 8000,
  });

  assert.equal(relaunched.status, 0, relaunched.stderr);
  assertRecordedDead(firstProcesses, 'old generation reclaim');
  assert.equal(fs.existsSync(setup.socketPath), false);
  assert.equal(fs.existsSync(setup.manifestPath), false);
});

test('foreign listener without a generation manifest remains live and inode-stable', async (t) => {
  const setup = fixture(t);
  const foreign = bindForeignListener(setup);
  await waitFor(() => fs.existsSync(setup.socketPath), 'foreign socket');
  const before = fs.lstatSync(setup.socketPath, { bigint: true });

  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 3000,
  });

  const after = fs.lstatSync(setup.socketPath, { bigint: true });
  assert.equal(result.status, 73, result.stderr);
  assert.equal(alive(foreign.pid), true);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(fs.existsSync(setup.manifestPath), false);
});

test('malformed generation manifest remains byte-stable and cannot authorize a foreign listener reclaim', async (t) => {
  const setup = fixture(t);
  const foreign = bindForeignListener(setup);
  await waitFor(() => fs.existsSync(setup.socketPath), 'foreign socket');
  const malformed = Buffer.from('{"version":1,"not":"an owned generation"}\n');
  fs.writeFileSync(setup.manifestPath, malformed, { mode: 0o600 });
  const socket = fs.lstatSync(setup.socketPath, { bigint: true });

  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 3000,
  });

  assert.equal(result.status, 73, result.stderr);
  assert.equal(alive(foreign.pid), true);
  assert.deepEqual(fs.readFileSync(setup.manifestPath), malformed);
  assert.equal(fs.lstatSync(setup.socketPath, { bigint: true }).ino, socket.ino);
});

test('recorded launcher PID reuse rejects reclaim without touching the exact orphan generation', async (t) => {
  const setup = fixture(t);
  const orphan = await orphanReadyGeneration(setup);
  const socket = fs.lstatSync(setup.socketPath, { bigint: true });
  const mutated = {
    ...orphan.manifest,
    launcher: { pid: process.pid, startTicks: '1' },
  };
  const raw = `${JSON.stringify(mutated)}\n`;
  fs.writeFileSync(setup.manifestPath, raw);

  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 3000,
  });

  assert.equal(result.status, 73, result.stderr);
  assert.equal(fs.readFileSync(setup.manifestPath, 'utf8'), raw);
  assert.equal(fs.lstatSync(setup.socketPath, { bigint: true }).ino, socket.ino);
  assert.ok(orphan.records.some((item) => alive(item.pid)), 'generation must remain untouched');
});

test('wrong recorded app PGID rejects reclaim without signalling either recorded group or listener', async (t) => {
  const setup = fixture(t);
  const orphan = await orphanReadyGeneration(setup);
  const socket = fs.lstatSync(setup.socketPath, { bigint: true });
  const mutated = {
    ...orphan.manifest,
    app: { ...orphan.manifest.app, pgid: orphan.manifest.app.pgid + 1 },
  };
  const raw = `${JSON.stringify(mutated)}\n`;
  fs.writeFileSync(setup.manifestPath, raw);

  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 3000,
  });

  assert.equal(result.status, 73, result.stderr);
  assert.equal(fs.readFileSync(setup.manifestPath, 'utf8'), raw);
  assert.equal(fs.lstatSync(setup.socketPath, { bigint: true }).ino, socket.ino);
  assert.ok(orphan.records.some((item) => alive(item.pid)), 'generation must remain untouched');
});

test('multiple live listeners for one path reject reclaim before either process group is touched', async (t) => {
  const setup = fixture(t);
  const orphan = await orphanReadyGeneration(setup);
  fs.unlinkSync(setup.socketPath);
  const foreign = bindForeignListener(setup);
  await waitFor(() => fs.existsSync(setup.socketPath), 'second live listener');
  const replacement = fs.lstatSync(setup.socketPath, { bigint: true });
  const mutated = {
    ...orphan.manifest,
    endpoint: { dev: String(replacement.dev), ino: String(replacement.ino), path: setup.socketPath },
  };
  const raw = `${JSON.stringify(mutated)}\n`;
  fs.writeFileSync(setup.manifestPath, raw);

  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 3000,
  });

  assert.equal(result.status, 73, result.stderr);
  assert.equal(alive(foreign.pid), true);
  assert.equal(fs.readFileSync(setup.manifestPath, 'utf8'), raw);
  assert.equal(fs.lstatSync(setup.socketPath, { bigint: true }).ino, replacement.ino);
  assert.ok(orphan.records.some((item) => alive(item.pid)), 'recorded generation must remain untouched');
});

test('replaced socket inode ABA rejects reclaim and touches neither generation nor foreign listener', async (t) => {
  const setup = fixture(t);
  const first = launch(setup, {
    CODEX_DISCORD_STOP_TIMEOUT_MS: '5000',
    NATIVE_IGNORE_TERM: '1',
  });
  await waitFor(() => fs.existsSync(setup.socketPath), 'app-server socket');
  await waitFor(() => {
    if (!fs.existsSync(setup.manifestPath)) return false;
    return JSON.parse(fs.readFileSync(setup.manifestPath, 'utf8')).endpoint?.ino;
  }, 'ready generation manifest');
  const gateway = await waitFor(
    () => recordedProcesses(setup).find((item) => item.role === 'gateway'),
    'gateway process',
  );
  await waitFor(() => !alive(gateway.pid) && alive(first.pid), 'launcher waiting on app cleanup');
  const generationPids = recordedProcesses(setup);
  process.kill(first.pid, 'SIGKILL');
  await waitForExit(first);
  fs.unlinkSync(setup.socketPath);
  const foreign = bindForeignListener(setup);
  await waitFor(() => fs.existsSync(setup.socketPath), 'replacement foreign socket');
  const replacement = fs.lstatSync(setup.socketPath, { bigint: true });

  const result = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 3000,
  });

  assert.equal(result.status, 73, result.stderr);
  assert.equal(alive(foreign.pid), true);
  assert.equal(fs.lstatSync(setup.socketPath, { bigint: true }).ino, replacement.ino);
  assert.ok(generationPids.some((item) => alive(item.pid)), 'recorded generation must not be partially killed');
});

test('a live launcher lock still rejects a second launcher without touching it', async (t) => {
  const setup = fixture(t);
  const first = await readyLauncher(setup);
  const socket = fs.lstatSync(setup.socketPath, { bigint: true });

  const second = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 3000,
  });

  assert.equal(second.status, 73, second.stderr);
  assert.match(second.stderr, /active launcher/);
  assert.equal(alive(first.pid), true);
  assert.equal(fs.lstatSync(setup.socketPath, { bigint: true }).ino, socket.ino);
  first.kill('SIGTERM');
  await waitForExit(first);
});

test('normal TUI exit terminates the app wrapper and its native listener', async (t) => {
  const setup = fixture(t);
  const child = launch(setup);
  await waitFor(() => recordedProcesses(setup).some((item) => item.role === 'native-listener'), 'native listener');
  const owned = recordedProcesses(setup);
  const result = await waitForExit(child);

  assert.equal(result.code, 0, child.stderrText);
  assertRecordedDead(owned, `normal exit (${child.stderrText})`);
  assert.equal(fs.existsSync(setup.socketPath), false);
  assert.equal(fs.existsSync(setup.manifestPath), false);
});

test('TUI wrapper exit terminates a same-generation native descendant before identity is cleared', async (t) => {
  const setup = fixture(t);
  const child = launch(setup, {
    TUI_DESCENDANT_IGNORE_TERM: '1',
    TUI_LEAVE_DESCENDANT: '1',
  });
  const descendant = await waitFor(
    () => recordedProcesses(setup).find((item) => item.role === 'tui-native-descendant'),
    'TUI native descendant',
  );
  const result = await waitForExit(child);

  assert.equal(result.code, 0, child.stderrText);
  assertRecordedDead([descendant], 'normal TUI wrapper exit');
  assert.equal(fs.existsSync(setup.socketPath), false);
  assert.equal(fs.existsSync(setup.manifestPath), false);

  const relaunched = spawnSync(setup.launcher, ['codex02'], {
    encoding: 'utf8',
    env: env(setup),
    timeout: 8000,
  });
  assert.equal(relaunched.status, 0, relaunched.stderr);
});

test('repeated TERM during delayed cleanup cannot interrupt descendant teardown', async (t) => {
  const setup = fixture(t);
  const child = await readyLauncher(setup, { NATIVE_IGNORE_TERM: '1' });
  const owned = recordedProcesses(setup);
  const gateway = owned.find((item) => item.role === 'gateway');
  assert.ok(gateway);
  child.kill('SIGTERM');
  await waitFor(() => !alive(gateway.pid) && alive(child.pid), 'masked delayed app cleanup');
  child.kill('SIGTERM');
  child.kill('SIGHUP');
  const result = await waitForExit(child);

  assert.equal(result.code, 143, child.stderrText);
  assertRecordedDead(owned, 'repeated signals');
  assert.equal(fs.existsSync(setup.socketPath), false);
  assert.equal(fs.existsSync(setup.manifestPath), false);
});

test('bounded wrapper timeout KILL removes the native listener from the exact group', async (t) => {
  const setup = fixture(t);
  const child = launch(setup, { NATIVE_IGNORE_TERM: '1' });
  await waitFor(() => recordedProcesses(setup).some((item) => item.role === 'native-listener'), 'native listener');
  const owned = recordedProcesses(setup);
  const startedAt = Date.now();
  const result = await waitForExit(child);

  assert.equal(result.code, 0, child.stderrText);
  assert.ok(Date.now() - startedAt < 3000, 'cleanup must use the bounded group timeout');
  assertRecordedDead(owned, `group KILL (${child.stderrText})`);
  assert.equal(fs.existsSync(setup.socketPath), false);
  assert.equal(fs.existsSync(setup.manifestPath), false);
});
