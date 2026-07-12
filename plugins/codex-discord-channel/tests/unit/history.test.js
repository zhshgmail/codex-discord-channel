'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readDiscordHistory,
  validateHistoryArgs,
} = require('../../src/history');

const CHANNEL_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const USER_ID = '300000000000000001';
const BOT_ID = '900000000000000001';

function message(id, overrides = {}) {
  return {
    id,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    createdTimestamp: Number(id.slice(-6)),
    author: { id: USER_ID, username: 'Alice', bot: false },
    content: `message ${id}`,
    attachments: new Map(),
    ...overrides,
  };
}

function historyFixture({ access = {}, messages = [], channel = {}, fetchError = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-history-'));
  const accessPath = path.join(dir, 'access.json');
  fs.writeFileSync(accessPath, JSON.stringify({
    version: 1,
    groups: { [CHANNEL_ID]: { requireMention: true } },
    ...access,
  }));
  const calls = [];
  const target = {
    id: CHANNEL_ID,
    guildId: GUILD_ID,
    type: 0,
    name: 'general',
    messages: {
      async fetch(options) {
        calls.push(options);
        if (fetchError) throw fetchError;
        return new Map(messages.map((item) => [item.id, item]));
      },
    },
    ...channel,
  };
  const client = {
    user: { id: BOT_ID },
    channels: {
      async fetch(channelId) {
        calls.push({ channelId });
        return target;
      },
    },
  };

  return {
    calls,
    client,
    config: { botUserId: BOT_ID, paths: { accessPath } },
  };
}

test('validateHistoryArgs accepts own snowflake properties and applies defaults', () => {
  assert.deepEqual(validateHistoryArgs({}), { channelId: '', before: '', limit: 20 });
  assert.deepEqual(validateHistoryArgs({
    channelId: CHANNEL_ID,
    before: '400000000000000001',
    limit: 25,
  }), {
    channelId: CHANNEL_ID,
    before: '400000000000000001',
    limit: 25,
  });

  const inherited = Object.create({ channelId: CHANNEL_ID, before: '400000000000000001', limit: 25 });
  assert.deepEqual(validateHistoryArgs(inherited), { channelId: '', before: '', limit: 20 });
});

test('validateHistoryArgs rejects invalid snowflakes, limits, and unknown own properties', () => {
  for (const args of [
    null,
    [],
    { channelId: 'not-a-snowflake' },
    { channelId: '99999999999999999999' },
    { before: '1234' },
    { limit: 0 },
    { limit: 26 },
    { limit: 1.5 },
    { extra: true },
  ]) {
    assert.throws(() => validateHistoryArgs(args), /invalid_history_args/);
  }
});

test('readDiscordHistory performs one limit-plus-one fetch and returns a newest-first cursor', async () => {
  const messages = [
    message('500000000000000004'),
    message('500000000000000003'),
    message('500000000000000002'),
  ];
  const fixture = historyFixture({ messages });

  const result = await readDiscordHistory({
    args: { channelId: CHANNEL_ID, before: '500000000000000005', limit: 2 },
    config: fixture.config,
    client: fixture.client,
  });

  assert.deepEqual(fixture.calls, [
    { channelId: CHANNEL_ID },
    { limit: 3, before: '500000000000000005' },
  ]);
  assert.deepEqual(result.messages.map((item) => item.messageId), [
    '500000000000000004',
    '500000000000000003',
  ]);
  assert.equal(result.channelId, CHANNEL_ID);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextBefore, '500000000000000003');
});

test('readDiscordHistory filters guild senders and bots but includes the active bot', async () => {
  const fixture = historyFixture({
    access: {
      groups: {
        [CHANNEL_ID]: {
          requireMention: true,
          allowFrom: [USER_ID],
          allowBots: false,
        },
      },
    },
    messages: [
      message('500000000000000004', { author: { id: BOT_ID, username: 'ActiveBot', bot: true } }),
      message('500000000000000003', { author: { id: '800000000000000001', username: 'OtherBot', bot: true } }),
      message('500000000000000002', { author: { id: '300000000000000002', username: 'Mallory', bot: false } }),
      message('500000000000000001', { content: 'allowed without a mention' }),
    ],
  });

  const result = await readDiscordHistory({
    args: { channelId: CHANNEL_ID, limit: 4 },
    config: fixture.config,
    client: fixture.client,
  });

  assert.deepEqual(result.messages.map((item) => item.authorId), [BOT_ID, USER_ID]);
});

test('readDiscordHistory resolves only same-channel references present in the fetched page', async () => {
  const referenced = message('500000000000000001');
  const sameChannelReply = message('500000000000000003', {
    reference: { channelId: CHANNEL_ID, messageId: referenced.id },
  });
  const crossChannelReply = message('500000000000000002', {
    reference: { channelId: '100000000000000099', messageId: referenced.id },
  });
  const fixture = historyFixture({ messages: [sameChannelReply, crossChannelReply, referenced] });

  const result = await readDiscordHistory({
    args: { channelId: CHANNEL_ID, limit: 3 },
    config: fixture.config,
    client: fixture.client,
  });

  assert.deepEqual(result.messages[0].replyTo, {
    messageId: referenced.id,
    authorId: USER_ID,
    authorName: 'Alice',
  });
  assert.equal(result.messages[1].replyTo, null);
});

