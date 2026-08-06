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
const lockWrapper = path.join(pluginRoot, 'scripts', 'build-runtime-locked.sh');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-build-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'mcp-server.js'), '// source fixture\n');
  fs.writeFileSync(path.join(root, 'bin', 'codex-discord-channel'), '// source fixture\n');
  return root;
}

function outputBytes(label = 'fixture') {
  return Buffer.from(`'use strict';\nrequire("node:fs");\n// ${label}\n`);
}

function fakeEsbuild(options = {}) {
  const calls = [];
  let stops = 0;
  return {
    api: {
      async build(request) {
        calls.push(request);
        if (options.buildError) throw options.buildError;
        fs.mkdirSync(request.outdir, { recursive: true });
        for (const name of Object.keys(request.entryPoints)) {
          const output = path.join(request.outdir, `${name}.cjs`);
          if (options.oversized === name) {
            fs.writeFileSync(output, Buffer.from('x'));
            fs.truncateSync(output, options.maximumOutputBytes + 1);
          } else {
            const bytes = options.outputs?.[name] ?? outputBytes(name);
            fs.writeFileSync(output, bytes);
          }
        }
        return {};
      },
      async stop() {
        stops += 1;
      },
    },
    calls,
    get stops() { return stops; },
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function waitForPath(filePath) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

test('package build entry points use the checked-in lock wrapper', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  assert.equal(fs.existsSync(lockWrapper), true);
  assert.equal(manifest.scripts['build:runtime'], 'bash scripts/build-runtime-locked.sh');
  assert.equal(manifest.scripts['build:check'], 'bash scripts/build-runtime-locked.sh --check');
  assert.match(manifest.scripts.syntax, /bash -n .*scripts\/build-runtime-locked\.sh/);
  assert.equal(manifest.devDependencies.esbuild, '0.28.1');
  const lockfile = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package-lock.json'), 'utf8'));
  assert.equal(lockfile.packages[''].devDependencies.esbuild, '0.28.1');
  assert.equal(lockfile.packages['node_modules/esbuild'].version, '0.28.1');
});

test('bounded Buffer comparison reports only lengths, hashes, and first offset', () => {
  const { assertCommittedBundleCurrent } = require(buildScript);
  assert.doesNotThrow(() => assertCommittedBundleCurrent('runtime/a.cjs', Buffer.from('abc'), Buffer.from('abc')));

  const left = Buffer.from('abc');
  const right = Buffer.from('axcd');
  let failure;
  try {
    assertCommittedBundleCurrent('runtime/a.cjs', left, right);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(Object.hasOwn(failure, 'actual'), false);
  assert.equal(Object.hasOwn(failure, 'expected'), false);
  assert.match(failure.message, /committed_len=3 generated_len=4 first_mismatch=1/);
  assert.match(failure.message, new RegExp(`committed_sha256=${sha256(left)}`));
  assert.match(failure.message, new RegExp(`generated_sha256=${sha256(right)}`));
  assert.ok(failure.message.length < 512);
  assert.doesNotMatch(failure.message, /<Buffer|61 62 63|61 78 63/);
});

test('one fake esbuild request owns both entry points, writes privately, and stops', async (t) => {
  const root = fixture(t);
  const fake = fakeEsbuild();
  const { runBuildRuntime } = require(buildScript);

  const result = await runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].entryPoints, {
    channel: 'bin/codex-discord-channel',
    'mcp-server': 'src/mcp-server.js',
  });
  assert.equal(fake.calls[0].write, true);
  assert.equal(fake.calls[0].metafile, false);
  assert.equal(path.dirname(fake.calls[0].outdir), process.env.XDG_RUNTIME_DIR || os.tmpdir());
  assert.match(path.basename(fake.calls[0].outdir), /^codex-discord-build-runtime-unmanaged-/);
  assert.notEqual(fake.calls[0].outdir, path.join(root, 'runtime'));
  assert.equal(fake.stops, 1);
  assert.equal(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), 'utf8'), outputBytes('mcp-server').toString());
  assert.equal(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs'), 'utf8'), outputBytes('channel').toString());
  assert.equal(fs.existsSync(result.temporaryDirectory), false);
});

