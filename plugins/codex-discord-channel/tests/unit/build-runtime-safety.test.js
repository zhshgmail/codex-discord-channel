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
const buildDriver = path.join(pluginRoot, 'scripts', 'build-runtime-driver.js');
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
  const auditCalls = [];
  const buildCalls = [];
  let stops = 0;
  return {
    api: {
      version: options.version || '0.28.1',
      async build(request) {
        calls.push(request);
        if (Array.isArray(request.entryPoints)) {
          auditCalls.push(request);
          const entryPoint = request.entryPoints[0];
          const entryName = path.basename(entryPoint, '.cjs');
          if (options.auditErrors?.[entryName]) throw options.auditErrors[entryName];
          fs.mkdirSync(path.dirname(request.outfile), { recursive: true });
          if (options.auditOversized === entryName) {
            fs.writeFileSync(request.outfile, Buffer.from('x'));
            fs.truncateSync(request.outfile, options.maximumOutputBytes + 1);
          } else {
            fs.writeFileSync(
              request.outfile,
              options.auditOutputBytes?.[entryName] || Buffer.from('// closure audit fixture\n'),
            );
          }
          const auditOverride = options.auditMetafileOverrides?.[entryName];
          if (typeof auditOverride === 'function') return auditOverride(request, entryPoint);
          return auditOverride || {
            metafile: {
              outputs: {
                [request.outfile]: {
                  entryPoint,
                  imports: options.auditImports?.[entryName] || [],
                },
              },
            },
          };
        }
        buildCalls.push(request);
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
        return options.metafileOverride || {
          metafile: {
            outputs: {
              'runtime/channel.cjs': { imports: options.metadataImports || [] },
              'runtime/mcp-server.cjs': { imports: [] },
            },
          },
        };
      },
      async stop() {
        stops += 1;
      },
    },
    auditCalls,
    buildCalls,
    calls,
    get stops() { return stops; },
  };
}

