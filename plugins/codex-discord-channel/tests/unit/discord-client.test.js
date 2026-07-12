'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeAccessState } = require('../../src/access-state');
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
