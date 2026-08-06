'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const moduleBuiltin = require('node:module');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_MAXIMUM_OUTPUT_BYTES = 8 * 1024 * 1024;
const FILE_COMPARE_CHUNK_BYTES = 64 * 1024;
const MAX_UNRESOLVED_SAMPLES = 8;
const MAX_SPECIFIER_SAMPLE_BYTES = 120;
const PINNED_ESBUILD_VERSION = '0.28.1';

function isVerifiedNodeBuiltin(specifier) {
  if (!specifier.startsWith('node:')) return false;
  return moduleBuiltin.isBuiltin(specifier);
}

const nodeExternals = {
  name: 'node-externals',
  setup(build) {
    build.onResolve({ filter: /^(?:node:)?[A-Za-z0-9_][A-Za-z0-9_./-]*$/ }, (args) => {
      const bare = args.path.replace(/^node:/, '');
      if (moduleBuiltin.isBuiltin(args.path)) return { external: true, path: `node:${bare}` };
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

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function firstMismatchOffset(left, right) {
  const limit = Math.min(left.length, right.length);
  for (let offset = 0; offset < limit; offset += 1) {
    if (left[offset] !== right[offset]) return offset;
  }
  return left.length === right.length ? -1 : limit;
}

function staleBundleError(relativeOutput, metadata) {
  return new Error(
    `${relativeOutput} is stale: `
    + `committed_len=${metadata.committedLength} generated_len=${metadata.generatedLength} `
    + `first_mismatch=${metadata.firstMismatch} `
    + `committed_sha256=${metadata.committedSha256} `
    + `generated_sha256=${metadata.generatedSha256}`,
  );
}

function assertCommittedBundleCurrent(relativeOutput, committed, generated) {
  if (committed.equals(generated)) return;
  throw staleBundleError(relativeOutput, {
    committedLength: committed.length,
    generatedLength: generated.length,
    firstMismatch: firstMismatchOffset(committed, generated),
    committedSha256: sha256(committed),
    generatedSha256: sha256(generated),
  });
}

function definitions(pluginRoot) {
  return [
    {
      entryName: 'mcp-server',
      entryPoint: 'src/mcp-server.js',
      label: 'MCP',
      outputPath: path.join(pluginRoot, 'runtime', 'mcp-server.cjs'),
    },
    {
      entryName: 'channel',
      entryPoint: 'bin/codex-discord-channel',
      label: 'service CLI',
      outputPath: path.join(pluginRoot, 'runtime', 'channel.cjs'),
    },
  ];
}

function temporaryPrefix(pluginRoot) {
  const canonicalRoot = fs.realpathSync(pluginRoot);
  const rootDigest = crypto.createHash('sha256').update(canonicalRoot).digest('hex');
  return `codex-discord-build-runtime-${rootDigest}-`;
}

function unmanagedTemporaryPrefix(pluginRoot) {
  const canonicalRoot = fs.realpathSync(pluginRoot);
  const rootDigest = crypto.createHash('sha256').update(canonicalRoot).digest('hex');
  return `codex-discord-build-runtime-unmanaged-${rootDigest}-`;
}

function createPrivateTemporaryDirectory(pluginRoot, temporaryRoot) {
  const root = path.resolve(temporaryRoot || process.env.XDG_RUNTIME_DIR || os.tmpdir());
  // Exported/test callers do not prove ownership of the cross-process lock.
  // Give them a non-reapable identity so the locked wrapper can never delete
  // an active direct caller's output. Normal CLI calls re-enter via wrapper.
  const prefix = unmanagedTemporaryPrefix(pluginRoot);
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error(`build runtime temporary root is not a directory: ${root}`);
  const temporaryDirectory = fs.mkdtempSync(path.join(root, prefix));
  fs.chmodSync(temporaryDirectory, 0o700);
  return temporaryDirectory;
}

function resolveTemporaryDirectory(pluginRoot, options) {
  const provided = options.temporaryDirectory
    || (!options.temporaryRoot && process.env.CODEX_DISCORD_BUILD_TEMPORARY_DIRECTORY);
  if (!provided) return createPrivateTemporaryDirectory(pluginRoot, options.temporaryRoot);

  const temporaryDirectory = fs.realpathSync(provided);
  const allowedRoot = fs.realpathSync(path.resolve(
    options.temporaryRoot || process.env.XDG_RUNTIME_DIR || os.tmpdir(),
  ));
  if (path.dirname(temporaryDirectory) !== allowedRoot) {
    throw new Error(`build runtime temporary directory is outside its private root: ${temporaryDirectory}`);
  }
  const expectedPrefix = temporaryPrefix(pluginRoot);
  if (!path.basename(temporaryDirectory).startsWith(expectedPrefix)) {
    throw new Error(`build runtime temporary directory has wrong identity: ${temporaryDirectory}`);
  }
  const stat = fs.statSync(temporaryDirectory);
  if (!stat.isDirectory()) {
    throw new Error(`build runtime temporary path is not a directory: ${temporaryDirectory}`);
  }
  return temporaryDirectory;
}

function boundedRegularFile(filePath, maximumOutputBytes, kind) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`${kind} is missing: ${filePath}`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`${kind} is not a regular file: ${filePath}`);
  if (stat.size > maximumOutputBytes) {
    throw new Error(
      `${kind} exceeds size ceiling: path=${filePath} size=${stat.size} ceiling=${maximumOutputBytes}`,
    );
  }
  return stat;
}

function boundedSpecifier(specifier) {
  const oneLine = specifier.replace(/[\r\n\t]/g, ' ');
  if (Buffer.byteLength(oneLine) <= MAX_SPECIFIER_SAMPLE_BYTES) return oneLine;
  return `${Buffer.from(oneLine).subarray(0, MAX_SPECIFIER_SAMPLE_BYTES).toString()}...`;
}

// Contract A is deliberately narrower than semantic loader non-reachability:
// it covers only retained runtime dependency edges and direct computed loader
// calls recognized by the pinned esbuild parser. Aliases, optional/call/apply
// forms, createRequire, require.resolve, import.meta.resolve, Module._load,
// process.mainModule, compile-time dead code, eval, and Function are
// product-design scope, not evidence that this build gate passed a stronger
// semantic contract.
function artifactAuditExternals() {
  return {
    name: 'artifact-audit-externals',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return null;
        return { external: true, path: args.path };
      });
    },
  };
}

