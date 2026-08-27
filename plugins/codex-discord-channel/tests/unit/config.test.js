'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig, loadEnvFile } = require('../../src/config');

const pluginRoot = path.resolve(__dirname, '..', '..');
const releasePluginVersion = '0.3.17';

test('loadEnvFile does not override existing environment values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-config-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'DISCORD_BOT_TOKEN=file-token\nDISCORD_INSTANCE=file-instance\n');
  const env = { DISCORD_BOT_TOKEN: 'real-token' };
  assert.equal(loadEnvFile(envFile, env), true);
  assert.equal(env.DISCORD_BOT_TOKEN, 'real-token');
  assert.equal(env.DISCORD_INSTANCE, 'file-instance');
});

test('loadConfig resolves default instance state path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'Codex 01' }, { cwd: '/workspace' });
  assert.equal(config.paths.instance, 'codex-01');
  assert.equal(config.paths.stateDir, path.join(home, '.codex', 'channels', 'discord', 'codex-01'));
  assert.equal(config.paths.deliveryQueuePath, path.join(
    home,
    '.codex',
    'channels',
    'discord',
    'codex-01',
    'pending-delivery.json',
  ));
  assert.equal(config.paths.gatewayHealthPath, path.join(
    home,
    '.codex',
    'channels',
    'discord',
    'codex-01',
    'gateway-health.json',
  ));
  assert.equal(config.deliveryMode, 'app-server');
  assert.equal(
    config.appServerUrl,
    `unix://${path.join(home, '.codex', 'channels', 'discord', 'codex-01', 'app-server.sock')}`,
  );
  assert.equal(config.ignoredDeliveryMode, null);
  assert.equal(config.deliveryDrainIntervalMs, 1000);
  assert.equal(config.deliveryDrainMaxBackoffMs, 30000);
  assert.equal(config.automaticOutboundEnabled, true);
  assert.equal(config.deliveryUncertainRetryBaseMs, 5000);
  assert.equal(config.deliveryUncertainRetryMaxMs, 300000);
  assert.equal(config.gatewayHealthStaleMs, 180000);
  assert.equal(config.requireTuiLease, false);
  assert.equal(config.tuiLeaseStaleMs, 3000);
  assert.equal(config.messageContentIntent, true);
  assert.equal(config.cwd, '/workspace');
});

test('loadConfig can disable automatic Discord outbound without disabling inbound delivery', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_AUTOMATIC_OUTBOUND_ENABLED: 'false',
  });

  assert.equal(config.automaticOutboundEnabled, false);
  assert.equal(config.deliveryMode, 'app-server');
});

test('loadConfig can disable the privileged Message Content gateway intent', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    DISCORD_MESSAGE_CONTENT_INTENT: 'false',
  });

  assert.equal(config.messageContentIntent, false);
});

test('loadConfig derives delivery activation from the installed plugin root', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
  });

  assert.equal(config.deliveryActivationId, path.resolve(__dirname, '..', '..'));
});

test('loadConfig accepts an explicit delivery activation id', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_DELIVERY_ACTIVATION_ID: 'release-a',
  });

  assert.equal(config.deliveryActivationId, 'release-a');
});

test('loadConfig uses CODEX_HOME for instance state when configured', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-codex-home-'));
  const config = loadConfig({ HOME: home, CODEX_HOME: codexHome, DISCORD_INSTANCE: 'codex01' });
  assert.equal(
    config.paths.stateDir,
    path.join(codexHome, 'channels', 'discord', 'codex01'),
  );
  assert.equal(
    config.appServerUrl,
    `unix://${path.join(codexHome, 'channels', 'discord', 'codex01', 'app-server.sock')}`,
  );
});

test('account env changes Codex account home without moving Discord state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  const accountHome = path.join(home, '.codex-account-02');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'account.env'), `CODEX_HOME=${accountHome}\n`);

  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex02' });

  assert.equal(config.accountEnvLoaded, true);
  assert.equal(config.accountHomeSource, 'account_env');
  assert.equal(config.codexHome, accountHome);
  assert.equal(config.paths.stateDir, stateDir);
  assert.equal(config.env.DISCORD_CONFIG_DIR, stateDir);
  assert.equal(config.paths.accountEnvPath, path.join(stateDir, 'account.env'));
  assert.equal(config.appServerUrl, `unix://${path.join(stateDir, 'app-server.sock')}`);
});

test('explicit Discord state wins when account env points at another Codex home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, 'discord-state', 'codex02');
  const accountHome = path.join(home, '.codex-account-02');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'account.env'), `CODEX_HOME=${accountHome}\n`);

  const config = loadConfig({
    HOME: home,
    DISCORD_INSTANCE: 'codex02',
    DISCORD_CONFIG_DIR: stateDir,
  });

  assert.equal(config.codexHome, accountHome);
  assert.equal(config.paths.stateDir, stateDir);
});

