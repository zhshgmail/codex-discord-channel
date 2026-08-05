'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  beginReply,
  sendDiscordReplyOnce: sendDiscordReplyOnceRaw,
} = require('../../src/reply-delivery');

const confirmSent = async (_target, _prepared, sent) => sent;

function sendDiscordReplyOnce(options) {
  if (options.args?.followup === true || Object.hasOwn(options, 'confirmer')) {
    return sendDiscordReplyOnceRaw(options);
  }
  return sendDiscordReplyOnceRaw({ ...options, confirmer: confirmSent });
}

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

function runWorker(mode, stateDir, markerPath) {
  const worker = path.join(__dirname, '..', 'fixtures', 'reply-receipt-worker.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, mode, stateDir, markerPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
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
    args: { channelId: 'c1', replyTo: 'm1', followup: true },
    config,
    content: 'explicit followup',
    sender,
  });

  assert.equal(followup.duplicateSuppressed, false);
  assert.equal(followup.sourceMessageId, null);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].replyTo, 'm1');
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

test('an unreadable durable receipt fails closed instead of being overwritten', async () => {
  const { config } = fixture();
  const claimed = await beginReply(config, {
    channelId: 'c1', sourceMessageId: 'm1',
  }, 'answer');
  fs.writeFileSync(claimed.file, '{not-json');
  let sendCount = 0;

  const result = await sendDiscordReplyOnce({
    args: sourceArgs(),
    config,
    content: 'answer',
    sender: async () => { sendCount += 1; },
  });

  assert.equal(sendCount, 0);
  assert.equal(result.duplicateSuppressed, true);
  assert.equal(result.reason, 'source_message_reply_receipt_unreadable');
  assert.equal(fs.readFileSync(claimed.file, 'utf8'), '{not-json');
});

test('foreign receipt channel source and nonce identities fail closed before network', async () => {
  for (const mutation of [
    ['channelId', 'foreign-channel'],
    ['sourceMessageId', 'foreign-source'],
    ['nonce', 'foreign-nonce'],
  ]) {
    const { config } = fixture();
    const claimed = await beginReply(config, {
      channelId: 'c1', sourceMessageId: 'm1',
    }, 'answer');
    const receipt = JSON.parse(fs.readFileSync(claimed.file, 'utf8'));
    receipt[mutation[0]] = mutation[1];
    fs.writeFileSync(claimed.file, `${JSON.stringify(receipt)}\n`);
    let networkCount = 0;

    const result = await sendDiscordReplyOnceRaw({
      args: sourceArgs(),
      config,
      content: 'answer',
      preflight: async () => { networkCount += 1; },
      sender: async () => { networkCount += 1; },
      confirmer: confirmSent,
    });

    assert.equal(networkCount, 0, mutation[0]);
    assert.equal(result.duplicateSuppressed, true, mutation[0]);
    assert.equal(result.reason, 'source_message_reply_receipt_identity_mismatch', mutation[0]);
  }
});

test('a guarded send without a confirmer cannot send or become confirmed', async () => {
  const { config } = fixture();
  let sendCount = 0;

  await assert.rejects(sendDiscordReplyOnceRaw({
    args: sourceArgs(),
    config,
    content: 'answer',
    sender: async () => {
      sendCount += 1;
      return { channelId: 'c1', messageId: 'must-not-send' };
    },
  }), /require exact readback confirmation/);

  const retry = await sendDiscordReplyOnceRaw({
    args: sourceArgs(),
    config,
    content: 'answer',
    sender: async () => {
      sendCount += 1;
      return { channelId: 'c1', messageId: 'confirmed-after-retry' };
    },
    confirmer: confirmSent,
  });

  assert.equal(sendCount, 1);
  assert.equal(retry.messageId, 'confirmed-after-retry');
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
    content: 'answer',
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
    content: 'answer',
    sender: async () => {
      sendCount += 1;
      return { channelId: 'c1', messageId: 'out-retry' };
    },
  });

  assert.equal(sendCount, 1);
  assert.equal(retry.duplicateSuppressed, true);
  assert.equal(retry.reason, 'source_message_reply_uncertain');
  assert.equal(retry.receiptStatus, 'uncertain');
});

