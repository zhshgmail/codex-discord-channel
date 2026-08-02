'use strict';

const fs = require('node:fs');
const path = require('node:path');

function canonicalPath(input) {
  let current = path.resolve(input);
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

function pathContains(parent, child) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function accountStateRelationship(accountHome, stateDir) {
  const account = canonicalPath(accountHome);
  const state = canonicalPath(stateDir);
  if (account === state) return 'same';
  if (pathContains(account, state)) return 'account_contains_state';
  if (pathContains(state, account)) return 'state_contains_account';
  return 'disjoint';
}

function sanitizedAppServerEnv(config) {
  const env = { ...config.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('DISCORD_')) delete env[key];
    if (
      key === 'CODEX_THREAD_ID' ||
      key === 'CODEX_SESSION_ID' ||
      key === 'CODEX_APP_SERVER_SOCKET' ||
      key === 'CODEX_CWD' ||
      key.startsWith('CODEX_TARGET_') ||
      key.startsWith('CODEX_DISCORD_') ||
      key.startsWith('CODEX_TURN_') ||
      key.startsWith('CODEX_WAKE_') ||
      key.startsWith('CODEX_DENY_')
    ) {
      delete env[key];
    }
  }
  return env;
}

function buildAppServerLaunch(config) {
  if (config.accountHomeSource === 'default') {
    const error = new Error(
      `CODEX_HOME must be set in ${config.paths.accountEnvPath} or the service environment`,
    );
    error.code = 'codex_account_home_required';
    throw error;
  }

  const command = String(config.env.NODE_BIN || '').trim();
  const codexBin = String(config.env.CODEX_BIN || '').trim();
  if (!path.isAbsolute(command) || !path.isAbsolute(codexBin)) {
    const error = new Error(
      'NODE_BIN and the CODEX_BIN JavaScript entry point must both be absolute paths',
    );
    error.code = 'codex_bin_required';
    throw error;
  }

  return {
    command,
    args: [codexBin, 'app-server', '--listen', config.appServerUrl],
    env: {
      ...sanitizedAppServerEnv(config),
      CODEX_HOME: config.codexHome,
      DISCORD_INSTANCE: config.paths.instance,
      DISCORD_CONFIG_DIR: config.paths.stateDir,
      CODEX_DISCORD_APP_SERVER_URL: config.appServerUrl,
    },
  };
}

function runAppServer(config, dependencies = {}) {
  const launch = buildAppServerLaunch(config);
  const execve = dependencies.execve || process.execve;
  if (typeof execve !== 'function') {
    const error = new Error('Node 22.15 or newer is required for process.execve');
    error.code = 'node_execve_required';
    throw error;
  }
  return execve(launch.command, [launch.command, ...launch.args], launch.env);
}

function instanceDoctor(config) {
  return {
    instance: config.paths.instance,
    accountEnvPath: config.paths.accountEnvPath,
    accountBindingPath: config.paths.accountBindingPath,
    accountBindingLoaded: config.accountBindingLoaded,
    legacyInstanceFallbackUsed: config.legacyInstanceFallbackUsed,
    accountEnvLoaded: config.accountEnvLoaded,
    accountHomeSource: config.accountHomeSource,
    codexHome: config.codexHome,
    discordStateDir: config.paths.stateDir,
    appServerUrl: config.appServerUrl,
    botUserId: config.botUserId,
    botTokenConfigured: config.tokenConfigured,
    accountStateRelationship: accountStateRelationship(config.codexHome, config.paths.stateDir),
  };
}

module.exports = {
  buildAppServerLaunch,
  accountStateRelationship,
  instanceDoctor,
  runAppServer,
  sanitizedAppServerEnv,
};
