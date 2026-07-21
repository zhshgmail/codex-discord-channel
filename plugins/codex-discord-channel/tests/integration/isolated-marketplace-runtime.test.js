'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const fakeCodex = path.join(pluginRoot, 'tests', 'fixtures', 'fake-codex.js');
const realCodex = process.env.CODEX_BIN || findExecutable('codex');

function findExecutable(name) {
  const result = spawnSync('which', [name], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.stack);
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result;
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stderr, stdout });
      else reject(new Error(`command exited ${code ?? signal}: ${stdout}\n${stderr}`));
    });
  });
}

function copyMarketplace(sourceRoot) {
  fs.mkdirSync(path.join(sourceRoot, 'plugins'), { recursive: true });
  fs.cpSync(path.join(repositoryRoot, '.agents'), path.join(sourceRoot, '.agents'), {
    recursive: true,
  });
  fs.cpSync(pluginRoot, path.join(sourceRoot, 'plugins', 'codex-discord-channel'), {
    recursive: true,
    filter(source) {
      return !['node_modules', '.env'].includes(path.basename(source));
    },
  });
}

function findNamed(root, name) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name === name) matches.push(entryPath);
      if (entry.isDirectory()) visit(entryPath);
    }
  };
  visit(root);
  return matches;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(pid) {
  if (!processExists(pid)) return;
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50 && processExists(pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (processExists(pid)) process.kill(pid, 'SIGKILL');
  assert.equal(processExists(pid), false, `fake app-server ${pid} must be reaped`);
}

async function mcpRequests(command, args, options, requests) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const responses = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const complete = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (responses.size !== requests.length) {
          reject(new Error(`MCP exited early (${code ?? signal}): ${stderr}`));
        }
      });
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        if (Object.hasOwn(message, 'id')) responses.set(String(message.id), message);
        if (responses.size === requests.length) resolve();
      });
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
    await complete;
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill('SIGTERM');
  }
  return requests.map((request) => responses.get(String(request.id)));
}