test('a failed network send can reconcile absence and retry the same source identity once', async () => {
  const { config } = fixture();
  const remoteMessages = [];
  let sendCount = 0;
  const common = {
    args: sourceArgs(),
    config,
    content: 'same answer',
    preflight: async (_target, identity) => ({ identity }),
    reconciler: async (_target, prepared) => ({
      found: false,
      nonce: prepared.identity.nonce,
    }),
    confirmer: async (_target, _prepared, sent) => ({
      channelId: sent.channelId,
      messageId: sent.messageId,
    }),
  };

  await assert.rejects(
    sendDiscordReplyOnce({
      ...common,
      sender: async () => {
        sendCount += 1;
        throw new Error('fetch failed');
      },
    }),
    /fetch failed/,
  );
  assert.deepEqual(remoteMessages, []);

  const retry = await sendDiscordReplyOnce({
    ...common,
    sender: async (_target, prepared) => {
      sendCount += 1;
      remoteMessages.push(prepared.identity.nonce);
      return { channelId: 'c1', messageId: 'out-retry' };
    },
  });
  const duplicate = await sendDiscordReplyOnce({
    ...common,
    sender: async () => {
      throw new Error('confirmed replies must not send again');
    },
  });

  assert.equal(sendCount, 2);
  assert.equal(retry.duplicateSuppressed, false);
  assert.equal(retry.messageId, 'out-retry');
  assert.equal(remoteMessages.length, 1);
  assert.equal(duplicate.duplicateSuppressed, true);
  assert.equal(duplicate.reason, 'source_message_already_replied');
});

test('an uncertain acknowledgement reconciles the stable nonce without a second send', async () => {
  const { config } = fixture();
  let nonce = '';
  let sendCount = 0;
  const common = {
    args: sourceArgs(),
    config,
    content: 'same answer',
    preflight: async (_target, identity) => {
      nonce = identity.nonce;
      return { identity };
    },
    confirmer: async (_target, _prepared, sent) => sent,
  };
  await assert.rejects(sendDiscordReplyOnce({
    ...common,
    sender: async () => {
      sendCount += 1;
      throw new Error('response lost after Discord accepted the message');
    },
  }));

  const retry = await sendDiscordReplyOnce({
    ...common,
    reconciler: async (_target, _prepared, receipt) => ({
      found: receipt.nonce === nonce,
      channelId: 'c1',
      messageId: 'existing-message',
    }),
    sender: async () => {
      sendCount += 1;
      throw new Error('reconciliation must not resend');
    },
  });

  assert.equal(sendCount, 1);
  assert.equal(retry.reconciled, true);
  assert.equal(retry.messageId, 'existing-message');
});

test('a returned message id stays fail closed when exact readback cannot be reconciled', async () => {
  const { config } = fixture();
  let sendCount = 0;
  const common = {
    args: sourceArgs(),
    config,
    content: 'answer',
    sender: async () => {
      sendCount += 1;
      return { channelId: 'c1', messageId: 'discord-id' };
    },
  };
  await assert.rejects(sendDiscordReplyOnce({
    ...common,
    confirmer: async () => { throw new Error('readback unavailable'); },
  }), /readback unavailable/);

  const retry = await sendDiscordReplyOnce({
    ...common,
    reconciler: async (_target, _prepared, receipt) => {
      assert.equal(receipt.outboundMessageId, 'discord-id');
      return { found: false };
    },
  });

  assert.equal(sendCount, 1);
  assert.equal(retry.duplicateSuppressed, true);
  assert.equal(retry.reason, 'source_message_reply_uncertain');
});

test('a restart confirms a returned message id by exact identity without resending', async () => {
  const { config } = fixture();
  let sendCount = 0;
  const common = {
    args: sourceArgs(),
    config,
    content: 'answer',
    sender: async () => {
      sendCount += 1;
      return { channelId: 'c1', messageId: 'discord-id' };
    },
  };
  await assert.rejects(sendDiscordReplyOnce({
    ...common,
    confirmer: async () => { throw new Error('process stopped before readback'); },
  }));

  const recovered = await sendDiscordReplyOnce({
    ...common,
    reconciler: async (_target, _prepared, receipt) => ({
      found: receipt.outboundMessageId === 'discord-id',
      channelId: 'c1',
      messageId: 'discord-id',
    }),
  });

  assert.equal(sendCount, 1);
  assert.equal(recovered.reconciled, true);
  assert.equal(recovered.messageId, 'discord-id');
});

