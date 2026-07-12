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

test('tty delivery injects Discord prompt into the session terminal', async () => {
  const writes = [];
  const delivery = createDelivery({
    deliveryMode: 'tty',
    tty: '/dev/pts/9',
    ttyPromptFormat: 'minimal',
    ttySubmitSequence: 'cr',
    ttySubmitDelayMs: 0,
  }, () => {}, {
    ttyExists: () => true,
    runTtyInjector: async (tty, data) => {
      writes.push({ tty, text: data.toString('utf8') });
    },
  });

  const result = await delivery.deliver({
    channelId: 'c1',
    guildId: 'g1',
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: '<@bot> hello',
    attachments: [],
  });

  assert.equal(result.status, 'delivered');
  assert.equal(result.reason, 'tty_injected');
  assert.equal(result.tty, '/dev/pts/9');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].tty, '/dev/pts/9');
  assert.match(writes[0].text, /Discord message received/);
  assert.match(writes[0].text, /channelId: "c1"/);
  assert.match(writes[0].text, /replyTo: "m1"/);
  assert.match(writes[0].text, /codex-discord-channel' send --channel 'c1' --reply-to 'm1'/);
  assert.match(writes[0].text, /<@bot> hello/);
  assert.equal(writes[1].text, '\r');
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
    content: 'hello',
    repliedToContent: 'private referenced audience text',
    attachments: [],
  });

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