function assertPinnedEsbuild(esbuildApi) {
  if (!esbuildApi || esbuildApi.version !== PINNED_ESBUILD_VERSION) {
    throw new Error(
      `build runtime requires pinned esbuild ${PINNED_ESBUILD_VERSION}; `
      + `loaded=${esbuildApi && typeof esbuildApi.version === 'string' ? esbuildApi.version : '<unknown>'}`,
    );
  }
}

function resolveMetafilePath(workingDirectory, filePath) {
  return path.resolve(workingDirectory, filePath);
}

function assertArtifactAuditMetafile(
  metafile,
  expectedOutputPath,
  expectedEntryPoint,
  workingDirectory,
  label,
) {
  if (!metafile || typeof metafile !== 'object' || !metafile.outputs || typeof metafile.outputs !== 'object') {
    throw new Error(`${label} closure audit returned malformed or incomplete metadata`);
  }
  const entries = Object.entries(metafile.outputs);
  if (entries.length !== 1) {
    throw new Error(`${label} closure audit returned malformed or incomplete metadata`);
  }
  const [outputPath, output] = entries[0];
  if (resolveMetafilePath(workingDirectory, outputPath) !== path.resolve(expectedOutputPath)
    || !output || typeof output !== 'object'
    || typeof output.entryPoint !== 'string'
    || resolveMetafilePath(workingDirectory, output.entryPoint) !== path.resolve(expectedEntryPoint)
    || !Array.isArray(output.imports)) {
    throw new Error(`${label} closure audit returned malformed or incomplete metadata`);
  }

  const samples = [];
  let count = 0;
  for (const item of output.imports) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string'
      || typeof item.kind !== 'string' || item.external !== true) {
      throw new Error(`${label} closure audit returned malformed or incomplete metadata`);
    }
    if (isVerifiedNodeBuiltin(item.path)) continue;
    count += 1;
    if (samples.length < MAX_UNRESOLVED_SAMPLES) samples.push(boundedSpecifier(item.path));
  }
  if (count > 0) {
    throw new Error(
      `${label} closure audit rejected esbuild-recognized retained runtime dependency edges: `
      + `count=${count} sample=${samples.join(',')}`,
    );
  }
}