function realSecondPassEsbuild(options = {}) {
  const realEsbuild = require('esbuild');
  const auditResults = [];
  const auditRequests = [];
  return {
    api: {
      version: realEsbuild.version,
      async build(request) {
        if (!Array.isArray(request.entryPoints)) {
          fs.mkdirSync(request.outdir, { recursive: true });
          fs.writeFileSync(
            path.join(request.outdir, 'channel.cjs'),
            Buffer.from(options.channelSource || "require('node:fs');\n"),
          );
          fs.writeFileSync(
            path.join(request.outdir, 'mcp-server.cjs'),
            outputBytes('mcp-server'),
          );
          if (options.adjacentSource) {
            fs.writeFileSync(path.join(request.outdir, 'adjacent.cjs'), options.adjacentSource);
          }
          return {
            metafile: {
              outputs: {
                'runtime/channel.cjs': { imports: [] },
                'runtime/mcp-server.cjs': { imports: [] },
              },
            },
          };
        }
        auditRequests.push(request);
        const actualRequest = options.removeAuditExternalizer
          ? { ...request, plugins: [] }
          : request;
        const result = await realEsbuild.build(actualRequest);
        auditResults.push({ request, result });
        return result;
      },
      async stop() { await realEsbuild.stop(); },
    },
    auditRequests,
    auditResults,
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
  assert.equal(fs.existsSync(buildDriver), true);
  assert.equal(manifest.scripts['build:runtime'], 'bash scripts/build-runtime-locked.sh');
  assert.equal(manifest.scripts['build:check'], 'bash scripts/build-runtime-locked.sh --check');
  assert.match(manifest.scripts.syntax, /bash -n .*scripts\/build-runtime-locked\.sh/);
  assert.equal(manifest.devDependencies.esbuild, '0.28.1');
  const lockfile = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package-lock.json'), 'utf8'));
  assert.equal(lockfile.packages[''].devDependencies.esbuild, '0.28.1');
  assert.equal(lockfile.packages['node_modules/esbuild'].version, '0.28.1');
  assert.match(fs.readFileSync(lockWrapper, 'utf8'), /build-runtime-driver\.js/);
  assert.doesNotMatch(fs.readFileSync(buildScript, 'utf8'), /CODEX_DISCORD_BUILD_WRAPPER_HELD/);
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
  assert.equal(fake.buildCalls.length, 1);
  assert.equal(fake.auditCalls.length, 2);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.buildCalls[0].entryPoints, {
    channel: 'bin/codex-discord-channel',
    'mcp-server': 'src/mcp-server.js',
  });
  assert.equal(fake.buildCalls[0].write, true);
  assert.equal(fake.buildCalls[0].metafile, true);
  assert.equal(path.dirname(fake.buildCalls[0].outdir), process.env.XDG_RUNTIME_DIR || os.tmpdir());
  assert.match(path.basename(fake.buildCalls[0].outdir), /^codex-discord-build-runtime-unmanaged-/);
  assert.notEqual(fake.buildCalls[0].outdir, path.join(root, 'runtime'));
  for (const auditCall of fake.auditCalls) {
    assert.equal(auditCall.bundle, true);
    assert.equal(auditCall.write, true);
    assert.equal(auditCall.metafile, true);
    assert.equal(auditCall.treeShaking, false);
    assert.equal(auditCall.ignoreAnnotations, true);
    assert.equal(auditCall.logOverride['unsupported-require-call'], 'error');
    assert.equal(auditCall.logOverride['unsupported-dynamic-import'], 'error');
    assert.equal(auditCall.logLevel, 'silent');
    assert.equal(path.dirname(auditCall.outfile), fake.buildCalls[0].outdir);
    assert.match(path.basename(auditCall.outfile), /^\.closure-audit-/);
    const registrations = [];
    auditCall.plugins[0].setup({
      onResolve(filter, callback) { registrations.push({ callback, filter }); },
    });
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].callback({ kind: 'entry-point', path: auditCall.entryPoints[0] }), null);
    assert.deepEqual(
      registrations[0].callback({ kind: 'require-call', path: './adjacent.cjs' }),
      { external: true, path: './adjacent.cjs' },
    );
  }
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
  assert.equal(fake.buildCalls.length, 1);
  assert.equal(fake.auditCalls.length, 0);
  assert.equal(fake.stops, 1);
});

