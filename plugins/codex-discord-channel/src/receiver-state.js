'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readPid(pidPath) {
  try {
    const value = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    if (error && error.code === 'ENOENT') return 0;
    throw error;
  }
}

function writePid(pidPath, pid = process.pid) {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidPath, `${pid}\n`, { mode: 0o600 });
  return pid;
}

function clearPid(pidPath, pid = process.pid) {
  if (readPid(pidPath) !== pid) return false;
  fs.unlinkSync(pidPath);
  return true;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isActiveDiscordReceiver(config = {}, deps = {}) {
  const pidPath = config.paths?.gatewayPidPath || '';
  if (!pidPath) return { active: true, reason: 'gateway_pid_unconfigured' };

  const activePid = readPid(pidPath);
  if (!activePid) return { active: true, reason: 'gateway_pid_missing' };
  if (activePid === process.pid) return { active: true, reason: 'gateway_pid_match', pid: activePid };

  const alive = (deps.isProcessAlive || isProcessAlive)(activePid);
  if (alive) {
    return { active: false, reason: 'another_gateway_active', pid: activePid };
  }
  return { active: true, reason: 'stale_gateway_pid', pid: activePid };
}

module.exports = {
  clearPid,
  isActiveDiscordReceiver,
  isProcessAlive,
  readPid,
  writePid,
};