async function auditGeneratedArtifactClosure(
  artifact,
  temporaryDirectory,
  maximumOutputBytes,
  esbuildApi,
) {
  boundedRegularFile(artifact.generatedPath, maximumOutputBytes, 'generated audit input');
  const auditOutputPath = path.join(temporaryDirectory, `.closure-audit-${artifact.entryName}.cjs`);
  let failure;
  try {
    const result = await esbuildApi.build({
      absWorkingDir: temporaryDirectory,
      bundle: true,
      entryPoints: [artifact.generatedPath],
      format: 'cjs',
      ignoreAnnotations: true,
      legalComments: 'none',
      logOverride: {
        'unsupported-dynamic-import': 'error',
        'unsupported-require-call': 'error',
      },
      logLevel: 'silent',
      metafile: true,
      minify: false,
      outfile: auditOutputPath,
      platform: 'node',
      plugins: [artifactAuditExternals()],
      sourcemap: false,
      target: ['node22'],
      treeShaking: false,
      write: true,
    });
    boundedRegularFile(auditOutputPath, maximumOutputBytes, 'closure audit output');
    assertArtifactAuditMetafile(
      result.metafile,
      auditOutputPath,
      artifact.generatedPath,
      temporaryDirectory,
      artifact.label,
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      fs.rmSync(auditOutputPath, { force: true });
    } catch (error) {
      if (!failure) failure = error;
    }
  }
  if (failure) throw failure;
}

function assertMetafileHasNoExternalRuntimeImports(metafile, bundleDefinitions) {
  if (!metafile || typeof metafile !== 'object' || !metafile.outputs || typeof metafile.outputs !== 'object') {
    throw new Error('esbuild did not return bounded external-import metadata');
  }
  const outputEntries = Object.entries(metafile.outputs);
  const expectedOutputs = new Set(bundleDefinitions.map((definition) => `${definition.entryName}.cjs`));
  const coveredOutputs = new Set();
  const samples = [];
  let count = 0;
  for (const [outputPath, output] of outputEntries) {
    const outputName = path.basename(outputPath);
    if (!expectedOutputs.has(outputName) || coveredOutputs.has(outputName)
      || !output || typeof output !== 'object' || !Array.isArray(output.imports)) {
      throw new Error('esbuild returned malformed or incomplete external-import metadata');
    }
    coveredOutputs.add(outputName);
    for (const item of output.imports) {
      if (!item || typeof item !== 'object' || typeof item.path !== 'string'
        || typeof item.external !== 'boolean') {
        throw new Error('esbuild returned malformed or incomplete external-import metadata');
      }
      if (!item.external || isVerifiedNodeBuiltin(item.path)) continue;
      count += 1;
      if (samples.length < MAX_UNRESOLVED_SAMPLES) samples.push(boundedSpecifier(item.path));
    }
  }
  if (outputEntries.length !== expectedOutputs.size || coveredOutputs.size !== expectedOutputs.size) {
    throw new Error('esbuild returned malformed or incomplete external-import metadata');
  }
  if (count === 0) return;
  throw new Error(
    'esbuild metadata contains external non-node runtime imports: '
    + `count=${count} sample=${samples.join(',')}`,
  );
}

