'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnWithEagainRetry } = require('../../lib/transient-launch');

const pluginRoot = path.resolve(__dirname, '..', '..');
const generationHelper = path.join(pluginRoot, 'bin', 'codex-discord-generation');

function failedSpawn(error) {
  const child = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => child.emit('error', error));
  return child;
}

function successfulSpawn() {
  const child = new EventEmitter();
  child.kill = () => {};
  child.pid = 4242;
  process.nextTick(() => child.emit('spawn'));
  return child;
}

for (const stage of ['app-supervisor-spawn', 'gateway-spawn', 'tui-spawn']) {
  test(`${stage} retries exactly one audited EAGAIN`, async () => {
    let attempts = 0;
    const incidents = [];
    const child = await spawnWithEagainRetry({
      args: ['--fixture'],
      command: '/fixture/worker',
      env: {},
      stage,
      stdio: 'inherit',
    }, {
      async delay() {},
      recordLaunchIncident(incident) { incidents.push(incident); },
      spawn() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('Resource temporarily unavailable');
          error.code = 'EAGAIN';
          error.errno = -11;
          error.syscall = 'spawn /fixture/worker';
          return failedSpawn(error);
        }
        return successfulSpawn();
      },
    });

    assert.equal(child.pid, 4242);
    assert.equal(attempts, 2);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].stage, stage);
    assert.equal(incidents[0].action, 'retry');
    assert.equal(incidents[0].error.code, 'EAGAIN');
    assert.match(incidents[0].argvSha256, /^[0-9a-f]{64}$/);
  });
}

test('spawn failure is terminal after one EAGAIN retry', async () => {
  let attempts = 0;
  const incidents = [];
  await assert.rejects(
    spawnWithEagainRetry({
      args: [], command: '/fixture/worker', env: {}, stage: 'gateway-spawn', stdio: 'inherit',
    }, {
      async delay() {},
      recordLaunchIncident(incident) { incidents.push(incident); },
      spawn() {
        attempts += 1;
        const error = new Error('Resource temporarily unavailable');
        error.code = 'EAGAIN';
        error.errno = -11;
        error.syscall = 'spawn /fixture/worker';
        return failedSpawn(error);
      },
    }),
    (error) => error.code === 'EAGAIN',
  );
  assert.equal(attempts, 2);
  assert.deepEqual(incidents.map((item) => item.action), ['retry', 'abort']);
});

function startTicks(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

function generationFixture(role) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cdc-${role}-eagain-`));
  const stateDir = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  const preload = path.join(root, 'fail-spawn.cjs');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(codexHome);
  fs.writeFileSync(preload, String.raw`'use strict';
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const original = Module._load;
Module._load = function patched(request, parent, isMain) {
  const loaded = original.apply(this, arguments);
  if (request !== 'node:child_process') return loaded;
  return {
    ...loaded,
    spawn() {
      const child = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => {
        const error = new Error('Resource temporarily unavailable');
        error.code = 'EAGAIN';
        error.errno = -11;
        error.syscall = 'spawn /fixture/worker';
        child.emit('error', error);
      });
      return child;
    },
  };
};
`);
  const nonce = '11111111-2222-4333-8444-555555555555';
  const manifest = path.join(stateDir, 'instance-generation.json');
  const socket = path.join(stateDir, 'app-server.sock');
  const identityArgs = [
    '--manifest', manifest,
    '--instance', 'codex02',
    '--state-dir', stateDir,
    '--codex-home', codexHome,
    '--plugin-root', pluginRoot,
    '--socket', socket,
    '--node-bin', process.execPath,
    '--codex-bin', '/fixture/codex.js',
    '--channel-bin', '/fixture/channel.cjs',
    '--generation-bin', generationHelper,
  ];
  const env = {
    ...process.env,
    CODEX_DISCORD_LAUNCH_CODEX_HOME: codexHome,
    CODEX_DISCORD_LAUNCH_ENDPOINT: socket,
    CODEX_DISCORD_LAUNCH_GENERATION: nonce,
    CODEX_DISCORD_LAUNCH_INSTANCE: 'codex02',
    CODEX_DISCORD_LAUNCH_PLUGIN_ROOT: pluginRoot,
    CODEX_DISCORD_LAUNCH_ROLE: role,
    CODEX_DISCORD_LAUNCH_STATE_DIR: stateDir,
    NODE_OPTIONS: `--require=${preload}`,
  };
  return { codexHome, env, identityArgs, manifest, nonce, root, socket, stateDir };
}

test('app supervisor terminal EAGAIN removes its unready generation identity', () => {
  const fixture = generationFixture('app');
  const result = spawnSync('/usr/bin/setsid', [
    process.execPath,
    generationHelper,
    'supervise',
    ...fixture.identityArgs,
    '--nonce', fixture.nonce,
    '--launcher-pid', String(process.pid),
    '--launcher-start-ticks', startTicks(process.pid),
    '--', '/fixture/worker',
  ], { encoding: 'utf8', env: fixture.env });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.existsSync(fixture.manifest), false);
  assert.equal(fs.existsSync(fixture.socket), false);
  const incidents = fs.readFileSync(path.join(fixture.stateDir, 'startup-incidents.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(incidents.map((item) => [item.stage, item.action]), [
    ['app-supervisor-spawn', 'retry'],
    ['app-supervisor-spawn', 'abort'],
  ]);
});

for (const role of ['gateway', 'tui']) {
  test(`${role} terminal EAGAIN leaves no listener or generation state`, () => {
    const fixture = generationFixture(role);
    const result = spawnSync('/usr/bin/setsid', [
      process.execPath,
      generationHelper,
      'worker-supervise',
      ...fixture.identityArgs,
      '--nonce', fixture.nonce,
      '--role', role,
      '--', '/fixture/worker',
    ], { encoding: 'utf8', env: fixture.env });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(fs.existsSync(fixture.manifest), false);
    assert.equal(fs.existsSync(fixture.socket), false);
    const incidents = fs.readFileSync(path.join(fixture.stateDir, 'startup-incidents.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(incidents.map((item) => [item.stage, item.action]), [
      [`${role}-spawn`, 'retry'],
      [`${role}-spawn`, 'abort'],
    ]);
  });
}
