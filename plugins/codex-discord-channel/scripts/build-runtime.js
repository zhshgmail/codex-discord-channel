'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const moduleBuiltin = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'runtime', 'mcp-server.cjs');
const check = process.argv.includes('--check');
const builtins = new Set(moduleBuiltin.builtinModules.map((name) => name.replace(/^node:/, '')));

const nodeExternals = {
  name: 'node-externals',
  setup(build) {
    build.onResolve({ filter: /^(?:node:)?[A-Za-z0-9_][A-Za-z0-9_./-]*$/ }, (args) => {
      const bare = args.path.replace(/^node:/, '');
      if (builtins.has(bare)) return { external: true, path: `node:${bare}` };
      return null;
    });
  },
};

const optionalNativeFallbacks = {
  name: 'optional-native-fallbacks',
  setup(build) {
    build.onResolve({ filter: /^zlib-sync$/ }, () => ({
      namespace: 'optional-native-fallback',
      path: 'zlib-sync',
    }));
    build.onLoad({ filter: /.*/, namespace: 'optional-native-fallback' }, () => ({
      contents: 'throw new Error("Optional native compression is not bundled.");',
      loader: 'js',
    }));
  },
};

function externalImports(metafile) {
  return Object.values(metafile.outputs)
    .flatMap((output) => output.imports || [])
    .filter((item) => item.external)
    .map((item) => item.path);
}

async function buildBundle() {
  const result = await esbuild.build({
    absWorkingDir: root,
    bundle: true,
    define: {
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    },
    entryPoints: ['src/mcp-server.js'],
    format: 'cjs',
    legalComments: 'none',
    metafile: true,
    minifySyntax: true,
    outfile: path.relative(root, outputPath),
    packages: 'bundle',
    platform: 'node',
    plugins: [optionalNativeFallbacks, nodeExternals],
    sourcemap: false,
    target: ['node22'],
    write: false,
  });
  const external = externalImports(result.metafile);
  assert.deepEqual(
    external.filter((specifier) => !specifier.startsWith('node:')),
    [],
    'MCP bundle contains external non-node dependencies',
  );
  const output = result.outputFiles.find((file) => file.path === outputPath);
  assert(output, 'esbuild did not produce the MCP runtime bundle');
  const unresolved = [...output.text.matchAll(/(?:require|__require)\(["']([^"']+)["']\)/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith('node:'));
  assert.deepEqual(unresolved, [], 'MCP bundle contains unresolved runtime imports');
  return output.contents;
}

async function main() {
  const bundle = await buildBundle();
  if (check) {
    assert(fs.existsSync(outputPath), 'runtime/mcp-server.cjs is not committed');
    assert.deepEqual(fs.readFileSync(outputPath), Buffer.from(bundle), 'runtime/mcp-server.cjs is stale');
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bundle);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
