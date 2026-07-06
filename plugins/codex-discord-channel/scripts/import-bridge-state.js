#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolvePaths } = require('../src/paths');
const { loadEnvFile } = require('../src/config');

function parseArgs(argv) {
  const args = {
    instance: '',
    from: '',
    to: '',
    force: false,
    fetchBotId: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--instance') args.instance = argv[++index] || '';
    else if (item === '--from') args.from = argv[++index] || '';
    else if (item === '--to') args.to = argv[++index] || '';
    else if (item === '--force') args.force = true;
    else if (item === '--fetch-bot-id') args.fetchBotId = true;
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function parseEnvText(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function setEnvValue(envPath, key, value) {
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (line.trim().match(new RegExp(`^(?:export\\s+)?${key}=`))) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== '') next.push('');
    next.push(`${key}=${value}`);
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envPath, `${next.join('\n').replace(/\n+$/g, '')}\n`, { mode: 0o600 });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bridgeStateToAccess(state, sourcePath) {
  return {
    version: 1,
    dmPolicy: state.dmPolicy || 'pairing',
    allowFrom: Array.isArray(state.allowFrom) ? state.allowFrom : [],
    groups: state.groups && typeof state.groups === 'object' ? state.groups : {},
    pendingPairings: state.pendingPairings && typeof state.pendingPairings === 'object' ? state.pendingPairings : {},
    mentionPatterns: Array.isArray(state.mentionPatterns) ? state.mentionPatterns : [],
    ackReaction: state.ackReaction,
    replyToMode: state.replyToMode || 'reply',
    textChunkLimit: Number.isInteger(state.textChunkLimit) ? state.textChunkLimit : 1900,
    chunkMode: state.chunkMode || 'split',
    threads: state.threads && typeof state.threads === 'object' ? state.threads : {},
    importedFrom: {
      kind: 'discord-codex-bridge',
      statePath: sourcePath,
      importedAt: new Date().toISOString(),
    },
  };
}

async function fetchBotUserId(token) {
  configureFetchProxy();
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Discord /users/@me returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload.id !== 'string') {
    throw new Error('Discord /users/@me response did not include id.');
  }
  return payload.id;
}

function configureFetchProxy() {
  const proxyUrl =
    process.env.DISCORD_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  if (!proxyUrl) return;
  const { ProxyAgent, setGlobalDispatcher } = require('undici');
  const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
  setGlobalDispatcher(new ProxyAgent({
    uri: proxyUrl,
    requestTls: { rejectUnauthorized },
    proxyTls: { rejectUnauthorized },
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...process.env };
  if (args.instance) {
    env.DISCORD_INSTANCE = args.instance;
    env.DISCORD_BRIDGE_INSTANCE = args.instance;
  }

  const destination = args.to ? path.resolve(args.to) : resolvePaths(env).stateDir;
  const source = args.from ? path.resolve(args.from) : destination;
  const sourceEnvPath = path.join(source, '.env');
  const sourceStatePath = path.join(source, 'state.json');
  const destinationEnvPath = path.join(destination, '.env');
  const destinationAccessPath = path.join(destination, 'access.json');

  if (!fs.existsSync(sourceEnvPath)) throw new Error(`Missing bridge env file: ${sourceEnvPath}`);
  if (!fs.existsSync(sourceStatePath)) throw new Error(`Missing bridge state file: ${sourceStatePath}`);
  if (fs.existsSync(destinationAccessPath) && !args.force) {
    throw new Error(`Refusing to overwrite ${destinationAccessPath}; pass --force to replace it.`);
  }

  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  if (sourceEnvPath !== destinationEnvPath) {
    fs.copyFileSync(sourceEnvPath, destinationEnvPath);
    fs.chmodSync(destinationEnvPath, 0o600);
  }

  setEnvValue(destinationEnvPath, 'DISCORD_INSTANCE', args.instance || resolvePaths(env).instance);

  const state = readJson(sourceStatePath);
  const access = bridgeStateToAccess(state, sourceStatePath);
  fs.writeFileSync(destinationAccessPath, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });

  let botUserId = '';
  if (args.fetchBotId) {
    const tokenEnv = parseEnvText(fs.readFileSync(destinationEnvPath, 'utf8'));
    loadEnvFile(destinationEnvPath, tokenEnv);
    const token = tokenEnv.DISCORD_BOT_TOKEN || tokenEnv.DISCORD_TOKEN || '';
    if (!token) throw new Error(`Cannot fetch bot id because ${destinationEnvPath} has no Discord token.`);
    botUserId = await fetchBotUserId(token);
    setEnvValue(destinationEnvPath, 'DISCORD_BOT_USER_ID', botUserId);
  }

  process.stdout.write(`${JSON.stringify({
    imported: true,
    source,
    destination,
    envReused: sourceEnvPath === destinationEnvPath,
    accessPath: destinationAccessPath,
    dmPolicy: access.dmPolicy,
    allowFromCount: access.allowFrom.length,
    groupCount: Object.keys(access.groups).length,
    botUserIdConfigured: Boolean(botUserId),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
