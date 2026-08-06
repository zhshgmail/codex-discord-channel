'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  definitions,
  recoverPublishTransaction,
  runBuildRuntime,
} = require('./build-runtime');

const LOCK_CONTRACT_ERROR = 'build_runtime_lock_contract_unavailable';

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function regularLockPath(filePath) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(LOCK_CONTRACT_ERROR);
  return stat;
}

function lockInheritedDescriptor(fd) {
  const stdio = Array.from({ length: 10 }, (_, index) => (index < 3 ? 'ignore' : 'ignore'));
  stdio[fd] = fd;
  const result = childProcess.spawnSync(
    '/usr/bin/flock',
    ['--nonblock', '--conflict-exit-code=73', String(fd)],
    { stdio },
  );
  if (result.error || result.signal || result.status === null) throw new Error(LOCK_CONTRACT_ERROR);
  if (result.status === 73) {
    const error = new Error('build_runtime_already_running');
    error.exitCode = 73;
    throw error;
  }
  if (result.status !== 0) throw new Error(LOCK_CONTRACT_ERROR);
}

function assertInheritedLockContract(pluginRoot) {
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const canonicalRoot = fs.realpathSync(pluginRoot);
  const rootDigest = crypto.createHash('sha256').update(canonicalRoot).digest('hex');
  const compatPath = path.join(runtimeDirectory, 'codex02-discord-build-runtime.lock');
  const canonicalPath = path.join(runtimeDirectory, `codex-discord-build-runtime-${rootDigest}.lock`);
  const compatPathStat = regularLockPath(compatPath);
  const canonicalPathStat = regularLockPath(canonicalPath);
  const compatFdStat = fs.fstatSync(8, { bigint: true });
  const canonicalFdStat = fs.fstatSync(9, { bigint: true });
  if (!compatFdStat.isFile() || !canonicalFdStat.isFile()
    || !sameInode(compatFdStat, compatPathStat)
    || !sameInode(canonicalFdStat, canonicalPathStat)) {
    throw new Error(LOCK_CONTRACT_ERROR);
  }
  lockInheritedDescriptor(8);
  if (!sameInode(compatFdStat, canonicalFdStat)) lockInheritedDescriptor(9);
}

async function main() {
  const pluginRoot = path.resolve(__dirname, '..');
  assertInheritedLockContract(pluginRoot);
  if (process.argv.includes('--recover-publish')) {
    recoverPublishTransaction(definitions(pluginRoot));
    return;
  }
  await runBuildRuntime({ check: process.argv.includes('--check') });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message === LOCK_CONTRACT_ERROR ? message : (error.stack || message)}\n`);
  process.exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 72;
});
