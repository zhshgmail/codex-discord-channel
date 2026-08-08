'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildAppServerLaunch, instanceDoctor, runAppServer } = require('../../src/app-server-runtime');
const { loadConfig } = require('../../src/config');
const { parseRuntimeArgs } = require('../../bin/codex-discord-channel');

function createInstance(root, instance, accountName, botId) {
  const stateDir = path.join(root, 'discord', instance);
  const codexHome = path.join(root, accountName);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'account.env'),
    `CODEX_HOME=${codexHome}\nCODEX_BIN=/opt/codex/bin/codex.js\nNODE_BIN=/opt/node/bin/node\n`,
  );
  fs.writeFileSync(
    path.join(stateDir, '.env'),
    `DISCORD_BOT_USER_ID=${botId}\nDISCORD_BOT_TOKEN=token-${instance}\n`,
  );
  return loadConfig({
    HOME: root,
    DISCORD_INSTANCE: instance,
    DISCORD_CONFIG_DIR: stateDir,
  });
}

test('two instances isolate Codex accounts, Discord bots, state, sessions, and sockets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-multi-account-'));
  const first = createInstance(root, 'codex01', '.codex-account-01', '11111111111111111');
  const second = createInstance(root, 'codex02', '.codex-account-02', '22222222222222222');

  assert.notEqual(first.codexHome, second.codexHome);
  assert.notEqual(first.paths.stateDir, second.paths.stateDir);
  assert.notEqual(first.paths.deliveryQueuePath, second.paths.deliveryQueuePath);
  assert.notEqual(first.appServerUrl, second.appServerUrl);
  assert.notEqual(first.botUserId, second.botUserId);
  assert.notEqual(path.join(first.codexHome, 'sessions'), path.join(second.codexHome, 'sessions'));

  const firstLaunch = buildAppServerLaunch(first);
  const secondLaunch = buildAppServerLaunch(second);
  assert.equal(firstLaunch.env.CODEX_HOME, first.codexHome);
  assert.equal(secondLaunch.env.CODEX_HOME, second.codexHome);
  assert.equal(firstLaunch.env.DISCORD_CONFIG_DIR, first.paths.stateDir);
  assert.equal(secondLaunch.env.DISCORD_CONFIG_DIR, second.paths.stateDir);
  assert.equal(Object.hasOwn(firstLaunch.env, 'DISCORD_BOT_TOKEN'), false);
  assert.equal(Object.hasOwn(secondLaunch.env, 'DISCORD_BOT_TOKEN'), false);
  assert.deepEqual(firstLaunch.args, ['/opt/codex/bin/codex.js', 'app-server', '--listen', first.appServerUrl]);
  assert.deepEqual(secondLaunch.args, ['/opt/codex/bin/codex.js', 'app-server', '--listen', second.appServerUrl]);
});

test('app-server fails closed when no explicit Codex account home is configured', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-account-required-'));
  const config = loadConfig({ HOME: root, DISCORD_INSTANCE: 'codex02' });
  assert.throws(
    () => buildAppServerLaunch(config),
    (error) => error.code === 'codex_account_home_required',
  );
});

test('runAppServer replaces itself with Codex under the isolated environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-app-server-run-'));
  const config = createInstance(root, 'codex02', '.codex-account-02', '22222222222222222');
  let observed;
  const result = runAppServer(config, {
    execve(command, args, env) {
      observed = { command, args, env };
      return 'execve-called';
    },
  });

  assert.equal(result, 'execve-called');
  assert.equal(observed.command, '/opt/node/bin/node');
  assert.deepEqual(observed.args.slice(0, 2), ['/opt/node/bin/node', '/opt/codex/bin/codex.js']);
  assert.equal(observed.env.CODEX_HOME, config.codexHome);
  assert.equal(observed.env.DISCORD_INSTANCE, 'codex02');
  assert.equal(observed.env.DISCORD_CONFIG_DIR, config.paths.stateDir);
});

test('instance doctor reports account and Discord state separation without secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-instance-doctor-'));
  const config = createInstance(root, 'codex02', '.codex-account-02', '22222222222222222');
  const result = instanceDoctor(config);

  assert.equal(result.accountHomeSource, 'account_env');
  assert.equal(result.accountStateRelationship, 'disjoint');
  assert.equal(result.botTokenConfigured, true);
  assert.equal(Object.hasOwn(result, 'token'), false);
});

test('app-server launch strips Discord and stale target controls from its child environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-app-server-secrets-'));
  const config = createInstance(root, 'codex02', '.codex-account-02', '22222222222222222');
  config.env.CODEX_TARGET_THREAD_ID = 'stale-thread';
  const launch = buildAppServerLaunch(config);

  assert.equal(Object.hasOwn(launch.env, 'DISCORD_BOT_TOKEN'), false);
  assert.equal(Object.hasOwn(launch.env, 'DISCORD_BOT_USER_ID'), false);
  assert.equal(Object.hasOwn(launch.env, 'CODEX_TARGET_THREAD_ID'), false);
  assert.equal(launch.env.DISCORD_INSTANCE, 'codex02');
  assert.equal(launch.env.DISCORD_CONFIG_DIR, config.paths.stateDir);
});

