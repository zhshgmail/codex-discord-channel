'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  commitReceiverOwnership,
  createReceiverOwnership,
  getDeliveryQueueLockIdentity,
  isCurrentReceiverOwnership,
  readReceiverAuthoritySnapshot,
  releaseReceiverOwnership,
} = require('../../src/receiver-state');

const A6_COMMIT = 'c09749a018253e79ac939be1e2a5809756209437';
const RECEIVER_STATE_PATH = 'plugins/codex-discord-channel/src/receiver-state.js';
const A6_RECEIVER_STATE_SHA256 = '511c574c2636b6e4238c8bdd1c137eadf4321988a0e81f00c8bede32bed5906f';

function loadA6ReceiverState() {
  const modulePath = path.join(__dirname, '..', 'fixtures', 'a6', 'receiver-state.js');
  const digest = createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex');
  assert.equal(digest, A6_RECEIVER_STATE_SHA256, `${A6_COMMIT}:${RECEIVER_STATE_PATH}`);
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
  const config = {
    paths: {
      stateDir,
      gatewayPidPath,
      receiverOwnershipPath,
      deliveryQueuePath: path.join(stateDir, 'pending-delivery.json'),
    },
  };
  fs.writeFileSync(gatewayPidPath, `${process.pid}\n`);
  fs.writeFileSync(receiverOwnershipPath, `${JSON.stringify(ownership)}\n`);
  return { config, gatewayPidPath, ownership, receiverOwnershipPath, stateDir };
}