test('a stale uncertain receipt remains fail closed outside the nonce replay window', async () => {
  const { config } = fixture();
  let sendCount = 0;
  await assert.rejects(sendDiscordReplyOnce({
    args: sourceArgs(),
    config,
    content: 'answer',
    sender: async () => {
      sendCount += 1;
      throw new Error('uncertain');
    },
    deps: { now: () => 1_000 },
  }));

  const retry = await sendDiscordReplyOnce({
    args: sourceArgs(),
    config,
    content: 'answer',
    reconciler: async () => ({ found: false }),
    sender: async () => {
      sendCount += 1;
      return { channelId: 'c1', messageId: 'must-not-send' };
    },
    deps: { now: () => 120_000 },
  });

  assert.equal(sendCount, 1);
  assert.equal(retry.duplicateSuppressed, true);
  assert.equal(retry.reason, 'source_message_reply_uncertain');
});

test('a restart reclaims an abandoned in-flight receipt and retries with the same nonce', async () => {
  const { config } = fixture();
  const original = await beginReply(config, {
    channelId: 'c1',
    sourceMessageId: 'm1',
  }, 'answer', {
    pid: 111,
    now: () => 10_000,
    randomUUID: () => 'operation-before-crash',
  });
  assert.equal(original.mode, 'send');

  let sendCount = 0;
  const recovered = await sendDiscordReplyOnce({
    args: sourceArgs(),
    config,
    content: 'answer',
    preflight: async (_target, identity) => ({ identity }),
    reconciler: async () => ({ found: false }),
    sender: async (_target, prepared) => {
      sendCount += 1;
      assert.equal(prepared.identity.nonce, original.receipt.nonce);
      return { channelId: 'c1', messageId: 'after-restart' };
    },
    confirmer: async (_target, _prepared, sent) => sent,
    deps: {
      pid: 222,
      now: () => 11_000,
      isProcessAlive: () => false,
      randomUUID: () => 'operation-after-crash',
    },
  });

  assert.equal(sendCount, 1);
  assert.equal(recovered.messageId, 'after-restart');
  assert.equal(recovered.duplicateSuppressed, false);
});

test('two processes sharing the receipt directory perform only one network send', async () => {
  const { dir } = fixture();
  const markerPath = path.join(dir, 'network-sends.log');
  const results = await Promise.all([
    runWorker('send', dir, markerPath),
    runWorker('send', dir, markerPath),
  ]);

  assert.deepEqual(results.map((item) => item.code), [0, 0], results.map((item) => item.stderr).join('\n'));
  const markers = fs.readFileSync(markerPath, 'utf8').trim().split('\n');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].startsWith('send:cdr-'), true);
  const outputs = results.map((item) => JSON.parse(item.stdout));
  assert.equal(outputs.filter((item) => item.duplicateSuppressed).length, 1);
  assert.equal(outputs.filter((item) => !item.duplicateSuppressed).length, 1);
});

test('a new process recovers crashes before and after the network send without duplicating', async () => {
  for (const crashMode of ['crash-before-send', 'crash-after-remote']) {
    const { dir } = fixture();
    const markerPath = path.join(dir, `${crashMode}.log`);
    const crashed = await runWorker(crashMode, dir, markerPath);
    assert.equal(crashed.code, crashMode === 'crash-before-send' ? 73 : 74);

    const recovered = await runWorker('send', dir, markerPath);
    assert.equal(recovered.code, 0, recovered.stderr);
    const output = JSON.parse(recovered.stdout);
    const markers = fs.existsSync(markerPath)
      ? fs.readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    if (crashMode === 'crash-before-send') {
      assert.equal(output.reconciled, false);
      assert.equal(markers.filter((line) => line.startsWith('send:')).length, 1);
    } else {
      assert.equal(output.reconciled, true);
      assert.equal(markers.filter((line) => line.startsWith('remote:')).length, 1);
      assert.equal(markers.filter((line) => line.startsWith('send:')).length, 0);
    }
  }
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
  assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.channelId, 'c1');
  assert.equal(receipt.sourceMessageId, 'm1');
  assert.equal(receipt.outboundMessageId, 'out-1');
});
