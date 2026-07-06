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

test('delivery returns unsupported instead of pretending host push exists', () => {
  const delivery = createDelivery({}, () => {});
  const result = delivery.deliver({
    channelId: 'c1',
    guildId: null,
    messageId: 'm1',
    authorId: 'u1',
    authorName: 'Alice',
    content: 'hello',
    attachments: [],
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'codex_channel_api_unavailable');
});