test('fake esbuild stop runs from finally after build failure', async (t) => {
  const root = fixture(t);
  const fake = fakeEsbuild({ buildError: new Error('synthetic_build_failure') });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
    /synthetic_build_failure/,
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.stops, 1);
});

test('oversized fake output fails before publish and leaves both committed files unchanged', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const maximumOutputBytes = 1024;
  const fake = fakeEsbuild({ maximumOutputBytes, oversized: 'channel' });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, maximumOutputBytes, pluginRoot: root }),
    /generated output exceeds size ceiling.*size=1025.*ceiling=1024/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
  assert.equal(fake.stops, 1);
});

for (const [syntax, source] of [
  ['require', "require('left-pad');\n"],
  ['dynamic import', "import('left-pad');\n"],
]) {
test(`unresolved non-node ${syntax} from fake output fails bounded and publishes neither runtime`, async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild({
    outputs: {
      channel: Buffer.from(source),
      'mcp-server': outputBytes('mcp-server'),
    },
  });
  const { runBuildRuntime } = require(buildScript);

  let failure;
  try {
    await runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /contains unresolved non-node runtime imports: count=1 sample=left-pad/);
  assert.ok(failure.message.length < 512);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
  assert.equal(fake.stops, 1);
});
}

test('check mode compares files in chunks and emits bounded stale metadata', async (t) => {
  const root = fixture(t);
  const committedMcp = outputBytes('old-mcp');
  const committedChannel = outputBytes('channel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), committedMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), committedChannel);
  const generatedMcp = outputBytes('new-mcp');
  const fake = fakeEsbuild({
    outputs: { channel: committedChannel, 'mcp-server': generatedMcp },
  });
  const { runBuildRuntime } = require(buildScript);

  let failure;
  try {
    await runBuildRuntime({ check: true, esbuildApi: fake.api, pluginRoot: root });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(Object.hasOwn(failure, 'actual'), false);
  assert.equal(Object.hasOwn(failure, 'expected'), false);
  assert.match(failure.message, /runtime\/mcp-server\.cjs is stale/);
  assert.match(failure.message, /committed_len=.*generated_len=.*first_mismatch=/);
  assert.match(failure.message, new RegExp(`committed_sha256=${sha256(committedMcp)}`));
  assert.match(failure.message, new RegExp(`generated_sha256=${sha256(generatedMcp)}`));
  assert.ok(failure.message.length < 512);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.stops, 1);
});

test('chunked file comparison finds a mismatch beyond the first chunk without Buffer fields', (t) => {
  const root = fixture(t);
  const committedPath = path.join(root, 'committed.cjs');
  const generatedPath = path.join(root, 'generated.cjs');
  const committed = Buffer.alloc(150 * 1024, 0x61);
  const generated = Buffer.from(committed);
  generated[96 * 1024 + 17] = 0x62;
  fs.writeFileSync(committedPath, committed);
  fs.writeFileSync(generatedPath, generated);
  const { compareFilesBounded } = require(buildScript);

  let failure;
  try {
    compareFilesBounded('runtime/chunked.cjs', committedPath, generatedPath, 256 * 1024);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.equal(Object.hasOwn(failure, 'actual'), false);
  assert.equal(Object.hasOwn(failure, 'expected'), false);
  assert.match(failure.message, /first_mismatch=98321/);
  assert.ok(failure.message.length < 512);
});

test('second publish rename failure rolls the first runtime back to the committed generation', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild();
  const { runBuildRuntime } = require(buildScript);
  let renameCalls = 0;

  await assert.rejects(runBuildRuntime({
    check: false,
    esbuildApi: fake.api,
    pluginRoot: root,
    publishOperations: {
      rename(source, destination) {
        renameCalls += 1;
        if (renameCalls === 2) throw new Error('synthetic_second_rename_failure');
        fs.renameSync(source, destination);
      },
    },
  }), /synthetic_second_rename_failure/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'runtime')).sort(),
    ['channel.cjs', 'mcp-server.cjs'],
  );
  assert.equal(fake.stops, 1);
});

