'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  clearPid,
  isActiveDiscordReceiver,
  readPid,
  readReceiverAuthoritySnapshot,
  releaseReceiverOwnership,
  writePid,
} = require('../../src/receiver-state');

test('gateway pid file selects active receiver independently from owner id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const ownerPath = path.join(dir, 'owner.json');
  const config = { paths: { gatewayPidPath, ownerPath } };

  assert.deepEqual(isActiveDiscordReceiver(config), { active: false, reason: 'gateway_pid_missing' });

  writePid(gatewayPidPath, process.pid);
  assert.equal(readPid(gatewayPidPath), process.pid);
  assert.deepEqual(isActiveDiscordReceiver(config), {
    active: true,
    reason: 'gateway_pid_match',
    pid: process.pid,
  });
  fs.writeFileSync(ownerPath, JSON.stringify({
    ownerId: 'thread-before-clear',
    pid: 111111,
  }));
  fs.writeFileSync(ownerPath, JSON.stringify({
    ownerId: 'thread-after-clear',
    pid: 222222,
  }));
  assert.deepEqual(isActiveDiscordReceiver(config), {
    active: true,
    reason: 'gateway_pid_match',
    pid: process.pid,
  });
  assert.equal(clearPid(gatewayPidPath, process.pid), true);
  assert.equal(readPid(gatewayPidPath), 0);
});

test('non-gateway receiver stands down when live gateway pid differs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = { paths: { gatewayPidPath } };
  writePid(gatewayPidPath, 12345);

  const decision = isActiveDiscordReceiver(config, { isProcessAlive: () => true });
  assert.equal(decision.active, false);
  assert.equal(decision.reason, 'another_gateway_active');
  assert.equal(decision.pid, 12345);
});

test('stale gateway pid fails closed instead of enabling a fallback receiver', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = { paths: { gatewayPidPath } };
  writePid(gatewayPidPath, 12345);

  const decision = isActiveDiscordReceiver(config, { isProcessAlive: () => false });
  assert.equal(decision.active, false);
  assert.equal(decision.reason, 'stale_gateway_pid');
  assert.equal(decision.pid, 12345);
});

test('graceful successor release promotes a live legacy fallback to a valid atomic record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-release-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const current = {
    version: 2,
    pid: 23456,
    generation: 'successor-generation',
    claimedAt: '2026-07-20T01:00:00.000Z',
    fallback: {
      version: 1,
      pid: process.pid,
      generation: 'legacy-generation',
      claimedAt: '2026-07-20T00:00:00.000Z',
    },
  };
  const config = { paths: { gatewayPidPath } };
  fs.writeFileSync(gatewayPidPath, `${JSON.stringify(current)}\n`);

  assert.equal(releaseReceiverOwnership(config, current, {
    isProcessAlive: (pid) => pid === process.pid,
  }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8')), {
    version: 2,
    pid: process.pid,
    generation: 'legacy-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
    fallback: null,
  });
  assert.equal(readReceiverAuthoritySnapshot(config).valid, true);
});
