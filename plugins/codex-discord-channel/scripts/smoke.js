'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SERVER_VERSION, toolList } = require('../src/mcp-server');

const root = path.resolve(__dirname, '..');
const PACKAGE_VERSION = '0.3.1';
const PLUGIN_VERSION_PREFIX = `${PACKAGE_VERSION}+codex.`;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const manifest = readJson('.codex-plugin/plugin.json');
const mcp = readJson('.mcp.json');
const pkg = readJson('package.json');

assert(manifest.name === 'codex-discord-channel', 'manifest name mismatch');
assert(
  typeof manifest.version === 'string' &&
    manifest.version.startsWith(PLUGIN_VERSION_PREFIX) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.version.slice(PLUGIN_VERSION_PREFIX.length)),
  'manifest version mismatch',
);
assert(manifest.mcpServers === './.mcp.json', 'manifest must point at .mcp.json');
assert(
  mcp.mcpServers['codex-discord-channel']?.args?.[0] === './runtime/mcp-server.cjs',
  'MCP server must run the committed runtime bundle',
);
assert(pkg.version === PACKAGE_VERSION, 'package version mismatch');
assert(SERVER_VERSION === PACKAGE_VERSION, 'MCP server version mismatch');
assert(pkg.bin['codex-discord-channel'] === 'bin/codex-discord-channel', 'bin entry mismatch');
for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
  assert(!Object.hasOwn(pkg.scripts, lifecycle), `package must not rely on ${lifecycle}`);
}

const historyTool = toolList().find((tool) => tool.name === 'discord_channel_read_history');
assert(historyTool, 'missing discord_channel_read_history tool');
assert(historyTool.inputSchema?.additionalProperties === false, 'history tool schema must reject unknown properties');
assert(historyTool.inputSchema?.properties?.limit?.minimum === 1, 'history tool minimum limit mismatch');
assert(historyTool.inputSchema?.properties?.limit?.maximum === 25, 'history tool maximum limit mismatch');
assert(historyTool.annotations?.readOnlyHint === true, 'history tool must be read-only');
assert(historyTool.annotations?.destructiveHint === false, 'history tool must be non-destructive');
assert(historyTool.annotations?.idempotentHint === true, 'history tool must be idempotent');
assert(historyTool.annotations?.openWorldHint === true, 'history tool must declare external Discord access');

const mcpServerSource = fs.readFileSync(path.join(root, 'src', 'mcp-server.js'), 'utf8');
assert(mcpServerSource.includes(`const SERVER_VERSION = '${PACKAGE_VERSION}';`), 'MCP server version mismatch');

const binPath = path.join(root, 'bin', 'codex-discord-channel');
const mode = fs.statSync(binPath).mode;
assert((mode & 0o111) !== 0, 'bin/codex-discord-channel must be executable');
assert(fs.existsSync(path.join(root, 'runtime', 'mcp-server.cjs')), 'missing MCP runtime bundle');
assert(fs.existsSync(path.join(root, 'THIRD_PARTY_NOTICES.txt')), 'missing bundled dependency notices');
assert(!fs.existsSync(path.join(root, '.env')), 'plugin root must not contain .env');

process.stdout.write('smoke passed\n');