test('SIGKILL between output renames is recovered to one complete old generation', async (t) => {
  const root = fixture(t);
  const generated = path.join(root, 'generated');
  fs.mkdirSync(generated);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  const afterMcp = Buffer.from('generated mcp replacement');
  const afterChannel = Buffer.from('generated channel replacement');
  const mcpOutput = path.join(root, 'runtime', 'mcp-server.cjs');
  const channelOutput = path.join(root, 'runtime', 'channel.cjs');
  const mcpGenerated = path.join(generated, 'mcp-server.cjs');
  const channelGenerated = path.join(generated, 'channel.cjs');
  const marker = path.join(root, 'first-rename-complete');
  fs.writeFileSync(mcpOutput, beforeMcp);
  fs.writeFileSync(channelOutput, beforeChannel);
  fs.writeFileSync(mcpGenerated, afterMcp);
  fs.writeFileSync(channelGenerated, afterChannel);
  const artifacts = [
    { entryName: 'mcp-server', generatedPath: mcpGenerated, outputPath: mcpOutput },
    { entryName: 'channel', generatedPath: channelGenerated, outputPath: channelOutput },
  ];
  const program = [
    "'use strict';",
    "const fs = require('node:fs');",
    `const { publishValidatedArtifacts } = require(${JSON.stringify(buildScript)});`,
    `const artifacts = ${JSON.stringify(artifacts)};`,
    'let installs = 0;',
    'publishValidatedArtifacts(artifacts, {',
    '  rename(source, destination) {',
    '    fs.renameSync(source, destination);',
    "    if (source.endsWith('.stage') && ++installs === 1) {",
    `      fs.writeFileSync(${JSON.stringify(marker)}, 'ready');`,
    '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    '    }',
    '  },',
    '});',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await waitForPath(marker);
  assert.deepEqual(fs.readFileSync(mcpOutput), afterMcp);
  assert.deepEqual(fs.readFileSync(channelOutput), beforeChannel);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  const { recoverPublishTransaction } = require(buildScript);
  assert.deepEqual(recoverPublishTransaction(artifacts), { recovered: true, state: 'PREPARED' });
  assert.deepEqual(fs.readFileSync(mcpOutput), beforeMcp);
  assert.deepEqual(fs.readFileSync(channelOutput), beforeChannel);
  assert.equal(fs.existsSync(path.join(root, 'runtime', '.build-runtime-transaction')), false);
});

test('empty or partial PREPARED.next marker is treated as unprepared and never wedges recovery', (t) => {
  const root = fixture(t);
  const mcpOutput = path.join(root, 'runtime', 'mcp-server.cjs');
  const channelOutput = path.join(root, 'runtime', 'channel.cjs');
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(mcpOutput, beforeMcp);
  fs.writeFileSync(channelOutput, beforeChannel);
  const artifacts = [
    { entryName: 'mcp-server', generatedPath: path.join(root, 'unused-mcp'), outputPath: mcpOutput },
    { entryName: 'channel', generatedPath: path.join(root, 'unused-channel'), outputPath: channelOutput },
  ];
  const { recoverPublishTransaction } = require(buildScript);

  for (const marker of ['', 'PREP']) {
    const transaction = path.join(root, 'runtime', '.build-runtime-transaction');
    fs.mkdirSync(transaction);
    fs.writeFileSync(path.join(transaction, 'STATE.next'), marker);
    assert.deepEqual(recoverPublishTransaction(artifacts), { recovered: true, state: 'UNPREPARED' });
    assert.deepEqual(fs.readFileSync(mcpOutput), beforeMcp);
    assert.deepEqual(fs.readFileSync(channelOutput), beforeChannel);
    assert.equal(fs.existsSync(transaction), false);
  }
});

test('copy failure before PREPARED leaves both outputs and no transaction debris', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild();
  const { runBuildRuntime } = require(buildScript);
  let copies = 0;

  await assert.rejects(runBuildRuntime({
    check: false,
    esbuildApi: fake.api,
    pluginRoot: root,
    publishOperations: {
      copyFile(source, destination, flags) {
        copies += 1;
        if (copies === 3) throw new Error('synthetic_copy_failure');
        fs.copyFileSync(source, destination, flags);
      },
    },
  }), /synthetic_copy_failure/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
  assert.deepEqual(
    fs.readdirSync(path.join(root, 'runtime')).sort(),
    ['channel.cjs', 'mcp-server.cjs'],
  );
  assert.equal(fake.stops, 1);
});