test('runtime arguments provide an immutable systemd instance selection', () => {
  assert.deepEqual(parseRuntimeArgs([
    '--instance',
    'codex02',
    '--state-dir',
    '/srv/codex-discord/codex02',
  ]), {
    DISCORD_INSTANCE: 'codex02',
    DISCORD_CONFIG_DIR: '/srv/codex-discord/codex02',
  });
  assert.throws(() => parseRuntimeArgs(['--unknown']), /Unknown runtime argument/);
});

test('plugin MCP manifest inherits the selected instance instead of hardcoding codex01', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '.mcp.json')));
  const server = manifest.mcpServers['codex-discord-channel'];
  assert.equal(Object.hasOwn(server, 'env'), false);
});

test('systemd templates load absolute runtime paths from each instance account file', () => {
  const systemdDir = path.resolve(__dirname, '..', '..', 'systemd');
  for (const name of ['codex-discord-app-server@.service', 'codex-discord-channel@.service']) {
    const unit = fs.readFileSync(path.join(systemdDir, name), 'utf8');
    assert.match(unit, /ConditionPathExists=%h\/\.codex\/channels\/discord\/%i\/account\.env/);
    assert.match(unit, /EnvironmentFile=%h\/\.codex\/channels\/discord\/%i\/account\.env/);
    assert.doesNotMatch(unit, /EnvironmentFile=.*app-server-network\.env/);
    assert.match(unit, /ExecStart=\/usr\/bin\/env \$\{NODE_BIN\} \$\{CODEX_DISCORD_CHANNEL_BIN\}/);
    assert.match(unit, /--instance %i --state-dir %h\/\.codex\/channels\/discord\/%i/);
    assert.doesNotMatch(unit, /nvm\/versions\/node/);
  }
  const appServerUnit = fs.readFileSync(
    path.join(systemdDir, 'codex-discord-app-server@.service'),
    'utf8',
  );
  assert.match(appServerUnit, /^RefuseManualStop=yes$/m);
  assert.match(appServerUnit, /^OOMPolicy=continue$/m);
  assert.doesNotMatch(appServerUnit, /^KillMode=process$/m);
  const gatewayUnit = fs.readFileSync(
    path.join(systemdDir, 'codex-discord-channel@.service'),
    'utf8',
  );
  assert.doesNotMatch(gatewayUnit, /^RefuseManualStop=yes$/m);
});

test('real app-server entrypoint execs two processes with isolated account and Discord state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-real-multi-account-'));
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const cli = path.join(pluginRoot, 'bin', 'codex-discord-channel');
  const captureProgram = path.join(pluginRoot, 'tests', 'fixtures', 'capture-app-server-env.js');
  const captures = [];

  for (const [instance, account] of [['codex01', '.codex-account-01'], ['codex02', '.codex-account-02']]) {
    const stateDir = path.join(root, 'discord', instance);
    const codexHome = path.join(root, account);
    const capturePath = path.join(root, `${instance}.json`);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'account.env'), [
      `CODEX_HOME=${codexHome}`,
      `CODEX_BIN=${captureProgram}`,
      `NODE_BIN=${process.execPath}`,
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(stateDir, '.env'), [
      'DISCORD_BOT_TOKEN=must-not-reach-codex',
      'CODEX_TARGET_THREAD_ID=must-not-reach-codex',
      '',
    ].join('\n'));

    const completed = spawnSync(process.execPath, [cli, 'app-server'], {
      env: {
        HOME: root,
        DISCORD_INSTANCE: instance,
        DISCORD_CONFIG_DIR: stateDir,
        CODEX_TEST_CAPTURE_PATH: capturePath,
      },
      encoding: 'utf8',
    });
    assert.equal(completed.status, 0, completed.stderr);
    captures.push(JSON.parse(fs.readFileSync(capturePath, 'utf8')));
  }

  assert.deepEqual(captures.map((item) => item.discordInstance), ['codex01', 'codex02']);
  assert.notEqual(captures[0].codexHome, captures[1].codexHome);
  assert.notEqual(captures[0].discordStateDir, captures[1].discordStateDir);
  assert.notEqual(captures[0].appServerUrl, captures[1].appServerUrl);
  for (const item of captures) {
    assert.deepEqual(item.argv, ['app-server', '--listen', item.appServerUrl]);
    assert.equal(item.discordBotTokenPresent, false);
    assert.equal(item.codexTargetThreadIdPresent, false);
  }
});