function compareFilesBounded(relativeOutput, committedPath, generatedPath, maximumOutputBytes) {
  const committed = boundedRegularFile(committedPath, maximumOutputBytes, 'committed output');
  const generated = boundedRegularFile(generatedPath, maximumOutputBytes, 'generated output');
  const committedHash = crypto.createHash('sha256');
  const generatedHash = crypto.createHash('sha256');
  const committedBuffer = Buffer.allocUnsafe(FILE_COMPARE_CHUNK_BYTES);
  const generatedBuffer = Buffer.allocUnsafe(FILE_COMPARE_CHUNK_BYTES);
  const committedFd = fs.openSync(committedPath, 'r');
  const generatedFd = fs.openSync(generatedPath, 'r');
  let firstMismatch = committed.size === generated.size ? -1 : Math.min(committed.size, generated.size);

  try {
    const limit = Math.max(committed.size, generated.size);
    for (let offset = 0; offset < limit; offset += FILE_COMPARE_CHUNK_BYTES) {
      const committedRead = offset < committed.size
        ? fs.readSync(committedFd, committedBuffer, 0, Math.min(FILE_COMPARE_CHUNK_BYTES, committed.size - offset), offset)
        : 0;
      const generatedRead = offset < generated.size
        ? fs.readSync(generatedFd, generatedBuffer, 0, Math.min(FILE_COMPARE_CHUNK_BYTES, generated.size - offset), offset)
        : 0;
      if (committedRead > 0) committedHash.update(committedBuffer.subarray(0, committedRead));
      if (generatedRead > 0) generatedHash.update(generatedBuffer.subarray(0, generatedRead));
      if (firstMismatch !== -1 && firstMismatch < Math.min(committed.size, generated.size)) continue;
      const common = Math.min(committedRead, generatedRead);
      for (let index = 0; index < common; index += 1) {
        if (committedBuffer[index] !== generatedBuffer[index]) {
          firstMismatch = offset + index;
          break;
        }
      }
    }
  } finally {
    fs.closeSync(committedFd);
    fs.closeSync(generatedFd);
  }

  const metadata = {
    committedLength: committed.size,
    generatedLength: generated.size,
    firstMismatch,
    committedSha256: committedHash.digest('hex'),
    generatedSha256: generatedHash.digest('hex'),
  };
  if (metadata.firstMismatch === -1 && metadata.committedSha256 === metadata.generatedSha256) return;
  throw staleBundleError(relativeOutput, metadata);
}

function validateGeneratedArtifacts(bundleDefinitions, temporaryDirectory, maximumOutputBytes) {
  return bundleDefinitions.map((definition) => {
    const generatedPath = path.join(temporaryDirectory, `${definition.entryName}.cjs`);
    boundedRegularFile(generatedPath, maximumOutputBytes, 'generated output');
    return { ...definition, generatedPath };
  });
}

function publishOperations(overrides = {}) {
  return {
    copyFile: overrides.copyFile || fs.copyFileSync,
    exists: overrides.exists || fs.existsSync,
    makeDirectory: overrides.makeDirectory || fs.mkdirSync,
    readFile: overrides.readFile || fs.readFileSync,
    remove: overrides.remove || fs.rmSync,
    rename: overrides.rename || fs.renameSync,
    writeFile: overrides.writeFile || fs.writeFileSync,
  };
}

function transactionPaths(artifacts) {
  if (artifacts.length === 0) throw new Error('build runtime publish has no artifacts');
  const outputDirectory = path.dirname(artifacts[0].outputPath);
  if (artifacts.some((artifact) => path.dirname(artifact.outputPath) !== outputDirectory)) {
    throw new Error('build runtime outputs must share one directory');
  }
  const transactionDirectory = path.join(outputDirectory, '.build-runtime-transaction');
  return {
    outputDirectory,
    statePath: path.join(transactionDirectory, 'STATE'),
    transactionDirectory,
  };
}

function transactionRecord(transactionDirectory, artifact) {
  const safeName = artifact.entryName;
  if (!/^[a-z0-9-]+$/.test(safeName)) throw new Error(`unsafe build runtime entry name: ${safeName}`);
  return {
    ...artifact,
    backupPath: path.join(transactionDirectory, `${safeName}.backup`),
    hadPath: path.join(transactionDirectory, `${safeName}.had-output`),
    restorePath: path.join(transactionDirectory, `${safeName}.restore`),
    stagedPath: path.join(transactionDirectory, `${safeName}.stage`),
  };
}