test('an unpinned esbuild API fails closed before build', async (t) => {
  const root = fixture(t);
  const fake = fakeEsbuild({ version: '0.28.0' });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
    /requires pinned esbuild 0\.28\.1; loaded=0\.28\.0/,
  );
  assert.equal(fake.calls.length, 0);
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

for (const [syntax, source, kind] of [
  ['require', "require('left-pad');\n", 'require-call'],
  ['dynamic import', "import('left-pad');\n", 'dynamic-import'],
  ['dynamic import with options', "import('left-pad', { with: { type: 'json' } });\n", 'dynamic-import'],
  ['formatted dynamic import', "import /*format*/ ('left-pad');\n", 'dynamic-import'],
  ['line-comment require', "require //format\n ('left-pad');\n", 'require-call'],
  ['no-substitution template dynamic import', "import(`left-pad`);\n", 'dynamic-import'],
  ['escaped require identifier', "\\u0072equire('left-pad');\n", 'require-call'],
  ['module.require', "module.require('left-pad');\n", 'require-call'],
  ['module bracket require', "module['require']('left-pad');\n", 'require-call'],
  ['parenthesized direct require', "(require)('left-pad');\n", 'require-call'],
]) {
test(`Contract A rejects esbuild-recognized non-node ${syntax} and publishes neither runtime`, async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild({
    auditImports: {
      channel: [{ external: true, kind, path: 'left-pad' }],
    },
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
  assert.match(failure.message, /closure audit rejected esbuild-recognized retained runtime dependency edges: count=1 sample=left-pad/);
  assert.ok(failure.message.length < 512);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
  assert.equal(fake.stops, 1);
});
}

for (const [syntax, source] of [
  ['computed dynamic import', "const target = 'left-pad'; import(target);\n"],
  ['computed template import', "const target = 'left-pad'; import(`pkg-${target}`);\n"],
  ['computed require', "const target = 'left-pad'; require(target);\n"],
]) {
test(`Contract A promotes unsupported ${syntax} diagnostic to error and publishes neither runtime`, async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild({
    auditErrors: { channel: new Error(`synthetic_${syntax.replaceAll(' ', '_')}`) },
    outputs: { channel: Buffer.from(source), 'mcp-server': outputBytes('mcp-server') },
  });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
    new RegExp(`synthetic_${syntax.replaceAll(' ', '_')}`),
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
});
}

test('Contract A documents semantic loader forms as non-goals instead of PASS evidence', () => {
  const buildSource = fs.readFileSync(buildScript, 'utf8');
  const readme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');
  for (const phrase of [
    'optional/call/apply',
    'createRequire',
    'require.resolve',
    'import.meta.resolve',
    'Module._load',
    'process.mainModule',
    'compile-time dead',
    'eval',
    'Function',
  ]) {
    assert.match(buildSource, new RegExp(phrase.replace('.', '\\.')));
    assert.match(readme, new RegExp(phrase.replace('.', '\\.')));
  }
  assert.match(readme, /documented non-goal, never\s+PASS evidence/);
});

test('real pinned esbuild causally enforces the exact Contract A second pass', async (t) => {
  const { runBuildRuntime } = require(buildScript);
  assert.equal(require('esbuild').version, '0.28.1');

  async function invoke(source, options = {}) {
    const root = fixture(t);
    const beforeMcp = Buffer.from('committed mcp sentinel');
    const beforeChannel = Buffer.from('committed channel sentinel');
    fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
    fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
    const hybrid = realSecondPassEsbuild({ channelSource: source, ...options });
    let failure;
    try {
      await runBuildRuntime({ check: false, esbuildApi: hybrid.api, pluginRoot: root });
    } catch (error) {
      failure = error;
    }
    if (failure) {
      assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
      assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
    }
    return { failure, hybrid };
  }

  const canonical = await invoke("require('node:fs');\n");
  assert.equal(canonical.failure, undefined);
  const channelAudit = canonical.hybrid.auditResults.find(({ request }) => (
    path.basename(request.entryPoints[0]) === 'channel.cjs'
  ));
  assert.ok(channelAudit);
  const [realOutputPath, realOutput] = Object.entries(channelAudit.result.metafile.outputs)[0];
  assert.equal(path.isAbsolute(realOutputPath), false, 'real esbuild output identity must exercise relative normalization');
  assert.equal(path.isAbsolute(realOutput.entryPoint), false, 'real esbuild entry identity must exercise relative normalization');
  assert.deepEqual(realOutput.imports.map(({ external, kind, path: importPath }) => ({
    external,
    kind,
    path: importPath,
  })), [{ external: true, kind: 'require-call', path: 'node:fs' }]);

  const falsePositive = await invoke([
    "'require(\\'left-pad\\')';",
    "// import('left-pad')",
    "const pattern = /require\\('left-pad'\\)/;",
    "const loader = { import() {} }; loader.import('left-pad');",
  ].join('\n'));
  assert.equal(falsePositive.failure, undefined);

  for (const [label, source] of [
    ['literal require', "require('left-pad');\n"],
    ['literal dynamic import', "import('left-pad');\n"],
    ['bare builtin', "require('fs');\n"],
    ['fake node builtin', "require('node:not-a-real-builtin');\n"],
    ['parser-equivalent bracket require', "module['require']('left-pad');\n"],
  ]) {
    const observed = await invoke(source);
    assert.ok(observed.failure instanceof Error, `${label} unexpectedly passed`);
    assert.match(
      observed.failure.message,
      /closure audit rejected esbuild-recognized retained runtime dependency edges/,
      label,
    );
  }

  for (const [label, source, diagnosticId] of [
    ['computed require', "const target = process.argv[2]; require(target);\n", 'unsupported-require-call'],
    ['computed import', "const target = process.argv[2]; import(target);\n", 'unsupported-dynamic-import'],
  ]) {
    const observed = await invoke(source);
    assert.ok(observed.failure instanceof Error, `${label} unexpectedly passed`);
    assert.equal(
      observed.failure.errors?.some((error) => error.id === diagnosticId),
      true,
      `${label} did not fail through ${diagnosticId}`,
    );
  }

  const relativeSource = "module.exports = require('./adjacent.cjs');\n";
  const relative = await invoke(relativeSource, { adjacentSource: 'module.exports = 42;\n' });
  assert.ok(relative.failure instanceof Error);
  assert.match(relative.failure.message, /sample=\.\/adjacent\.cjs/);

  const externalizerMutation = await invoke(relativeSource, {
    adjacentSource: 'module.exports = 42;\n',
    removeAuditExternalizer: true,
  });
  assert.equal(
    externalizerMutation.failure,
    undefined,
    'removing the audit externalizer must causally kill the relative-edge RED',
  );
});

for (const [label, specifier] of [
  ['bare package', 'left-pad'],
  ['relative dependency', './adjacent.cjs'],
  ['bare builtin', 'fs'],
  ['fake node builtin', 'node:not-a-real-builtin'],
]) {
test(`Contract A rejects ${label} from second-pass metadata`, async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild({
    auditImports: {
      channel: [{ external: true, kind: 'require-call', path: specifier }],
    },
  });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
    /closure audit rejected esbuild-recognized retained runtime dependency edges/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
});
}

