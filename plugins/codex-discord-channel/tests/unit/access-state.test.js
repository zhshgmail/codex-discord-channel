'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decideAccess, defaultAccessState, mentionsBot, normalizeAccessState } = require('../../src/access-state');

test('DM pairing policy denies unknown sender and requests pairing', () => {
  const decision = decideAccess(defaultAccessState(), {
    source: 'dm',
    authorId: 'u1',
    authorIsBot: false,
    content: 'hi',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'dm_pairing_required');
  assert.equal(decision.requiresPairingCode, true);
});

test('allowlisted DM sender is accepted', () => {
  const state = normalizeAccessState({ allowFrom: ['u1'] });
  const decision = decideAccess(state, { source: 'dm', authorId: 'u1', authorIsBot: false, content: 'hi' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'dm_allowlisted');
});

test('disabled guild channel is denied', () => {
  const decision = decideAccess(defaultAccessState(), {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: '<@bot> hi',
    botUserId: 'bot',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'guild_channel_not_enabled');
});

test('guild channel requires mention by default', () => {
  const state = normalizeAccessState({ groups: { c1: {} } });
  const decision = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: 'hi',
    botUserId: 'bot',
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'guild_mention_required');
});

test('guild channel can disable mention requirement', () => {
  const state = normalizeAccessState({ groups: { c1: { requireMention: false } } });
  const decision = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: 'hi',
    botUserId: 'bot',
  });
  assert.equal(decision.allowed, true);
});

test('bot-authored messages are denied unless channel allows bots', () => {
  const denied = decideAccess(normalizeAccessState({ groups: { c1: { requireMention: false } } }), {
    source: 'guild',
    channelId: 'c1',
    authorId: 'bot2',
    authorIsBot: true,
    content: 'hi',
    botUserId: 'bot',
  });
  assert.equal(denied.reason, 'bot_author_denied');

  const allowed = decideAccess(normalizeAccessState({ groups: { c1: { requireMention: false, allowBots: true } } }), {
    source: 'guild',
    channelId: 'c1',
    authorId: 'bot2',
    authorIsBot: true,
    content: 'hi',
    botUserId: 'bot',
  });
  assert.equal(allowed.allowed, true);
});

test('mentionsBot detects Discord mention or configured pattern', () => {
  assert.equal(mentionsBot('hi <@123>', '123'), true);
  assert.equal(mentionsBot('hi codex', '', ['\\bcodex\\b']), true);
  assert.equal(mentionsBot('hi', '123'), false);
});
