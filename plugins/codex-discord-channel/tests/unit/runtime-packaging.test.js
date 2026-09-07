'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const releasePackageVersion = '0.3.24';

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

test('marketplace cache starts the worker CLI without node_modules', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-marketplace-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installedRoot = path.join(root, 'installed-plugin');
  const stateDir = path.join(root, 'discord', 'codex01');
  const codexHome = path.join(root, 'codex-home');
  fs.cpSync(pluginRoot, installedRoot, {
    recursive: true,
    filter(source) {
      return !['node_modules', '.env'].includes(path.basename(source));
    },
  });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'account.env'), [
    `CODEX_HOME=${codexHome}`,
    `CODEX_BIN=${path.join(root, 'unused-codex.js')}`,
    `NODE_BIN=${process.execPath}`,
    '',
  ].join('\n'));

  assert.deepEqual(findNamed(installedRoot, 'node_modules'), []);
  const worker = path.join(installedRoot, 'runtime', 'channel.cjs');
  assert.equal(fs.existsSync(worker), true, 'runtime/channel.cjs must be committed');
  const result = spawnSync(process.execPath, [worker, '--help'], {
    cwd: installedRoot,
    encoding: 'utf8',
    env: {
      HOME: root,
      CODEX_HOME: codexHome,
      DISCORD_INSTANCE: 'codex01',
      DISCORD_CONFIG_DIR: stateDir,
      NODE_PATH: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Cannot find module/);
  const imports = [...fs.readFileSync(worker, 'utf8')
    .matchAll(/(?:require|__require)\(["']([^"']+)["']\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(imports.filter((specifier) => !specifier.startsWith('node:')), []);
});

test('stale runtime check fails clearly within a bounded Node heap', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-runtime-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copy = path.join(root, 'plugin');
  fs.cpSync(pluginRoot, copy, {
    recursive: true,
    filter(source) {
      return path.basename(source) !== 'node_modules';
    },
  });
  fs.symlinkSync(path.join(pluginRoot, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  fs.appendFileSync(path.join(copy, 'runtime', 'mcp-server.cjs'), '\n');

  const result = spawnSync(
    process.execPath,
    ['--max-old-space-size=256', 'scripts/build-runtime.js', '--check'],
    { cwd: copy, encoding: 'utf8', timeout: 10_000 },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /runtime\/mcp-server\.cjs is stale/);
});

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
  fs.writeFileSync(path.join(codexHome, 'discord-instance.env'), [
    'DISCORD_INSTANCE=packaging-test',
    `DISCORD_CONFIG_DIR=${stateDir}`,
    '',
  ].join('\n'));
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    DISCORD_CHANNEL_DISABLE_LOGIN: '1',
    CODEX_DISCORD_DELIVERY_MODE: 'off',
    NODE_PATH: '',
    // Exercise the distributed MCP command using the host's supported Node.
    // Calling process.execPath directly would hide a developer-specific path
    // accidentally shipped in the manifest.
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`,
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
    mcp.command,
    mcp.args,
    { cwd: installedRoot, env },
    requests,
  );

  assert.equal(
    initialized.result.serverInfo.version,
    releasePackageVersion,
    'stripped marketplace runtime must advertise the v0.3.24 package release',
  );
  assert.ok(tools.result.tools.some((tool) => tool.name === 'discord_channel_status'));
  assert.equal(status.result.structuredContent.stateDir, stateDir);
  assert.equal(status.result.structuredContent.discordReason, 'gateway_health_missing');
  assert.equal(status.result.structuredContent.mcpDiscordClientReason, 'token_missing');
  assert.equal(fs.existsSync(path.join(stateDir, 'owner.json')), true);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
});

test('two stripped marketplace MCP children recover only their own account bindings', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-marketplace-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(
    path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
    'utf8',
  ));
  const observed = [];

  for (const instance of ['codex01', 'codex02']) {
    const codexHome = path.join(root, `.codex-account-${instance.slice(-2)}`);
    const stateDir = path.join(root, 'discord', instance);
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
    fs.writeFileSync(path.join(codexHome, 'discord-instance.env'), [
      `DISCORD_INSTANCE=${instance}`,
      `DISCORD_CONFIG_DIR=${stateDir}`,
      '',
    ].join('\n'));

    const mcp = JSON.parse(fs.readFileSync(path.join(installedRoot, '.mcp.json'), 'utf8'))
      .mcpServers['codex-discord-channel'];
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'discord_channel_status', arguments: {} },
      },
    ];
    const [, status] = await requestMcp(
      process.execPath,
      mcp.args,
      {
        cwd: installedRoot,
        env: {
          HOME: home,
          DISCORD_CHANNEL_DISABLE_LOGIN: '1',
          CODEX_DISCORD_DELIVERY_MODE: 'off',
          NODE_PATH: '',
        },
      },
      requests,
    );
    observed.push(status.result.structuredContent);
  }

  assert.deepEqual(observed.map((status) => status.instance), ['codex01', 'codex02']);
  assert.deepEqual(observed.map((status) => status.accountBindingLoaded), [true, true]);
  assert.deepEqual(observed.map((status) => status.legacyInstanceFallbackUsed), [false, false]);
  assert.deepEqual(observed.map((status) => status.accountHomeSource), [
    'plugin_cache',
    'plugin_cache',
  ]);
  assert.notEqual(observed[0].stateDir, observed[1].stateDir);
  assert.equal(observed[0].stateDir, path.join(root, 'discord', 'codex01'));
  assert.equal(observed[1].stateDir, path.join(root, 'discord', 'codex02'));
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
});