function recoverPublishTransaction(artifacts, overrides = {}) {
  const operations = publishOperations(overrides);
  const { statePath, transactionDirectory } = transactionPaths(artifacts);
  if (!operations.exists(transactionDirectory)) return { recovered: false };

  const records = artifacts.map((artifact) => transactionRecord(transactionDirectory, artifact));
  const state = operations.exists(statePath)
    ? String(operations.readFile(statePath, 'utf8')).trim()
    : 'UNPREPARED';
  if (!['UNPREPARED', 'PREPARED', 'COMMITTED'].includes(state)) {
    throw new Error(`unknown build runtime transaction state: ${state}`);
  }

  if (state === 'PREPARED') {
    // PREPARED is durable before either output rename. Restore the complete
    // old generation after a killed publisher, never just the file that was
    // observed half-installed.
    for (const record of records) {
      if (operations.exists(record.hadPath)) {
        if (!operations.exists(record.backupPath)) {
          throw new Error(`build runtime recovery is missing backup: ${record.entryName}`);
        }
        // Keep the backup until the whole pair is restored. If recovery itself
        // is killed between the two renames, the next locked recovery can
        // repeat both copies instead of finding a consumed first backup.
        operations.copyFile(record.backupPath, record.restorePath);
        operations.rename(record.restorePath, record.outputPath);
      } else {
        operations.remove(record.outputPath, { force: true });
      }
    }
  }

  // UNPREPARED cannot have changed committed outputs. COMMITTED means both
  // output renames completed. In both cases only transaction debris remains.
  operations.remove(transactionDirectory, { force: true, recursive: true });
  return { recovered: true, state };
}