async function codexHostedMcpStatus(command, options) {
  const child = spawn(command, ['app-server', '--stdio'], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  let nextId = 1;
  const exit = new Promise((resolve) => child.once('exit', resolve));

  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const request = pending.get(String(message.id));
    if (!request) return;
    pending.delete(String(message.id));
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  child.once('error', (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`Codex app-server exited ${code ?? signal}: ${stderr}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });

  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      pending.delete(String(id));
      reject(new Error(`Timed out waiting for Codex app-server ${method}: ${stderr}`));
    }, 10000);
    pending.set(String(id), { reject, resolve, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  try {
    await request('initialize', {
      clientInfo: { name: 'codex_discord_channel_test', version: '0.1.0' },
    });
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    return await request('mcpServerStatus/list', {});
  } finally {
    child.kill('SIGTERM');
    const stopped = await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!stopped) {
      child.kill('SIGKILL');
      await exit;
    }
    lines.close();
  }
}

test('real marketplace cache runs bundled MCP, CLI dependencies, and shared-session topology without npm', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex marketplace runtime with spaces '));
  let appServerPid = 0;
  t.after(async () => {
    await stopProcess(appServerPid);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sourceRoot = path.join(root, 'marketplace source with spaces');
  const isolatedHome = path.join(root, 'isolated home with spaces');
  const codexHome = path.join(isolatedHome, '.codex');
  const fakeBin = path.join(root, 'sentinel bin');
  const npmSentinel = path.join(root, 'npm-was-run');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  copyMarketplace(sourceRoot);
  const fakeNpm = path.join(fakeBin, 'npm');
  fs.writeFileSync(fakeNpm, `#!/bin/sh\nprintf '%s\\n' "$*" > "${npmSentinel}"\nexit 97\n`, { mode: 0o755 });

  const isolatedEnv = {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    HOME: isolatedHome,
    CODEX_HOME: codexHome,
  };
  run(realCodex, ['plugin', 'marketplace', 'add', sourceRoot, '--json'], { env: isolatedEnv });
  const install = run(
    realCodex,
    ['plugin', 'add', 'codex-discord-channel@personal', '--json'],
    { env: isolatedEnv },
  );
  const installedPath = JSON.parse(install.stdout).installedPath;
  assert.match(installedPath, / /, 'installed cache path must retain spaces');
  assert.equal(path.relative(path.join(codexHome, 'plugins', 'cache'), installedPath).startsWith('..'), false);
  assert.equal(fs.existsSync(npmSentinel), false, 'marketplace install must not execute npm');
  assert.deepEqual(findNamed(installedPath, 'node_modules'), []);

  const mcpConfig = JSON.parse(fs.readFileSync(path.join(installedPath, '.mcp.json'), 'utf8'))
    .mcpServers['codex-discord-channel'];
  assert.equal(fs.existsSync(path.join(installedPath, 'runtime', 'mcp-server.cjs')), true);
  assert.equal(fs.existsSync(path.join(installedPath, 'runtime', 'channel-cli.cjs')), true);
  assert.equal(fs.existsSync(path.join(installedPath, 'bin', 'codex-discord-session')), true);

  const stateDir = path.join(root, 'isolated plugin state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, '.env'),
    'DISCORD_CHANNEL_DISABLE_LOGIN=1\n',
    { mode: 0o600 },
  );
  const hostedEnv = {
    ...isolatedEnv,
    DISCORD_INSTANCE: 'codex01',
    DISCORD_STATE_DIR: stateDir,
    NODE_PATH: '',
  };
  const hostedStatus = await codexHostedMcpStatus(realCodex, {
    cwd: installedPath,
    env: hostedEnv,
  });
  const hostedPlugin = hostedStatus.data.find((server) => server.name === 'codex-discord-channel');
  assert.ok(hostedPlugin, 'real Codex host must discover the installed MCP server');
  assert.ok(hostedPlugin.tools.discord_channel_status);
  const hostedOwnerPath = path.join(stateDir, 'owner.json');
  assert.equal(
    fs.existsSync(hostedOwnerPath),
    true,
    'real Codex-hosted MCP must use the gateway/session Discord state binding',
  );
  assert.equal(JSON.parse(fs.readFileSync(hostedOwnerPath, 'utf8')).instance, 'codex01');
  assert.equal(
    fs.existsSync(path.join(codexHome, 'channels', 'discord', 'default', 'owner.json')),
    false,
    'real Codex-hosted MCP must not fall back to the default instance state',
  );

  assert.deepEqual(mcpConfig, {
    cwd: '.',
    command: 'node',
    args: ['./runtime/mcp-server.cjs'],
    env_vars: ['CODEX_HOME', 'DISCORD_INSTANCE', 'DISCORD_STATE_DIR'],
  });
  const noticesPath = path.join(installedPath, 'THIRD_PARTY_NOTICES.txt');
  assert.equal(fs.existsSync(noticesPath), true, 'marketplace payload must include third-party notices');
  assert.equal(
    fs.readFileSync(noticesPath, 'utf8'),
    fs.readFileSync(path.join(pluginRoot, 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
  );

  const runtimeEnv = {
    ...hostedEnv,
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '',
    NODE_PATH: '',
  };
  const [initialized, tools] = await mcpRequests(
    mcpConfig.command,
    mcpConfig.args,
    { cwd: installedPath, env: runtimeEnv },
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ],
  );
  assert.equal(initialized.result.serverInfo.version, '0.2.0');
  assert.ok(tools.result.tools.some((tool) => tool.name === 'discord_channel_status'));

  const dependencySmoke = run(
    path.join(installedPath, 'bin', 'codex-discord-channel'),
    ['runtime-deps-check'],
    { cwd: installedPath, env: runtimeEnv },
  );
  assert.deepEqual(JSON.parse(dependencySmoke.stdout), {
    discordJs: true,
    undici: true,
    ws: true,
  });

  const loadedThreadFile = path.join(root, 'loaded-thread.json');
  const visibleLog = path.join(root, 'visible-session.json');
  const protocolLog = path.join(root, 'protocol.jsonl');
  const topologyEnv = {
    ...runtimeEnv,
    CODEX_DISCORD_CODEX_BIN: fakeCodex,
    CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS: '4000',
    CODEX_DISCORD_SESSION_POLL_INTERVAL_MS: '25',
    FAKE_CODEX_LOADED_THREAD: loadedThreadFile,
    FAKE_CODEX_VISIBLE_LOG: visibleLog,
    FAKE_CODEX_PROTOCOL_LOG: protocolLog,
  };
  const pidFile = path.join(stateDir, 'app-server.pid');

  const sessionBin = path.join(installedPath, 'bin', 'codex-discord-session');
  await Promise.all([
    runAsync(sessionBin, ['resume', '--last'], { cwd: installedPath, env: topologyEnv }),
    runAsync(sessionBin, ['resume', '--last'], { cwd: installedPath, env: topologyEnv }),
  ]);
  appServerPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  const endpoint = `unix://${path.join(stateDir, 'app-server.sock')}`;
  const visibleSessions = readJsonLines(visibleLog);
  assert.equal(visibleSessions.length, 2);
  for (const visible of visibleSessions) {
    assert.deepEqual(visible, {
      args: ['--remote', endpoint, 'resume', '--last'],
      endpoint,
      threadId: 'thread-loaded-by-visible-session',
    });
  }

  const probe = run(
    path.join(installedPath, 'bin', 'codex-discord-channel'),
    ['gateway-probe', '--timeout-ms', '2000', '--exercise-turn'],
    { cwd: installedPath, env: topologyEnv },
  );
  assert.deepEqual(JSON.parse(probe.stdout), {
    available: true,
    status: 'idle',
    threadId: 'thread-loaded-by-visible-session',
    turnStarted: true,
  });
  const methods = readJsonLines(protocolLog).map((entry) => entry.method).filter(Boolean);
  const listeners = readJsonLines(protocolLog).filter((entry) => entry.event === 'listening');
  assert.equal(listeners.length, 1, 'concurrent launches must share one app-server');
  assert.ok(methods.includes('thread/loaded/list'));
  assert.ok(methods.includes('thread/read'));
  assert.ok(methods.includes('turn/start'));
  assert.equal(fs.existsSync(npmSentinel), false, 'installed runtime must not execute npm');
});
