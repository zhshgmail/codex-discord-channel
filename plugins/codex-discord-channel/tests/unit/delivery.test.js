'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDelivery, escapeAttr, formatEnvelope, normalizeDiscordMessage } = require('../../src/delivery');

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