test('actual A6 incumbent must be quiesced before a flock-protocol successor commits', (t) => {
  const a6ReceiverState = loadA6ReceiverState();
  const { config, gatewayPidPath, ownership, receiverOwnershipPath, stateDir } = legacyIncumbentFixture();
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const fixture = path.join(__dirname, '..', 'fixtures', 'receiver-handoff-crash.js');

  const successor = spawnSync(process.execPath, [fixture, stateDir, 'authority_committed'], {
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.equal(successor.status, 2, successor.stderr);
  assert.equal(fs.existsSync(`${gatewayPidPath}.v2`), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(receiverOwnershipPath, 'utf8')), ownership);
  assert.deepEqual(a6ReceiverState.isActiveDiscordReceiver(config), {
    active: true,
    reason: 'gateway_pid_match',
    pid: process.pid,
  }, fs.readFileSync(gatewayPidPath, 'utf8'));

  const beforeQueueAccess = spawnSync(process.execPath, [fixture, stateDir, 'durable_queue_ready'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(beforeQueueAccess.status, 2, beforeQueueAccess.stderr);
  assert.equal(fs.existsSync(path.join(stateDir, 'pending-delivery.json.lock')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(receiverOwnershipPath, 'utf8')), ownership);

  const beforeDiscordLogin = spawnSync(process.execPath, [fixture, stateDir, 'discord_login_ready'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(beforeDiscordLogin.status, 2, beforeDiscordLogin.stderr);
});

test('direct ownership commit rejects a live incumbent with no queue-lock protocol', (t) => {
  const { config, gatewayPidPath, ownership, stateDir } = legacyIncumbentFixture();
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const successorPid = 987654;
  const snapshot = readReceiverAuthoritySnapshot(config, {
    isProcessAlive: (pid) => pid === ownership.pid,
    pid: successorPid,
  });
  const successor = createReceiverOwnership(snapshot.record, {
    now: () => Date.parse('2026-07-20T01:00:00.000Z'),
    pid: successorPid,
    randomUUID: () => 'a7-successor-generation',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
  });

  assert.throws(
    () => commitReceiverOwnership(config, snapshot, successor, {
      isProcessAlive: (pid) => pid === ownership.pid,
      pid: successorPid,
    }),
    (error) => error?.code === 'delivery_queue_lock_protocol_quiescence_required',
  );
  assert.equal(fs.readFileSync(gatewayPidPath, 'utf8'), `${process.pid}\n`);
  assert.equal(fs.existsSync(`${gatewayPidPath}.v2`), false);
});

test('ownership commit rejects a candidate that omits the current queue-lock protocol', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-invalid-protocol-candidate-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const gatewayPidPath = path.join(stateDir, 'session-gateway.pid');
  const config = { paths: { gatewayPidPath } };
  const snapshot = readReceiverAuthoritySnapshot(config);
  const candidate = {
    version: 2,
    pid: process.pid,
    generation: 'missing-protocol',
    claimedAt: '2026-09-11T00:00:00.000Z',
    fallback: null,
  };

  assert.throws(
    () => commitReceiverOwnership(config, snapshot, candidate),
    (error) => error?.code === 'receiver_ownership_protocol_invalid',
  );
  assert.equal(fs.existsSync(gatewayPidPath), false);
});

test('ownership commit rejects a candidate that omits its queue-lock identity', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-missing-queue-candidate-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const gatewayPidPath = path.join(stateDir, 'session-gateway.pid');
  const config = {
    paths: {
      stateDir,
      gatewayPidPath,
      deliveryQueuePath: path.join(stateDir, 'pending-delivery.json'),
    },
  };
  const snapshot = readReceiverAuthoritySnapshot(config);
  const candidate = {
    version: 2,
    pid: process.pid,
    generation: 'missing-identity',
    claimedAt: '2026-09-11T00:00:00.000Z',
    deliveryQueueLockProtocol: 'flock-v1',
    fallback: null,
  };

  assert.throws(
    () => commitReceiverOwnership(config, snapshot, candidate),
    (error) => error?.code === 'receiver_ownership_queue_lock_identity_invalid',
  );
  assert.equal(fs.existsSync(gatewayPidPath), false);
});

test('ownership commit rejects a candidate bound to a different configured queue', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-invalid-queue-candidate-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const config = {
    paths: {
      stateDir,
      gatewayPidPath: path.join(stateDir, 'session-gateway.pid'),
      deliveryQueuePath: path.join(stateDir, 'queue-a.json'),
    },
  };
  const snapshot = readReceiverAuthoritySnapshot(config);
  const candidate = createReceiverOwnership(null, {
    randomUUID: () => 'wrong-queue-candidate',
    deliveryQueueLockIdentity: path.join(stateDir, 'queue-b.json.lock'),
  });

  assert.throws(
    () => commitReceiverOwnership(config, snapshot, candidate),
    (error) => error?.code === 'receiver_ownership_queue_lock_identity_invalid',
  );
  assert.equal(fs.existsSync(config.paths.gatewayPidPath), false);
});

test('a flock-protocol successor can commit after the legacy incumbent is proven quiesced', (t) => {
  const a6ReceiverState = loadA6ReceiverState();
  const { config, gatewayPidPath, stateDir } = legacyIncumbentFixture();
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const successorPid = 987654;
  const snapshot = readReceiverAuthoritySnapshot(config, {
    isProcessAlive: () => false,
    pid: successorPid,
  });
  const successor = createReceiverOwnership(null, {
    now: () => Date.parse('2026-07-20T01:00:00.000Z'),
    pid: successorPid,
    randomUUID: () => 'a7-successor-generation',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
  });

  commitReceiverOwnership(config, snapshot, successor, {
    isProcessAlive: () => false,
    pid: successorPid,
  });
  assert.equal(a6ReceiverState.clearPid(gatewayPidPath, process.pid), false);
  assert.deepEqual(isCurrentReceiverOwnership(config, successor, {
    isProcessAlive: (pid) => pid === successorPid,
    pid: successorPid,
  }), {
    active: true,
    reason: 'gateway_generation_match',
    pid: successorPid,
    generation: successor.generation,
  });
});

test('same flock protocol retains live-successor handoff semantics', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-flock-handoff-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const gatewayPidPath = path.join(stateDir, 'session-gateway.pid');
  const config = {
    paths: {
      stateDir,
      gatewayPidPath,
      deliveryQueuePath: path.join(stateDir, 'pending-delivery.json'),
    },
  };
  const incumbent = createReceiverOwnership(null, {
    pid: 31001,
    randomUUID: () => 'flock-incumbent',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
  });
  fs.writeFileSync(gatewayPidPath, `${JSON.stringify(incumbent)}\n`);
  const snapshot = readReceiverAuthoritySnapshot(config, {
    isProcessAlive: (pid) => pid === incumbent.pid,
    pid: 31002,
  });
  const successor = createReceiverOwnership(incumbent, {
    pid: 31002,
    randomUUID: () => 'flock-successor',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
  });

  commitReceiverOwnership(config, snapshot, successor, {
    isProcessAlive: (pid) => pid === incumbent.pid,
    pid: 31002,
  });
  assert.equal(readReceiverAuthoritySnapshot(config).record.generation, successor.generation);
  assert.equal(releaseReceiverOwnership(config, successor, {
    isProcessAlive: (pid) => pid === incumbent.pid,
    pid: 31002,
  }), true);
  assert.equal(readReceiverAuthoritySnapshot(config).record.generation, incumbent.generation);
});

test('same authority path with a different queue-lock identity requires quiescence', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-flock-identity-handoff-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const gatewayPidPath = path.join(stateDir, 'session-gateway.pid');
  const incumbentConfig = {
    paths: {
      stateDir,
      gatewayPidPath,
      deliveryQueuePath: path.join(stateDir, 'queue-a.json'),
    },
  };
  const successorConfig = {
    paths: {
      stateDir,
      gatewayPidPath,
      deliveryQueuePath: path.join(stateDir, 'queue-b.json'),
    },
  };
  const incumbent = createReceiverOwnership(null, {
    pid: 32001,
    randomUUID: () => 'flock-incumbent-a',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(incumbentConfig),
  });
  fs.writeFileSync(gatewayPidPath, `${JSON.stringify(incumbent)}\n`);
  const snapshot = readReceiverAuthoritySnapshot(successorConfig, {
    isProcessAlive: (pid) => pid === incumbent.pid,
    pid: 32002,
  });
  const successor = createReceiverOwnership(incumbent, {
    pid: 32002,
    randomUUID: () => 'flock-successor-b',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(successorConfig),
  });

  assert.throws(
    () => commitReceiverOwnership(successorConfig, snapshot, successor, {
      isProcessAlive: (pid) => pid === incumbent.pid,
      pid: 32002,
    }),
    (error) => error?.code === 'delivery_queue_lock_identity_quiescence_required',
  );
  assert.deepEqual(readReceiverAuthoritySnapshot(incumbentConfig).record, incumbent);
  assert.equal(fs.existsSync(`${successorConfig.paths.deliveryQueuePath}.lock`), false);
});
