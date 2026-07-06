'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { claimOwner, createOwner, isCurrentOwner, readOwner } = require('../../src/owner-state');

test('claimOwner writes readable owner file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-owner-'));
  const ownerPath = path.join(dir, 'owner.json');
  const owner = {
    version: 1,
    instance: 'codex01',
    ownerId: 'owner-a',
    pid: 100,
    hostname: 'host',
    cwd: '/workspace',
    startedAt: '2026-07-06T00:00:00.000Z',
  };
  claimOwner(ownerPath, owner);
  assert.deepEqual(readOwner(ownerPath), owner);
  assert.equal(isCurrentOwner(ownerPath, 'owner-a'), true);
  assert.equal(isCurrentOwner(ownerPath, 'owner-b'), false);
});

test('new owner supersedes old owner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-owner-'));
  const ownerPath = path.join(dir, 'owner.json');
  claimOwner(ownerPath, { ownerId: 'old' });
  claimOwner(ownerPath, { ownerId: 'new' });
  assert.equal(isCurrentOwner(ownerPath, 'old'), false);
  assert.equal(isCurrentOwner(ownerPath, 'new'), true);
});

test('createOwner captures session identity', () => {
  const owner = createOwner({
    paths: { instance: 'codex01' },
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