test('Contract A accepts only exact verified canonical node builtins', async (t) => {
  const root = fixture(t);
  const fake = fakeEsbuild({
    auditImports: {
      channel: [
        { external: true, kind: 'require-call', path: 'node:fs' },
        { external: true, kind: 'require-call', path: 'node:sqlite' },
      ],
    },
  });
  const { runBuildRuntime } = require(buildScript);

  await runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root });
  assert.equal(fake.auditCalls.length, 2);
});

test('malformed syntax reported by the second-pass parser fails before publish', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild({
    auditErrors: { channel: new Error('synthetic_esbuild_parse_failure') },
    outputs: { channel: Buffer.from('function {'), 'mcp-server': outputBytes('mcp-server') },
  });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
    /synthetic_esbuild_parse_failure/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
});

test('malformed second-pass metadata variants fail closed before publish', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const { runBuildRuntime } = require(buildScript);
  const malformed = [
    { metafile: { outputs: {} } },
    { metafile: { outputs: { a: {}, b: {} } } },
    { metafile: { outputs: { wrong: { entryPoint: 'channel.cjs', imports: [] } } } },
    (request) => ({
      metafile: { outputs: { [request.outfile]: { imports: [] } } },
    }),
    (request, entryPoint) => ({
      metafile: { outputs: { [request.outfile]: { entryPoint, imports: 'not-an-array' } } },
    }),
    (request, entryPoint) => ({
      metafile: {
        outputs: {
          [request.outfile]: {
            entryPoint,
            imports: [{ external: true, path: 'node:fs' }],
          },
        },
      },
    }),
  ];

  for (const override of malformed) {
    const fake = fakeEsbuild({ auditMetafileOverrides: { channel: override } });
    await assert.rejects(
      runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
      /closure audit returned malformed or incomplete metadata/,
    );
    assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
    assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
  }
});

test('nonexternal or malformed second-pass import records fail closed', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild({
    auditImports: {
      channel: [{ external: false, kind: 'require-call', path: 'node:fs' }],
    },
  });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
    /closure audit returned malformed or incomplete metadata/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
});