test('account binding routes an MCP process without inherited Discord variables', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const codexHome = path.join(home, '.codex-account-02');
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'discord-instance.env'), [
    'DISCORD_INSTANCE=codex02',
    `DISCORD_CONFIG_DIR=${stateDir}`,
    '',
  ].join('\n'));

  const config = loadConfig({ HOME: home, CODEX_HOME: codexHome });

  assert.equal(config.accountBindingLoaded, true);
  assert.equal(config.paths.instance, 'codex02');
  assert.equal(config.paths.stateDir, stateDir);
});

test('installed MCP recovers its account binding from plugin cache cwd when Codex strips env', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const codexHome = path.join(home, '.codex-account-02');
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    'utf8',
  ));
  assert.equal(
    manifest.version,
    releasePluginVersion,
    'marketplace cache identity must name the v0.3.17 plugin release',
  );
  const pluginCwd = path.join(
    codexHome,
    'plugins',
    'cache',
    'personal',
    'codex-discord-channel',
    manifest.version,
  );
  fs.mkdirSync(pluginCwd, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'discord-instance.env'), [
    'DISCORD_INSTANCE=codex02',
    `DISCORD_CONFIG_DIR=${stateDir}`,
    '',
  ].join('\n'));

  const config = loadConfig({ HOME: home }, { cwd: pluginCwd });

  assert.equal(config.accountHomeSource, 'plugin_cache');
  assert.equal(config.accountBindingLoaded, true);
  assert.equal(config.legacyInstanceFallbackUsed, false);
  assert.equal(config.codexHome, codexHome);
  assert.equal(config.paths.instance, 'codex02');
  assert.equal(config.paths.stateDir, stateDir);
});

test('installed MCP without its account binding cannot fall into a global legacy instance', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const codexHome = path.join(home, '.codex-account-02');
  const pluginCwd = path.join(
    codexHome,
    'plugins',
    'cache',
    'personal',
    'codex-discord-channel',
    releasePluginVersion,
  );
  const legacyStateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(pluginCwd, { recursive: true });
  fs.mkdirSync(legacyStateDir, { recursive: true });
  fs.writeFileSync(path.join(legacyStateDir, '.env'), 'DISCORD_BOT_TOKEN=legacy-token\n');

  assert.throws(
    () => loadConfig({ HOME: home }, { cwd: pluginCwd }),
    (error) => error.code === 'discord_account_binding_missing',
  );
});

test('legacy codex01 install remains routable until an account binding is created', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const legacyStateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(legacyStateDir, { recursive: true });
  fs.writeFileSync(path.join(legacyStateDir, '.env'), 'DISCORD_BOT_TOKEN=legacy-token\n');

  const config = loadConfig({ HOME: home });

  assert.equal(config.legacyInstanceFallbackUsed, true);
  assert.equal(config.paths.instance, 'codex01');
  assert.equal(config.paths.stateDir, legacyStateDir);
});

test('legacy codex01 fallback does not override an initialized default instance', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  for (const instance of ['default', 'codex01']) {
    const stateDir = path.join(home, '.codex', 'channels', 'discord', instance);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.env'), `DISCORD_BOT_TOKEN=${instance}\n`);
  }

  const config = loadConfig({ HOME: home });

  assert.equal(config.legacyInstanceFallbackUsed, false);
  assert.equal(config.paths.instance, 'default');
});

test('account env rejects Discord keys instead of redirecting instance state', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'account.env'), [
    `CODEX_HOME=${path.join(home, '.codex-account-02')}`,
    'DISCORD_CONFIG_DIR=/tmp/codex01',
    '',
  ].join('\n'));

  assert.throws(
    () => loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex02' }),
    (error) => error.code === 'environment_key_not_allowed',
  );
});

test('account binding rejects a state conflict with an explicit service selection', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const codexHome = path.join(home, '.codex-account-02');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'discord-instance.env'), [
    'DISCORD_INSTANCE=codex01',
    `DISCORD_CONFIG_DIR=${path.join(home, 'discord', 'codex01')}`,
    '',
  ].join('\n'));

  assert.throws(
    () => loadConfig({
      HOME: home,
      CODEX_HOME: codexHome,
      DISCORD_INSTANCE: 'codex02',
      DISCORD_CONFIG_DIR: path.join(home, 'discord', 'codex02'),
    }),
    (error) => error.code === 'environment_key_conflict',
  );
});

