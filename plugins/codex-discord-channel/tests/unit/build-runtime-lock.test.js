'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginRoot = path.resolve(__dirname, '..', '..');
const buildScript = path.join(pluginRoot, 'scripts', 'build-runtime.js');
const wrapper = path.join(pluginRoot, 'scripts', 'build-runtime-locked.sh');

function executable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

function lockFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-build-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const runtime = path.join(root, 'runtime');
  const entered = path.join(root, 'entered');
  fs.mkdirSync(bin);
  fs.mkdirSync(runtime);
  executable(path.join(bin, 'node'), [
    `#!${process.execPath}`,
    "'use strict';",
    "if (process.argv.includes('--recover-publish')) process.exit(0);",
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.FAKE_ENTERED, `${process.pid}|${process.env.CODEX_DISCORD_BUILD_TEMPORARY_DIRECTORY || ''}\\n`);",
    "if (process.env.FAKE_SLOW_TERM === '1') process.on('SIGTERM', () => setTimeout(() => process.exit(143), 250));",
    "if (process.env.FAKE_HOLD === '1') setInterval(() => {}, 1000);",
    '',
  ].join('\n'));
  return {
    entered,
    env: {
      ...process.env,
      FAKE_ENTERED: entered,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_RUNTIME_DIR: runtime,
    },
    root,
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timed out waiting for wrapper exit'));
    }, 3000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function enteredRows(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => {
    const [pid, temporaryDirectory] = line.split('|');
    return { pid: Number(pid), temporaryDirectory };
  });
}

function directBypassFixture(t) {
  const setup = lockFixture(t);
  const plugin = path.join(setup.root, 'plugin');
  const scripts = path.join(plugin, 'scripts');
  fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'src'), { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(buildScript, path.join(scripts, 'build-runtime.js'));
  fs.copyFileSync(wrapper, path.join(scripts, 'build-runtime-locked.sh'));
  fs.chmodSync(path.join(scripts, 'build-runtime-locked.sh'), 0o700);
  const driver = path.join(pluginRoot, 'scripts', 'build-runtime-driver.js');
  if (fs.existsSync(driver)) fs.copyFileSync(driver, path.join(scripts, 'build-runtime-driver.js'));
  fs.writeFileSync(path.join(plugin, 'bin', 'codex-discord-channel'), '// fixture\n');
  fs.writeFileSync(path.join(plugin, 'src', 'mcp-server.js'), '// fixture\n');
  const preload = path.join(setup.root, 'preload-fake-esbuild.js');
  fs.writeFileSync(preload, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const Module = require('node:module');",
    'const originalLoad = Module._load;',
    'Module._load = function patched(request, parent, isMain) {',
    "  if (request !== 'esbuild') return originalLoad.call(this, request, parent, isMain);",
    '  return {',
    "    version: '0.28.1',",
    '    async build(options) {',
    '      if (Array.isArray(options.entryPoints)) {',
    "        if (!options.metafile || options.treeShaking !== false || options.ignoreAnnotations !== true) throw new Error('invalid_audit_options');",
    "        if (options.logOverride?.['unsupported-require-call'] !== 'error' || options.logOverride?.['unsupported-dynamic-import'] !== 'error' || options.logLevel !== 'silent') throw new Error('missing_audit_diagnostics');",
    "        if (!Array.isArray(options.plugins) || options.plugins.length !== 1) throw new Error('missing_audit_plugin');",
    '        const callbacks = [];',
    '        options.plugins[0].setup({ onResolve(_filter, callback) { callbacks.push(callback); } });',
    "        if (callbacks.length !== 1 || callbacks[0]({ kind: 'entry-point', path: options.entryPoints[0] }) !== null) throw new Error('invalid_entry_policy');",
    "        const external = callbacks[0]({ kind: 'require-call', path: 'node:fs' });",
    "        if (external?.external !== true || external?.path !== 'node:fs') throw new Error('invalid_external_policy');",
    "        fs.mkdirSync(require('node:path').dirname(options.outfile), { recursive: true });",
    "        fs.writeFileSync(options.outfile, '\\'use strict\\';\\nrequire(\"node:fs\");\\n');",
    '        return { metafile: { outputs: {',
    "          [options.outfile]: { entryPoint: options.entryPoints[0], imports: [{ external: true, kind: 'require-call', path: 'node:fs' }] },",
    '        } } };',
    '      }',
    "      fs.appendFileSync(process.env.FAKE_ENTERED, `${process.pid}|${options.outdir}\\n`);",
    "      if (process.env.FAKE_HOLD === '1') await new Promise(() => {});",
    '      fs.mkdirSync(options.outdir, { recursive: true });',
    '      const outputs = {};',
    '      for (const name of Object.keys(options.entryPoints)) {',
    "        fs.writeFileSync(require('node:path').join(options.outdir, `${name}.cjs`), '\\'use strict\\';\\nrequire(\"node:fs\");\\n');",
    "        outputs[`runtime/${name}.cjs`] = { imports: [{ external: true, path: 'node:fs' }] };",
    '      }',
    '      return { metafile: { outputs } };',
    '    },',
    '    async stop() {},',
    '  };',
    '};',
    '',
  ].join('\n'));
  return {
    ...setup,
    buildScript: path.join(scripts, 'build-runtime.js'),
    driver: path.join(scripts, 'build-runtime-driver.js'),
    env: {
      ...setup.env,
      CODEX_DISCORD_BUILD_WRAPPER_HELD: '1',
      FAKE_HOLD: '1',
      NODE_OPTIONS: `--require=${preload}`,
    },
    wrapper: path.join(scripts, 'build-runtime-locked.sh'),
  };
}