test('temporary cleanup failure preserves primary error and never skips esbuild stop', async (t) => {
  const root = fixture(t);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-build-cleanup-failure-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const fake = fakeEsbuild({ buildError: new Error('primary_build_failure') });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(runBuildRuntime({
    check: false,
    esbuildApi: fake.api,
    pluginRoot: root,
    temporaryRoot,
    removeTemporaryDirectory() {
      throw new Error('synthetic_cleanup_failure');
    },
  }), /primary_build_failure/);
  assert.equal(fake.stops, 1);
});

test('check mode uses writable private temp while the archived plugin source is read-only', async (t) => {
  const root = fixture(t);
  const mcp = outputBytes('mcp-server');
  const channel = outputBytes('channel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), mcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), channel);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-build-readonly-output-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const fake = fakeEsbuild({ outputs: { channel, 'mcp-server': mcp } });
  const { runBuildRuntime } = require(buildScript);
  fs.chmodSync(path.join(root, 'runtime', 'mcp-server.cjs'), 0o400);
  fs.chmodSync(path.join(root, 'runtime', 'channel.cjs'), 0o400);
  fs.chmodSync(path.join(root, 'runtime'), 0o500);
  fs.chmodSync(root, 0o500);
  try {
    await runBuildRuntime({ check: true, esbuildApi: fake.api, pluginRoot: root, temporaryRoot });
  } finally {
    fs.chmodSync(root, 0o700);
    fs.chmodSync(path.join(root, 'runtime'), 0o700);
  }
  assert.equal(path.dirname(fake.calls[0].outdir), temporaryRoot);
  assert.equal(fake.stops, 1);
});

test('a direct JS build never reaps a peer private temp without owning the wrapper lock', async (t) => {
  const root = fixture(t);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-build-reaper-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const digest = crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex');
  const stale = path.join(temporaryRoot, `codex-discord-build-runtime-${digest}-stale1`);
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'partial.cjs'), 'partial');
  const fake = fakeEsbuild();
  const { runBuildRuntime } = require(buildScript);

  await runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root, temporaryRoot });
  assert.equal(fs.existsSync(stale), true);
  assert.deepEqual(fs.readdirSync(stale), ['partial.cjs']);
  assert.equal(fake.stops, 1);
});

test('provided temporary directory outside the selected private root fails closed before fake build', async (t) => {
  const root = fixture(t);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-build-allowed-root-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-build-outside-root-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const digest = crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex');
  const provided = path.join(outsideRoot, `codex-discord-build-runtime-${digest}-bad123`);
  fs.mkdirSync(provided);
  const fake = fakeEsbuild();
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(runBuildRuntime({
    check: false,
    esbuildApi: fake.api,
    pluginRoot: root,
    temporaryDirectory: provided,
    temporaryRoot,
  }), /temporary directory is outside its private root/);
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.stops, 1);
  assert.equal(fs.existsSync(provided), true, 'rejected path must not be deleted');
});

test('5 MiB mismatch diagnostic passes in a fixed 64 MiB heap subprocess', () => {
  const program = [
    "'use strict';",
    `const { assertCommittedBundleCurrent } = require(${JSON.stringify(buildScript)});`,
    "const left = Buffer.alloc(5 * 1024 * 1024, 0x61);",
    "const right = Buffer.from(left);",
    "right[right.length - 1] = 0x62;",
    'let failure;',
    "try { assertCommittedBundleCurrent('runtime/large.cjs', left, right); } catch (error) { failure = error; }",
    "if (!(failure instanceof Error)) throw new Error('missing_mismatch');",
    "if (!/first_mismatch=5242879/.test(failure.message)) throw failure;",
    "if (failure.message.length >= 512 || Object.hasOwn(failure, 'actual') || Object.hasOwn(failure, 'expected')) throw new Error('unbounded_diagnostic');",
    "process.stdout.write('fixed_heap_5mib_green\\n');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', program], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fixed_heap_5mib_green\n');
});
