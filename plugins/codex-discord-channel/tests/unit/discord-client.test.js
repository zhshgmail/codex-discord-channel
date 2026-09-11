'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { decideAccess, normalizeAccessState } = require('../../src/access-state');
const { createDelivery, normalizeDiscordMessage } = require('../../src/delivery');
const {
  commitReceiverOwnership,
  createReceiverOwnership,
  getDeliveryQueueLockIdentity,
  readReceiverAuthoritySnapshot,
} = require('../../src/receiver-state');
const {
  confirmDiscordMessage,
  createDiscordMessageHandler,
  isCurrentDiscordReceiverOwnership,
  prepareDiscordMessageSend,
  reconcileDiscordMessage,
  releaseDiscordReceiverOwnership,
  resolveReferencedMessage,
  sendDiscordMessage,
  startDiscordClient,
} = require('../../src/discord-client');

test('guarded Discord sends carry a stable enforced nonce and require exact readback', async () => {
  const messages = new Map([['m1', { id: 'm1', channelId: 'c1' }]]);
  const channel = {
    messages: {
      async fetch(query) {
        if (typeof query === 'string') return messages.get(query) || null;
        return new Map(messages.entries());
      },
    },
    async send(payload) {
      const response = {
        id: 'out1',
        channelId: 'c1',
        content: payload.content,
        nonce: payload.nonce,
        reference: { messageId: payload.reply.messageReference },
        author: { id: 'bot1' },
      };
      const durable = { ...response };
      delete durable.nonce;
      messages.set(durable.id, durable);
      return response;
    },
  };
  const client = {
    user: { id: 'bot1' },
    channels: { async fetch() { return channel; } },
  };
  const args = {
    channelId: 'c1',
    replyTo: 'm1',
    content: 'answer',
    nonce: 'cdr-stable',
    enforceNonce: true,
  };

  const prepared = await prepareDiscordMessageSend(client, args);
  assert.equal(prepared.payload.nonce, 'cdr-stable');
  assert.equal(prepared.payload.enforceNonce, true);
  assert.equal(prepared.payload.reply.failIfNotExists, true);
  const sent = await sendDiscordMessage(client, args, prepared);
  assert.deepEqual(sent, { channelId: 'c1', messageId: 'out1' });
  assert.deepEqual(await confirmDiscordMessage(client, args, prepared, sent), {
    channelId: 'c1', messageId: 'out1',
  });
});

test('guarded Discord sends reject a conflicting nonce in the immediate POST response', async () => {
  const prepared = {
    channel: {
      async send() {
        return { id: 'out1', channelId: 'c1', nonce: 'foreign-nonce' };
      },
    },
    payload: { content: 'answer', nonce: 'cdr-stable', enforceNonce: true },
  };

  await assert.rejects(sendDiscordMessage({}, {
    channelId: 'c1', nonce: 'cdr-stable', enforceNonce: true,
  }, prepared), (error) => {
    assert.equal(error.code, 'reply_send_response_nonce_mismatch');
    assert.deepEqual(error.replySendIdentity, { channelId: 'c1', messageId: 'out1' });
    return true;
  });
});

test('stable reply confirmation rejects foreign message identity fields without requiring GET nonce', async () => {
  const args = {
    channelId: 'c1', replyTo: 'm1', content: 'answer', nonce: 'cdr-stable', enforceNonce: true,
  };
  const baseline = {
    id: 'out1', channelId: 'c1', content: 'answer',
    reference: { messageId: 'm1' }, author: { id: 'bot1' },
  };
  const attacks = [
    ['message id', { id: 'foreign-id' }],
    ['channel', { channelId: 'foreign-channel' }],
    ['content', { content: 'foreign-content' }],
    ['reply source', { reference: { messageId: 'foreign-source' } }],
    ['bot author', { author: { id: 'foreign-bot' } }],
  ];

  for (const [label, mutation] of attacks) {
    const channel = {
      messages: { async fetch() { return { ...baseline, ...mutation }; } },
    };
    const client = {
      user: { id: 'bot1' }, channels: { async fetch() { return channel; } },
    };
    await assert.rejects(
      confirmDiscordMessage(client, args, { channel }, { channelId: 'c1', messageId: 'out1' }),
      (error) => error.code === 'reply_confirmation_mismatch',
      label,
    );
  }
});

