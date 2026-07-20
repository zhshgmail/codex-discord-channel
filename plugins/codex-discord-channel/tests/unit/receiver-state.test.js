'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  getStagedReceiverAuthorityPath,
  isActiveDiscordReceiver,
  readReceiverAuthoritySnapshot,
  releaseReceiverOwnership,
} = require('../../src/receiver-state');

test('gateway pid file selects active receiver independently from owner id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const ownerPath = path.join(dir, 'owner.json');
  const config = { paths: { gatewayPidPath, ownerPath } };

  assert.deepEqual(isActiveDiscordReceiver(config), { active: false, reason: 'gateway_pid_missing' });

  fs.writeFileSync(gatewayPidPath, `${process.pid}\n`);
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
  fs.unlinkSync(gatewayPidPath);
  assert.deepEqual(isActiveDiscordReceiver(config), { active: false, reason: 'gateway_pid_missing' });
});

test('non-gateway receiver stands down when live gateway pid differs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = { paths: { gatewayPidPath } };
  fs.writeFileSync(gatewayPidPath, '12345\n');

  const decision = isActiveDiscordReceiver(config, { isProcessAlive: () => true });
  assert.equal(decision.active, false);
  assert.equal(decision.reason, 'another_gateway_active');
  assert.equal(decision.pid, 12345);
});

test('stale gateway pid fails closed instead of enabling a fallback receiver', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = { paths: { gatewayPidPath } };
  fs.writeFileSync(gatewayPidPath, '12345\n');

  const decision = isActiveDiscordReceiver(config, { isProcessAlive: () => false });
  assert.equal(decision.active, false);
  assert.equal(decision.reason, 'stale_gateway_pid');
  assert.equal(decision.pid, 12345);
});

test('graceful successor release restores a live A6 fallback in legacy format', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-release-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const receiverOwnershipPath = `${gatewayPidPath}.generation`;
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
  const config = { paths: { gatewayPidPath, receiverOwnershipPath } };
  const stagedAuthorityPath = getStagedReceiverAuthorityPath(config);
  fs.writeFileSync(gatewayPidPath, `${process.pid}\n`);
  fs.writeFileSync(receiverOwnershipPath, `${JSON.stringify(current.fallback)}\n`);
  fs.writeFileSync(stagedAuthorityPath, `${JSON.stringify(current)}\n`);

  assert.equal(releaseReceiverOwnership(config, current, {
    isProcessAlive: (pid) => pid === process.pid,
  }), true);
  assert.equal(fs.readFileSync(gatewayPidPath, 'utf8'), `${process.pid}\n`);
  assert.equal(fs.existsSync(stagedAuthorityPath), false);
  assert.deepEqual(readReceiverAuthoritySnapshot(config).record, current.fallback);
});

test('graceful successor release keeps an A7 fallback as atomic JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-release-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const fallback = {
    version: 2,
    pid: process.pid,
    generation: 'a7-fallback-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
    fallback: null,
  };
  const current = {
    version: 2,
    pid: 23456,
    generation: 'successor-generation',
    claimedAt: '2026-07-20T01:00:00.000Z',
    fallback,
  };
  const config = { paths: { gatewayPidPath } };
  fs.writeFileSync(gatewayPidPath, `${JSON.stringify(current)}\n`);

  assert.equal(releaseReceiverOwnership(config, current, {
    isProcessAlive: (pid) => pid === process.pid,
  }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8')), fallback);
  assert.deepEqual(readReceiverAuthoritySnapshot(config).record, fallback);
});

test('malformed staged authority fails closed over a valid legacy receiver', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-staged-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = { paths: { gatewayPidPath } };
  fs.writeFileSync(gatewayPidPath, `${process.pid}\n`);
  fs.writeFileSync(getStagedReceiverAuthorityPath(config), '{not-json}\n');

  const snapshot = readReceiverAuthoritySnapshot(config);
  assert.equal(snapshot.valid, false);
  assert.equal(snapshot.source, 'invalid');
});
