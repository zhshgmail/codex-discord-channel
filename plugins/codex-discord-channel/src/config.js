'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { resolvePaths } = require('./paths');

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

function loadEnvFile(file, env) {
  if (!file || !fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(normalized);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (env[key] === undefined) {
      env[key] = stripQuotes(rawValue);
    }
  }
  return true;
}

function loadConfig(inputEnv = process.env, options = {}) {
  const env = { ...inputEnv };
  let paths = resolvePaths(env);
  const envLoaded = loadEnvFile(paths.envFile, env);
  paths = resolvePaths(env);
  if (paths.envFile !== resolvePaths(inputEnv).envFile) {
    loadEnvFile(paths.envFile, env);
  }

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
  const ownerId =
    env.CODEX_DISCORD_OWNER_ID ||
    env.CODEX_THREAD_ID ||
    env.CODEX_SESSION_ID ||
    env.CODEX_TARGET_THREAD_ID ||
    `${os.hostname()}:${process.pid}:${Date.now()}`;
  const requestedDeliveryMode = String(
    env.CODEX_DISCORD_DELIVERY_MODE || env.DISCORD_DELIVERY_MODE || 'app-server',
  ).toLowerCase();
  const deliveryMode = requestedDeliveryMode === 'off' ? 'off' : 'app-server';
  const appServerUrl = String(
    env.CODEX_DISCORD_APP_SERVER_URL ||
    env.CODEX_APP_SERVER_URL ||
    `unix://${paths.stateDir}/app-server.sock`,
  ).trim();

  return {
    env,
    paths,
    envLoaded,
    token,
    tokenConfigured: token !== '',
    botUserId,
    proxyUrl,
    insecureTls: parseBool(env.DISCORD_INSECURE_TLS, env.NODE_TLS_REJECT_UNAUTHORIZED === '0'),
    loginDisabled: parseBool(env.DISCORD_CHANNEL_DISABLE_LOGIN, false),
    deliveryMode,
    ignoredDeliveryMode: ['app-server', 'app_server', 'structured', 'turn', 'off'].includes(requestedDeliveryMode)
      ? null
      : requestedDeliveryMode,
    appServerUrl,
    appServerConnectTimeoutMs: parseInteger(env.CODEX_DISCORD_APP_SERVER_CONNECT_TIMEOUT_MS, 10000),
    appServerRequestTimeoutMs: parseInteger(env.CODEX_DISCORD_APP_SERVER_REQUEST_TIMEOUT_MS, 30000),
    deliveryDrainIntervalMs: parseInteger(env.CODEX_DISCORD_QUEUE_DRAIN_INTERVAL_MS, 1000),
    deliveryDrainMaxBackoffMs: parseInteger(env.CODEX_DISCORD_QUEUE_DRAIN_MAX_BACKOFF_MS, 30000),
    parentPid: process.ppid,
    ownerId,
    cwd,
    hostname: os.hostname(),
    pid: parseInteger(env.CODEX_DISCORD_OWNER_PID || env.CODEX_OWNER_PID, process.pid),
    startedAt: new Date().toISOString(),
  };
}

module.exports = {
  loadConfig,
  loadEnvFile,
  parseInteger,
  parseBool,
  stripQuotes,
};
