'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizedAppServerEnv } = require('./app-server-runtime');
const { loadEnvFile } = require('./config');

const ACCOUNT_BINDING_KEYS = new Set(['DISCORD_INSTANCE', 'DISCORD_CONFIG_DIR']);
const ENTER_KEYMAP_COMPAT_ARGS = [
  '-c',
  'tui.keymap.composer.submit=["enter","ctrl-m"]',
  '-c',
  'tui.keymap.editor.insert_newline=["ctrl-j","enter","shift-enter","alt-enter"]',
];
function verifyAccountBinding(config) {
  const binding = {};
  const loaded = loadEnvFile(config.paths.accountBindingPath, binding, {
    allowedKeys: ACCOUNT_BINDING_KEYS,
    strict: true,
  });
  if (!loaded) throw new Error(`Discord account binding is missing: ${config.paths.accountBindingPath}`);
  if (
    binding.DISCORD_INSTANCE !== config.paths.instance
    || path.resolve(binding.DISCORD_CONFIG_DIR || '') !== path.resolve(config.paths.stateDir)
  ) {
    throw new Error(`Discord account binding does not match instance ${config.paths.instance}`);
  }
}

function verifyLiveProcess(config, pid, dependencies = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid live service PID: ${pid}`);
  const readFileSync = dependencies.readFileSync || fs.readFileSync;
  let entries;
  try {
    entries = readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0').filter(Boolean);
  } catch {
    throw new Error(`Cannot read live service identity for PID ${pid}`);
  }
  const env = Object.fromEntries(entries.map((entry) => {
    const separator = entry.indexOf('=');
    return separator === -1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const explicitIdentityMatches = (
    env.CODEX_HOME !== config.codexHome
    || env.DISCORD_INSTANCE !== config.paths.instance
    || path.resolve(env.DISCORD_CONFIG_DIR || '') !== path.resolve(config.paths.stateDir)
  ) === false;
  if (explicitIdentityMatches) return;
  const generationIdentityMatches = Boolean(
    env.CODEX_DISCORD_LAUNCH_GENERATION
    && ['app', 'gateway'].includes(env.CODEX_DISCORD_LAUNCH_ROLE)
    && env.CODEX_DISCORD_LAUNCH_INSTANCE === config.paths.instance
    && path.resolve(env.CODEX_DISCORD_LAUNCH_STATE_DIR || '') === path.resolve(config.paths.stateDir)
    && path.resolve(env.CODEX_DISCORD_LAUNCH_CODEX_HOME || '') === path.resolve(config.codexHome)
    && path.resolve(env.CODEX_DISCORD_LAUNCH_PLUGIN_ROOT || '') === path.resolve(config.deliveryActivationId)
    && env.CODEX_DISCORD_LAUNCH_ENDPOINT === config.appServerUrl.replace(/^unix:\/\//, '')
  );
  if (generationIdentityMatches) return;

  let argv = [];
  try {
    argv = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  } catch {}
  const legacyDefaultAppServer = !env.CODEX_HOME
    && !env.DISCORD_INSTANCE
    && !env.DISCORD_CONFIG_DIR
    && path.join(env.HOME || '', '.codex') === config.codexHome
    && argv.includes('app-server')
    && argv.includes('--listen')
    && argv.includes(config.appServerUrl);
  if (legacyDefaultAppServer) return;
  throw new Error(`Live service PID ${pid} does not match instance ${config.paths.instance}`);
}

function requireInstancePrerequisites(config) {
  if (config.accountHomeSource === 'default') {
    throw new Error(`CODEX_HOME is not pinned in ${config.paths.accountEnvPath}`);
  }
  verifyAccountBinding(config);
  if (!config.tokenConfigured || !config.botUserId) {
    throw new Error(`Discord bot credentials are incomplete in ${config.paths.envFile}`);
  }
  const nodeBin = String(config.env.NODE_BIN || '').trim();
  const codexBin = String(config.env.CODEX_BIN || '').trim();
  if (!path.isAbsolute(nodeBin) || !path.isAbsolute(codexBin)) {
    throw new Error('NODE_BIN and CODEX_BIN must be absolute paths in account.env');
  }
  return { codexBin, nodeBin };
}

function requireInstanceReady(config, dependencies = {}) {
  const statSync = dependencies.statSync || fs.statSync;
  const existsSync = dependencies.existsSync || fs.existsSync;
  const { codexBin, nodeBin } = requireInstancePrerequisites(config);
  const authPath = path.join(config.codexHome, 'auth.json');
  if (!existsSync(authPath) || !statSync(authPath).isFile()) {
    const error = new Error(
      `OpenAI account is not logged in under ${config.codexHome}; run the account login command first`,
    );
    error.code = 'openai_account_login_missing';
    throw error;
  }
  return { authPath, codexBin, nodeBin };
}

function buildTuiLaunch(config, codexArgs = [], dependencies = {}) {
  const { codexBin, nodeBin } = requireInstanceReady(config, dependencies);
  return {
    command: nodeBin,
    args: [codexBin, '--remote', config.appServerUrl, ...ENTER_KEYMAP_COMPAT_ARGS, ...codexArgs],
    env: {
      ...sanitizedAppServerEnv(config),
      CODEX_HOME: config.codexHome,
      DISCORD_INSTANCE: config.paths.instance,
      DISCORD_CONFIG_DIR: config.paths.stateDir,
    },
  };
}

function runTui(config, codexArgs = [], dependencies = {}) {
  const launch = buildTuiLaunch(config, codexArgs, dependencies);
  const execve = dependencies.execve || process.execve;
  if (typeof execve !== 'function') throw new Error('Node 22.15 or newer is required for process.execve');
  return execve(launch.command, [launch.command, ...launch.args], launch.env);
}

module.exports = {
  buildTuiLaunch,
  requireInstanceReady,
  runTui,
  verifyAccountBinding,
  verifyLiveProcess,
};
