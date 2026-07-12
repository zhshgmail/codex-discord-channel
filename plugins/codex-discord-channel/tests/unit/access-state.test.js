'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allowHistoryMessage,
  decideAccess,
  decideHistoryTarget,
  defaultAccessState,
  mentionsBot,
  normalizeAccessState,
} = require('../../src/access-state');

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

test('allowlisted bot DM sender is accepted', () => {
  const state = normalizeAccessState({ allowFrom: ['bot2'] });
  const decision = decideAccess(state, { source: 'dm', authorId: 'bot2', authorIsBot: true, content: 'hi' });
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

test('guild reply to the active bot satisfies the mention requirement', () => {
  const state = normalizeAccessState({ groups: { c1: {} } });
  const decision = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: 'follow-up without a visible mention',
    botUserId: 'bot',
    repliedToAuthorId: 'bot',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'guild_allowed');
});

test('guild reply to another author does not satisfy the mention requirement', () => {
  const state = normalizeAccessState({ groups: { c1: {} } });
  const decision = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: 'follow-up without a visible mention',
    botUserId: 'bot',
    repliedToAuthorId: 'u2',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'guild_mention_required');
});

test('guild reply to a peer message mentioning the active bot satisfies the mention requirement', () => {
  const state = normalizeAccessState({ groups: { c1: {} } });
  const decision = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: 'follow-up without a visible mention',
    botUserId: 'bot',
    repliedToAuthorId: 'u2',
    repliedToContent: 'asking <@bot> and another agent',
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'guild_allowed');
});

test('guild reply to a peer message not mentioning the active bot remains denied', () => {
  const state = normalizeAccessState({ groups: { c1: {} } });
  const decision = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: 'follow-up without a visible mention',
    botUserId: 'bot',
    repliedToAuthorId: 'u2',
    repliedToContent: 'asking another agent only',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'guild_mention_required');
});

test('guild reply with no normalized replied author still requires a mention', () => {
  const state = normalizeAccessState({ groups: { c1: {} } });
  const decision = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: 'follow-up without a visible mention',
    botUserId: 'bot',
    repliedToAuthorId: '',
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

test('bot reply to the active bot remains subject to allowBots and allowFrom', () => {
  const deniedByAllowBots = decideAccess(normalizeAccessState({ groups: { c1: {} } }), {
    source: 'guild',
    channelId: 'c1',
    authorId: 'bot2',
    authorIsBot: true,
    content: 'follow-up without a visible mention',
    botUserId: 'bot',
    repliedToAuthorId: 'bot',
  });
  const deniedByAllowFrom = decideAccess(normalizeAccessState({
    groups: { c1: { allowBots: true, allowFrom: ['bot3'] } },
  }), {
    source: 'guild',
    channelId: 'c1',
    authorId: 'bot2',
    authorIsBot: true,
    content: 'follow-up without a visible mention',
    botUserId: 'bot',
    repliedToAuthorId: 'bot',
  });

  assert.equal(deniedByAllowBots.reason, 'bot_author_denied');
  assert.equal(deniedByAllowFrom.reason, 'guild_sender_denied');
});

test('mentionsBot detects Discord mention or configured pattern', () => {
  assert.equal(mentionsBot('hi <@123>', '123'), true);
  assert.equal(mentionsBot('hi codex', '', ['\\bcodex\\b']), true);
  assert.equal(mentionsBot('hi', '123'), false);
});

test('history target requires exact enabled guild channel or thread id', () => {
  const state = normalizeAccessState({ groups: { '100000000000000001': {} } });
  const channel = {
    id: '100000000000000001',
    guildId: '200000000000000001',
    type: 0,
  };
  const threadWithEnabledParent = {
    id: '100000000000000002',
    parentId: channel.id,
    guildId: channel.guildId,
    type: 11,
  };

  assert.deepEqual(decideHistoryTarget(state, channel, '900000000000000001'), {
    allowed: true,
    reason: 'guild_channel_enabled',
    source: 'guild',
  });
  assert.deepEqual(decideHistoryTarget(state, threadWithEnabledParent, '900000000000000001'), {
    allowed: false,
    reason: 'history_target_not_allowed',
  });
});

test('history target supports only message-bearing guild channel types', () => {
  const channelId = '100000000000000001';
  const state = normalizeAccessState({ groups: { [channelId]: {} } });

  for (const type of [0, 5, 10, 11, 12]) {
    assert.equal(decideHistoryTarget(state, { id: channelId, guildId: 'g1', type }, 'bot').allowed, true);
  }
  for (const type of [2, 4, 13, 15, 16]) {
    assert.deepEqual(decideHistoryTarget(state, { id: channelId, guildId: 'g1', type }, 'bot'), {
      allowed: false,
      reason: 'history_target_not_allowed',
    });
  }
});

test('DM history requires open policy or an allowlisted counterparty', () => {
  const target = {
    id: '100000000000000001',
    type: 1,
    recipient: { id: '300000000000000001' },
  };

  assert.deepEqual(decideHistoryTarget(normalizeAccessState({ dmPolicy: 'open' }), target, 'bot'), {
    allowed: true,
    reason: 'dm_open',
    source: 'dm',
    counterpartyId: '300000000000000001',
  });
  assert.equal(decideHistoryTarget(normalizeAccessState({
    dmPolicy: 'closed',
    allowFrom: ['300000000000000001'],
  }), target, 'bot').allowed, true);
  assert.deepEqual(decideHistoryTarget(defaultAccessState(), target, 'bot'), {
    allowed: false,
    reason: 'history_target_not_allowed',
  });
  assert.equal(decideHistoryTarget(normalizeAccessState({ dmPolicy: 'open' }), {
    ...target,
    type: 3,
  }, 'bot').allowed, false);
});

test('history filtering preserves own bot messages and guild access ordering', () => {
  const channelId = '100000000000000001';
  const target = { id: channelId, guildId: 'g1', type: 0 };
  const state = normalizeAccessState({
    groups: {
      [channelId]: {
        requireMention: true,
        allowFrom: ['300000000000000001'],
        allowBots: false,
      },
    },
  });

  assert.equal(allowHistoryMessage(state, target, {
    author: { id: '900000000000000001', bot: true },
    content: 'bot response',
  }, '900000000000000001'), true);
  assert.equal(allowHistoryMessage(state, target, {
    author: { id: '800000000000000001', bot: true },
    content: '<@900000000000000001> bot response',
  }, '900000000000000001'), false);
  assert.equal(allowHistoryMessage(state, target, {
    author: { id: '300000000000000002', bot: false },
    content: '<@900000000000000001> denied sender',
  }, '900000000000000001'), false);
  assert.equal(allowHistoryMessage(state, target, {
    author: { id: '300000000000000001', bot: false },
    content: 'no mention required for history',
  }, '900000000000000001'), true);
});
