'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sendDiscordReplyOnce } = require('../../src/reply-delivery');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-reply-once-'));
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

function sourceArgs(messageId = 'm1') {
  return { channelId: 'c1', replyTo: messageId };
}

test('one exact source Discord message produces at most one guarded reply', async () => {
  const { config } = fixture();
  const sends = [];
  const sender = async (target) => {
    sends.push(target);
    return { channelId: target.channelId, messageId: `out-${sends.length}` };
  };

  const first = await sendDiscordReplyOnce({
    args: sourceArgs(),
    config,
    content: 'first answer',
    sender,
  });
  const second = await sendDiscordReplyOnce({
    args: sourceArgs(),
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

test('concurrent replies to one exact source acquire one durable claim', async () => {
  const { config } = fixture();
  let sendCount = 0;
  const sender = async (target) => {
    sendCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { channelId: target.channelId, messageId: 'out-only' };
  };

  const results = await Promise.all([
    sendDiscordReplyOnce({ args: sourceArgs(), config, content: 'one', sender }),
    sendDiscordReplyOnce({ args: sourceArgs(), config, content: 'two', sender }),
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

  await sendDiscordReplyOnce({ args: sourceArgs(), config, content: 'answer', sender });
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

test('a newer exact inbound source gets an independent reply receipt', async () => {
  const { config } = fixture();
  const sends = [];
  const sender = async (target) => {
    sends.push(target);
    return { channelId: target.channelId, messageId: `out-${sends.length}` };
  };

  await sendDiscordReplyOnce({ args: sourceArgs('m1'), config, content: 'answer one', sender });
  const second = await sendDiscordReplyOnce({
    args: sourceArgs('m2'),
    config,
    content: 'answer two',
    sender,
  });

  assert.equal(second.duplicateSuppressed, false);
  assert.equal(second.sourceMessageId, 'm2');
  assert.equal(sends.length, 2);
});

test('mutable last-inbound context cannot rebind a stale continuation', async () => {
  const { config, dir } = fixture();
  const sends = [];
  const sender = async (target) => {
    sends.push(target);
    return { channelId: target.channelId, messageId: `out-${sends.length}` };
  };

  await sendDiscordReplyOnce({ args: sourceArgs('m1'), config, content: 'answer one', sender });
  fs.writeFileSync(path.join(dir, 'last-inbound.json'), '{"channelId":"c1","messageId":"m2"}\n');
  const stale = await sendDiscordReplyOnce({
    args: sourceArgs('m1'),
    config,
    content: 'stale continuation',
    sender,
  });
  const current = await sendDiscordReplyOnce({
    args: sourceArgs('m2'),
    config,
    content: 'answer two',
    sender,
  });

  assert.equal(stale.duplicateSuppressed, true);
  assert.equal(stale.sourceMessageId, 'm1');
  assert.equal(current.duplicateSuppressed, false);
  assert.equal(current.sourceMessageId, 'm2');
  assert.equal(sends.length, 2);
});

test('guarded replies require exact channel and source identities', async () => {
  const { config, dir } = fixture();
  fs.writeFileSync(path.join(dir, 'last-inbound.json'), '{not-json');
  let sendCount = 0;
  const sender = async () => {
    sendCount += 1;
    return { channelId: 'c1', messageId: 'out' };
  };

  await assert.rejects(
    sendDiscordReplyOnce({ args: { channelId: 'c1' }, config, content: 'answer', sender }),
    /channelId and replyTo are required/,
  );
  await assert.rejects(
    sendDiscordReplyOnce({ args: { replyTo: 'm1' }, config, content: 'answer', sender }),
    /channelId and replyTo are required/,
  );
  assert.equal(sendCount, 0);
  assert.equal(fs.existsSync(path.join(dir, 'reply-receipts')), false);
});

test('preflight failure does not consume the source reply', async () => {
  const { config } = fixture();
  let sendCount = 0;
  await assert.rejects(
    sendDiscordReplyOnce({
      args: sourceArgs(),
      config,
      content: 'answer',
      preflight: async () => {
        throw new Error('content is required');
      },
      sender: async () => {
        sendCount += 1;
      },
    }),
    /content is required/,
  );

  const retry = await sendDiscordReplyOnce({
    args: sourceArgs(),
    config,
    content: 'answer',
    preflight: async () => ({ prepared: true }),
    sender: async (target, prepared) => {
      sendCount += 1;
      assert.deepEqual(prepared, { prepared: true });
      return { channelId: target.channelId, messageId: 'out-retry' };
    },
  });

  assert.equal(sendCount, 1);
  assert.equal(retry.duplicateSuppressed, false);
});

test('a definitive no-send failure releases its durable claim', async () => {
  const { config } = fixture();
  let sendCount = 0;
  await assert.rejects(
    sendDiscordReplyOnce({
      args: sourceArgs(),
      config,
      content: 'answer',
      sender: async () => {
        sendCount += 1;
        const error = new Error('Discord rejected request');
        error.definitiveNoSend = true;
        throw error;
      },
    }),
    /Discord rejected request/,
  );

  const retry = await sendDiscordReplyOnce({
    args: sourceArgs(),
    config,
    content: 'retry',
    sender: async () => {
      sendCount += 1;
      return { channelId: 'c1', messageId: 'out-retry' };
    },
  });

  assert.equal(sendCount, 2);
  assert.equal(retry.duplicateSuppressed, false);
});

test('an uncertain first send fails closed instead of replaying', async () => {
  const { config } = fixture();
  let sendCount = 0;
  await assert.rejects(
    sendDiscordReplyOnce({
      args: sourceArgs(),
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
    args: sourceArgs(),
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

test('reply receipt is private and records the exact source identity', async () => {
  const { config } = fixture();
  await sendDiscordReplyOnce({
    args: sourceArgs(),
    config,
    content: 'answer',
    sender: async () => ({ channelId: 'c1', messageId: 'out-1' }),
  });

  const files = fs.readdirSync(config.paths.replyReceiptDir);
  assert.equal(files.length, 1);
  const file = path.join(config.paths.replyReceiptDir, files[0]);
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.channelId, 'c1');
  assert.equal(receipt.sourceMessageId, 'm1');
  assert.equal(receipt.outboundMessageId, 'out-1');
});
