'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { expandPath, resolvePaths } = require('./paths');

const ACCOUNT_BINDING_KEYS = new Set(['DISCORD_INSTANCE', 'DISCORD_CONFIG_DIR']);
const ACCOUNT_ENV_KEYS = new Set([
  'CODEX_HOME',
  'CODEX_BIN',
  'NODE_BIN',
  'CODEX_DISCORD_CHANNEL_BIN',
]);
const NETWORK_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
]);

function stripQuotes(value) {
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function inferCodexHomeFromPluginCache(cwd) {
  const resolvedCwd = path.resolve(String(cwd || ''));
  const marker = `${path.sep}plugins${path.sep}cache${path.sep}`;
  const markerIndex = resolvedCwd.lastIndexOf(marker);
  if (markerIndex <= 0) return '';
  return resolvedCwd.slice(0, markerIndex);
}

function canonicalIdentityPath(input) {
  let current = path.resolve(String(input || ''));
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const resolved = fs.existsSync(current) ? fs.realpathSync.native(current) : current;
  return path.join(resolved, ...suffix);
}

function createInstanceIdentity(instance, codexHome, stateDir) {
  const binding = {
    version: 1,
    instance: String(instance),
    codexHome: canonicalIdentityPath(codexHome),
    stateDir: canonicalIdentityPath(stateDir),
  };
  const digest = createHash('sha256')
    .update(JSON.stringify([
      binding.version,
      binding.instance,
      binding.codexHome,
      binding.stateDir,
    ]))
    .digest('hex');
  return { ...binding, fingerprint: `sha256:${digest}` };
}

function loadEnvFile(file, env, options = {}) {
  if (!file || !fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(normalized);
    if (!match) {
      if (options.strict) {
        const error = new Error(`Invalid environment entry in ${file}`);
        error.code = 'invalid_environment_entry';
        throw error;
      }
      continue;
    }
    const [, key, rawValue] = match;
    if (options.allowedKeys && !options.allowedKeys.has(key)) {
      const error = new Error(`Environment key ${key} is not allowed in ${file}`);
      error.code = 'environment_key_not_allowed';
      throw error;
    }
    const value = stripQuotes(rawValue);
    if (
      options.rejectConflicts &&
      env[key] !== undefined &&
      String(env[key]) !== value
    ) {
      const error = new Error(`Environment key ${key} conflicts with the selected instance`);
      error.code = 'environment_key_conflict';
      throw error;
    }
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
  return true;
}

function loadConfig(inputEnv = process.env, options = {}) {
  const env = { ...inputEnv };
  const instanceWasExplicit = Boolean(
    env.DISCORD_INSTANCE ||
    env.DISCORD_BRIDGE_INSTANCE ||
    env.DISCORD_STATE_DIR ||
    env.DISCORD_CONFIG_DIR
  );
  let codexHomeFromPluginCache = false;
  if (!env.CODEX_HOME && !instanceWasExplicit) {
    const inferredCodexHome = inferCodexHomeFromPluginCache(options.cwd || process.cwd());
    if (inferredCodexHome) {
      env.CODEX_HOME = inferredCodexHome;
      codexHomeFromPluginCache = true;
    }
  }
  const codexHomeWasExplicit = Boolean(env.CODEX_HOME);
  let initialPaths = resolvePaths(env);
  let accountBindingLoaded = false;
  if (!instanceWasExplicit || codexHomeWasExplicit) {
    accountBindingLoaded = loadEnvFile(initialPaths.accountBindingPath, env, {
      allowedKeys: ACCOUNT_BINDING_KEYS,
      rejectConflicts: true,
      strict: true,
    });
  }
  if (codexHomeFromPluginCache && !accountBindingLoaded) {
    const error = new Error(
      `Discord account binding is missing for installed plugin account ${initialPaths.accountBindingPath}`,
    );
    error.code = 'discord_account_binding_missing';
    throw error;
  }
  initialPaths = resolvePaths(env);
  let legacyInstanceFallbackUsed = false;
  if (!instanceWasExplicit && !accountBindingLoaded) {
    const legacyStateDir = path.join(initialPaths.baseDir, 'codex01');
    const legacyEnvFile = path.join(legacyStateDir, '.env');
    const defaultEnvFile = path.join(initialPaths.stateDir, '.env');
    if (fs.existsSync(legacyEnvFile) && !fs.existsSync(defaultEnvFile)) {
      env.DISCORD_INSTANCE = 'codex01';
      env.DISCORD_CONFIG_DIR = legacyStateDir;
      initialPaths = resolvePaths(env);
      legacyInstanceFallbackUsed = true;
    }
  }
  env.DISCORD_INSTANCE = initialPaths.instance;
  env.DISCORD_CONFIG_DIR = initialPaths.stateDir;

  const inputCodexHome = String(env.CODEX_HOME || '').trim();
  const accountEnvLoaded = loadEnvFile(initialPaths.accountEnvPath, env, {
    allowedKeys: ACCOUNT_ENV_KEYS,
    rejectConflicts: true,
    strict: true,
  });
  const accountEnvCodexHome = String(env.CODEX_HOME || '').trim();
  const accountHomeSource = inputCodexHome
    ? (codexHomeFromPluginCache ? 'plugin_cache' : 'process')
    : (accountEnvLoaded && accountEnvCodexHome ? 'account_env' : 'default');
  if (accountHomeSource !== 'default') {
    env.CODEX_HOME = expandPath(env.CODEX_HOME, env);
  }

  let paths = resolvePaths(env);
  if (paths.accountBindingPath !== initialPaths.accountBindingPath) {
    accountBindingLoaded = loadEnvFile(paths.accountBindingPath, env, {
      allowedKeys: ACCOUNT_BINDING_KEYS,
      rejectConflicts: true,
      strict: true,
    }) || accountBindingLoaded;
  }
  const networkEnvLoaded = loadEnvFile(paths.networkEnvPath, env, {
    allowedKeys: NETWORK_ENV_KEYS,
    strict: true,
  });
  const envLoaded = options.loadDiscordEnv === false
    ? false
    : loadEnvFile(paths.envFile, env);
  paths = resolvePaths(env);

  const token = env.DISCORD_BOT_TOKEN || env.DISCORD_TOKEN || '';
  const botUserId = env.DISCORD_BOT_USER_ID || env.DISCORD_BOT_ID || '';
  const proxyUrl =
    env.DISCORD_PROXY_URL ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    '';
  const cwd = env.CODEX_CWD || options.cwd || process.cwd();
  const requestedDeliveryMode = String(
    env.CODEX_DISCORD_DELIVERY_MODE || env.DISCORD_DELIVERY_MODE || 'app-server',
  ).toLowerCase();
  const deliveryMode = requestedDeliveryMode === 'off' ? 'off' : 'app-server';
  const appServerUrl = String(
    env.CODEX_DISCORD_APP_SERVER_URL ||
    `unix://${paths.stateDir}/app-server.sock`,
  ).trim();
  const deliveryActivationId = String(
    env.CODEX_DISCORD_DELIVERY_ACTIVATION_ID || '',
  ).trim() || fs.realpathSync(path.resolve(__dirname, '..'));
  const codexHome = expandPath(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'), env);
  const instanceIdentity = createInstanceIdentity(paths.instance, codexHome, paths.stateDir);

  return {
    env,
    paths,
    envLoaded,
    accountBindingLoaded,
    legacyInstanceFallbackUsed,
    accountEnvLoaded,
    networkEnvLoaded,
    accountHomeSource,
    codexHome,
    instanceIdentity,
    token,
    tokenConfigured: token !== '',
    botUserId,
    proxyUrl,
    insecureTls: parseBool(env.DISCORD_INSECURE_TLS, env.NODE_TLS_REJECT_UNAUTHORIZED === '0'),
    messageContentIntent: parseBool(env.DISCORD_MESSAGE_CONTENT_INTENT, true),
    loginDisabled: parseBool(env.DISCORD_CHANNEL_DISABLE_LOGIN, false),
    deliveryMode,
    deliveryActivationId,
    ignoredDeliveryMode: ['app-server', 'app_server', 'structured', 'turn', 'off'].includes(requestedDeliveryMode)
      ? null
      : requestedDeliveryMode,
    appServerUrl,
    appServerConnectTimeoutMs: parseInteger(env.CODEX_DISCORD_APP_SERVER_CONNECT_TIMEOUT_MS, 10000),
    appServerRequestTimeoutMs: parseInteger(env.CODEX_DISCORD_APP_SERVER_REQUEST_TIMEOUT_MS, 30000),
    deliveryDrainIntervalMs: parseInteger(env.CODEX_DISCORD_QUEUE_DRAIN_INTERVAL_MS, 1000),
    deliveryDrainMaxBackoffMs: parseInteger(env.CODEX_DISCORD_QUEUE_DRAIN_MAX_BACKOFF_MS, 30000),
    automaticOutboundEnabled: parseBool(
      env.CODEX_DISCORD_AUTOMATIC_OUTBOUND_ENABLED,
      true,
    ),
    deliveryUncertainRetryBaseMs: parseInteger(
      env.CODEX_DISCORD_UNCERTAIN_RETRY_BASE_MS,
      5000,
    ),
    deliveryUncertainRetryMaxMs: parseInteger(
      env.CODEX_DISCORD_UNCERTAIN_RETRY_MAX_MS,
      300000,
    ),
    gatewayHealthStaleMs: parseInteger(
      env.CODEX_DISCORD_GATEWAY_HEALTH_STALE_MS,
      180000,
    ),
    requireTuiLease: true,
    tuiLeaseStaleMs: Math.max(
      1000,
      parseInteger(env.CODEX_DISCORD_TUI_LEASE_STALE_MS, 3000),
    ),
    parentPid: process.ppid,
    cwd,
    hostname: os.hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

module.exports = {
  canonicalIdentityPath,
  createInstanceIdentity,
  loadConfig,
  loadEnvFile,
  parseInteger,
  parseBool,
  stripQuotes,
};