test('oversized closure audit output fails before publish and preserves committed bytes', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const maximumOutputBytes = 1024;
  const fake = fakeEsbuild({ auditOversized: 'channel', maximumOutputBytes });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, maximumOutputBytes, pluginRoot: root }),
    /closure audit output exceeds size ceiling.*size=1025.*ceiling=1024/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
});

test('malformed or incomplete esbuild metadata fails closed before publish', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const { runBuildRuntime } = require(buildScript);

  for (const metafileOverride of [
    { metafile: { outputs: {} } },
    { metafile: { outputs: { 'runtime/channel.cjs': { imports: 'not-an-array' } } } },
  ]) {
    const fake = fakeEsbuild({ metafileOverride });
    await assert.rejects(
      runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
      /external-import metadata/,
    );
    assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
    assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
    assert.equal(fake.stops, 1);
  }
});

test('fake node prefix is rejected while real Node builtin external remains allowed', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const { runBuildRuntime } = require(buildScript);

  const invalid = fakeEsbuild({
    metadataImports: [{ external: true, kind: 'require-call', path: 'node:not-a-real-builtin' }],
    outputs: {
      channel: Buffer.from("require('node:not-a-real-builtin');\n"),
      'mcp-server': outputBytes('mcp-server'),
    },
  });
  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: invalid.api, pluginRoot: root }),
    /node:not-a-real-builtin/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);

  const valid = fakeEsbuild({
    metadataImports: [
      { external: true, kind: 'require-call', path: 'node:fs' },
      { external: true, kind: 'require-call', path: 'node:sqlite' },
    ],
    outputs: {
      channel: Buffer.from("'require(\\'left-pad\\')';\n// import('left-pad')\n/* require('left-pad') */\nconst template = `require('left-pad')`;\nconst regex = /require('left-pad')/;\nif (true) /require('left-pad')/.test('x');\nloader.import('left-pad');\nrequire('node:fs');\nrequire('node:sqlite');\n"),
      'mcp-server': outputBytes('mcp-server'),
    },
  });
  await runBuildRuntime({ check: false, esbuildApi: valid.api, pluginRoot: root });
  assert.equal(
    fs.readFileSync(path.join(root, 'runtime', 'channel.cjs'), 'utf8'),
    "'require(\\'left-pad\\')';\n// import('left-pad')\n/* require('left-pad') */\nconst template = `require('left-pad')`;\nconst regex = /require('left-pad')/;\nif (true) /require('left-pad')/.test('x');\nloader.import('left-pad');\nrequire('node:fs');\nrequire('node:sqlite');\n",
  );
  assert.equal(valid.stops, 1);
});

test('bounded esbuild metadata rejects an external non-node import before output backstop and publish', async (t) => {
  const root = fixture(t);
  const beforeMcp = Buffer.from('committed mcp sentinel');
  const beforeChannel = Buffer.from('committed channel sentinel');
  fs.writeFileSync(path.join(root, 'runtime', 'mcp-server.cjs'), beforeMcp);
  fs.writeFileSync(path.join(root, 'runtime', 'channel.cjs'), beforeChannel);
  const fake = fakeEsbuild({
    metadataImports: [{ external: true, kind: 'dynamic-import', path: 'left-pad' }],
  });
  const { runBuildRuntime } = require(buildScript);

  await assert.rejects(
    runBuildRuntime({ check: false, esbuildApi: fake.api, pluginRoot: root }),
    /metadata contains external non-node runtime imports: count=1 sample=left-pad/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'mcp-server.cjs')), beforeMcp);
  assert.deepEqual(fs.readFileSync(path.join(root, 'runtime', 'channel.cjs')), beforeChannel);
  assert.equal(fake.stops, 1);
});

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
  assert.equal(fake.buildCalls.length, 1);
  assert.equal(fake.auditCalls.length, 2);
  assert.equal(fake.calls.length, 3);
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
  assert.equal(path.dirname(fake.buildCalls[0].outdir), temporaryRoot);
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
