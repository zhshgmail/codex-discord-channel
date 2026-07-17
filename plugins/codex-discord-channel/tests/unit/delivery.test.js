'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createDelivery,
  escapeAttr,
  formatEnvelope,
  formatTtyPrompt,
  normalizeDiscordMessage,
  readLastInboundContext,
  resolveReplyTarget,
} = require('../../src/delivery');

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function framedPaste(text, submit = '') {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}${submit}`;
}

function discordMessage(messageId, content) {
  return {
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId,
    authorId: 'u1',
    authorName: 'Alice',
    content,
    attachments: [],
  };
}

test('escapeAttr escapes unsafe attribute characters', () => {
  assert.equal(escapeAttr('"x<&'), '&quot;x&lt;&amp;');
});

test('formatEnvelope includes Discord metadata and content', () => {
  const envelope = formatEnvelope({
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'hello',
    attachments: [],
  });
  assert.match(envelope, /source="discord"/);
  assert.match(envelope, /channel_id="c1"/);
  assert.match(envelope, /message_id="m1"/);
  assert.match(envelope, /hello/);
});

test('normalizeDiscordMessage maps message shape', () => {
  const normalized = normalizeDiscordMessage({
    guildId: 'g1',
    channelId: 'c1',
    id: 'm1',
    author: { id: 'u1', username: 'Alice', bot: false },
    content: 'hello',
    attachments: new Map([['a1', { id: 'a1', name: 'x.txt', url: 'https://example.test/x.txt' }]]),
  });
  assert.equal(normalized.source, 'guild');
  assert.equal(normalized.attachments.length, 1);
  assert.equal(normalized.attachments[0].name, 'x.txt');
});

test('normalizeDiscordMessage does not record replied author without a message reference', () => {
  const missingReference = normalizeDiscordMessage({
    channelId: 'c1',
    id: 'm2',
    author: { id: 'u1', username: 'Alice', bot: false },
    mentions: { repliedUser: { id: 'bot' } },
  });

  assert.equal(missingReference.repliedToAuthorId, '');
});

test('normalizeDiscordMessage fails closed when referenced reply author metadata is absent or null', () => {
  const missingRepliedUser = normalizeDiscordMessage({
    channelId: 'c1',
    id: 'm3',
    reference: { messageId: 'm0' },
    mentions: {},
  });
  const nullRepliedUser = normalizeDiscordMessage({
    channelId: 'c1',
    id: 'm4',
    reference: { messageId: 'm0' },
    mentions: { repliedUser: null },
  });

  assert.equal(missingRepliedUser.repliedToAuthorId, '');
  assert.equal(nullRepliedUser.repliedToAuthorId, '');
});

test('normalizeDiscordMessage uses resolved reference author and content', () => {
  const normalized = normalizeDiscordMessage({
    channelId: 'c1',
    id: 'm1',
    reference: { messageId: 'm0' },
    author: { id: 'u1', username: 'Alice', bot: false },
    mentions: { repliedUser: { id: 'stale-author' } },
  }, {
    author: { id: 'peer' },
    content: 'asking <@bot> and another agent',
  });

  assert.equal(normalized.repliedToAuthorId, 'peer');
  assert.equal(normalized.repliedToContent, 'asking <@bot> and another agent');
});

test('normalizeDiscordMessage ignores replied-user metadata without a resolved reference', () => {
  const normalized = normalizeDiscordMessage({
    channelId: 'c1',
    id: 'm1',
    reference: { messageId: 'm0' },
    mentions: { repliedUser: { id: 'bot' } },
  }, null);

  assert.equal(normalized.repliedToAuthorId, '');
  assert.equal(normalized.repliedToContent, '');
});

test('off delivery returns unsupported without pretending host push exists', async () => {
  const delivery = createDelivery({ deliveryMode: 'off' }, () => {});
  const result = await delivery.deliver({
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'hello',
    attachments: [],
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'delivery_disabled');
});

test('explicit verified flush atomically pastes and submits one queued Discord prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const writes = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'minimal',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  }, () => {}, {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  const queued = await delivery.deliver({
    channelId: 'c1',
    guildId: 'g1',
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: '<@bot> hello',
    attachments: [],
  });

  assert.equal(queued.status, 'queued');
  assert.equal(queued.reason, 'composer_readiness_unavailable');
  assert.equal(writes.length, 0);
  const result = await delivery.flush();
  assert.equal(result.status, 'delivered');
  assert.equal(result.reason, 'queue_flushed');
  assert.equal(result.tty, '/dev/pts/9');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].tty, '/dev/pts/9');
  assert.match(writes[0].text, /Discord message received/);
  assert.match(writes[0].text, /channelId: "c1"/);
  assert.match(writes[0].text, /replyTo: "m1"/);
  assert.match(writes[0].text, /codex-discord-channel' send --channel 'c1' --reply-to 'm1'/);
  assert.match(writes[0].text, /<@bot> hello/);
  assert.equal(writes[0].text.startsWith(BRACKETED_PASTE_START), true);
  assert.equal(writes[0].text.endsWith(`${BRACKETED_PASTE_END}\r`), true);
  assert.equal((writes[0].text.match(/\r/g) || []).length, 1);
});

test('configured auto-submit compatibility persists and atomically delivers during receive', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const writes = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    ttyAutoSubmitCompat: true,
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  }, () => {}, {
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  const result = await delivery.deliver(discordMessage('m-auto', 'deliver now'));

  assert.equal(result.status, 'delivered');
  assert.equal(result.reason, 'queue_flushed');
  assert.equal(result.deliveredCount, 1);
  assert.deepEqual(writes, [{
    tty: '/dev/pts/9',
    text: framedPaste('deliver now', '\r'),
  }]);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items, []);
  assert.deepEqual(persisted.completed.map((item) => item.messageId), ['m-auto']);
  assert.equal(persisted.blocked, null);
});

test('auto-submit compatibility persists the next inbound message while the head injector is stalled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const writes = [];
  let activeInjectors = 0;
  let maxActiveInjectors = 0;
  let firstInjectionStarted;
  let finishFirstInjection;
  const firstStarted = new Promise((resolve) => { firstInjectionStarted = resolve; });
  const firstPending = new Promise((resolve) => { finishFirstInjection = resolve; });
  const delivery = createDelivery({
    deliveryMode: 'tty',
    ttyAutoSubmitCompat: true,
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  }, () => {}, {
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      activeInjectors += 1;
      maxActiveInjectors = Math.max(maxActiveInjectors, activeInjectors);
      writes.push({ tty, text: data.toString('utf8') });
      if (writes.length === 1) {
        firstInjectionStarted();
        await firstPending;
      }
      activeInjectors -= 1;
    },
  });

  const first = delivery.deliver(discordMessage('m1', 'first'));
  await firstStarted;
  const second = delivery.deliver(discordMessage('m2', 'second'));
  const secondPersistedBeforeFirstFinished = await new Promise((resolve) => {
    let attempts = 0;
    const inspect = () => {
      const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      if (persisted.items.some((item) => item.normalized.messageId === 'm2')) {
        resolve(true);
        return;
      }
      attempts += 1;
      if (attempts >= 50) {
        resolve(false);
        return;
      }
      setTimeout(inspect, 1);
    };
    inspect();
  });
  finishFirstInjection();
  const results = await Promise.all([first, second]);

  assert.equal(secondPersistedBeforeFirstFinished, true);
  assert.deepEqual(results.map((result) => result.status), ['delivered', 'delivered']);
  assert.equal(maxActiveInjectors, 1);
  assert.deepEqual(writes.map((write) => write.text), [
    framedPaste('first', '\r'),
    framedPaste('second', '\r'),
  ]);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items, []);
  assert.deepEqual(persisted.completed.map((item) => item.messageId), ['m1', 'm2']);
});

test('auto-submit compatibility requires an effective submit sequence', async (t) => {
  for (const [name, override] of [
    ['tty submit disabled', { ttySubmit: false, ttySubmitSequence: 'cr' }],
    ['submit sequence none', { ttySubmit: true, ttySubmitSequence: 'none' }],
  ]) {
    await t.test(name, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
      const queuePath = path.join(dir, 'pending-delivery.json');
      let injectorCalls = 0;
      const delivery = createDelivery({
        deliveryMode: 'tty',
        ttyAutoSubmitCompat: true,
        tty: '/dev/pts/9',
        ttyPromptFormat: 'plain',
        ...override,
        paths: {
          stateDir: dir,
          lastInboundPath: path.join(dir, 'last-inbound.json'),
          deliveryQueuePath: queuePath,
        },
      }, () => {}, {
        ttyExists: () => true,
        runTtyInjector: async () => {
          injectorCalls += 1;
        },
      });

      const result = await delivery.deliver(discordMessage(`m-${name}`, 'must remain queued'));

      assert.equal(result.status, 'failed');
      assert.equal(result.reason, 'auto_submit_requires_submit_sequence');
      assert.equal(injectorCalls, 0);
      const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), [`m-${name}`]);
      assert.deepEqual(persisted.completed, []);
    });
  }
});

test('auto-submit compatibility blocks replay after an uncertain injection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  let injectorCalls = 0;
  const delivery = createDelivery({
    deliveryMode: 'tty',
    ttyAutoSubmitCompat: true,
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  }, () => {}, {
    ttyExists: () => true,
    runTtyInjector: async () => {
      injectorCalls += 1;
      throw new Error('injector acknowledgement lost');
    },
  });

  const first = await delivery.deliver(discordMessage('m1', 'first'));
  const second = await delivery.deliver(discordMessage('m2', 'second'));

  assert.equal(first.status, 'failed');
  assert.equal(first.reason, 'delivery_outcome_uncertain');
  assert.equal(second.status, 'failed');
  assert.equal(second.reason, 'delivery_outcome_uncertain');
  assert.equal(injectorCalls, 1);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1', 'm2']);
  assert.equal(persisted.blocked.reason, 'delivery_outcome_uncertain');
});

test('auto-submit compatibility preserves long Unicode and strips control framing bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const writes = [];
  const unicode = '\u6c49\u5b57\ud83d\ude42e\u0301'.repeat(400);
  const content = `${unicode}\x1b[201~\rafter`;
  const delivery = createDelivery({
    deliveryMode: 'tty',
    ttyAutoSubmitCompat: true,
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  }, () => {}, {
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  const result = await delivery.deliver(discordMessage('m-unicode-control', content));

  assert.equal(result.status, 'delivered');
  assert.deepEqual(writes, [{
    tty: '/dev/pts/9',
    text: framedPaste(`${unicode}[201~\nafter`, '\r'),
  }]);
});

test('tty delivery keeps a long Unicode prompt intact in one submitted paste frame', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const writes = [];
  const content = '\u6c49\u5b57\ud83d\ude42e\u0301'.repeat(400);
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  }, () => {}, {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm-unicode',
    authorId: 'u1',
    authorName: 'Alice',
    content,
    attachments: [],
  });
  const result = await delivery.flush();

  assert.equal(result.status, 'delivered');
  assert.deepEqual(writes, [{
    tty: '/dev/pts/9',
    text: framedPaste(content, '\r'),
  }]);
});

test('tty delivery cannot be terminated or submitted by control bytes in Discord text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const writes = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  }, () => {}, {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm-control',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'before\x1b[201~\rafter',
    attachments: [],
  });
  await delivery.flush();

  assert.deepEqual(writes, [{
    tty: '/dev/pts/9',
    text: framedPaste('before[201~\nafter', '\r'),
  }]);
});

test('tty delivery queues durably when composer readiness cannot be verified', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const writes = [];
  const logs = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  }, (...entry) => logs.push(entry), {
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  const result = await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'do not type into a popup',
    attachments: [],
  });

  assert.equal(result.status, 'queued');
  assert.equal(result.reason, 'composer_readiness_unavailable');
  assert.equal(result.queueDepth, 1);
  assert.equal(writes.length, 0);
  assert.equal(fs.statSync(queuePath).mode & 0o777, 0o600);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1']);
  assert.equal(persisted.blocked.reason, 'composer_readiness_unavailable');
  assert.equal(logs.some(([level]) => level === 'ERROR'), true);
});

test('tty delivery leaves messages queued while the TUI is busy or has draft text', async (t) => {
  for (const reason of ['composer_task_running', 'composer_has_draft']) {
    await t.test(reason, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
      const queuePath = path.join(dir, 'pending-delivery.json');
      const writes = [];
      const delivery = createDelivery({
        deliveryMode: 'tty',
        tty: '/dev/pts/9',
        paths: {
          stateDir: dir,
          lastInboundPath: path.join(dir, 'last-inbound.json'),
          deliveryQueuePath: queuePath,
        },
      }, () => {}, {
        getComposerReadiness: async () => ({ ready: false, reason }),
        ttyExists: () => true,
        runTtyInjector: async (tty, data) => {
          writes.push({ tty, text: data.toString('utf8') });
        },
      });

      await delivery.deliver({
        source: 'dm',
        channelId: 'c1',
        guildId: null,
        messageId: `m-${reason}`,
        authorId: 'u1',
        authorName: 'Alice',
        content: reason,
        attachments: [],
      });
      const result = await delivery.flush();

      assert.equal(result.status, 'queued');
      assert.equal(result.reason, reason);
      assert.deepEqual(writes, []);
      const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      assert.deepEqual(
        persisted.items.map((item) => item.normalized.messageId),
        [`m-${reason}`],
      );
      assert.equal(persisted.blocked.reason, reason);
    });
  }
});

test('receiver enqueue never waits for or invokes the composer readiness seam', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  let readinessCalls = 0;
  const delivery = createDelivery({
    deliveryMode: 'tty',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  }, () => {}, {
    getComposerReadiness: async () => {
      readinessCalls += 1;
      return new Promise(() => {});
    },
  });
  let timeout;

  const result = await Promise.race([
    delivery.deliver({
      source: 'dm',
      channelId: 'c1',
      guildId: null,
      messageId: 'm1',
      authorId: 'u1',
      authorName: 'Alice',
      content: 'persist without draining',
      attachments: [],
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('receiver enqueue waited for readiness')), 30);
    }),
  ]);
  clearTimeout(timeout);

  assert.equal(result.status, 'queued');
  assert.equal(result.reason, 'composer_readiness_unavailable');
  assert.equal(readinessCalls, 0);
});

test('a stalled explicit readiness check does not block receiver persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const config = {
    deliveryMode: 'tty',
    deliveryQueueLockTimeoutMs: 20,
    deliveryQueueLockRetryMs: 1,
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  };
  let readinessStarted;
  let finishReadiness;
  const started = new Promise((resolve) => { readinessStarted = resolve; });
  const readiness = new Promise((resolve) => { finishReadiness = resolve; });
  const delivery = createDelivery(config, () => {}, {
    getComposerReadiness: async () => {
      readinessStarted();
      return readiness;
    },
  });
  const message = (messageId) => ({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId,
    authorId: 'u1',
    authorName: 'Alice',
    content: messageId,
    attachments: [],
  });

  await delivery.deliver(message('m1'));
  const draining = delivery.flush();
  await started;
  const receiving = delivery.deliver(message('m2'));
  let admissionTimeout;
  const admission = await Promise.race([
    receiving.then((result) => ({ result })),
    new Promise((resolve) => {
      admissionTimeout = setTimeout(() => resolve({ timedOut: true }), 30);
    }),
  ]);
  finishReadiness({ ready: false, reason: 'composer_not_ready' });
  await Promise.all([draining, receiving]);
  clearTimeout(admissionTimeout);

  assert.equal(admission.timedOut, undefined);
  assert.equal(admission.result.status, 'queued');
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1', 'm2']);
});

test('a stalled explicit injector does not block receiver persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const config = {
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'none',
    deliveryQueueLockTimeoutMs: 20,
    deliveryQueueLockRetryMs: 1,
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  };
  let injectionStarted;
  let finishInjection;
  const started = new Promise((resolve) => { injectionStarted = resolve; });
  const injection = new Promise((resolve) => { finishInjection = resolve; });
  const drainer = createDelivery(config, () => {}, {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async () => {
      injectionStarted();
      return injection;
    },
  });
  const receiver = createDelivery(config, () => {});
  const message = (messageId) => ({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId,
    authorId: 'u1',
    authorName: 'Alice',
    content: messageId,
    attachments: [],
  });

  await drainer.deliver(message('m1'));
  const draining = drainer.flush();
  await started;
  const result = await receiver.deliver(message('m2'));
  const persistedWhileStalled = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  finishInjection();
  await draining;

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'delivery_outcome_uncertain');
  assert.deepEqual(
    persistedWhileStalled.items.map((item) => item.normalized.messageId),
    ['m1', 'm2'],
  );
});

test('concurrent explicit flushers claim a queue head only once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const writes = [];
  const config = {
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'none',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  };
  const deps = {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
  const first = createDelivery(config, () => {}, deps);
  const second = createDelivery(config, () => {}, deps);

  await first.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'once',
    attachments: [],
  });
  const results = await Promise.all([first.flush(), second.flush()]);

  assert.equal(writes.length, 1);
  assert.equal(results.filter((result) => result.status === 'delivered').length, 1);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items, []);
});

test('tty delivery deduplicates concurrent receiver instances by Discord message identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const config = {
    deliveryMode: 'tty',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  };
  const first = createDelivery(config, () => {});
  const second = createDelivery(config, () => {});
  const normalized = {
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'enqueue once',
    attachments: [],
  };

  const results = await Promise.all([
    first.deliver(normalized),
    second.deliver(normalized),
  ]);

  assert.deepEqual(results.map((result) => result.status), ['queued', 'queued']);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1']);
  assert.equal(fs.existsSync(`${queuePath}.lock`), false);
});

test('tty delivery reclaims an expired queue lock even when its pid was reused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const lockPath = `${queuePath}.lock`;
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    pid: 999999,
    token: 'abandoned',
    acquiredAt: '2026-07-13T00:00:00.000Z',
  }));
  const old = new Date(Date.now() - 1000);
  fs.utimesSync(lockPath, old, old);
  const delivery = createDelivery({
    deliveryMode: 'tty',
    deliveryQueueLockStaleMs: 5,
    deliveryQueueLockLiveLeaseMs: 10,
    deliveryQueueLockTimeoutMs: 30,
    deliveryQueueLockRetryMs: 1,
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  }, () => {}, {
    isProcessAlive: () => true,
  });

  const result = await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'survive pid reuse',
    attachments: [],
  });

  assert.equal(result.status, 'queued');
  assert.equal(fs.existsSync(lockPath), false);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1']);
});

test('tty delivery does not replay a completed Discord identity from another receiver', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const writes = [];
  const config = {
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'none',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  };
  const deps = {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  };
  const first = createDelivery(config, () => {}, deps);
  const second = createDelivery(config, () => {}, deps);
  const normalized = {
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'inject once',
    attachments: [],
  };

  const queued = await first.deliver(normalized);
  const delivered = await first.flush();
  const duplicate = await second.deliver(normalized);

  assert.equal(queued.status, 'queued');
  assert.equal(delivered.status, 'delivered');
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(writes.length, 1);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items, []);
  assert.deepEqual(
    persisted.completed.map((item) => [item.channelId, item.messageId]),
    [['c1', 'm1']],
  );
});

test('tty delivery fails loudly without injecting when queue persistence fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const invalidParent = path.join(dir, 'not-a-directory');
  fs.writeFileSync(invalidParent, 'occupied');
  const writes = [];
  const logs = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(invalidParent, 'pending-delivery.json'),
    },
  }, (...entry) => logs.push(entry), {
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  const result = await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'must not be injected',
    attachments: [],
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'delivery_queue_persist_failed');
  assert.equal(writes.length, 0);
  assert.equal(logs.some(([level, message]) => level === 'ERROR' && message.includes('persist')), true);
});

test('tty delivery rejects a positive readiness assertion without source evidence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const writes = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  }, () => {}, {
    getComposerReadiness: async () => ({ ready: true }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  const queued = await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'uncertain readiness must stay queued',
    attachments: [],
  });

  assert.equal(queued.status, 'queued');
  const result = await delivery.flush();
  assert.equal(result.status, 'queued');
  assert.equal(result.reason, 'composer_readiness_unverified');
  assert.equal(writes.length, 0);
});

test('tty delivery blocks the FIFO when an atomic injection outcome is uncertain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const logs = [];
  const writes = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  }, (...entry) => logs.push(entry), {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
      throw new Error('injector result lost');
    },
  });

  const queued = await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'retain me',
    attachments: [],
  });

  assert.equal(queued.status, 'queued');
  const result = await delivery.flush();
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'delivery_outcome_uncertain');
  assert.deepEqual(writes, [{
    tty: '/dev/pts/9',
    text: framedPaste('retain me', '\r'),
  }]);
  let persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1']);
  assert.equal(persisted.blocked.reason, 'delivery_outcome_uncertain');
  assert.equal(logs.some(([level]) => level === 'ERROR'), true);

  const retry = await delivery.flush();
  assert.equal(retry.status, 'failed');
  assert.equal(retry.reason, 'delivery_outcome_uncertain');
  assert.equal(writes.length, 1);

  const next = await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm2',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'queue behind uncertain head',
    attachments: [],
  });
  assert.equal(next.status, 'failed');
  assert.equal(next.reason, 'delivery_outcome_uncertain');
  assert.equal(writes.length, 1);
  persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1', 'm2']);
  assert.equal(persisted.blocked.reason, 'delivery_outcome_uncertain');
});

test('tty delivery does not retry after injection succeeds but queue commit fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const writes = [];
  let injectionCompleted = false;
  let rejectQueueCommit = true;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') {
        return (source, destination) => {
          if (rejectQueueCommit && injectionCompleted && destination === queuePath) {
            throw new Error('simulated queue commit failure');
          }
          return target.renameSync(source, destination);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'none',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  }, () => {}, {
    fs: fsImpl,
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
      injectionCompleted = true;
    },
  });

  const queued = await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'commit once',
    attachments: [],
  });

  assert.equal(queued.status, 'queued');
  const result = await delivery.flush();
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'delivery_outcome_uncertain');
  assert.equal(writes.length, 1);
  let persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1']);
  assert.equal(persisted.blocked.reason, 'delivery_in_progress');

  rejectQueueCommit = false;
  const retry = await delivery.flush();
  assert.equal(retry.status, 'failed');
  assert.equal(retry.reason, 'delivery_outcome_uncertain');
  assert.equal(writes.length, 1);
  persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items.map((item) => item.normalized.messageId), ['m1']);
  assert.equal(persisted.blocked.reason, 'delivery_outcome_uncertain');
});

test('tty delivery flushes the persistent queue FIFO only after verified readiness', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const writes = [];
  const config = {
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  };
  const blockedDelivery = createDelivery(config, () => {}, {
    getComposerReadiness: async () => ({ ready: false, reason: 'composer_popup_active' }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });
  const readyDelivery = createDelivery(config, () => {}, {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });
  const message = (messageId, content) => ({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId,
    authorId: 'u1',
    authorName: 'Alice',
    content,
    attachments: [],
  });

  await blockedDelivery.deliver(message('m1', 'first'));
  await blockedDelivery.deliver(message('m2', 'second'));
  assert.equal(writes.length, 0);

  const result = await readyDelivery.flush();

  assert.equal(result.status, 'delivered');
  assert.equal(result.reason, 'queue_flushed');
  assert.equal(result.deliveredCount, 2);
  assert.equal(result.queueDepth, 0);
  assert.deepEqual(writes.map((write) => write.text), [
    framedPaste('first', '\r'),
    framedPaste('second', '\r'),
  ]);
  assert.equal(writes.every((write) => (write.text.match(/\r/g) || []).length === 1), true);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items, []);
  assert.equal(persisted.blocked, null);
});

test('tty delivery serializes concurrent receiver calls without duplicate injection', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const queuePath = path.join(dir, 'pending-delivery.json');
  const writes = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'plain',
    ttySubmitSequence: 'cr',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: queuePath,
    },
  }, () => {}, {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      writes.push({ tty, text: data.toString('utf8') });
    },
  });
  const message = (messageId, content) => ({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId,
    authorId: 'u1',
    authorName: 'Alice',
    content,
    attachments: [],
  });

  const results = await Promise.all([
    delivery.deliver(message('m1', 'first')),
    delivery.deliver(message('m2', 'second')),
  ]);

  assert.deepEqual(results.map((result) => result.status), ['queued', 'queued']);
  assert.deepEqual(writes, []);
  const flushed = await delivery.flush();
  assert.equal(flushed.status, 'delivered');
  assert.equal(flushed.deliveredCount, 2);
  assert.deepEqual(writes.map((write) => write.text), [
    framedPaste('first', '\r'),
    framedPaste('second', '\r'),
  ]);
  const persisted = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.deepEqual(persisted.items, []);
});

test('display prompt shows only source, author, and content', () => {
  const prompt = formatTtyPrompt({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'hello',
    attachments: [],
  }, '<channel channel_id="c1">hello</channel>', { ttyPromptFormat: 'display' });

  assert.match(prompt, /Discord DM from Alice:/);
  assert.match(prompt, /hello/);
  assert.doesNotMatch(prompt, /channelId/);
  assert.doesNotMatch(prompt, /replyTo/);
  assert.doesNotMatch(prompt, /codex-discord-channel/);
  assert.doesNotMatch(prompt, /<channel/);
});

test('tty delivery persists last inbound reply context outside the terminal prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-delivery-'));
  const writes = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'display',
    ttySubmitSequence: 'none',
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
    },
  }, () => {}, {
    getComposerReadiness: async () => ({
      ready: true,
      source: 'test-host',
      evidence: 'composer-ready',
    }),
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  const queued = await delivery.deliver({
    source: 'dm',
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'hello',
    repliedToContent: 'private referenced audience text',
    attachments: [],
  });

  assert.equal(queued.status, 'queued');
  assert.equal(writes.length, 0);
  const result = await delivery.flush();
  assert.equal(result.status, 'delivered');
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0].text, /channelId/);
  const context = readLastInboundContext({
    paths: { lastInboundPath: path.join(dir, 'last-inbound.json') },
  });
  assert.equal(context.channelId, 'c1');
  assert.equal(context.messageId, 'm1');
  assert.equal(context.authorName, 'Alice');
  assert.equal(Object.hasOwn(context, 'repliedToContent'), false);
  assert.doesNotMatch(writes[0].text, /private referenced audience text/);
});

test('resolveReplyTarget defaults missing channel to last inbound context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-reply-'));
  const lastInboundPath = path.join(dir, 'last-inbound.json');
  fs.writeFileSync(lastInboundPath, JSON.stringify({
    channelId: 'c1',
    messageId: 'm1',
  }));

  assert.deepEqual(resolveReplyTarget({ channelId: '', replyTo: '' }, {
    paths: { lastInboundPath },
  }), {
    channelId: 'c1',
    replyTo: 'm1',
    usedLastInbound: true,
  });

  assert.deepEqual(resolveReplyTarget({ channelId: 'c2', replyTo: '' }, {
    paths: { lastInboundPath },
  }), {
    channelId: 'c2',
    replyTo: '',
    usedLastInbound: false,
  });
});
