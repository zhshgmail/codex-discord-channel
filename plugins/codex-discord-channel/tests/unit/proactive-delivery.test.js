'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  sendDiscordReplyOnce,
  notificationReceiptPath,
  receiptPath,
} = require('../../src/reply-delivery');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-notification-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { paths: { stateDir: dir, replyReceiptDir: path.join(dir, 'reply-receipts') } };
}

function reportOptions(config, extra = {}) {
  return {
    config,
    args: { channelId: 'c1', notificationId: 'project-20261114T0949Z' },
    content: 'Measured result and next action',
    confirmer: async (_target, _prepared, sent) => sent,
    ...extra,
  };
}

test('proactive report durably claims a named notification before POST without inventing a reply source', async (t) => {
  const config = fixture(t);
  let posts = 0;
  const options = reportOptions(config, {
    sender: async (target, _prepared, identity) => {
      posts += 1;
      assert.equal(target.replyTo, '');
      assert.equal(identity.enforceNonce, true);
      const receipt = JSON.parse(fs.readFileSync(notificationReceiptPath(
        config, 'c1', options.args.notificationId,
      )));
      assert.equal(receipt.notificationId, options.args.notificationId);
      assert.equal(Object.hasOwn(receipt, 'sourceMessageId'), false);
      assert.equal(receipt.status, 'in_flight');
      assert.equal(receipt.nonce, identity.nonce);
      return { channelId: 'c1', messageId: 'out-1' };
    },
  });
  const first = await sendDiscordReplyOnce(options);
  assert.equal(first.notificationId, options.args.notificationId);
  assert.equal(Object.hasOwn(first, 'sourceMessageId'), false);
  const again = await sendDiscordReplyOnce({ ...options, content: 'Changed repeat' });
  assert.equal(again.duplicateSuppressed, true);
  assert.equal(again.messageId, 'out-1');
  assert.equal(posts, 1);
});

test('concurrent proactive reports share one claim and stay separate from reply receipts', async (t) => {
  const config = fixture(t);
  let posts = 0;
  const options = reportOptions(config, {
    sender: async () => {
      posts += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { channelId: 'c1', messageId: 'out-1' };
    },
  });
  const results = await Promise.all([
    sendDiscordReplyOnce(options), sendDiscordReplyOnce(options),
  ]);
  assert.equal(posts, 1);
  assert.equal(results.filter((r) => r.duplicateSuppressed).length, 1);
  assert.notEqual(notificationReceiptPath(config, 'c1', options.args.notificationId),
    receiptPath(config, 'c1', options.args.notificationId));
  assert.equal(fs.existsSync(receiptPath(config, 'c1', options.args.notificationId)), false);
});

test('proactive report requires exact readback and preserves uncertain delivery for reconciliation', async (t) => {
  const config = fixture(t);
  let posts = 0;
  const sender = async () => {
    posts += 1;
    return { channelId: 'c1', messageId: 'out-1' };
  };
  await assert.rejects(sendDiscordReplyOnce(reportOptions(config, {
    sender, confirmer: undefined,
  })), /exact readback/);
  assert.equal(posts, 0);
  await assert.rejects(sendDiscordReplyOnce(reportOptions(config, {
    sender, confirmer: async () => { throw new Error('readback unavailable'); },
  })), /readback unavailable/);
  const result = await sendDiscordReplyOnce(reportOptions(config, {
    sender,
    deps: { isProcessAlive: () => false },
    reconciler: async (target, _prepared, receipt) => {
      assert.equal(target.replyTo, '');
      assert.equal(receipt.outboundMessageId, 'out-1');
      assert.equal(receipt.notificationId, 'project-20261114T0949Z');
      return { found: true, channelId: 'c1', messageId: 'out-1' };
    },
  }));
  assert.equal(result.reconciled, true);
  assert.equal(posts, 1);
});

test('expired uncertain proactive POST never retries outside the original nonce window', async (t) => {
  const config = fixture(t);
  let now = 100000;
  let posts = 0;
  const options = reportOptions(config, {
    sender: async () => { posts += 1; throw new Error('POST response lost'); },
    deps: { now: () => now, isProcessAlive: () => false },
  });
  await assert.rejects(sendDiscordReplyOnce(options), /POST response lost/);
  now += 120000;
  const result = await sendDiscordReplyOnce({
    ...options, reconciler: async () => ({ found: false }),
  });
  assert.equal(result.duplicateSuppressed, true);
  assert.equal(result.receiptStatus, 'uncertain');
  assert.equal(posts, 1);
});

test('notification identity cannot weaken required replies or mix with bypass/fake-parent modes', async (t) => {
  const config = fixture(t);
  const bad = [
    { channelId: 'c1' },
    { channelId: 'c1', notificationId: '' },
    { channelId: 'c1', notificationId: '../unsafe' },
    { channelId: 'c1', notificationId: 'id', replyTo: 'm1' },
    { channelId: 'c1', notificationId: 'id', followup: true },
    { notificationId: 'id' },
  ];
  for (const args of bad) {
    await assert.rejects(sendDiscordReplyOnce(reportOptions(config, {
      args, sender: async () => { assert.fail('must reject before POST'); },
    })));
  }
});
