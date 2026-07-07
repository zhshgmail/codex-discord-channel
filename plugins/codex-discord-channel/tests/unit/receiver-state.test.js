'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { clearPid, isActiveDiscordReceiver, readPid, writePid } = require('../../src/receiver-state');

test('gateway pid file selects active receiver independently from owner id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = { paths: { gatewayPidPath } };

  assert.deepEqual(isActiveDiscordReceiver(config), { active: true, reason: 'gateway_pid_missing' });

  writePid(gatewayPidPath, process.pid);
  assert.equal(readPid(gatewayPidPath), process.pid);
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

test('stale gateway pid does not block fallback receiver', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = { paths: { gatewayPidPath } };
  writePid(gatewayPidPath, 12345);

  const decision = isActiveDiscordReceiver(config, { isProcessAlive: () => false });
  assert.equal(decision.active, true);
  assert.equal(decision.reason, 'stale_gateway_pid');
  assert.equal(decision.pid, 12345);
});
