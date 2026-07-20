'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { decideAccess, normalizeAccessState } = require('../../src/access-state');
const { normalizeDiscordMessage } = require('../../src/delivery');
const {
  claimDiscordReceiverOwnership,
  createDiscordMessageHandler,
  readDiscordReceiverOwnership,
  resolveReferencedMessage,
} = require('../../src/discord-client');

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

test('concurrent reference fetch preserves Discord event delivery order', async () => {
  let releaseReference;
  let markReferenceStarted;
  const referenceStarted = new Promise((resolve) => { markReferenceStarted = resolve; });
  const referenceReleased = new Promise((resolve) => { releaseReference = resolve; });
  const delivered = [];
  const handler = createDiscordMessageHandler({
    config: { botUserId: 'bot' },
    client: { user: { id: 'bot' } },
    delivery: {
      async deliver(normalized) {
        delivered.push(normalized.messageId);
        return { status: 'delivered', reason: 'turn_accepted' };
      },
    },
    logger: () => {},
    deps: {
      isActiveDiscordReceiver: () => ({ active: true, reason: 'gateway_pid_match' }),
      loadAccessState: () => normalizeAccessState({
        groups: { c1: { requireMention: false } },
      }),
    },
  });
  const first = {
    guildId: 'g1',
    channelId: 'c1',
    id: 'm1',
    author: { id: 'u1', username: 'Alice', bot: false },
    content: 'first',
    attachments: [],
    reference: { messageId: 'parent' },
    async fetchReference() {
      markReferenceStarted();
      await referenceReleased;
      return { author: { id: 'u0' }, content: 'parent' };
    },
  };
  const second = {
    guildId: 'g1',
    channelId: 'c1',
    id: 'm2',
    author: { id: 'u2', username: 'Bob', bot: false },
    content: 'second',
    attachments: [],
  };

  const firstHandling = handler(first);
  const secondHandling = handler(second);
  await referenceStarted;
  assert.deepEqual(delivered, []);
  releaseReference();
  await Promise.all([firstHandling, secondHandling]);

  assert.deepEqual(delivered, ['m1', 'm2']);
});

test('receiver ownership claim atomically replaces the durable generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-generation-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  fs.writeFileSync(gatewayPidPath, `${process.pid}\n`);
  const config = { paths: { gatewayPidPath } };
  const generations = ['generation-a', 'generation-b'];
  const deps = {
    fs,
    isActiveDiscordReceiver: () => ({
      active: true,
      reason: 'gateway_pid_match',
      pid: process.pid,
    }),
    randomUUID: () => generations.shift(),
  };

  const first = claimDiscordReceiverOwnership(config, deps);
  const second = claimDiscordReceiverOwnership(config, deps);

  assert.equal(first.generation, 'generation-a');
  assert.equal(second.generation, 'generation-b');
  assert.deepEqual(readDiscordReceiverOwnership(config, deps), second);
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('.tmp')),
    [],
  );
});

test('old gateway cannot accept an earlier message after new ownership accepts a later one', async () => {
  let currentGeneration = 'generation-a';
  let releaseReference;
  let markReferenceStarted;
  const referenceStarted = new Promise((resolve) => { markReferenceStarted = resolve; });
  const referenceReleased = new Promise((resolve) => { releaseReference = resolve; });
  const delivered = [];
  const delivery = {
    async deliver(normalized, options = {}) {
      const receiver = options.verifyReceiverOwnership?.() || { active: true };
      if (!receiver.active) return { status: 'ignored', reason: receiver.reason };
      delivered.push(normalized.messageId);
      return { status: 'delivered', reason: 'turn_accepted' };
    },
  };
  const createHandler = (generation) => createDiscordMessageHandler({
    config: { botUserId: 'bot' },
    client: { user: { id: 'bot' } },
    delivery,
    logger: () => {},
    receiverOwnership: { pid: process.pid, generation },
    deps: {
      isActiveDiscordReceiver: () => ({ active: true, reason: 'gateway_pid_match', pid: process.pid }),
      isCurrentDiscordReceiverOwnership: (_config, ownership) => ownership.generation === currentGeneration
        ? { active: true, reason: 'gateway_generation_match', pid: process.pid }
        : { active: false, reason: 'gateway_generation_changed', pid: process.pid },
      loadAccessState: () => normalizeAccessState({
        groups: { c1: { requireMention: false } },
      }),
    },
  });
  const oldHandler = createHandler('generation-a');
  const newHandler = createHandler('generation-b');
  const first = {
    guildId: 'g1',
    channelId: 'c1',
    id: 'm1',
    author: { id: 'u1', username: 'Alice', bot: false },
    content: 'first',
    attachments: [],
    reference: { messageId: 'parent' },
    async fetchReference() {
      markReferenceStarted();
      await referenceReleased;
      return { author: { id: 'u0' }, content: 'parent' };
    },
  };
  const second = {
    guildId: 'g1',
    channelId: 'c1',
    id: 'm2',
    author: { id: 'u2', username: 'Bob', bot: false },
    content: 'second',
    attachments: [],
  };

  const oldHandling = oldHandler(first);
  await referenceStarted;
  currentGeneration = 'generation-b';
  await newHandler(second);
  releaseReference();
  await oldHandling;

  assert.deepEqual(delivered, ['m2']);
});