test('reply reconciliation requires nonce source content channel and bot identity', async () => {
  const messages = new Map([
    ['wrong-source', {
      id: 'wrong-source', channelId: 'c1', content: 'answer', nonce: 'cdr-stable',
      reference: { messageId: 'other' }, author: { id: 'bot1' },
    }],
    ['right', {
      id: 'right', channelId: 'c1', content: 'answer', nonce: 'cdr-stable',
      reference: { messageId: 'm1' }, author: { id: 'bot1' },
    }],
  ]);
  const channel = {
    messages: {
      async fetch(query) {
        if (typeof query === 'string') return messages.get(query) || null;
        return new Map(messages.entries());
      },
    },
  };
  const client = {
    user: { id: 'bot1' },
    channels: { async fetch() { return channel; } },
  };
  const args = {
    channelId: 'c1', replyTo: 'm1', content: 'answer', nonce: 'cdr-stable', enforceNonce: true,
  };

  assert.deepEqual(await reconcileDiscordMessage(client, args, { channel }, {}), {
    found: true,
    channelId: 'c1',
    messageId: 'right',
  });
  messages.delete('right');
  assert.deepEqual(await reconcileDiscordMessage(client, args, { channel }, {}), { found: false });
});

test('reply reconciliation with a durable message id never substitutes a different nonce match', async () => {
  const exact = {
    id: 'foreign-id', channelId: 'c1', content: 'answer', nonce: 'cdr-stable',
    reference: { messageId: 'm1' }, author: { id: 'bot1' },
  };
  const substitute = {
    ...exact, id: 'substitute-id',
  };
  const channel = {
    messages: {
      async fetch(query) {
        if (typeof query === 'string') return exact;
        return new Map([[substitute.id, substitute]]);
      },
    },
  };
  const client = {
    user: { id: 'bot1' }, channels: { async fetch() { return channel; } },
  };

  assert.deepEqual(await reconcileDiscordMessage(client, {
    channelId: 'c1', replyTo: 'm1', content: 'answer', nonce: 'cdr-stable', enforceNonce: true,
  }, { channel }, { outboundMessageId: 'out1' }), { found: false });
});

test('guarded Discord preflight fails closed for missing or cross-channel sources', async () => {
  for (const source of [null, { id: 'm1', channelId: 'other-channel' }]) {
    let sendCount = 0;
    const channel = {
      messages: { async fetch() { return source; } },
      async send() { sendCount += 1; },
    };
    const client = {
      user: { id: 'bot1' },
      channels: { async fetch() { return channel; } },
    };

    await assert.rejects(prepareDiscordMessageSend(client, {
      channelId: 'c1', replyTo: 'm1', content: 'answer', nonce: 'stable', enforceNonce: true,
    }), /Exact Discord reply source/);
    assert.equal(sendCount, 0);
  }
});

test('structured Discord 4xx errors release sends but response-loss errors stay uncertain', async () => {
  const prepared = {
    channel: {
      async send() {
        const error = new Error('Invalid Form Body');
        error.status = 400;
        error.code = 50035;
        throw error;
      },
    },
    payload: { content: 'answer' },
  };
  await assert.rejects(
    sendDiscordMessage({}, { channelId: 'c1' }, prepared),
    (error) => error.definitiveNoSend === true,
  );

  prepared.channel.send = async () => { throw new Error('fetch failed after write'); };
  await assert.rejects(
    sendDiscordMessage({}, { channelId: 'c1' }, prepared),
    (error) => error.definitiveNoSend !== true,
  );
});

test('reconciliation rejects an unavailable expected bot author before fetching', async () => {
  let fetchCount = 0;
  const channel = {
    messages: { async fetch() { fetchCount += 1; return new Map(); } },
  };
  const client = { user: { id: '' }, channels: { async fetch() { return channel; } } };

  await assert.rejects(reconcileDiscordMessage(client, {
    channelId: 'c1', replyTo: 'm1', content: 'answer', nonce: 'stable', enforceNonce: true,
  }, { channel }, {}), (error) => error.code === 'reply_reconciliation_author_unavailable');
  assert.equal(fetchCount, 0);
});

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
      async enqueue(normalized) {
        delivered.push(normalized.messageId);
        return { status: 'accepted', reason: 'discord_message_persisted' };
      },
      async flush() { return { status: 'delivered', reason: 'turn_accepted' }; },
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