async function waitForAdmissionOrExit(child, file) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) return { kind: 'admitted' };
    if (child.exitCode !== null || child.signalCode !== null) {
      return { kind: 'exit', code: child.exitCode, signal: child.signalCode };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill('SIGKILL');
  throw new Error('timed out waiting for driver admission or exit');
}

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`nonblocking canonical lock rejects overlap and ${signal} releases without stale cleanup`, async (t) => {
    const setup = lockFixture(t);
    const holder = spawn(wrapper, ['--check'], {
      env: { ...setup.env, FAKE_HOLD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let admittedPid;
    t.after(() => {
      if (Number.isInteger(admittedPid)) {
        try { process.kill(admittedPid, 'SIGKILL'); } catch {}
      }
      if (holder.exitCode === null) holder.kill('SIGKILL');
    });
    await waitForFile(setup.entered);
    const rootDigest = crypto.createHash('sha256').update(fs.realpathSync(pluginRoot)).digest('hex');
    const lockNames = fs.readdirSync(path.join(setup.root, 'runtime'))
      .filter((name) => name.endsWith('.lock'))
      .sort();
    assert.deepEqual(lockNames, [
      `codex-discord-build-runtime-${rootDigest}.lock`,
      'codex02-discord-build-runtime.lock',
    ].sort());
    const lockStats = lockNames
      .map((name) => fs.statSync(path.join(setup.root, 'runtime', name)));
    assert.equal(lockStats[0].ino, lockStats[1].ino, 'wrapper and transient names must share one lock inode');

    const rejected = spawnSync(wrapper, ['--check'], {
      encoding: 'utf8',
      env: setup.env,
      timeout: 2000,
    });
    assert.equal(rejected.status, 73, rejected.stderr);
    assert.match(rejected.stderr, /^build_runtime_already_running\n$/);
    assert.equal(enteredRows(setup.entered).length, 1);

    const [{ pid, temporaryDirectory }] = enteredRows(setup.entered);
    admittedPid = pid;
    assert.match(temporaryDirectory, new RegExp(`codex-discord-build-runtime-${rootDigest}-`));
    process.kill(admittedPid, signal);
    await waitForExit(holder);
    assert.equal(fs.existsSync(temporaryDirectory), false, 'supervisor must remove killed child output');

    const admitted = spawnSync(wrapper, ['--check'], {
      encoding: 'utf8',
      env: setup.env,
      timeout: 2000,
    });
    assert.equal(admitted.status, 0, admitted.stderr);
    assert.equal(enteredRows(setup.entered).length, 2);
  });
}

test('documented transient lock and package wrapper contend on the same identity', async (t) => {
  const setup = lockFixture(t);
  const compatibilityLock = path.join(setup.root, 'runtime', 'codex02-discord-build-runtime.lock');
  fs.writeFileSync(compatibilityLock, '');
  const fakeNode = path.join(setup.root, 'bin', 'node');
  const transientHolder = spawn('/usr/bin/flock', [
    '--no-fork',
    '--nonblock',
    '--conflict-exit-code=73',
    compatibilityLock,
    fakeNode,
  ], {
    env: { ...setup.env, FAKE_HOLD: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (transientHolder.exitCode === null) transientHolder.kill('SIGKILL'); });
  await waitForFile(setup.entered);

  const rejected = spawnSync(wrapper, ['--check'], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 2000,
  });
  assert.equal(rejected.status, 73, rejected.stderr);
  assert.match(rejected.stderr, /^build_runtime_already_running\n$/);
  assert.equal(enteredRows(setup.entered).length, 1);

  transientHolder.kill('SIGKILL');
  await waitForExit(transientHolder);
  const admitted = spawnSync(wrapper, ['--check'], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 2000,
  });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(enteredRows(setup.entered).length, 2);
});

