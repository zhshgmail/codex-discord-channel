'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function createOwner(config) {
  return {
    version: 2,
    instance: config.paths.instance,
    instanceIdentity: config.instanceIdentity,
    pid: config.pid,
    hostname: config.hostname,
    cwd: config.cwd,
    startedAt: config.startedAt,
  };
}

function claimOwner(ownerPath, owner) {
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
  const tempPath = `${ownerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, ownerPath);
  return owner;
}

function readOwner(ownerPath) {
  const owner = readJson(ownerPath);
  if (!owner || typeof owner !== 'object') return null;
  return owner;
}

function isSameInstanceOwner(ownerPath, instanceIdentity) {
  const owner = readOwner(ownerPath);
  return Boolean(
    owner
    && owner.instanceIdentity?.version === 1
    && instanceIdentity?.version === 1
    && owner.instanceIdentity.fingerprint === instanceIdentity.fingerprint,
  );
}

module.exports = {
  claimOwner,
  createOwner,
  isSameInstanceOwner,
  readOwner,
};
