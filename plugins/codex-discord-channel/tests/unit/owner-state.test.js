'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  bindOwnerDelivery,
  claimOwner,
  createOwner,
  isCurrentOwner,
  publicOwner,
  readOwner,
} = require('../../src/owner-state');

test('claimOwner writes readable owner file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-owner-'));
  const ownerPath = path.join(dir, 'owner.json');
  const owner = {
    instance: 'codex01',
    stateDir: dir,
    ownerId: 'owner-a',
    pid: 100,
    hostname: 'host',
    cwd: '/workspace',
    startedAt: '2026-07-06T00:00:00.000Z',
  };
  const claimed = await claimOwner(ownerPath, owner, { expected: null });
  assert.deepEqual(readOwner(ownerPath), claimed);
  assert.equal(claimed.generation, 1);
  assert.equal(typeof claimed.capability, 'string');
  assert.equal(isCurrentOwner(ownerPath, 'owner-a'), true);
  assert.equal(isCurrentOwner(ownerPath, 'owner-b'), false);
});

test('new owner supersedes old owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-owner-'));
  const ownerPath = path.join(dir, 'owner.json');
  const old = await claimOwner(ownerPath, {
    instance: 'codex01', stateDir: dir, ownerId: 'old', pid: 1,
  }, { expected: null });
  const current = await claimOwner(ownerPath, {
    instance: 'codex01', stateDir: dir, ownerId: 'new', pid: 2,
  }, { expected: old });
  assert.equal(isCurrentOwner(ownerPath, 'old'), false);
  assert.equal(isCurrentOwner(ownerPath, 'new'), true);
  assert.equal(current.generation, 2);
});

test('createOwner captures session identity', () => {
  const owner = createOwner({
    paths: { instance: 'codex01', stateDir: '/state/codex01' },
    ownerId: 'abc',
    pid: 123,
    hostname: 'host',
    cwd: '/work',
    startedAt: 'now',
  });
  assert.equal(owner.instance, 'codex01');
  assert.equal(owner.ownerId, 'abc');
  assert.equal(owner.cwd, '/work');
});

test('delivery binding advances once and retains the owner claim lineage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-owner-'));
  const config = {
    paths: {
      instance: 'codex01',
      stateDir: dir,
      ownerPath: path.join(dir, 'owner.json'),
    },
    ownerId: 'owner-a',
    pid: 123,
    hostname: 'host',
    cwd: '/work',
    startedAt: 'now',
    threadId: 'thread-a',
    turnId: '',
  };
  const claimed = await claimOwner(
    config.paths.ownerPath,
    createOwner(config),
    { expected: null },
  );
  const delivery = {
    channelId: 'c1', sourceMessageId: 'm1', threadId: 'thread-a', turnId: 'turn-a',
  };
  const bound = await bindOwnerDelivery(config, delivery);
  const repeated = await bindOwnerDelivery(config, delivery);

  assert.equal(bound.generation, claimed.generation + 1);
  assert.notEqual(bound.capability, claimed.capability);
  assert.equal(bound.claimCapability, claimed.claimCapability);
  assert.deepEqual(bound.delivery, delivery);
  assert.deepEqual(repeated, bound);
});

test('public owner metadata omits every sender capability token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-owner-'));
  const ownerPath = path.join(dir, 'owner.json');
  const claimed = await claimOwner(ownerPath, {
    instance: 'codex01', stateDir: dir, ownerId: 'owner-a', pid: 123,
  }, { expected: null });
  const safe = publicOwner(claimed);

  assert.equal(Object.hasOwn(safe, 'capability'), false);
  assert.equal(Object.hasOwn(safe, 'claimCapability'), false);
  assert.equal(Object.hasOwn(safe, 'previousCapability'), false);
  assert.equal(safe.generation, 1);
});