test('accepted Discord events persist in FIFO order while an earlier delivery blocks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-discord-admission-'));
  const config = {
    botUserId: 'bot',
    deliveryMode: 'app-server',
    appServerRequestTimeoutMs: 30000,
    paths: {
      stateDir: dir,
      lastInboundPath: path.join(dir, 'last-inbound.json'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  };
  let target = { available: true, threadId: 'thread-root', status: 'idle' };
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const requests = [];
  const delivery = createDelivery(config, () => {}, {
    structuredHost: {
      async resolveTarget() { return { ...target }; },
      async startTurn(params) {
        requests.push(params);
        target = { ...target, status: 'active' };
        markFirstStarted();
        await firstReleased;
        return { turn: { id: 'turn-m1' } };
      },
      onThreadIdle() { return () => {}; },
      status() { return { configured: true, available: true, reason: null }; },
      destroy() {},
    },
  });
  const handler = createDiscordMessageHandler({
    config,
    client: { user: { id: 'bot' } },
    delivery,
    logger: () => {},
    deps: {
      isActiveDiscordReceiver: () => ({ active: true, reason: 'gateway_pid_match' }),
      loadAccessState: () => normalizeAccessState({
        groups: { c1: { requireMention: false } },
      }),
    },
  });
  const makeMessage = (id, content) => ({
    guildId: 'g1',
    channelId: 'c1',
    id,
    author: { id: `user-${id}`, username: id, bot: false },
    content,
    attachments: [],
  });

  const firstHandling = handler(makeMessage('m1', 'first'));
  await firstStarted;
  const secondHandling = handler(makeMessage('m2', 'second'));
  const persistenceDeadline = Date.now() + 2000;
  while (
    JSON.parse(fs.readFileSync(config.paths.deliveryQueuePath, 'utf8')).items.length < 2 &&
    Date.now() < persistenceDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const persistedBeforeFirstCompleted = JSON.parse(
    fs.readFileSync(config.paths.deliveryQueuePath, 'utf8'),
  );
  releaseFirst();
  await Promise.all([firstHandling, secondHandling]);

  assert.deepEqual(
    persistedBeforeFirstCompleted.items.map((item) => item.normalized.messageId),
    ['m1', 'm2'],
  );
  assert.deepEqual(requests.map((request) => request.clientUserMessageId), ['discord:c1:m1']);
  delivery.destroy();
});

test('receiver authority commit stores PID and generation in one atomic record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-receiver-generation-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = {
    paths: {
      stateDir: dir,
      gatewayPidPath,
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  };
  const generations = ['generation-a', 'generation-b'];
  const deps = {
    fs,
    randomUUID: () => generations.shift(),
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
  };

  const firstSnapshot = readReceiverAuthoritySnapshot(config, deps);
  const first = createReceiverOwnership(firstSnapshot.record, deps);
  commitReceiverOwnership(config, firstSnapshot, first, deps);
  const firstAuthority = JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8'));
  const secondSnapshot = readReceiverAuthoritySnapshot(config, deps);
  const second = createReceiverOwnership(secondSnapshot.record, deps);
  commitReceiverOwnership(config, secondSnapshot, second, deps);

  assert.equal(first.generation, 'generation-a');
  assert.deepEqual(firstAuthority, first);
  assert.equal(second.generation, 'generation-b');
  assert.deepEqual(readReceiverAuthoritySnapshot(config, deps).record, second);
  assert.equal(fs.existsSync(`${gatewayPidPath}.generation`), false);
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
    async enqueue(normalized, options = {}) {
      const receiver = options.verifyReceiverOwnership?.() || { active: true };
      if (!receiver.active) return { status: 'ignored', reason: receiver.reason };
      delivered.push(normalized.messageId);
      return { status: 'accepted', reason: 'discord_message_persisted' };
    },
    async flush() { return { status: 'delivered', reason: 'turn_accepted' }; },
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

test('non-receiver MCP client logs in without claiming ownership or registering inbound delivery', async () => {
  const { EventEmitter } = require('node:events');
  let claims = 0;
  class FakeDiscordClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.user = { id: 'bot', tag: 'bot#0001' };
      this.loginTokens = [];
    }

    async login(token) {
      this.loginTokens.push(token);
    }
  }
  const delivery = {
    coordinateReceiverOwnership() {
      claims += 1;
      throw new Error('must not claim');
    },
  };

  const result = await startDiscordClient({
    config: {
      tokenConfigured: true,
      loginDisabled: false,
      token: 'test-token',
      botUserId: 'bot',
      paths: { gatewayPidPath: '/missing/session-gateway.pid' },
    },
    delivery,
    logger: () => {},
    deps: {
      discord: {
        Client: FakeDiscordClient,
        Events: { MessageCreate: 'messageCreate' },
        GatewayIntentBits: {
          DirectMessages: 1,
          Guilds: 2,
          GuildMessages: 4,
          MessageContent: 8,
        },
        Partials: { Channel: 'channel' },
      },
      isActiveDiscordReceiver: () => ({ active: false, reason: 'another_gateway_active', pid: 1234 }),
    },
  });

  assert.equal(result.started, true);
  assert.equal(claims, 0);
  assert.deepEqual(result.client.loginTokens, ['test-token']);
  assert.deepEqual(result.client.options.intents, [1, 2, 4, 8]);
  assert.equal(result.client.listenerCount('messageCreate'), 0);
});

