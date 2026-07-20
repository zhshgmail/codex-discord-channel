'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  commitReceiverOwnership,
  createReceiverOwnership,
  isCurrentReceiverOwnership,
  readReceiverAuthoritySnapshot,
  releaseReceiverOwnership,
} = require('../../src/receiver-state');

const A6_COMMIT = 'c09749a018253e79ac939be1e2a5809756209437';
const RECEIVER_STATE_PATH = 'plugins/codex-discord-channel/src/receiver-state.js';

function loadA6ReceiverState() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const source = execFileSync('git', ['show', `${A6_COMMIT}:${RECEIVER_STATE_PATH}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-a6-receiver-module-'));
  const modulePath = path.join(moduleDir, 'receiver-state.js');
  fs.writeFileSync(modulePath, source);
  return require(modulePath);
}

function legacyIncumbentFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-a6-a7-handoff-'));
  const gatewayPidPath = path.join(stateDir, 'session-gateway.pid');
  const receiverOwnershipPath = `${gatewayPidPath}.generation`;
  const ownership = {
    version: 1,
    pid: process.pid,
    generation: 'a6-incumbent-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
  };
  const config = { paths: { gatewayPidPath, receiverOwnershipPath } };
  fs.writeFileSync(gatewayPidPath, `${process.pid}\n`);
  fs.writeFileSync(receiverOwnershipPath, `${JSON.stringify(ownership)}\n`);
  return { config, gatewayPidPath, ownership, receiverOwnershipPath, stateDir };
}

test('actual A6 incumbent remains active after an A7 successor crashes post-commit', () => {
  const a6ReceiverState = loadA6ReceiverState();
  const { config, gatewayPidPath, ownership, stateDir } = legacyIncumbentFixture();
  const fixture = path.join(__dirname, '..', 'fixtures', 'receiver-handoff-crash.js');

  const successor = spawnSync(process.execPath, [fixture, stateDir, 'authority_committed'], {
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(successor.status, 86, successor.stderr);
  assert.deepEqual(isCurrentReceiverOwnership(config, ownership), {
    active: true,
    reason: 'gateway_generation_fallback',
    pid: process.pid,
    generation: ownership.generation,
  });
  assert.deepEqual(a6ReceiverState.isActiveDiscordReceiver(config), {
    active: true,
    reason: 'gateway_pid_match',
    pid: process.pid,
  }, fs.readFileSync(gatewayPidPath, 'utf8'));
});

test('actual A6 incumbent remains active after graceful A7 successor release', () => {
  const a6ReceiverState = loadA6ReceiverState();
  const { config, gatewayPidPath, ownership, receiverOwnershipPath } = legacyIncumbentFixture();
  const successorPid = 987654;
  const snapshot = readReceiverAuthoritySnapshot(config, {
    isProcessAlive: (pid) => pid === ownership.pid,
    pid: successorPid,
  });
  const successor = createReceiverOwnership(snapshot.record, {
    now: () => Date.parse('2026-07-20T01:00:00.000Z'),
    pid: successorPid,
    randomUUID: () => 'a7-successor-generation',
  });

  commitReceiverOwnership(config, snapshot, successor, { pid: successorPid });
  assert.equal(releaseReceiverOwnership(config, successor, {
    isProcessAlive: (pid) => pid === ownership.pid,
    pid: successorPid,
  }), true);

  assert.deepEqual(a6ReceiverState.isActiveDiscordReceiver(config), {
    active: true,
    reason: 'gateway_pid_match',
    pid: process.pid,
  }, fs.readFileSync(gatewayPidPath, 'utf8'));
  assert.deepEqual(JSON.parse(fs.readFileSync(receiverOwnershipPath, 'utf8')), ownership);
});
