'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decideAccess, normalizeAccessState } = require('../../src/access-state');
const { normalizeDiscordMessage } = require('../../src/delivery');
const { resolveReferencedMessage } = require('../../src/discord-client');

test('reference resolver fetches references for enabled guild channels', async () => {
  const referenced = { author: { id: 'peer' }, content: 'hello <@bot>' };
  let fetchCount = 0;
  const result = await resolveReferencedMessage({
    guildId: 'g1',
    channelId: 'c1',
    reference: { messageId: 'm0' },
    async fetchReference() {
      fetchCount += 1;
      return referenced;
    },
  }, normalizeAccessState({ groups: { c1: {} } }));

  assert.equal(fetchCount, 1);
  assert.equal(result, referenced);
});

test('reference resolver fails closed when an enabled guild reference cannot be fetched', async () => {
  let fetchCount = 0;
  const result = await resolveReferencedMessage({
    guildId: 'g1',
    channelId: 'c1',
    reference: { messageId: 'm0' },
    async fetchReference() {
      fetchCount += 1;
      throw new Error('unknown message');
    },
  }, normalizeAccessState({ groups: { c1: {} } }));

  assert.equal(fetchCount, 1);
  assert.equal(result, null);
});

test('failed reference ignores replied-user bot metadata and remains mention-denied', async () => {
  const state = normalizeAccessState({ groups: { c1: {} } });
  const message = {
    guildId: 'g1',
    channelId: 'c1',
    id: 'm1',
    author: { id: 'u1', username: 'Alice', bot: false },
    content: 'follow-up without a visible mention',
    reference: { messageId: 'm0' },
    mentions: { repliedUser: { id: 'bot' } },
    async fetchReference() {
      throw new Error('unknown message');
    },
  };

  const referenced = await resolveReferencedMessage(message, state);
  const normalized = normalizeDiscordMessage(message, referenced);
  normalized.botUserId = 'bot';

  assert.equal(normalized.repliedToAuthorId, '');
  assert.deepEqual(decideAccess(state, normalized), {
    allowed: false,
    reason: 'guild_mention_required',
  });
});

test('reference resolver does not fetch for a denied guild sender', async () => {
  let fetchCount = 0;
  const result = await resolveReferencedMessage({
    guildId: 'g1',
    channelId: 'c1',
    author: { id: 'denied-human', bot: false },
    reference: { messageId: 'm0' },
    async fetchReference() {
      fetchCount += 1;
      return { author: { id: 'peer' }, content: 'hello <@bot>' };
    },
  }, normalizeAccessState({ groups: { c1: { allowFrom: ['allowed-human'] } } }));

  assert.equal(result, null);
  assert.equal(fetchCount, 0);
});

test('reference resolver does not fetch for a denied bot author', async () => {
  let fetchCount = 0;
  const result = await resolveReferencedMessage({
    guildId: 'g1',
    channelId: 'c1',
    author: { id: 'peer-bot', bot: true },
    reference: { messageId: 'm0' },
    async fetchReference() {
      fetchCount += 1;
      return { author: { id: 'peer' }, content: 'hello <@bot>' };
    },
  }, normalizeAccessState({ groups: { c1: {} } }));

  assert.equal(result, null);
  assert.equal(fetchCount, 0);
});

test('reference resolver does not fetch outside enabled guild channels', async () => {
  let fetchCount = 0;
  const message = {
    guildId: 'g1',
    channelId: 'disabled',
    reference: { messageId: 'm0' },
    async fetchReference() {
      fetchCount += 1;
      return { author: { id: 'peer' }, content: 'hello <@bot>' };
    },
  };

  assert.equal(await resolveReferencedMessage(message, normalizeAccessState({ groups: { c1: {} } })), null);
  assert.equal(fetchCount, 0);
});