test('explicit false omits only the privileged Message Content gateway intent', async () => {
  const { EventEmitter } = require('node:events');
  class FakeDiscordClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.user = { id: 'bot', tag: 'bot#0001' };
    }

    async login() {}
  }

  const result = await startDiscordClient({
    config: {
      tokenConfigured: true,
      loginDisabled: false,
      messageContentIntent: false,
      token: 'test-token',
      botUserId: 'bot',
      paths: { gatewayPidPath: '/missing/session-gateway.pid' },
    },
    delivery: {},
    logger: () => {},
    deps: {
      discord: {
        Client: FakeDiscordClient,
        Events: { MessageCreate: 'messageCreate' },
        GatewayIntentBits: {
          DirectMessages: 1,
          Guilds: 2,
          GuildMessages: 4,
          MessageContent: 8,
        },
        Partials: { Channel: 'channel' },
      },
      isActiveDiscordReceiver: () => ({ active: false, reason: 'another_gateway_active', pid: 1234 }),
    },
  });

  assert.equal(result.started, true);
  assert.deepEqual(result.client.options.intents, [1, 2, 4]);
  assert.equal(result.client.listenerCount('messageCreate'), 0);
});

function gatewayDiscordDeps(Client) {
  return {
    Client,
    Events: { MessageCreate: 'messageCreate' },
    GatewayIntentBits: {
      DirectMessages: 1,
      Guilds: 2,
      GuildMessages: 4,
      MessageContent: 8,
    },
    Partials: { Channel: 'channel' },
  };
}

function incumbentGatewayFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-gateway-takeover-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const deliveryQueuePath = path.join(dir, 'pending-delivery.json');
  const ownership = {
    version: 2,
    pid: process.pid,
    generation: 'incumbent-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
    deliveryQueueLockProtocol: 'flock-v1',
    deliveryQueueLockIdentity: `${deliveryQueuePath}.lock`,
    fallback: null,
  };
  fs.writeFileSync(gatewayPidPath, `${JSON.stringify(ownership)}\n`);
  return {
    config: {
      tokenConfigured: true,
      loginDisabled: false,
      token: 'test-token',
      botUserId: 'bot',
      paths: { stateDir: dir, gatewayPidPath, deliveryQueuePath },
    },
    gatewayPidPath,
    ownership,
  };
}

test('live incumbent with a different queue identity is rejected before login or queue access', async () => {
  const { config, gatewayPidPath, ownership } = incumbentGatewayFixture();
  config.paths.deliveryQueuePath = path.join(config.paths.stateDir, 'different-queue.json');
  let clients = 0;
  let logins = 0;
  let persistenceChecks = 0;
  const { EventEmitter } = require('node:events');
  class MustNotStartDiscordClient extends EventEmitter {
    constructor() {
      super();
      clients += 1;
    }
    async login() { logins += 1; }
  }

  await assert.rejects(
    startDiscordClient({
      config,
      claimReceiver: true,
      delivery: {
        async ensurePersistenceReady() { persistenceChecks += 1; },
      },
      logger: () => {},
      deps: { discord: gatewayDiscordDeps(MustNotStartDiscordClient) },
    }),
    (error) => error?.code === 'delivery_queue_lock_identity_quiescence_required',
  );

  assert.equal(clients, 0);
  assert.equal(logins, 0);
  assert.equal(persistenceChecks, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8')), ownership);
  assert.equal(fs.existsSync(`${config.paths.deliveryQueuePath}.lock`), false);
});

test('successor Discord login failure preserves incumbent durable receiver ownership', async () => {
  const { config, gatewayPidPath, ownership } = incumbentGatewayFixture();
  let destroys = 0;
  let readinessChecks = 0;
  const { EventEmitter } = require('node:events');
  class FailingDiscordClient extends EventEmitter {
    async login() { throw new Error('login failed'); }
    async destroy() {
      await new Promise((resolve) => setImmediate(resolve));
      destroys += 1;
    }
  }

  await assert.rejects(
    startDiscordClient({
      config,
      claimReceiver: true,
      delivery: {
        async ensureReady() { readinessChecks += 1; },
        async coordinateReceiverOwnership(operation) { return operation(); },
      },
      logger: () => {},
      deps: { discord: gatewayDiscordDeps(FailingDiscordClient) },
    }),
    /login failed/,
  );

  assert.equal(destroys, 1);
  assert.equal(readinessChecks, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8')), ownership);
});

test('successor app-server readiness failure preserves incumbent durable receiver ownership', async () => {
  const { config, gatewayPidPath, ownership } = incumbentGatewayFixture();
  let destroys = 0;
  let ownershipClaims = 0;
  const { EventEmitter } = require('node:events');
  class ReadyDiscordClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'bot', tag: 'bot#0001' };
    }
    async login() {}
    destroy() { destroys += 1; }
  }

  await assert.rejects(
    startDiscordClient({
      config,
      claimReceiver: true,
      delivery: {
        async ensurePersistenceReady() {},
        async ensureReady() { throw new Error('app-server unavailable'); },
        async coordinateReceiverOwnership(operation) {
          ownershipClaims += 1;
          return operation();
        },
      },
      logger: () => {},
      deps: { discord: gatewayDiscordDeps(ReadyDiscordClient) },
    }),
    /app-server unavailable/,
  );

  assert.equal(destroys, 1);
  assert.equal(ownershipClaims, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8')), ownership);
});

