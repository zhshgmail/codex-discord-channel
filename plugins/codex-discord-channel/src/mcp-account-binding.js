'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { expandPath } = require('./paths');

function canonicalPath(value, fsImpl = fs) {
  const resolved = path.resolve(value);
  try {
    return fsImpl.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function installedCodexHome(pluginRoot, fsImpl = fs) {
  const root = path.resolve(pluginRoot);
  const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
  const mcpPath = path.join(root, '.mcp.json');
  if (!fsImpl.existsSync(manifestPath) || !fsImpl.existsSync(mcpPath)) return '';

  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  } catch {
    return '';
  }
  if (manifest?.name !== 'codex-discord-channel') return '';

  const pluginNameDir = path.dirname(root);
  const marketplaceDir = path.dirname(pluginNameDir);
  const cacheDir = path.dirname(marketplaceDir);
  const pluginsDir = path.dirname(cacheDir);
  if (path.basename(cacheDir) !== 'cache' || path.basename(pluginsDir) !== 'plugins') {
    return '';
  }
  return path.dirname(pluginsDir);
}

function bindMcpToInstalledAccount(inputEnv, pluginRoot, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const env = { ...inputEnv };
  const installedHome = installedCodexHome(pluginRoot, fsImpl);
  if (!installedHome) return env;

  const explicitHome = String(env.CODEX_HOME || '').trim();
  if (explicitHome) {
    const selected = canonicalPath(expandPath(explicitHome, env), fsImpl);
    const installed = canonicalPath(installedHome, fsImpl);
    if (selected !== installed) {
      const error = new Error('Installed Discord MCP account conflicts with CODEX_HOME');
      error.code = 'mcp_account_home_conflict';
      throw error;
    }
  }
  env.CODEX_HOME = installedHome;
  return env;
}

module.exports = {
  bindMcpToInstalledAccount,
  installedCodexHome,
};
