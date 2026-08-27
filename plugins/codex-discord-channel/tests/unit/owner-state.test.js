'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { claimOwner, createOwner, isSameInstanceOwner, readOwner } = require('../../src/owner-state');

test('claimOwner writes readable owner file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-owner-'));
  const ownerPath = path.join(dir, 'owner.json');
  const owner = {
    version: 2,
    instance: 'codex01',
    instanceIdentity: {
      version: 1,
      fingerprint: `sha256:${'a'.repeat(64)}`,
    },
    pid: 100,
    hostname: 'host',
    cwd: '/workspace',
    startedAt: '2026-07-06T00:00:00.000Z',
  };
  claimOwner(ownerPath, owner);
  assert.deepEqual(readOwner(ownerPath), owner);
  assert.equal(isSameInstanceOwner(ownerPath, owner.instanceIdentity), true);
  assert.equal(isSameInstanceOwner(ownerPath, {
    version: 1,
    fingerprint: `sha256:${'b'.repeat(64)}`,
  }), false);
});

test('new process metadata preserves the same stable instance identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-owner-'));
  const ownerPath = path.join(dir, 'owner.json');
  const instanceIdentity = {
    version: 1,
    fingerprint: `sha256:${'c'.repeat(64)}`,
  };
  claimOwner(ownerPath, { instanceIdentity, pid: 100 });
  claimOwner(ownerPath, { instanceIdentity, pid: 200 });
  assert.equal(isSameInstanceOwner(ownerPath, instanceIdentity), true);
  assert.equal(readOwner(ownerPath).pid, 200);
});

test('createOwner captures stable instance identity without volatile Codex ids', () => {
  const instanceIdentity = {
    version: 1,
    fingerprint: `sha256:${'d'.repeat(64)}`,
  };
  const owner = createOwner({
    paths: { instance: 'codex01' },
    instanceIdentity,
    pid: 123,
    hostname: 'host',
    cwd: '/work',
    startedAt: 'now',
  });
  assert.equal(owner.instance, 'codex01');
  assert.deepEqual(owner.instanceIdentity, instanceIdentity);
  assert.equal(Object.hasOwn(owner, 'ownerId'), false);
  assert.equal(Object.hasOwn(owner, 'threadId'), false);
  assert.equal(Object.hasOwn(owner, 'sessionId'), false);
  assert.equal(owner.cwd, '/work');
});
