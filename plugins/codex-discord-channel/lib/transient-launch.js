'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');

const INCIDENT_VERSION = 1;
const RETRY_DELAY_MS = 100;
const VALID_STAGES = new Set([
  'app-supervisor-spawn',
  'app-native-exec',
  'gateway-spawn',
  'tui-spawn',
  'tui-native-exec',
]);

function isEagain(error) {
  return error?.code === 'EAGAIN' || error?.errno === 11 || error?.errno === -11;
}

function argvSha256(command, args) {
  const hash = crypto.createHash('sha256');
  for (const value of [command, ...args]) {
    hash.update(String(value));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function integerFromFile(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function resourceSnapshot() {
  const memory = {};
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const match = line.match(/^(MemAvailable|MemFree|SwapFree|Committed_AS):\s+(\d+)\s+kB$/);
      if (match) memory[match[1]] = match[2];
    }
  } catch {}
  let processCount = null;
  try { processCount = String(fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).length); } catch {}
  let loadAverage = null;
  try { loadAverage = fs.readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3); } catch {}
  let cgroupPidsCurrent = null;
  let cgroupPidsMax = null;
  try {
    const unified = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n')
      .find((line) => line.startsWith('0::'));
    if (unified) {
      const relative = unified.slice(3).replace(/^\/+/, '');
      const base = path.join('/sys/fs/cgroup', relative);
      cgroupPidsCurrent = integerFromFile(path.join(base, 'pids.current'));
      try { cgroupPidsMax = fs.readFileSync(path.join(base, 'pids.max'), 'utf8').trim(); } catch {}
    }
  } catch {}
  return {
    cgroupPidsCurrent,
    cgroupPidsMax,
    loadAverage,
    memoryKb: memory,
    pid: process.pid,
    processCount,
    threadsMax: integerFromFile('/proc/sys/kernel/threads-max'),
  };
}

function errorIdentity(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    errno: Number.isInteger(error?.errno) ? error.errno : null,
    syscall: typeof error?.syscall === 'string' ? error.syscall : null,
  };
}

function validateStage(stage) {
  if (!VALID_STAGES.has(stage)) throw new Error(`unsupported launch stage: ${stage}`);
}

function appendIncident(stateDir, incident) {
  if (!path.isAbsolute(stateDir)) throw new Error('launch incident state directory must be absolute');
  const file = path.join(stateDir, 'startup-incidents.jsonl');
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow,
    0o600,
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('launch incident journal is not regular');
    if (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) {
      throw new Error('launch incident journal has a foreign owner');
    }
    if ((stat.mode & 0o077n) !== 0n || stat.nlink !== 1n) {
      throw new Error('launch incident journal has unsafe metadata');
    }
    fs.writeFileSync(fd, `${JSON.stringify(incident)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function incidentFor(options, error, attempt, action) {
  return {
    action,
    argvSha256: argvSha256(options.command, options.args),
    attempt,
    error: errorIdentity(error),
    generation: typeof options.env?.CODEX_DISCORD_LAUNCH_GENERATION === 'string'
      ? options.env.CODEX_DISCORD_LAUNCH_GENERATION
      : null,
    instance: typeof options.env?.CODEX_DISCORD_LAUNCH_INSTANCE === 'string'
      ? options.env.CODEX_DISCORD_LAUNCH_INSTANCE
      : null,
    resource: resourceSnapshot(),
    role: typeof options.env?.CODEX_DISCORD_LAUNCH_ROLE === 'string'
      ? options.env.CODEX_DISCORD_LAUNCH_ROLE
      : null,
    stage: options.stage,
    timestamp: new Date().toISOString(),
    version: INCIDENT_VERSION,
  };
}

function recordIncident(options, error, attempt, action, dependencies) {
  const incident = incidentFor(options, error, attempt, action);
  if (typeof dependencies.recordLaunchIncident === 'function') {
    dependencies.recordLaunchIncident(incident);
  } else {
    appendIncident(options.stateDir, incident);
  }
}

function sleepSync(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function execveWithEagainRetry(options, dependencies = {}) {
  validateStage(options.stage);
  const execve = dependencies.execve || process.execve;
  if (typeof execve !== 'function') {
    const error = new Error('Node 22.15 or newer is required for process.execve');
    error.code = 'node_execve_required';
    throw error;
  }
  const wait = dependencies.sleepSync || sleepSync;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return execve(options.command, [options.command, ...options.args], options.env);
    } catch (error) {
      if (!isEagain(error)) throw error;
      const action = attempt === 1 ? 'retry' : 'abort';
      recordIncident(options, error, attempt, action, dependencies);
      if (action === 'abort') throw error;
      wait(RETRY_DELAY_MS);
    }
  }
  throw new Error('unreachable exec retry state');
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.off('error', onError);
      resolve(child);
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

async function spawnWithEagainRetry(options, dependencies = {}) {
  validateStage(options.stage);
  const spawn = dependencies.spawn || nodeSpawn;
  const delay = dependencies.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let child;
    try {
      child = spawn(options.command, options.args, { env: options.env, stdio: options.stdio });
      return await waitForSpawn(child);
    } catch (error) {
      if (!isEagain(error)) throw error;
      const action = attempt === 1 ? 'retry' : 'abort';
      recordIncident(options, error, attempt, action, dependencies);
      if (action === 'abort') throw error;
      await delay(RETRY_DELAY_MS);
    }
  }
  throw new Error('unreachable spawn retry state');
}

module.exports = {
  appendIncident,
  argvSha256,
  execveWithEagainRetry,
  isEagain,
  resourceSnapshot,
  spawnWithEagainRetry,
};