test('a dead receiver record is replaced automatically with an actionable warning', async () => {
  const { config, gatewayPidPath, ownership } = incumbentGatewayFixture();
  const successorPid = 20002;
  const logs = [];
  const { EventEmitter } = require('node:events');
  class ReadyDiscordClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'bot', tag: 'bot#0001' };
    }
    async login() {}
  }

  const result = await startDiscordClient({
    config,
    claimReceiver: true,
    delivery: {
      async ensurePersistenceReady() {},
      async coordinateReceiverOwnership(operation) { return operation(); },
    },
    logger: (level, message, meta) => logs.push({ level, message, meta }),
    deps: {
      discord: gatewayDiscordDeps(ReadyDiscordClient),
      isProcessAlive: (pid) => pid === successorPid,
      pid: successorPid,
      randomUUID: () => 'replacement-generation',
    },
  });

  assert.equal(result.started, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8')), {
    version: 2,
    pid: successorPid,
    generation: 'replacement-generation',
    claimedAt: readReceiverAuthoritySnapshot(config).record.claimedAt,
    deliveryQueueLockProtocol: 'flock-v1',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
    stateDir: config.paths.stateDir,
    role: 'gateway',
    fallback: null,
  });
  assert.deepEqual(logs.find((entry) => entry.message.includes('reclaiming stale')), {
    level: 'WARN',
    message: 'Automatically reclaiming stale Discord gateway receiver record',
    meta: {
      stalePid: ownership.pid,
      authorityPath: gatewayPidPath,
      action: 'replace_after_discord_login',
    },
  });
});

test('successor replaces durable receiver ownership only after login and app-server readiness', async () => {
  const { config, gatewayPidPath, ownership } = incumbentGatewayFixture();
  const successorPid = 20002;
  const events = [];
  const { EventEmitter } = require('node:events');
  class ReadyDiscordClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'bot', tag: 'bot#0001' };
    }
    async login() { events.push('login'); }
  }

  const result = await startDiscordClient({
    config,
    claimReceiver: true,
    delivery: {
      async ensurePersistenceReady() { events.push('persistence'); },
      async ensureReady() {
        events.push('readiness');
        return { available: true, threadId: 'thread-root', status: 'idle' };
      },
      async coordinateReceiverOwnership(operation) {
        events.push('coordination');
        return operation();
      },
      async activateReceiver(verifyReceiverOwnership) {
        events.push('activate');
        assert.deepEqual(verifyReceiverOwnership(), {
          active: true,
          reason: 'gateway_generation_match',
          pid: successorPid,
          generation: 'successor-generation',
        });
      },
    },
    logger: () => {},
    deps: {
      discord: gatewayDiscordDeps(ReadyDiscordClient),
      isProcessAlive: (pid) => pid === ownership.pid || pid === successorPid,
      pid: successorPid,
      randomUUID: () => 'successor-generation',
    },
  });

  assert.deepEqual(events, ['login', 'persistence', 'readiness', 'coordination', 'activate']);
  assert.equal(result.started, true);
  assert.equal(result.client.listenerCount('messageCreate'), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8')), {
    version: 2,
    pid: successorPid,
    generation: 'successor-generation',
    claimedAt: readReceiverAuthoritySnapshot(config).record.claimedAt,
    deliveryQueueLockProtocol: 'flock-v1',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
    stateDir: config.paths.stateDir,
    role: 'gateway',
    fallback: ownership,
  });
});

test('concurrent sole gateways atomically select one listener and one generation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-gateway-race-'));
  const gatewayPidPath = path.join(dir, 'session-gateway.pid');
  const config = {
    tokenConfigured: true,
    loginDisabled: false,
    token: 'test-token',
    botUserId: 'bot',
    paths: {
      stateDir: dir,
      gatewayPidPath,
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  };
  const clients = [];
  const { EventEmitter } = require('node:events');
  class ReadyDiscordClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'bot', tag: 'bot#0001' };
      this.destroyed = false;
      clients.push(this);
    }
    async login() {}
    destroy() {
      this.destroyed = true;
      this.removeAllListeners();
    }
  }
  let coordination = Promise.resolve();
  const delivery = {
    async ensurePersistenceReady() {},
    coordinateReceiverOwnership(operation) {
      const result = coordination.then(operation, operation);
      coordination = result.catch(() => {});
      return result;
    },
  };
  const generations = ['generation-a', 'generation-b'];

  const results = await Promise.allSettled([
    startDiscordClient({
      config,
      claimReceiver: true,
      delivery,
      logger: () => {},
      deps: {
        discord: gatewayDiscordDeps(ReadyDiscordClient),
        randomUUID: () => generations.shift(),
      },
    }),
    startDiscordClient({
      config,
      claimReceiver: true,
      delivery,
      logger: () => {},
      deps: {
        discord: gatewayDiscordDeps(ReadyDiscordClient),
        randomUUID: () => generations.shift(),
      },
    }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /ownership changed/);
  assert.equal(clients.filter((client) => client.listenerCount('messageCreate') === 1).length, 1);
  assert.equal(clients.filter((client) => client.destroyed).length, 1);
  assert.equal(readReceiverAuthoritySnapshot(config).record.generation, 'generation-a');
});

