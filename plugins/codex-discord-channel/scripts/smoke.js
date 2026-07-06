'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

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
assert(manifest.mcpServers === './.mcp.json', 'manifest must point at .mcp.json');
assert(mcp.mcpServers['codex-discord-channel'], 'missing MCP server config');
assert(pkg.bin['codex-discord-channel'] === 'bin/codex-discord-channel', 'bin entry mismatch');

const binPath = path.join(root, 'bin', 'codex-discord-channel');
const mode = fs.statSync(binPath).mode;
assert((mode & 0o111) !== 0, 'bin/codex-discord-channel must be executable');
assert(!fs.existsSync(path.join(root, '.env')), 'plugin root must not contain .env');

process.stdout.write('smoke passed\n');