test('readDiscordHistory hides a reply reference authored by a denied sender', async () => {
  const deniedReference = message('500000000000000001', {
    author: { id: '300000000000000002', username: 'Mallory', bot: false },
  });
  const allowedReply = message('500000000000000002', {
    reference: { channelId: CHANNEL_ID, messageId: deniedReference.id },
  });
  const fixture = historyFixture({
    access: {
      groups: { [CHANNEL_ID]: { requireMention: true, allowFrom: [USER_ID] } },
    },
    messages: [allowedReply, deniedReference],
  });

  const result = await readDiscordHistory({
    args: { channelId: CHANNEL_ID, limit: 2 },
    config: fixture.config,
    client: fixture.client,
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].replyTo, null);
});

test('readDiscordHistory hides a reply reference authored by a denied bot', async () => {
  const deniedReference = message('500000000000000001', {
    author: { id: '800000000000000001', username: 'OtherBot', bot: true },
  });
  const allowedReply = message('500000000000000002', {
    reference: { channelId: CHANNEL_ID, messageId: deniedReference.id },
  });
  const fixture = historyFixture({
    access: {
      groups: {
        [CHANNEL_ID]: { requireMention: true, allowFrom: [USER_ID], allowBots: false },
      },
    },
    messages: [allowedReply, deniedReference],
  });

  const result = await readDiscordHistory({
    args: { channelId: CHANNEL_ID, limit: 2 },
    config: fixture.config,
    client: fixture.client,
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].replyTo, null);
});

test('readDiscordHistory bounds content, attachments, and total serialized output to 64 KiB', async () => {
  const attachments = new Map(Array.from({ length: 20 }, (_, index) => {
    const id = `6000000000000000${String(index).padStart(2, '0')}`;
    return [id, {
      id,
      name: `attachment-${index}-${'n'.repeat(5000)}`,
      size: 123,
      contentType: 'text/plain',
      url: `https://example.test/${'u'.repeat(5000)}`,
    }];
  }));
  const messages = Array.from({ length: 6 }, (_, index) => message(
    `50000000000000000${6 - index}`,
    { content: 'x'.repeat(30000), attachments },
  ));
  const fixture = historyFixture({ messages });

  const result = await readDiscordHistory({
    args: { channelId: CHANNEL_ID, limit: 6 },
    config: fixture.config,
    client: fixture.client,
  });

  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64 * 1024);
  assert.ok(result.messages.length > 0);
  assert.ok(result.messages.length < 6);
  assert.ok(result.messages[0].content.length <= 16 * 1024);
  assert.equal(result.messages[0].attachments.length, 10);
  assert.ok(result.messages[0].attachments[0].name.length <= 256);
  assert.ok(result.messages[0].attachments[0].url.length <= 2048);
  assert.equal(result.hasMore, true);
});

test('readDiscordHistory keeps a progress cursor when one normalized message exceeds the byte budget', async () => {
  const fixture = historyFixture({
    messages: [
      message('500000000000000002', {
        content: '\u0000'.repeat(30000),
        attachments: new Map(Array.from({ length: 10 }, (_, index) => [String(index), {
          id: String(index),
          name: '\u0000'.repeat(5000),
          url: `https://example.test/${'u'.repeat(5000)}`,
        }])),
      }),
      message('500000000000000001', { content: 'older message' }),
    ],
  });

  const result = await readDiscordHistory({
    args: { channelId: CHANNEL_ID, limit: 1 },
    config: fixture.config,
    client: fixture.client,
  });

  assert.equal(result.messages.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64 * 1024);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextBefore, '500000000000000002');
});

test('readDiscordHistory rejects unauthorized targets and sanitizes fetch failures', async () => {
  const denied = historyFixture({ access: { groups: {} } });
  await assert.rejects(readDiscordHistory({
    args: { channelId: CHANNEL_ID },
    config: denied.config,
    client: denied.client,
  }), /^Error: history_target_not_allowed$/);

  const inaccessibleClient = { channels: { async fetch() { throw new Error('secret channel detail'); } } };
  await assert.rejects(readDiscordHistory({
    args: { channelId: CHANNEL_ID },
    config: denied.config,
    client: inaccessibleClient,
  }), /^Error: history_channel_inaccessible$/);

  const failed = historyFixture({ fetchError: new Error('secret message detail') });
  await assert.rejects(readDiscordHistory({
    args: { channelId: CHANNEL_ID },
    config: failed.config,
    client: failed.client,
  }), /^Error: history_fetch_failed$/);
});