function publishValidatedArtifacts(artifacts, overrides = {}) {
  const operations = publishOperations(overrides);
  const { outputDirectory, statePath, transactionDirectory } = transactionPaths(artifacts);
  const records = artifacts.map((artifact) => transactionRecord(transactionDirectory, artifact));
  operations.makeDirectory(outputDirectory, { recursive: true });
  recoverPublishTransaction(artifacts, operations);
  operations.makeDirectory(transactionDirectory, { recursive: false });
  let prepared = false;
  let committed = false;
  let failure;

  try {
    // Cross-filesystem build roots are allowed. Both candidates and both old
    // outputs are durably represented inside one same-filesystem transaction
    // directory before the PREPARED marker permits publication.
    for (const record of records) {
      operations.copyFile(record.generatedPath, record.stagedPath, fs.constants.COPYFILE_EXCL);
      if (operations.exists(record.outputPath)) {
        operations.copyFile(record.outputPath, record.backupPath, fs.constants.COPYFILE_EXCL);
        operations.writeFile(record.hadPath, '', { flag: 'wx', mode: 0o600 });
      }
    }
    operations.writeFile(`${statePath}.next`, 'PREPARED\n', { flag: 'wx', mode: 0o600 });
    operations.rename(`${statePath}.next`, statePath);
    prepared = true;

    for (const record of records) operations.rename(record.stagedPath, record.outputPath);
    operations.writeFile(`${statePath}.next`, 'COMMITTED\n', { flag: 'wx', mode: 0o600 });
    operations.rename(`${statePath}.next`, statePath);
    committed = true;
  } catch (error) {
    failure = error;
  }

  if (prepared && !committed) {
    try {
      recoverPublishTransaction(artifacts, operations);
    } catch (recoveryError) {
      if (failure instanceof Error) {
        failure.message = `${failure.message}; recovery_failed=${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
      } else {
        failure = recoveryError;
      }
    }
  } else if (!prepared) {
    // No committed output could have changed before PREPARED. Remove all
    // partially copied transaction files without depending on records.push().
    try {
      operations.remove(transactionDirectory, { force: true, recursive: true });
    } catch (cleanupError) {
      if (!failure) failure = cleanupError;
    }
  } else {
    try {
      operations.remove(transactionDirectory, { force: true, recursive: true });
    } catch (cleanupError) {
      if (!failure) failure = cleanupError;
    }
  }

  if (failure) throw failure;
}

async function runBuildRuntime(options = {}) {
  const pluginRoot = path.resolve(options.pluginRoot || path.resolve(__dirname, '..'));
  const maximumOutputBytes = options.maximumOutputBytes || DEFAULT_MAXIMUM_OUTPUT_BYTES;
  const esbuildApi = options.esbuildApi || require('esbuild');
  const bundleDefinitions = definitions(pluginRoot);
  const removeTemporaryDirectory = options.removeTemporaryDirectory
    || ((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  let failure;
  let result;
  let temporaryDirectory;

  try {
    assertPinnedEsbuild(esbuildApi);
    temporaryDirectory = resolveTemporaryDirectory(pluginRoot, options);
    const buildResult = await esbuildApi.build({
      absWorkingDir: pluginRoot,
      bundle: true,
      define: {
        'process.env.WS_NO_BUFFER_UTIL': '"1"',
        'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
      },
      entryNames: '[name]',
      entryPoints: {
        channel: 'bin/codex-discord-channel',
        'mcp-server': 'src/mcp-server.js',
      },
      format: 'cjs',
      legalComments: 'none',
      metafile: true,
      minifySyntax: true,
      outExtension: { '.js': '.cjs' },
      outdir: temporaryDirectory,
      packages: 'bundle',
      platform: 'node',
      plugins: [optionalNativeFallbacks, nodeExternals],
      sourcemap: false,
      target: ['node22'],
      write: true,
    });
    assertMetafileHasNoExternalRuntimeImports(buildResult.metafile, bundleDefinitions);
    const artifacts = validateGeneratedArtifacts(
      bundleDefinitions,
      temporaryDirectory,
      maximumOutputBytes,
    );
    for (const artifact of artifacts) {
      await auditGeneratedArtifactClosure(
        artifact,
        temporaryDirectory,
        maximumOutputBytes,
        esbuildApi,
      );
    }
    if (options.check) {
      for (const artifact of artifacts) {
        const relativeOutput = path.relative(pluginRoot, artifact.outputPath);
        if (!fs.existsSync(artifact.outputPath)) throw new Error(`${relativeOutput} is not committed`);
        compareFilesBounded(
          relativeOutput,
          artifact.outputPath,
          artifact.generatedPath,
          maximumOutputBytes,
        );
      }
    } else {
      publishValidatedArtifacts(artifacts, options.publishOperations);
    }
    result = { temporaryDirectory };
  } catch (error) {
    failure = error;
  } finally {
    let cleanupFailure;
    if (temporaryDirectory) {
      try {
        removeTemporaryDirectory(temporaryDirectory);
      } catch (error) {
        cleanupFailure = error;
      }
    }
    try {
      await esbuildApi.stop();
    } catch (error) {
      if (!failure) failure = error;
    }
    if (!failure && cleanupFailure) failure = cleanupFailure;
  }

  if (failure) throw failure;
  return result;
}

if (require.main === module) {
  // This public CLI never trusts caller-controlled state as evidence that a
  // lock is held. The wrapper invokes a distinct non-main driver after it has
  // acquired the kernel locks; all direct CLI calls delegate unconditionally.
  const wrapper = path.join(__dirname, 'build-runtime-locked.sh');
  const delegated = childProcess.spawnSync('bash', [wrapper, ...process.argv.slice(2)], {
    env: process.env,
    stdio: 'inherit',
  });
  if (delegated.error) {
    process.stderr.write(`${delegated.error.stack || delegated.error.message}\n`);
    process.exitCode = 72;
  } else if (delegated.signal) {
    process.kill(process.pid, delegated.signal);
  } else {
    process.exitCode = delegated.status ?? 72;
  }
}

module.exports = {
  DEFAULT_MAXIMUM_OUTPUT_BYTES,
  PINNED_ESBUILD_VERSION,
  assertArtifactAuditMetafile,
  assertCommittedBundleCurrent,
  assertMetafileHasNoExternalRuntimeImports,
  compareFilesBounded,
  createPrivateTemporaryDirectory,
  definitions,
  firstMismatchOffset,
  publishValidatedArtifacts,
  recoverPublishTransaction,
  resolveTemporaryDirectory,
  runBuildRuntime,
  sha256,
};
