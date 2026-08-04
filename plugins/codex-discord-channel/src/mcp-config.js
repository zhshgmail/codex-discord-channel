'use strict';

const path = require('node:path');
const { loadConfig } = require('./config');

const REQUIRED_MCP_IDENTITY_KEYS = [
  'CODEX_HOME',
  'DISCORD_INSTANCE',
  'DISCORD_CONFIG_DIR',
];

function requireMcpIdentity(inputEnv) {
  const env = { ...inputEnv };
  const missing = REQUIRED_MCP_IDENTITY_KEYS.filter(
    (key) => String(env[key] || '').trim() === '',
  );
  if (missing.length > 0) {
    const error = new Error(`MCP account identity is missing: ${missing.join(', ')}`);
    error.code = 'mcp_account_identity_missing';
    throw error;
  }
  if (!path.isAbsolute(env.CODEX_HOME) || !path.isAbsolute(env.DISCORD_CONFIG_DIR)) {
    const error = new Error('MCP account identity paths must be absolute');
    error.code = 'mcp_account_identity_invalid';
    throw error;
  }
  return env;
}

function loadMcpConfig(inputEnv = process.env) {
  const env = requireMcpIdentity(inputEnv);
  const config = loadConfig(env);
  const matches = config.accountBindingLoaded
    && path.resolve(config.codexHome) === path.resolve(env.CODEX_HOME)
    && config.paths.instance === env.DISCORD_INSTANCE
    && path.resolve(config.paths.stateDir) === path.resolve(env.DISCORD_CONFIG_DIR);
  if (!matches) {
    const error = new Error('MCP account identity does not match its durable account binding');
    error.code = 'mcp_account_identity_mismatch';
    throw error;
  }
  return config;
}

module.exports = {
  REQUIRED_MCP_IDENTITY_KEYS,
  loadMcpConfig,
  requireMcpIdentity,
};