test('logger failure cannot tear down a listener after atomic authority commit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-gateway-logger-'));
  const config = {
    tokenConfigured: true,
    loginDisabled: false,
    token: 'test-token',
    botUserId: 'bot',
    paths: {
      stateDir: dir,
      gatewayPidPath: path.join(dir, 'session-gateway.pid'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
    },
  };
  const { EventEmitter } = require('node:events');
  let destroyed = false;
  class ReadyDiscordClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'bot', tag: 'bot#0001' };
    }
    async login() {}
    destroy() {
      destroyed = true;
      this.removeAllListeners();
    }
  }

  const result = await startDiscordClient({
    config,
    claimReceiver: true,
    delivery: {
      async ensurePersistenceReady() {},
      async coordinateReceiverOwnership(operation) { return operation(); },
    },
    logger() { throw new Error('injected logger failure'); },
    deps: {
      discord: gatewayDiscordDeps(ReadyDiscordClient),
      randomUUID: () => 'logger-generation',
    },
  });

  assert.equal(result.started, true);
  assert.equal(result.client.listenerCount('messageCreate'), 1);
  assert.equal(destroyed, false);
  assert.equal(readReceiverAuthoritySnapshot(config).record.generation, 'logger-generation');
});

test('hard crash at every takeover phase leaves incumbent effective or successor armed', () => {
  const fixture = path.join(__dirname, '..', 'fixtures', 'receiver-handoff-crash.js');
  const phases = [
    'discord_login_ready',
    'durable_queue_ready',
    'target_ready',
    'listener_armed',
    'authority_committed',
  ];

  for (const phase of phases) {
    const { config, gatewayPidPath, ownership } = incumbentGatewayFixture();
    const child = spawnSync(process.execPath, [fixture, path.dirname(gatewayPidPath), phase], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 86, `${phase}: ${child.stderr}`);
    const persisted = JSON.parse(fs.readFileSync(gatewayPidPath, 'utf8'));
    if (phase === 'authority_committed') {
      assert.equal(persisted.generation, 'successor-generation');
      assert.deepEqual(persisted.fallback, ownership);
    } else {
      assert.deepEqual(persisted, ownership);
    }
    assert.deepEqual(isCurrentDiscordReceiverOwnership(config, ownership), {
      active: true,
      reason: phase === 'authority_committed'
        ? 'gateway_generation_fallback'
        : 'gateway_generation_match',
      pid: process.pid,
      generation: ownership.generation,
    });
    assert.equal(fs.existsSync(`${gatewayPidPath}.generation`), false);
  }
});

