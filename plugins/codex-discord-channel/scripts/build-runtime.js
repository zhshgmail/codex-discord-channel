'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const moduleBuiltin = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
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

async function bundle(entryPoint, outputName) {
  const result = await esbuild.build({
    absWorkingDir: root,
    bundle: true,
    define: {
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    },
    entryPoints: [entryPoint],
    format: 'cjs',
    legalComments: 'none',
    metafile: true,
    minifySyntax: true,
    outfile: path.join('runtime', outputName),
    packages: 'bundle',
    platform: 'node',
    plugins: [optionalNativeFallbacks, nodeExternals],
    sourcemap: false,
    target: ['node22'],
    write: false,
  });
  const externals = externalImports(result.metafile);
  assert.deepEqual(
    externals.filter((specifier) => !specifier.startsWith('node:')),
    [],
    `${outputName} contains external non-node dependencies`,
  );
  const output = result.outputFiles.find((file) => file.path.endsWith(outputName));
  assert(output, `esbuild did not produce ${outputName}`);
  const source = output.text;
  const remainingImports = [...source.matchAll(/(?:require|__require)\(["']([^"']+)["']\)/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith('node:'));
  assert.deepEqual(remainingImports, [], `${outputName} contains unresolved runtime imports`);
  return output.contents;
}

async function main() {
  const outputs = new Map([
    ['mcp-server.cjs', await bundle('src/mcp-server.js', 'mcp-server.cjs')],
    ['channel-cli.cjs', await bundle('src/channel-cli.js', 'channel-cli.cjs')],
  ]);
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  for (const [name, contents] of outputs) {
    const outputPath = path.join(root, 'runtime', name);
    if (check) {
      assert(fs.existsSync(outputPath), `${name} is not committed`);
      assert.deepEqual(fs.readFileSync(outputPath), Buffer.from(contents), `${name} is stale`);
    } else {
      fs.writeFileSync(outputPath, contents);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
