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

test('guild reply to a peer message mentioning the active bot does not inherit that mention', () => {
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

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'guild_mention_required');
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

test('Discord broadcast satisfies the mention requirement only when the platform marks it', () => {
  const state = normalizeAccessState({ groups: { c1: {} } });
  const allowed = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: '@everyone coordinated update',
    mentionsEveryone: true,
    botUserId: 'bot',
  });
  const deniedLiteral = decideAccess(state, {
    source: 'guild',
    channelId: 'c1',
    authorId: 'u1',
    authorIsBot: false,
    content: '@everyone coordinated update',
    mentionsEveryone: false,
    botUserId: 'bot',
  });

  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'guild_allowed');
  assert.equal(deniedLiteral.allowed, false);
  assert.equal(deniedLiteral.reason, 'guild_mention_required');
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

test('guild thread inherits its enabled parent channel policy', () => {
  const state = normalizeAccessState({
    groups: { parent: { allowFrom: ['u1'], allowBots: false } },
  });
  const allowed = decideAccess(state, {
    source: 'guild',
    channelId: 'thread',
    policyChannelId: 'parent',
    authorId: 'u1',
    authorIsBot: false,
    content: '<@bot> hi',
    botUserId: 'bot',
  });
  const deniedSender = decideAccess(state, {
    source: 'guild',
    channelId: 'thread',
    policyChannelId: 'parent',
    authorId: 'u2',
    authorIsBot: false,
    content: '<@bot> hi',
    botUserId: 'bot',
  });
  const deniedBot = decideAccess(state, {
    source: 'guild',
    channelId: 'thread',
    policyChannelId: 'parent',
    authorId: 'u1',
    authorIsBot: true,
    content: '<@bot> hi',
    botUserId: 'bot',
  });

  assert.equal(allowed.allowed, true);
  assert.equal(deniedSender.reason, 'guild_sender_denied');
  assert.equal(deniedBot.reason, 'bot_author_denied');
});

test('guild thread with an unknown parent remains denied', () => {
  const state = normalizeAccessState({ groups: { parent: {} } });
  const decision = decideAccess(state, {
    source: 'guild',
    channelId: 'thread',
    policyChannelId: 'unknown-parent',
    authorId: 'u1',
    authorIsBot: false,
    content: '<@bot> hi',
    botUserId: 'bot',
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'guild_channel_not_enabled');
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

test('history target accepts an enabled guild channel and threads under it', () => {
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
    allowed: true,
    reason: 'guild_channel_enabled',
    source: 'guild',
  });
});

test('history target does not inherit policy from a category for an ordinary text channel', () => {
  const state = normalizeAccessState({ groups: { category: {} } });
  const channel = {
    id: 'channel',
    parentId: 'category',
    guildId: 'guild',
    type: 0,
  };

  assert.deepEqual(decideHistoryTarget(state, channel, 'bot'), {
    allowed: false,
    reason: 'history_target_not_allowed',
  });
});

test('history filtering applies the inherited parent policy to thread messages', () => {
  const state = normalizeAccessState({
    groups: {
      parent: { allowFrom: ['human'], allowBots: false },
    },
  });
  const thread = { id: 'thread', parentId: 'parent', guildId: 'guild', type: 11 };

  assert.equal(allowHistoryMessage(state, thread, {
    author: { id: 'human', bot: false },
  }, 'bot'), true);
  assert.equal(allowHistoryMessage(state, thread, {
    author: { id: 'other', bot: false },
  }, 'bot'), false);
  assert.equal(allowHistoryMessage(state, thread, {
    author: { id: 'peer-bot', bot: true },
  }, 'bot'), false);
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

test('wildcard uses instance sender IDs across channels and threads', () => {
  const state = normalizeAccessState({ allowFrom: ['peer'], groups: { '*': { allowBots: true } } });
  const base = { source: 'guild', guildId: 'guild', authorId: 'peer', authorIsBot: true,
    content: '<@self> work', botUserId: 'self' };
  for (const [channelId, policyChannelId] of [['one', 'one'], ['two', 'two'], ['thread', 'new-parent']]) {
    const message = { ...base, channelId, policyChannelId };
    assert.equal(decideAccess(state, message).allowed, true);
    assert.equal(decideAccess(state, { ...message, authorId: 'unknown' }).reason, 'guild_sender_denied');
    assert.equal(decideAccess(state, { ...message, content: 'work' }).reason, 'guild_mention_required');
    const target = { id: channelId, guildId: 'guild', type: channelId === 'thread' ? 11 : 0, parentId: policyChannelId };
    assert.equal(decideHistoryTarget(state, target, 'self').allowed, true);
    assert.equal(allowHistoryMessage(state, target, { author: { id: 'peer', bot: true } }, 'self'), true);
    assert.equal(allowHistoryMessage(state, target, { author: { id: 'unknown', bot: false } }, 'self'), false);
    assert.equal(decideAccess(normalizeAccessState({ allowFrom: ['peer'] }), message).allowed, false);
  }
});

test('wildcard without sender IDs stays closed and bot permission remains explicit', () => {
  const message = { source: 'guild', channelId: 'new', authorId: 'peer', authorIsBot: true,
    content: '<@self> work', botUserId: 'self' };
  const empty = normalizeAccessState({ groups: { '*': { allowBots: true } } });
  assert.equal(decideAccess(empty, message).allowed, false);
  assert.equal(decideHistoryTarget(empty, { id: 'new', guildId: 'guild', type: 0 }, 'self').allowed, false);
  const noBots = normalizeAccessState({ allowFrom: ['peer'], groups: { '*': {} } });
  assert.equal(decideAccess(noBots, message).reason, 'bot_author_denied');
});

test('exact thread and parent policies override wildcard sender permissions', () => {
  const state = normalizeAccessState({ allowFrom: ['global'], groups: {
    '*': { allowFrom: ['fallback'], allowBots: true },
    parent: { allowFrom: ['parent-user'], allowBots: true },
    thread: { allowFrom: ['thread-user'], allowBots: true },
  } });
  const base = { source: 'guild', content: '<@self>', botUserId: 'self', authorIsBot: true };
  for (const [channelId, policyChannelId, authorId] of [
    ['new', 'new', 'fallback'], ['inherited-thread', 'parent', 'parent-user'], ['thread', 'parent', 'thread-user'],
  ]) {
    const message = { ...base, channelId, policyChannelId, authorId };
    assert.equal(decideAccess(state, message).allowed, true);
    assert.equal(decideAccess(state, { ...message, authorId: 'global' }).allowed, false);
    const target = { id: channelId, parentId: policyChannelId, guildId: 'guild', type: 11 };
    assert.equal(allowHistoryMessage(state, target, { author: { id: authorId, bot: true } }, 'self'), true);
    assert.equal(allowHistoryMessage(state, target, { author: { id: 'global', bot: true } }, 'self'), false);
    if (channelId !== 'new') {
      assert.equal(decideAccess(state, { ...message, authorId: 'fallback' }).allowed, false);
      assert.equal(allowHistoryMessage(state, target, { author: { id: 'fallback', bot: true } }, 'self'), false);
    }
  }
});
