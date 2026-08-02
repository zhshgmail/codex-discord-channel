'use strict';

const os = require('node:os');
const path = require('node:path');

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }
  return '';
}

function expandPath(input, env = process.env) {
  if (!input) return input;
  let value = String(input);
  const home = env.HOME || os.homedir();
  if (value === '~') value = home;
  if (value.startsWith('~/')) value = path.join(home, value.slice(2));
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => env[key] || '');
  value = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => env[key] || '');
  return path.resolve(value);
}

function normalizeInstance(raw) {
  const value = firstNonEmpty(raw, 'default').toLowerCase();
  const normalized = value.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'default';
}

function resolvePaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const codexHome = firstNonEmpty(env.CODEX_HOME, path.join(home, '.codex'));
  const instance = normalizeInstance(firstNonEmpty(env.DISCORD_INSTANCE, env.DISCORD_BRIDGE_INSTANCE));
  const baseDir = expandPath(
    firstNonEmpty(env.DISCORD_CONFIG_BASE_DIR, path.join(codexHome, 'channels', 'discord')),
    env,
  );
  const stateDir = expandPath(
    firstNonEmpty(env.DISCORD_STATE_DIR, env.DISCORD_CONFIG_DIR, path.join(baseDir, instance)),
    env,
  );

  return {
    instance,
    baseDir,
    stateDir,
    accountBindingPath: expandPath(
      firstNonEmpty(env.CODEX_DISCORD_BINDING_FILE, path.join(codexHome, 'discord-instance.env')),
      env,
    ),
    accountEnvPath: expandPath(
      firstNonEmpty(env.CODEX_ACCOUNT_ENV_FILE, path.join(stateDir, 'account.env')),
      env,
    ),
    networkEnvPath: expandPath(
      firstNonEmpty(env.CODEX_NETWORK_ENV_FILE, path.join(stateDir, 'app-server-network.env')),
      env,
    ),
    envFile: expandPath(firstNonEmpty(env.DISCORD_ENV_FILE, path.join(stateDir, '.env')), env),
    accessPath: expandPath(firstNonEmpty(env.DISCORD_ACCESS_FILE, path.join(stateDir, 'access.json')), env),
    ownerPath: expandPath(firstNonEmpty(env.DISCORD_OWNER_FILE, path.join(stateDir, 'owner.json')), env),
    gatewayPidPath: expandPath(firstNonEmpty(env.DISCORD_GATEWAY_PID_FILE, path.join(stateDir, 'session-gateway.pid')), env),
    lastInboundPath: expandPath(firstNonEmpty(env.DISCORD_LAST_INBOUND_FILE, path.join(stateDir, 'last-inbound.json')), env),
    deliveryQueuePath: expandPath(firstNonEmpty(env.DISCORD_DELIVERY_QUEUE_FILE, path.join(stateDir, 'pending-delivery.json')), env),
  };
}

module.exports = {
  expandPath,
  firstNonEmpty,
  normalizeInstance,
  resolvePaths,
};
