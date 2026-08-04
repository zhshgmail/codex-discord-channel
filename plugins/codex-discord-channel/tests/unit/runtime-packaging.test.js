'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');

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

function requestMcp(command, args, options, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    let stderr = '';
    let complete = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for isolated MCP responses: ${stderr}`));
    }, 5000);

    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (Object.hasOwn(message, 'id')) responses.set(String(message.id), message);
      if (responses.size === requests.length) {
        complete = true;
        child.kill('SIGTERM');
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      lines.close();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      lines.close();
      if (!complete) {
        reject(new Error(`Isolated MCP exited ${code ?? signal}: ${stderr}`));
        return;
      }
      resolve(requests.map((request) => responses.get(String(request.id))));
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function runMcpExpectFailure(command, args, options) {
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for isolated MCP identity failure'));
    }, 5000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

test('marketplace cache starts MCP without node_modules in an isolated Codex environment', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-marketplace-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  const xdgConfig = path.join(root, 'xdg-config');
  const xdgCache = path.join(root, 'xdg-cache');
  const xdgData = path.join(root, 'xdg-data');
  const xdgState = path.join(root, 'xdg-state');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    'utf8',
  ));
  const installedRoot = path.join(
    codexHome,
    'plugins',
    'cache',
    'personal',
    'codex-discord-channel',
    manifest.version,
  );
  fs.mkdirSync(path.dirname(installedRoot), { recursive: true });
  fs.cpSync(pluginRoot, installedRoot, {
    recursive: true,
    filter(source) {
      return !['node_modules', '.env'].includes(path.basename(source));
    },
  });

  assert.deepEqual(findNamed(installedRoot, 'node_modules'), []);
  const mcp = JSON.parse(fs.readFileSync(path.join(installedRoot, '.mcp.json'), 'utf8'))
    .mcpServers['codex-discord-channel'];
  assert.deepEqual(mcp.args, ['./runtime/mcp-server.cjs']);
  assert.equal(fs.existsSync(path.join(installedRoot, 'runtime', 'mcp-server.cjs')), true);

  const bundle = fs.readFileSync(path.join(installedRoot, 'runtime', 'mcp-server.cjs'), 'utf8');
  const imports = [...bundle.matchAll(/(?:require|__require)\(["']([^"']+)["']\)/g)]
    .map((match) => match[1]);
  assert.ok(imports.length > 0, 'bundle must retain explicit node:* imports');
  assert.deepEqual(imports.filter((specifier) => !specifier.startsWith('node:')), []);

  for (const directory of [home, codexHome, xdgConfig, xdgCache, xdgData, xdgState]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const stateDir = path.join(xdgState, 'discord', 'packaging-test');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'discord-instance.env'),
    `DISCORD_INSTANCE=packaging-test\nDISCORD_CONFIG_DIR=${stateDir}\n`,
  );
  fs.writeFileSync(path.join(stateDir, 'account.env'), `CODEX_HOME=${codexHome}\n`);
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    DISCORD_INSTANCE: 'packaging-test',
    DISCORD_CONFIG_DIR: stateDir,
    DISCORD_CHANNEL_DISABLE_LOGIN: '1',
    CODEX_DISCORD_DELIVERY_MODE: 'off',
    NODE_PATH: '',
  };
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'discord_channel_status', arguments: {} },
    },
  ];
  const [initialized, tools, status] = await requestMcp(
    process.execPath,
    mcp.args,
    { cwd: installedRoot, env },
    requests,
  );

  assert.equal(initialized.result.serverInfo.version, '0.3.0');
  assert.ok(tools.result.tools.some((tool) => tool.name === 'discord_channel_status'));
  assert.equal(status.result.structuredContent.stateDir, stateDir);
  assert.equal(status.result.structuredContent.discordReason, 'token_missing');
  assert.equal(fs.existsSync(path.join(stateDir, 'owner.json')), true);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
});

test('packaged MCP missing any selected identity exits before owner or Discord state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-marketplace-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const codexHome = path.join(root, 'codex-home');
  const stateDir = path.join(root, 'discord', 'codex02');
  const installedRoot = path.join(root, 'installed-plugin');
  fs.cpSync(pluginRoot, installedRoot, {
    recursive: true,
    filter(source) {
      return !['node_modules', '.env'].includes(path.basename(source));
    },
  });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'discord-instance.env'),
    `DISCORD_INSTANCE=codex02\nDISCORD_CONFIG_DIR=${stateDir}\n`,
  );
  fs.writeFileSync(path.join(stateDir, 'account.env'), `CODEX_HOME=${codexHome}\n`);

  const completeEnv = {
    HOME: root,
    CODEX_HOME: codexHome,
    DISCORD_INSTANCE: 'codex02',
    DISCORD_CONFIG_DIR: stateDir,
    DISCORD_BOT_TOKEN: 'must-not-be-used',
    NODE_PATH: '',
  };
  for (const missing of ['CODEX_HOME', 'DISCORD_INSTANCE', 'DISCORD_CONFIG_DIR']) {
    const env = { ...completeEnv };
    delete env[missing];
    const result = await runMcpExpectFailure(
      process.execPath,
      ['./runtime/mcp-server.cjs'],
      { cwd: installedRoot, env },
    );
    assert.equal(result.code, 1, missing);
    assert.match(result.stderr, new RegExp(`MCP account identity is missing:.*${missing}`));
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(stateDir, 'owner.json')), false, missing);
  }

  fs.rmSync(path.join(stateDir, 'account.env'));
  const missingReverse = await runMcpExpectFailure(
    process.execPath,
    ['./runtime/mcp-server.cjs'],
    { cwd: installedRoot, env: completeEnv },
  );
  assert.equal(missingReverse.code, 1);
  assert.match(missingReverse.stderr, /does not match its durable account binding/);
  assert.equal(missingReverse.stdout, '');
  assert.equal(fs.existsSync(path.join(stateDir, 'owner.json')), false);

  const bindingPath = path.join(codexHome, 'discord-instance.env');
  const accountPath = path.join(stateDir, 'account.env');
  const validBinding = `DISCORD_INSTANCE=codex02\nDISCORD_CONFIG_DIR=${stateDir}\n`;
  const validAccount = `CODEX_HOME=${codexHome}\n`;
  const incompleteRecords = [
    { path: bindingPath, content: '', label: 'empty account binding' },
    { path: bindingPath, content: 'DISCORD_INSTANCE=codex02\n', label: 'partial account binding' },
    { path: accountPath, content: '', label: 'empty reverse binding' },
    { path: accountPath, content: 'CODEX_BIN=/opt/codex\n', label: 'partial reverse binding' },
  ];
  for (const attack of incompleteRecords) {
    fs.writeFileSync(bindingPath, validBinding);
    fs.writeFileSync(accountPath, validAccount);
    fs.writeFileSync(attack.path, attack.content);
    const result = await runMcpExpectFailure(
      process.execPath,
      ['./runtime/mcp-server.cjs'],
      { cwd: installedRoot, env: completeEnv },
    );
    assert.equal(result.code, 1, attack.label);
    assert.match(result.stderr, /does not match its durable account binding/, attack.label);
    assert.equal(result.stdout, '', attack.label);
    assert.equal(fs.existsSync(path.join(stateDir, 'owner.json')), false, attack.label);
  }
});