test('same Discord event crossing authority commit is persisted exactly once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-handoff-event-race-'));
  const config = {
    botUserId: 'bot',
    deliveryMode: 'app-server',
    paths: {
      stateDir: dir,
      gatewayPidPath: path.join(dir, 'session-gateway.pid'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
      lastInboundPath: path.join(dir, 'last-inbound.json'),
    },
  };
  const incumbent = {
    version: 2,
    pid: 30001,
    generation: 'incumbent-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
    deliveryQueueLockProtocol: 'flock-v1',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
    fallback: null,
  };
  fs.writeFileSync(config.paths.gatewayPidPath, `${JSON.stringify(incumbent)}\n`);
  const alive = new Set([incumbent.pid, 30002]);
  const host = {
    async resolveTarget() {
      return { available: true, threadId: 'thread-root', status: 'active' };
    },
    onThreadIdle() { return () => {}; },
    onReconnect() { return () => {}; },
    onThreadClosed() { return () => {}; },
    status() { return { configured: true, available: true, reason: null }; },
    destroy() {},
  };
  const delivery = createDelivery(config, () => {}, {
    structuredHost: host,
    isProcessAlive: (pid) => alive.has(pid),
  });
  const accessState = normalizeAccessState({ groups: { c1: { requireMention: false } } });
  const makeHandler = (receiverOwnership, pid) => createDiscordMessageHandler({
    config,
    client: { user: { id: 'bot' } },
    delivery,
    logger: () => {},
    receiverOwnership,
    deps: {
      isProcessAlive: (candidatePid) => alive.has(candidatePid),
      loadAccessState: () => accessState,
      pid,
    },
  });
  let releaseReference;
  let markReferenceStarted;
  const referenceStarted = new Promise((resolve) => { markReferenceStarted = resolve; });
  const referenceReleased = new Promise((resolve) => { releaseReference = resolve; });
  const message = {
    guildId: 'g1',
    channelId: 'c1',
    id: 'same-message',
    author: { id: 'user-1', username: 'Alice', bot: false },
    content: 'one event',
    attachments: [],
    reference: { messageId: 'parent' },
    async fetchReference() {
      markReferenceStarted();
      await referenceReleased;
      return { author: { id: 'user-0' }, content: 'parent' };
    },
  };
  const incumbentHandling = makeHandler(incumbent, incumbent.pid)(message);
  await referenceStarted;

  const snapshot = readReceiverAuthoritySnapshot(config, {
    isProcessAlive: (pid) => alive.has(pid),
    pid: 30002,
  });
  const successor = createReceiverOwnership(incumbent, {
    pid: 30002,
    randomUUID: () => 'successor-generation',
    deliveryQueueLockIdentity: getDeliveryQueueLockIdentity(config),
  });
  commitReceiverOwnership(config, snapshot, successor, { pid: 30002 });
  await makeHandler(successor, successor.pid)({ ...message, reference: null, fetchReference: undefined });
  releaseReference();
  await incumbentHandling;

  const queue = JSON.parse(fs.readFileSync(config.paths.deliveryQueuePath, 'utf8'));
  assert.deepEqual(queue.items.map((item) => item.normalized.messageId), ['same-message']);
  assert.deepEqual(queue.completed, []);
  assert.equal(queue.blocked.reason, 'thread_busy');
  delivery.destroy();
});

test('sole gateway queues while target is down and restart delivers the event exactly once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-sole-target-down-'));
  const config = {
    tokenConfigured: true,
    loginDisabled: false,
    token: 'test-token',
    botUserId: 'bot',
    deliveryMode: 'app-server',
    appServerRequestTimeoutMs: 100,
    paths: {
      stateDir: dir,
      gatewayPidPath: path.join(dir, 'session-gateway.pid'),
      deliveryQueuePath: path.join(dir, 'pending-delivery.json'),
      lastInboundPath: path.join(dir, 'last-inbound.json'),
    },
  };
  const { EventEmitter } = require('node:events');
  class ReadyDiscordClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'bot', tag: 'bot#0001' };
    }
    async login() {}
    destroy() { this.removeAllListeners(); }
  }
  const makeHost = (available, requests) => ({
    async resolveTarget() {
      return available
        ? { available: true, threadId: 'thread-root', status: 'idle' }
        : { available: false, reason: 'shared_app_server_socket_missing' };
    },
    async startTurn(params) {
      requests.push(params);
      return { turn: { id: 'turn-1' } };
    },
    async hasDelivered(_threadId, clientUserMessageId) {
      return requests.some((request) => request.clientUserMessageId === clientUserMessageId);
    },
    onThreadIdle() { return () => {}; },
    onReconnect() { return () => {}; },
    onThreadClosed() { return () => {}; },
    status() { return { configured: true, available, reason: available ? null : 'shared_app_server_socket_missing' }; },
    destroy() {},
  });
  const alive = new Set([10001]);
  const firstDelivery = createDelivery(config, () => {}, {
    structuredHost: makeHost(false, []),
    isProcessAlive: (pid) => alive.has(pid),
  });
  const first = await startDiscordClient({
    config,
    claimReceiver: true,
    delivery: firstDelivery,
    logger: () => {},
    deps: {
      discord: gatewayDiscordDeps(ReadyDiscordClient),
      isProcessAlive: (pid) => alive.has(pid),
      loadAccessState: () => normalizeAccessState({ dmPolicy: 'open' }),
      pid: 10001,
      randomUUID: () => 'first-generation',
    },
  });
  const handler = first.client.listeners('messageCreate')[0];
  await handler({
    guildId: null,
    channelId: 'dm-1',
    id: 'message-1',
    author: { id: 'user-1', username: 'Alice', bot: false },
    content: 'persist me',
    attachments: [],
  });
  const queued = JSON.parse(fs.readFileSync(config.paths.deliveryQueuePath, 'utf8'));
  assert.deepEqual(queued.items.map((item) => item.normalized.messageId), ['message-1']);

  first.client.destroy();
  firstDelivery.destroy();
  alive.delete(10001);
  alive.add(10002);
  const requests = [];
  const secondDelivery = createDelivery(config, () => {}, {
    structuredHost: makeHost(true, requests),
    isProcessAlive: (pid) => alive.has(pid),
  });
  const second = await startDiscordClient({
    config,
    claimReceiver: true,
    delivery: secondDelivery,
    logger: () => {},
    deps: {
      discord: gatewayDiscordDeps(ReadyDiscordClient),
      isProcessAlive: (pid) => alive.has(pid),
      loadAccessState: () => normalizeAccessState({ dmPolicy: 'open' }),
      pid: 10002,
      randomUUID: () => 'second-generation',
    },
  });
  for (let attempts = 0; attempts < 20 && requests.length === 0; attempts += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(second.started, true);
  assert.deepEqual(requests.map((request) => request.clientUserMessageId), ['discord:dm-1:message-1']);
  const drained = JSON.parse(fs.readFileSync(config.paths.deliveryQueuePath, 'utf8'));
  assert.equal(drained.items.length, 0);
  assert.deepEqual(drained.completed.map((item) => item.messageId), ['message-1']);
  assert.equal(releaseDiscordReceiverOwnership(config, second.receiverOwnership, {
    isProcessAlive: (pid) => alive.has(pid),
    pid: 10002,
  }), true);
  second.client.destroy();
  secondDelivery.destroy();
});