test('symlinked compatibility lock is rejected without changing victim bytes, then ordinary lock succeeds', (t) => {
  const setup = lockFixture(t);
  const victim = path.join(setup.root, 'unrelated-victim');
  const victimBytes = Buffer.from('must remain byte-for-byte intact\n');
  const compatibilityLock = path.join(setup.root, 'runtime', 'codex02-discord-build-runtime.lock');
  fs.writeFileSync(victim, victimBytes);
  fs.symlinkSync(victim, compatibilityLock);

  const rejected = spawnSync(wrapper, ['--check'], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 2000,
  });
  assert.equal(rejected.status, 72, rejected.stderr);
  assert.match(rejected.stderr, /^build_runtime_unsafe_lock_path\n$/);
  assert.deepEqual(fs.readFileSync(victim), victimBytes);
  assert.equal(fs.existsSync(setup.entered), false, 'unsafe lock must fail before Node admission');

  fs.unlinkSync(compatibilityLock);
  const admitted = spawnSync(wrapper, ['--check'], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 2000,
  });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.deepEqual(fs.readFileSync(victim), victimBytes);
  assert.equal(enteredRows(setup.entered).length, 1);
});

test('supervisor-directed TERM waits for a slow child before cleanup and lock release', async (t) => {
  const setup = lockFixture(t);
  const holder = spawn(wrapper, ['--check'], {
    env: { ...setup.env, FAKE_HOLD: '1', FAKE_SLOW_TERM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let admittedPid;
  t.after(() => {
    if (Number.isInteger(admittedPid) && processExists(admittedPid)) {
      try { process.kill(admittedPid, 'SIGKILL'); } catch {}
    }
    if (holder.exitCode === null) holder.kill('SIGKILL');
  });
  await waitForFile(setup.entered);
  const [{ pid, temporaryDirectory }] = enteredRows(setup.entered);
  admittedPid = pid;
  const holderExit = waitForExit(holder);
  holder.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(processExists(pid), true, 'slow child must still be alive while supervisor waits');
  assert.equal(fs.existsSync(temporaryDirectory), true, 'temporary output must remain until child exits');
  const exited = await holderExit;
  assert.equal(exited.code, 143);
  assert.equal(processExists(pid), false);
  assert.equal(fs.existsSync(temporaryDirectory), false);

  const admitted = spawnSync(wrapper, ['--check'], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 2000,
  });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(enteredRows(setup.entered).length, 2);
});

test('next locked wrapper reaps temp left by full supervisor and child SIGKILL', async (t) => {
  const setup = lockFixture(t);
  const holder = spawn(wrapper, ['--check'], {
    env: { ...setup.env, FAKE_HOLD: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let admittedPid;
  t.after(() => {
    if (Number.isInteger(admittedPid) && processExists(admittedPid)) {
      try { process.kill(admittedPid, 'SIGKILL'); } catch {}
    }
    if (holder.exitCode === null) holder.kill('SIGKILL');
  });
  await waitForFile(setup.entered);
  const [{ pid, temporaryDirectory }] = enteredRows(setup.entered);
  admittedPid = pid;
  const holderExit = waitForExit(holder);
  holder.kill('SIGKILL');
  process.kill(pid, 'SIGKILL');
  await holderExit;
  const childDeadline = Date.now() + 2000;
  while (processExists(pid) && Date.now() < childDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(processExists(pid), false);
  assert.equal(fs.existsSync(temporaryDirectory), true, 'full cgroup kill cannot run in-process cleanup');

  const admitted = spawnSync(wrapper, ['--check'], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 2000,
  });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(fs.existsSync(temporaryDirectory), false, 'next lock owner must reap the abandoned temp');
  assert.equal(enteredRows(setup.entered).length, 2);
});

test('plain Node CLI delegates to the wrapper so an overlapping wrapper cannot reap its active temp', async (t) => {
  const setup = lockFixture(t);
  const direct = spawn(process.execPath, [buildScript, '--check'], {
    env: { ...setup.env, CODEX_DISCORD_BUILD_WRAPPER_HELD: '', FAKE_HOLD: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let admittedPid;
  t.after(() => {
    if (Number.isInteger(admittedPid) && processExists(admittedPid)) {
      try { process.kill(admittedPid, 'SIGKILL'); } catch {}
    }
    if (direct.exitCode === null) direct.kill('SIGKILL');
  });
  await waitForFile(setup.entered);
  const [{ pid, temporaryDirectory }] = enteredRows(setup.entered);
  admittedPid = pid;
  assert.equal(fs.existsSync(temporaryDirectory), true);

  const rejected = spawnSync(wrapper, ['--check'], {
    encoding: 'utf8',
    env: setup.env,
    timeout: 2000,
  });
  assert.equal(rejected.status, 73, rejected.stderr);
  assert.match(rejected.stderr, /^build_runtime_already_running\n$/);
  assert.equal(fs.existsSync(temporaryDirectory), true, 'rejected wrapper must not reap active direct CLI output');
  assert.equal(enteredRows(setup.entered).length, 1);

  const directExit = waitForExit(direct);
  process.kill(pid, 'SIGKILL');
  const exited = await directExit;
  assert.equal(exited.code, 137);
  assert.equal(fs.existsSync(temporaryDirectory), false);
});

test('forged wrapper environment cannot let a direct CLI overlap the canonical wrapper', async (t) => {
  const setup = directBypassFixture(t);
  const direct = spawn(process.execPath, [setup.buildScript, '--check'], {
    env: setup.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let admittedPid;
  t.after(() => {
    if (Number.isInteger(admittedPid) && processExists(admittedPid)) {
      try { process.kill(admittedPid, 'SIGKILL'); } catch {}
    }
    if (direct.exitCode === null) direct.kill('SIGKILL');
  });
  await waitForFile(setup.entered);
  admittedPid = enteredRows(setup.entered)[0].pid;

  const rejected = spawnSync(setup.wrapper, ['--check'], {
    encoding: 'utf8',
    env: { ...setup.env, FAKE_HOLD: '' },
    timeout: 2000,
  });
  assert.equal(rejected.status, 73, rejected.stderr);
  assert.match(rejected.stderr, /^build_runtime_already_running\n$/);
  assert.equal(enteredRows(setup.entered).length, 1);

  const directExit = waitForExit(direct);
  process.kill(admittedPid, 'SIGKILL');
  await directExit;
});

test('direct internal driver cannot bypass the canonical wrapper lock', async (t) => {
  const setup = directBypassFixture(t);
  const direct = spawn(process.execPath, [setup.driver, '--check'], {
    env: setup.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let admittedPid;
  t.after(() => {
    if (Number.isInteger(admittedPid) && processExists(admittedPid)) {
      try { process.kill(admittedPid, 'SIGKILL'); } catch {}
    }
    if (direct.exitCode === null) direct.kill('SIGKILL');
  });
  const outcome = await waitForAdmissionOrExit(direct, setup.entered);
  if (outcome.kind === 'admitted') {
    admittedPid = enteredRows(setup.entered)[0].pid;
    const overlap = spawnSync(setup.wrapper, ['--check'], {
      encoding: 'utf8',
      env: { ...setup.env, FAKE_HOLD: '' },
      timeout: 2000,
    });
    assert.equal(overlap.status, 73, overlap.stderr);
    return;
  }

  assert.equal(outcome.code, 72);
  assert.equal(fs.existsSync(setup.entered), false);
  const realNodePath = setup.env.PATH.split(path.delimiter)
    .filter((entry) => entry !== path.join(setup.root, 'bin'))
    .join(path.delimiter);
  const admitted = spawnSync(setup.wrapper, [], {
    encoding: 'utf8',
    env: { ...setup.env, FAKE_HOLD: '', PATH: realNodePath },
    timeout: 2000,
  });
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.equal(enteredRows(setup.entered).length, 1);
});
