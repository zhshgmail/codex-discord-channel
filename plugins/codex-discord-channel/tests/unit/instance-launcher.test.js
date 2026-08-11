'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../../src/config');
const {
  buildTuiLaunch,
  requireInstanceReady,
  runTui,
  verifyAccountBinding,
  verifyLiveProcess,
} = require('../../src/instance-launcher');
const { parseLiveCheckArgs, parseTuiArgs } = require('../../bin/codex-discord-channel');

function instanceFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-instance-launch-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  const codexHome = path.join(home, '.codex-account-02');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}\n');
  fs.writeFileSync(path.join(codexHome, 'discord-instance.env'), [
    'DISCORD_INSTANCE=codex02',
    `DISCORD_CONFIG_DIR=${stateDir}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(stateDir, 'account.env'), [
    `CODEX_HOME=${codexHome}`,
    'CODEX_BIN=/opt/codex/bin/codex.js',
    'NODE_BIN=/opt/node/bin/node',
    'CODEX_DISCORD_CHANNEL_BIN=/opt/codex-discord-channel/bin/codex-discord-channel',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(stateDir, '.env'), [
    'DISCORD_BOT_USER_ID=22222222222222222',
    'DISCORD_BOT_TOKEN=secret-token',
    '',
  ].join('\n'));
  return loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex02' });
}

function readyDependencies(config) {
  const calls = [];
  return {
    calls,
    execve(command, args, env) {
      calls.push({ command, args, env, type: 'execve' });
      return 'execve-called';
    },
  };
}

test('TUI launcher replaces itself with matching Codex after the shell startup boundary', () => {
  const config = instanceFixture();
  const dependencies = readyDependencies(config);
  const result = runTui(config, ['resume', 'thread-2'], dependencies);

  assert.equal(result, 'execve-called');
  const launched = dependencies.calls.at(-1);
  assert.deepEqual(launched.args, [
    '/opt/node/bin/node',
    '/opt/codex/bin/codex.js',
    '--remote',
    config.appServerUrl,
    'resume',
    'thread-2',
  ]);
  assert.equal(launched.env.CODEX_HOME, config.codexHome);
  assert.equal(launched.env.DISCORD_CONFIG_DIR, config.paths.stateDir);
  assert.equal(Object.hasOwn(launched.env, 'DISCORD_BOT_TOKEN'), false);
});

test('launcher rejects an OpenAI account that is not logged in', () => {
  const config = instanceFixture();
  fs.unlinkSync(path.join(config.codexHome, 'auth.json'));
  assert.throws(
    () => requireInstanceReady(config),
    (error) => error.code === 'openai_account_login_missing' && /not logged in/.test(error.message),
  );
});

test('launcher fails before worker startup when Discord bot credentials are missing', () => {
  const config = instanceFixture();
  config.tokenConfigured = false;
  assert.throws(() => requireInstanceReady(config), /credentials are incomplete/);
});

test('launcher rejects an account binding that points at another Discord instance', () => {
  const config = instanceFixture();
  fs.writeFileSync(config.paths.accountBindingPath, [
    'DISCORD_INSTANCE=codex01',
    `DISCORD_CONFIG_DIR=${path.dirname(config.paths.stateDir)}/codex01`,
    '',
  ].join('\n'));
  assert.throws(() => verifyAccountBinding(config), /does not match instance codex02/);
});

test('TUI launch passes no Discord secret to Codex', () => {
  const config = instanceFixture();
  const launch = buildTuiLaunch(config, ['--help']);
  assert.equal(launch.command, '/opt/node/bin/node');
  assert.equal(Object.hasOwn(launch.env, 'DISCORD_BOT_TOKEN'), false);
  assert.equal(Object.hasOwn(launch.env, 'DISCORD_BOT_USER_ID'), false);
});

test('live process identity requires the selected OpenAI account and Discord state', () => {
  const config = instanceFixture();
  const matching = Buffer.from([
    `CODEX_HOME=${config.codexHome}`,
    'DISCORD_INSTANCE=codex02',
    `DISCORD_CONFIG_DIR=${config.paths.stateDir}`,
    '',
  ].join('\0'));
  assert.doesNotThrow(() => verifyLiveProcess(config, 12345, { readFileSync: () => matching }));

  const expectedGeneration = 'generation-123';
  const generationIdentity = {
    CODEX_HOME: config.codexHome,
    DISCORD_INSTANCE: 'codex02',
    DISCORD_CONFIG_DIR: config.paths.stateDir,
    CODEX_DISCORD_LAUNCH_GENERATION: expectedGeneration,
    CODEX_DISCORD_LAUNCH_ROLE: 'app',
    CODEX_DISCORD_LAUNCH_INSTANCE: 'codex02',
    CODEX_DISCORD_LAUNCH_STATE_DIR: config.paths.stateDir,
    CODEX_DISCORD_LAUNCH_CODEX_HOME: config.codexHome,
    CODEX_DISCORD_LAUNCH_PLUGIN_ROOT: config.deliveryActivationId,
    CODEX_DISCORD_LAUNCH_ENDPOINT: `${config.paths.stateDir}/app-server.sock`,
  };
  const generationEnvironment = (overrides = {}) => Buffer.from([
    ...Object.entries({ ...generationIdentity, ...overrides })
      .map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\0'));
  const matchingGenerationSupervisor = generationEnvironment();
  assert.doesNotThrow(() => verifyLiveProcess(config, 12345, {
    expectedGeneration,
    readFileSync: () => matchingGenerationSupervisor,
  }));
  for (const [name, overrides] of [
    ['generation', { CODEX_DISCORD_LAUNCH_GENERATION: 'generation-456' }],
    ['role', { CODEX_DISCORD_LAUNCH_ROLE: 'tui' }],
    ['instance', { CODEX_DISCORD_LAUNCH_INSTANCE: 'codex01' }],
    ['state directory', { CODEX_DISCORD_LAUNCH_STATE_DIR: `${config.paths.stateDir}-other` }],
    ['Codex home', { CODEX_DISCORD_LAUNCH_CODEX_HOME: `${config.codexHome}-other` }],
    ['plugin root', { CODEX_DISCORD_LAUNCH_PLUGIN_ROOT: `${config.deliveryActivationId}-other` }],
    ['endpoint', { CODEX_DISCORD_LAUNCH_ENDPOINT: `${config.paths.stateDir}/other.sock` }],
  ]) {
    assert.throws(
      () => verifyLiveProcess(config, 12345, {
        expectedGeneration,
        readFileSync: () => generationEnvironment(overrides),
      }),
      /does not match instance codex02/,
      name,
    );
  }

  const wrongAccount = Buffer.from([
    'CODEX_HOME=/tmp/other-account',
    'DISCORD_INSTANCE=codex02',
    `DISCORD_CONFIG_DIR=${config.paths.stateDir}`,
    '',
  ].join('\0'));
  assert.throws(
    () => verifyLiveProcess(config, 12345, { readFileSync: () => wrongAccount }),
    /does not match instance codex02/,
  );

  const legacyConfig = { ...config, codexHome: path.join(path.dirname(config.codexHome), '.codex') };
  const legacyDefault = Buffer.from([
    `HOME=${path.dirname(legacyConfig.codexHome)}`,
    '',
  ].join('\0'));
  const legacyCommand = Buffer.from([
    '/opt/node/bin/node',
    '/opt/codex/bin/codex.js',
    'app-server',
    '--listen',
    legacyConfig.appServerUrl,
    '',
  ].join('\0'));
  assert.doesNotThrow(() => verifyLiveProcess(legacyConfig, 12345, {
    readFileSync(target) {
      return target.endsWith('/cmdline') ? legacyCommand : legacyDefault;
    },
  }));
});

test('TUI argument separator keeps runtime selection separate from Codex arguments', () => {
  assert.deepEqual(parseTuiArgs([
    '--instance',
    'codex02',
    '--state-dir',
    '/srv/discord/codex02',
    '--',
    'resume',
    'thread-2',
  ]), {
    runtimeArgs: ['--instance', 'codex02', '--state-dir', '/srv/discord/codex02'],
    codexArgs: ['resume', 'thread-2'],
  });
});

test('live-check requires one expected generation and exactly two PIDs beside the runtime selection', () => {
  assert.deepEqual(parseLiveCheckArgs([
    '--instance', 'codex02', '--generation', 'generation-123', '--pid', '100',
    '--state-dir', '/state/codex02', '--pid', '200',
  ]), {
    generation: 'generation-123',
    runtimeArgs: ['--instance', 'codex02', '--state-dir', '/state/codex02'],
    pids: [100, 200],
  });
  assert.throws(
    () => parseLiveCheckArgs(['--pid', '100', '--pid', '200']),
    /exactly one --generation/,
  );
  assert.throws(
    () => parseLiveCheckArgs(['--generation', 'generation-123', '--pid', '100']),
    /exactly two/,
  );
});