test('gateway shutdown fences an in-flight admission before releasing receiver authority', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-gateway-shutdown-'));
  const eventsPath = path.join(dir, 'events.jsonl');
  const fixture = path.join(
    __dirname,
    '..',
    'fixtures',
    'gateway-shutdown-inflight-admission.js',
  );
  const gateway = path.join(__dirname, '..', '..', 'bin', 'codex-discord-channel');
  const child = spawn(process.execPath, [gateway, 'gateway'], {
    env: {
      ...process.env,
      CODEX_DISCORD_TEST_SHUTDOWN_EVENTS: eventsPath,
      NODE_OPTIONS: `--require=${fixture}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`gateway fixture did not become ready: ${stderr}`)), 5000);
    const inspect = () => {
      if (!stdout.includes('fixture-ready')) return;
      clearTimeout(timeout);
      child.stdout.off('data', inspect);
      resolve();
    };
    child.stdout.on('data', inspect);
    inspect();
  });

  assert.equal(child.kill('SIGTERM'), true);
  const [exitCode, signal] = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`gateway fixture did not stop: ${stderr}`)), 5000);
    child.once('exit', (code, exitSignal) => {
      clearTimeout(timeout);
      resolve([code, exitSignal]);
    });
  });
  const events = fs.readFileSync(eventsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).event);
  const index = (event) => events.indexOf(event);
  const lastIndex = (event) => events.lastIndexOf(event);

  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null);
  assert.equal(events.includes('enqueue_called'), false, events.join(', '));
  assert.equal(events.includes('flush_called'), false, events.join(', '));
  assert.match(stderr, /Ignoring Discord message because receiver ownership changed/);
  assert.ok(index('gateway_ready_with_inflight_admission') < index('receiver_deactivated'));
  assert.ok(index('receiver_deactivated') < index('reference_fetch_finished'));
  assert.ok(index('reference_fetch_finished') < index('client_destroy_finished'));
  assert.ok(index('client_destroy_finished') < index('drain_stop_started'));
  assert.ok(index('drain_stop_finished') < lastIndex('authority_release_started'));
  assert.ok(lastIndex('authority_release_started') < index('authority_released'));
  assert.ok(index('authority_released') < index('delivery_destroyed'));
});

test('wildcard handler gates reference fetch and preserves actual thread destination', async () => {
  const delivered = [];
  let fetches = 0;
  const handler = createDiscordMessageHandler({
    config: { botUserId: 'bot' }, client: { user: { id: 'bot' } }, logger: () => {},
    delivery: {
      async enqueue(normalized) { delivered.push(normalized); return { status: 'accepted' }; },
      async flush() { return { status: 'delivered' }; },
    },
    deps: {
      isActiveDiscordReceiver: () => ({ active: true, reason: 'gateway_pid_match' }),
      loadAccessState: () => normalizeAccessState({ allowFrom: ['peer'], groups: { '*': { allowBots: true } } }),
    },
  });
  const base = { guildId: 'guild', channelId: 'new-thread', id: 'source',
    channel: { isThread: () => true, parentId: 'new-parent' }, attachments: [],
    author: { id: 'unknown', username: 'Unknown', bot: true }, content: '<@bot> work',
    reference: { messageId: 'parent-source' },
    async fetchReference() { fetches += 1; return { author: { id: 'bot' }, content: 'prior' }; },
  };
  await handler(base);
  assert.equal(fetches, 0);
  assert.equal(delivered.length, 0);
  await handler({ ...base, author: { id: 'peer', username: 'Peer', bot: true } });
  assert.equal(fetches, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channelId, 'new-thread');
  assert.equal(delivered[0].policyChannelId, 'new-parent');
  assert.equal(delivered[0].messageId, 'source');
});
