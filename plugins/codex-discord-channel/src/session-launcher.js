'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { AppServerRpcClient, endpointToWebSocket } = require('./app-server-host');
const { loadConfig } = require('./config');

const DEFAULT_POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 300000;

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    throw new Error(`${label} must be a positive integer no greater than ${MAX_TIMEOUT_MS}.`);
  }
  return parsed;
}

function sessionTiming(env = process.env) {
  return {
    pollMs: positiveInteger(
      env.CODEX_DISCORD_SESSION_POLL_INTERVAL_MS,
      DEFAULT_POLL_MS,
      'Session poll interval',
    ),
    timeoutMs: positiveInteger(
      env.CODEX_DISCORD_SESSION_STARTUP_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      'Session startup timeout',
    ),
  };
}

function resolveSessionEndpoint(env = process.env) {
  const config = loadConfig(env);
  if (/[\u0000-\u001f\u007f]/.test(config.paths.stateDir)) {
    throw new Error('Discord state path must not contain ASCII control bytes.');
  }
  const endpoint = `unix://${path.join(config.paths.stateDir, 'app-server.sock')}`;
  if (config.appServerUrl !== endpoint) {
    throw new Error(`Configured app-server endpoint must match the Discord state path: ${endpoint}`);
  }
  return endpoint;
}

function validateSessionArguments(argv) {
  for (const argument of argv) {
    if (
      argument === '--remote' ||
      argument.startsWith('--remote=') ||
      argument === '--remote-auth-token-env' ||
      argument.startsWith('--remote-auth-token-env=')
    ) {
      throw new Error('The remote app-server endpoint is managed by the Discord session launcher.');
    }
  }
  return [...argv];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLockOwner(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Number(value.pid);
  } catch {
    return 0;
  }
}

function tryAcquireLock(lockPath) {
  try {
    const descriptor = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
    fs.closeSync(descriptor);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const ownerPid = readLockOwner(lockPath);
    if (!processExists(ownerPid)) {
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') return false;
      }
    }
    return false;
  }
}

function releaseLock(lockPath) {
  if (readLockOwner(lockPath) !== process.pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function protocolReady(endpoint, timeoutMs) {
  const client = new AppServerRpcClient({
    appServerUrl: endpoint,
    appServerConnectTimeoutMs: timeoutMs,
    appServerRequestTimeoutMs: timeoutMs,
  });
  try {
    await client.ensureConnected();
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

async function socketListening(endpoint, timeoutMs) {
  const { socketPath } = endpointToWebSocket(endpoint);
  if (!socketPath) return false;
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = net.createConnection({ path: socketPath });
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function spawnDetachedAppServer(codexBin, endpoint, stateDir, env) {
  const logPath = path.join(stateDir, 'app-server.log');
  const descriptor = fs.openSync(logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(codexBin, ['app-server', '--listen', endpoint], {
      detached: true,
      env,
      stdio: ['ignore', descriptor, descriptor],
    });
  } finally {
    fs.closeSync(descriptor);
  }
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child;
}

function writePid(pidPath, pid) {
  const temporary = `${pidPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${pid}\n`, { mode: 0o600 });
  fs.renameSync(temporary, pidPath);
}

async function waitForProtocol(endpoint, deadline, pollMs) {
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    if (await protocolReady(endpoint, Math.min(remaining, Math.max(250, pollMs)))) return true;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return false;
}

async function ensureSharedAppServer(options) {
  const {
    codexBin,
    endpoint,
    env,
    pollMs,
    timeoutMs,
  } = options;
  const { socketPath } = endpointToWebSocket(endpoint);
  const stateDir = path.dirname(socketPath);
  const lockPath = path.join(stateDir, 'app-server.start.lock');
  const pidPath = path.join(stateDir, 'app-server.pid');
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  if (await protocolReady(endpoint, Math.min(timeoutMs, 500))) return { endpoint, started: false };

  while (!tryAcquireLock(lockPath)) {
    if (await protocolReady(endpoint, Math.min(Math.max(1, deadline - Date.now()), 500))) {
      return { endpoint, started: false };
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for app-server startup at ${endpoint}.`);
    await delay(pollMs);
  }

  let child = null;
  try {
    if (await protocolReady(endpoint, Math.min(Math.max(1, deadline - Date.now()), 500))) {
      return { endpoint, started: false };
    }
    if (fs.existsSync(socketPath)) {
      if (await socketListening(endpoint, Math.min(Math.max(1, deadline - Date.now()), 500))) {
        if (await waitForProtocol(endpoint, deadline, pollMs)) return { endpoint, started: false };
        throw new Error(`App-server listener did not become protocol-ready at ${endpoint}.`);
      }
      fs.unlinkSync(socketPath);
    }

    child = await spawnDetachedAppServer(codexBin, endpoint, stateDir, env);
    if (!(await waitForProtocol(endpoint, deadline, pollMs))) {
      throw new Error(`App-server did not become ready at ${endpoint}; see ${path.join(stateDir, 'app-server.log')}.`);
    }
    if (!processExists(child.pid)) throw new Error('App-server exited before readiness was committed.');
    writePid(pidPath, child.pid);
    return { endpoint, pid: child.pid, started: true };
  } catch (error) {
    if (child && processExists(child.pid)) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {}
    }
    throw error;
  } finally {
    releaseLock(lockPath);
  }
}

async function launchVisibleSession(codexBin, endpoint, args, env) {
  const child = spawn(codexBin, ['--remote', endpoint, ...args], {
    env,
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Visible Codex session exited from signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

async function runSession(argv = process.argv.slice(2), env = process.env) {
  const args = validateSessionArguments(argv);
  const endpoint = resolveSessionEndpoint(env);
  const timing = sessionTiming(env);
  const codexBin = env.CODEX_DISCORD_CODEX_BIN || 'codex';
  await ensureSharedAppServer({ codexBin, endpoint, env, ...timing });
  return launchVisibleSession(codexBin, endpoint, args, env);
}

module.exports = {
  ensureSharedAppServer,
  resolveSessionEndpoint,
  runSession,
  sessionTiming,
  validateSessionArguments,
};
