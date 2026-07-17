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
  const deliveryMode = String(env.CODEX_DISCORD_DELIVERY_MODE || env.DISCORD_DELIVERY_MODE || 'tty').toLowerCase();
  const ttyPromptFormat = String(env.CODEX_DISCORD_TTY_PROMPT_FORMAT || env.CODEX_TTY_PROMPT_FORMAT || 'minimal').toLowerCase();

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
    tty: env.CODEX_DISCORD_TTY || env.CODEX_TTY || '',
    ttyPid: env.CODEX_DISCORD_TTY_PID || env.CODEX_TTY_PID || '',
    ttyUseSudo: parseBool(env.CODEX_DISCORD_TTY_USE_SUDO || env.CODEX_TTY_USE_SUDO, true),
    ttyPromptFormat: ['full', 'compact', 'minimal', 'plain', 'display'].includes(ttyPromptFormat) ? ttyPromptFormat : 'minimal',
    ttySubmit: parseBool(env.CODEX_DISCORD_TTY_SUBMIT || env.CODEX_TTY_SUBMIT, true),
    ttySubmitSequence: env.CODEX_DISCORD_TTY_SUBMIT_SEQUENCE || env.CODEX_TTY_SUBMIT_SEQUENCE || 'cr',
    ttyInjectTimeoutMs: parseInteger(env.CODEX_DISCORD_TTY_INJECT_TIMEOUT_MS || env.CODEX_TTY_INJECT_TIMEOUT_MS, 15000),
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
