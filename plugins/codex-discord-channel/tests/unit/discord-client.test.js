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
  readReceiverAuthoritySnapshot,
} = require('../../src/receiver-state');
const {
  createDiscordMessageHandler,
  isCurrentDiscordReceiverOwnership,
  releaseDiscordReceiverOwnership,
  resolveReferencedMessage,
  startDiscordClient,
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
  await new Promise((resolve) => setTimeout(resolve, 20));
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
  fs.writeFileSync(gatewayPidPath, `${process.pid}\n`);
  const config = { paths: { gatewayPidPath } };
  const generations = ['generation-a', 'generation-b'];
  const deps = { fs, randomUUID: () => generations.shift() };

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
    constructor() {
      super();
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
  const ownership = {
    version: 2,
    pid: process.pid,
    generation: 'incumbent-generation',
    claimedAt: '2026-07-20T00:00:00.000Z',
    fallback: null,
  };
  fs.writeFileSync(gatewayPidPath, `${JSON.stringify(ownership)}\n`);
  return {
    config: {
      tokenConfigured: true,
      loginDisabled: false,
      token: 'test-token',
      botUserId: 'bot',
      paths: { gatewayPidPath },
    },
    gatewayPidPath,
    ownership,
  };
}

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
    paths: { gatewayPidPath },
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
    paths: { gatewayPidPath: path.join(dir, 'session-gateway.pid') },
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

  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null);
  assert.equal(events.includes('enqueue_called'), false, events.join(', '));
  assert.equal(events.includes('flush_called'), false, events.join(', '));
  assert.match(stderr, /Ignoring Discord message because receiver ownership changed/);
  assert.ok(index('gateway_ready_with_inflight_admission') < index('receiver_deactivated'));
  assert.ok(index('receiver_deactivated') < index('reference_fetch_finished'));
  assert.ok(index('reference_fetch_finished') < index('client_destroy_finished'));
  assert.ok(index('client_destroy_finished') < index('drain_stop_started'));
  assert.ok(index('drain_stop_finished') < index('authority_release_started'));
  assert.ok(index('authority_release_started') < index('authority_released'));
  assert.ok(index('authority_released') < index('delivery_destroyed'));
});
