'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SERVER_VERSION, toolList } = require('../src/mcp-server');

const root = path.resolve(__dirname, '..');
const PACKAGE_VERSION = '0.3.23';

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function appearsInOrder(document, before, after) {
  const normalized = document.replace(/\s+/g, ' ').toLowerCase();
  const beforeIndex = normalized.indexOf(before.toLowerCase());
  const afterIndex = normalized.indexOf(after.toLowerCase());
  return beforeIndex >= 0 && afterIndex > beforeIndex;
}

function markdownSection(document, heading) {
  const start = document.indexOf(`${heading}\n`);
  if (start < 0) return '';
  const contentStart = start + heading.length + 1;
  const rest = document.slice(contentStart);
  const nextHeading = rest.search(/\n#{1,3} /);
  return nextHeading < 0 ? rest : rest.slice(0, nextHeading);
}

const manifest = readJson('.codex-plugin/plugin.json');
const mcp = readJson('.mcp.json');
const pkg = readJson('package.json');
const repoRoot = path.resolve(root, '..', '..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const pluginSkill = fs.readFileSync(path.join(root, 'skills', 'codex-discord-channel', 'SKILL.md'), 'utf8');
const knownIssues = fs.readFileSync(path.join(repoRoot, 'docs', 'known-issues.md'), 'utf8');

assert(manifest.name === 'codex-discord-channel', 'manifest name mismatch');
assert(manifest.version.split('+')[0] === PACKAGE_VERSION, 'manifest release version mismatch');
assert(manifest.mcpServers === './.mcp.json', 'manifest must point at .mcp.json');
assert(
  mcp.mcpServers['codex-discord-channel']?.args?.[0] === './runtime/mcp-server.cjs',
  'MCP server must run the committed runtime bundle',
);
assert(pkg.version === PACKAGE_VERSION, 'package version mismatch');
assert(SERVER_VERSION === PACKAGE_VERSION, 'MCP server version mismatch');
assert(
  pluginSkill.includes('<channel source="discord"'),
  'Discord skill must trigger on Discord-origin envelopes',
);
for (const requiredReplyContract of [
  'mcp__codex_discord_channel__discord_channel_send',
  'replyTo: <message_id>',
  'mcp__codex_discord_channel__discord_channel_read_history',
  'do not send a duplicate',
  'restarting, killing, or replacing',
]) {
  assert(
    pluginSkill.includes(requiredReplyContract),
    `Discord skill is missing reply contract: ${requiredReplyContract}`,
  );
}
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
assert(fs.existsSync(path.join(root, 'runtime', 'channel.cjs')), 'missing worker runtime bundle');
assert(fs.existsSync(path.join(root, 'THIRD_PARTY_NOTICES.txt')), 'missing bundled dependency notices');
assert(!fs.existsSync(path.join(root, '.env')), 'plugin root must not contain .env');
assert(!readme.includes('## Start The Shared Runtime'), 'README must not prescribe split shared-runtime startup');
assert(
  readme.includes('codex-discord-instance INSTANCE resume --last'),
  'README must prescribe the alias-owned launcher for production startup',
);
assert(
  readme.includes('Exit the selected alias first'),
  'README must require alias exit before marketplace replacement removes its old cache',
);
const runtimeUpdates = markdownSection(readme, '### Runtime Updates');
assert(
  appearsInOrder(
    runtimeUpdates,
    'Exit the selected alias first',
    'from an ordinary shell, replace its marketplace revision',
  ),
  'README runtime update must order alias exit before marketplace replacement',
);
assert(
  !readme.includes('Install the new marketplace revision, then exit'),
  'README must not remove a running generation before alias exit',
);
for (const [name, document] of [['plugin skill', pluginSkill], ['known issues', knownIssues]]) {
  assert(!document.includes('codex --remote <same-endpoint>'), `${name} must not prescribe a bare remote TUI`);
  assert(!document.includes('migrate the gateway'), `${name} must not prescribe split gateway migration`);
  assert(!document.includes("marketplace, then exit"), `${name} must not install before alias exit`);
}
assert(
  appearsInOrder(
    markdownSection(pluginSkill, '## Alias-Owned Runtime Boundary'),
    'Exit only the selected alias',
    'install the released plugin',
  ),
  'plugin skill must order alias exit before marketplace installation',
);
assert(
  appearsInOrder(
    markdownSection(knownIssues, '## Installed Plugin Changes Do Not Appear In An Existing Session'),
    'Exit the selected alias first',
    'install the new plugin version',
  ),
  'known issues must order alias exit before marketplace installation',
);
const priorBrokenSkill = [
  '1. Install the released plugin through that account configured marketplace.',
  '2. Verify the account binding.',
  '3. Exit only the selected alias and relaunch it.',
].join('\n');
assert(
  !appearsInOrder(priorBrokenSkill, 'Exit only the selected alias', 'install the released plugin'),
  'ordering gate must reject the prior install-before-exit skill regression',
);
const priorCrossSectionFalseGreen = [
  '## Earlier Section',
  'Exit the selected alias first.',
  '### Runtime Updates',
  'From an ordinary shell, replace its marketplace revision, then exit the selected alias.',
].join('\n');
assert(
  !appearsInOrder(
    markdownSection(priorCrossSectionFalseGreen, '### Runtime Updates'),
    'Exit the selected alias first',
    'from an ordinary shell, replace its marketplace revision',
  ),
  'ordering gate must not borrow an exit step from another README section',
);

process.stdout.write('smoke passed\n');
