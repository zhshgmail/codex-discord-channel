'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sendDiscordReplyOnce } = require('../../src/reply-delivery');

function fixture(messageId = 'm1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-reply-once-'));
  fs.writeFileSync(path.join(dir, 'last-inbound.json'), JSON.stringify({
    channelId: 'c1',
    messageId,
  }));
  return {
    dir,
    config: {
      paths: {
        stateDir: dir,
        lastInboundPath: path.join(dir, 'last-inbound.json'),
        replyReceiptDir: path.join(dir, 'reply-receipts'),
      },
    },
  };
}

test('one source Discord message produces at most one default reply', async () => {
  const { config } = fixture();
  const sends = [];
  const sender = async (target) => {
    sends.push(target);
    return { channelId: target.channelId, messageId: `out-${sends.length}` };
  };

  const first = await sendDiscordReplyOnce({
    args: { channelId: 'c1' },
    config,
    content: 'first answer',
    sender,
  });
  const second = await sendDiscordReplyOnce({
    args: { channelId: 'c1' },
    config,
    content: 'automatic continuation repeats the answer',
    sender,
  });

  assert.equal(first.duplicateSuppressed, false);
  assert.equal(first.sourceMessageId, 'm1');
  assert.equal(second.duplicateSuppressed, true);
  assert.equal(second.reason, 'source_message_already_replied');
  assert.equal(second.messageId, 'out-1');
  assert.deepEqual(sends, [{ channelId: 'c1', replyTo: 'm1', usedLastInbound: false }]);
});

test('concurrent replies to one source acquire one durable claim', async () => {
  const { config } = fixture();
  let sendCount = 0;
  const sender = async (target) => {
    sendCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { channelId: target.channelId, messageId: 'out-only' };
  };

  const results = await Promise.all([
    sendDiscordReplyOnce({ args: {}, config, content: 'one', sender }),
    sendDiscordReplyOnce({ args: {}, config, content: 'two', sender }),
  ]);

  assert.equal(sendCount, 1);
  assert.equal(results.filter((item) => item.duplicateSuppressed).length, 1);
  assert.equal(results.filter((item) => !item.duplicateSuppressed).length, 1);
});

test('explicit followup bypasses the one-reply guard', async () => {
  const { config } = fixture();
  const sends = [];
  const sender = async (target) => {
    sends.push(target);
    return { channelId: target.channelId, messageId: `out-${sends.length}` };
  };

  await sendDiscordReplyOnce({ args: {}, config, content: 'answer', sender });
  const followup = await sendDiscordReplyOnce({
    args: { channelId: 'c1', followup: true },
    config,
    content: 'explicit followup',
    sender,
  });

  assert.equal(followup.duplicateSuppressed, false);
  assert.equal(followup.sourceMessageId, null);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].replyTo, '');
});

test('a newer inbound source gets an independent reply receipt', async () => {
  const { config, dir } = fixture('m1');
  const sends = [];
  const sender = async (target) => {
    sends.push(target);
    return { channelId: target.channelId, messageId: `out-${sends.length}` };
  };

  await sendDiscordReplyOnce({ args: {}, config, content: 'answer one', sender });
  fs.writeFileSync(path.join(dir, 'last-inbound.json'), JSON.stringify({
    channelId: 'c1',
    messageId: 'm2',
  }));
  const second = await sendDiscordReplyOnce({ args: {}, config, content: 'answer two', sender });

  assert.equal(second.duplicateSuppressed, false);
  assert.equal(second.sourceMessageId, 'm2');
  assert.equal(sends.length, 2);
});

test('an uncertain first send fails closed instead of replaying', async () => {
  const { config } = fixture();
  let sendCount = 0;
  await assert.rejects(
    sendDiscordReplyOnce({
      args: {},
      config,
      content: 'answer',
      sender: async () => {
        sendCount += 1;
        throw new Error('transport closed after request');
      },
    }),
    /transport closed/,
  );

  const retry = await sendDiscordReplyOnce({
    args: {},
    config,
    content: 'retry',
    sender: async () => {
      sendCount += 1;
      return { channelId: 'c1', messageId: 'out-retry' };
    },
  });

  assert.equal(sendCount, 1);
  assert.equal(retry.duplicateSuppressed, true);
  assert.equal(retry.reason, 'source_message_reply_in_progress_or_uncertain');
  assert.equal(retry.receiptStatus, 'uncertain');
});