test('explicit state can discover its account home before validating that account binding', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const primaryHome = path.join(home, '.codex');
  const secondHome = path.join(home, '.codex-account-02');
  const secondState = path.join(primaryHome, 'channels', 'discord', 'codex02');
  fs.mkdirSync(secondHome, { recursive: true });
  fs.mkdirSync(secondState, { recursive: true });
  fs.writeFileSync(path.join(primaryHome, 'discord-instance.env'), [
    'DISCORD_INSTANCE=codex01',
    `DISCORD_CONFIG_DIR=${path.join(primaryHome, 'channels', 'discord', 'codex01')}`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(secondState, 'account.env'), `CODEX_HOME=${secondHome}\n`);
  fs.writeFileSync(path.join(secondHome, 'discord-instance.env'), [
    'DISCORD_INSTANCE=codex02',
    `DISCORD_CONFIG_DIR=${secondState}`,
    '',
  ].join('\n'));

  const config = loadConfig({
    HOME: home,
    DISCORD_INSTANCE: 'codex02',
    DISCORD_CONFIG_DIR: secondState,
  });

  assert.equal(config.codexHome, secondHome);
  assert.equal(config.accountBindingLoaded, true);
  assert.equal(config.paths.stateDir, secondState);
});

test('network env accepts proxy keys and rejects pre-exec command overrides', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex02');
  fs.mkdirSync(stateDir, { recursive: true });
  const networkFile = path.join(stateDir, 'app-server-network.env');
  fs.writeFileSync(networkFile, 'HTTPS_PROXY=http://127.0.0.1:8080\n');
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex02' });
  assert.equal(config.networkEnvLoaded, true);
  assert.equal(config.env.HTTPS_PROXY, 'http://127.0.0.1:8080');

  fs.writeFileSync(networkFile, 'NODE_BIN=/tmp/untrusted-node\n');
  assert.throws(
    () => loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex02' }),
    (error) => error.code === 'environment_key_not_allowed',
  );
});

test('loadConfig reads token from instance env file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=from-file\n');
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' });
  assert.equal(config.token, 'from-file');
  assert.equal(config.tokenConfigured, true);
});

test('loadConfig captures proxy and insecure TLS settings', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    HTTPS_PROXY: 'http://127.0.0.1:8080',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  });
  assert.equal(config.proxyUrl, 'http://127.0.0.1:8080');
  assert.equal(config.insecureTls, true);
});

test('loadConfig ignores legacy TTY delivery settings and keeps structured delivery', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_DELIVERY_MODE: 'tty',
    CODEX_DISCORD_TTY: '/dev/pts/7',
    CODEX_DISCORD_TTY_AUTO_SUBMIT_COMPAT: 'true',
  });
  assert.equal(config.deliveryMode, 'app-server');
  assert.equal(config.ignoredDeliveryMode, 'tty');
  assert.equal(Object.hasOwn(config, 'tty'), false);
  assert.equal(Object.hasOwn(config, 'ttyAutoSubmitCompat'), false);
});

test('loadConfig accepts an explicit shared app-server endpoint and timeouts', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_APP_SERVER_URL: 'ws://127.0.0.1:4500',
    CODEX_DISCORD_APP_SERVER_CONNECT_TIMEOUT_MS: '3456',
    CODEX_DISCORD_APP_SERVER_REQUEST_TIMEOUT_MS: '7890',
    CODEX_DISCORD_QUEUE_DRAIN_INTERVAL_MS: '25',
    CODEX_DISCORD_QUEUE_DRAIN_MAX_BACKOFF_MS: '400',
  });
  assert.equal(config.appServerUrl, 'ws://127.0.0.1:4500');
  assert.equal(config.appServerConnectTimeoutMs, 3456);
  assert.equal(config.appServerRequestTimeoutMs, 7890);
  assert.equal(config.deliveryDrainIntervalMs, 25);
  assert.equal(config.deliveryDrainMaxBackoffMs, 400);
});

test('generic Codex app-server endpoint cannot redirect a Discord instance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-generic-endpoint-'));
  const stateDir = path.join(root, 'discord', 'codex02');
  const config = loadConfig({
    HOME: root,
    DISCORD_INSTANCE: 'codex02',
    DISCORD_CONFIG_DIR: stateDir,
    CODEX_APP_SERVER_URL: 'unix:///tmp/foreign-codex01.sock',
  });

  assert.equal(config.appServerUrl, `unix://${path.join(stateDir, 'app-server.sock')}`);
});

test('loadConfig uses the state directory as stable owner id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({
    HOME: home,
    DISCORD_INSTANCE: 'codex02',
    CODEX_THREAD_ID: 'thread-123',
  });
  assert.equal(config.ownerId, `discord-state:${path.join(home, '.codex', 'channels', 'discord', 'codex02')}`);
});

test('session and explicit owner ids cannot override state-directory identity', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({
    HOME: home,
    DISCORD_INSTANCE: 'codex02',
    CODEX_DISCORD_OWNER_ID: 'manual-owner',
    CODEX_THREAD_ID: 'thread-123',
    CODEX_SESSION_ID: 'session-123',
    CODEX_TARGET_THREAD_ID: 'target-123',
  });
  assert.equal(config.ownerId, `discord-state:${path.join(home, '.codex', 'channels', 'discord', 'codex02')}`);
});

test('loadConfig accepts explicit owner pid for session binding metadata', () => {
  const config = loadConfig({
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-')),
    CODEX_DISCORD_OWNER_PID: '3547805',
  });
  assert.equal(config.pid, 3547805);
});
