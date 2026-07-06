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
  const ownerId = env.CODEX_DISCORD_OWNER_ID || `${os.hostname()}:${process.pid}:${Date.now()}`;

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
    ownerId,
    cwd,
    hostname: os.hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

module.exports = {
  loadConfig,
  loadEnvFile,
  parseBool,
  stripQuotes,
};
