'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../../src/config');
const { callTool } = require('../../src/mcp-server');
const {
  bindOwnerDelivery,
  claimOwner,
  createOwner,
  readOwner,
} = require('../../src/owner-state');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-sender-admission-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });

  function config(ownerId, threadId, turnId) {
    return loadConfig({
      HOME: home,
      DISCORD_INSTANCE: 'codex01',
      DISCORD_CONFIG_DIR: stateDir,
      CODEX_DISCORD_OWNER_ID: ownerId,
      CODEX_THREAD_ID: threadId,
      CODEX_TURN_ID: turnId,
    }, { cwd: '/workspace' });
  }

  function writeInbound({ messageId = 'm1', threadId = 'thread-a', turnId = 'turn-a' } = {}) {
    fs.writeFileSync(path.join(stateDir, 'last-inbound.json'), `${JSON.stringify({
      version: 2,
      channelId: 'c1',
      messageId,
      delivery: { threadId, turnId },
    })}\n`);
  }

  return { config, home, stateDir, writeInbound };
}

async function claim(config, expected = readOwner(config.paths.ownerPath)) {
  return claimOwner(
    config.paths.ownerPath,
    createOwner(config),
    { expected },
  );
}

async function bindDelivery(config, {
  messageId = 'm1', threadId = 'thread-a', turnId = 'turn-a',
} = {}) {
  return bindOwnerDelivery(config, {
    channelId: 'c1', sourceMessageId: messageId, threadId, turnId,
  });
}

function makeClient(controls = {}) {
  const sent = new Map();
  let sendCount = 0;
  let preflightCount = 0;
  const channel = {
    messages: {
      async fetch(query) {
        if (query === 'm1' || query === 'm2') return { id: query, channelId: 'c1' };
        if (typeof query === 'string') return sent.get(query) || null;
        return new Map(sent.entries());
      },
    },
    async send(payload) {
      sendCount += 1;
      const message = {
        id: `out-${sendCount}`,
        channelId: 'c1',
        nonce: payload.nonce,
        content: payload.content,
        reference: payload.reply ? { messageId: payload.reply.messageReference } : null,
        author: { id: 'bot1' },
      };
      sent.set(message.id, { ...message, nonce: undefined });
      return message;
    },
  };
  return {
    client: {
      user: { id: 'bot1' },
      channels: {
        async fetch() {
          preflightCount += 1;
          if (controls.preflightStarted) controls.preflightStarted.resolve();
          if (controls.releasePreflight) await controls.releasePreflight.promise;
          return channel;
        },
      },
    },
    counts() { return { preflightCount, sendCount }; },
  };
}

function makeContext(config, capability, client) {
  const context = {
    config,
    discordState: { started: true, client },
    senderCapability: capability,
    async claim() {
      const claimed = await claim(config, context.senderCapability);
      context.senderCapability = claimed;
      return claimed;
    },
  };
  return context;
}

test('successor owner claim fences a stale guarded send before preflight', async () => {
  const state = fixture();
  state.writeInbound();
  const configA = state.config('owner-a', 'thread-a', 'turn-a');
  const configB = state.config('owner-b', 'thread-b', 'turn-b');
  const capabilityA = await claim(configA);
  const boundA = await bindDelivery(configA);
  await claim(configB, boundA);
  const harness = makeClient();
  const stale = makeContext(configA, capabilityA, harness.client);

  await assert.rejects(
    callTool(stale, 'discord_channel_send', {
      channelId: 'c1', replyTo: 'm1', content: 'stale reply',
    }),
    (error) => error.code === 'sender_capability_stale',
  );
  assert.deepEqual(harness.counts(), { preflightCount: 0, sendCount: 0 });
});

test('stale MCP claim cannot overwrite a successor owner', async () => {
  const state = fixture();
  const configA = state.config('owner-a', 'thread-a', 'turn-a');
  const configB = state.config('owner-b', 'thread-b', 'turn-b');
  const capabilityA = await claim(configA);
  const stale = makeContext(configA, capabilityA, null);
  const capabilityB = await claim(configB, capabilityA);

  await assert.rejects(
    callTool(stale, 'discord_channel_claim_owner'),
    (error) => error.code === 'owner_claim_stale',
  );
  assert.deepEqual(readOwner(configA.paths.ownerPath), capabilityB);
});

test('current MCP claim adopts its delivery-bound lineage without rotating it', async () => {
  const state = fixture();
  const config = state.config('owner-a', 'thread-a', 'turn-a');
  const capability = await claim(config);
  const bound = await bindDelivery(config);
  const context = makeContext(config, capability, null);
  context.claim = async () => {
    const claimed = await claimOwner(
      config.paths.ownerPath,
      createOwner(config),
      { expected: context.senderCapability, allowLineage: true },
    );
    context.senderCapability = claimed;
    return claimed;
  };

  const result = await callTool(context, 'discord_channel_claim_owner');

  assert.equal(result.structuredContent.owner.generation, bound.generation);
  assert.deepEqual(readOwner(config.paths.ownerPath), bound);
  assert.deepEqual(context.senderCapability, bound);
});

test('owner transfer waits for admitted send completion under one durable lock', async () => {
  const state = fixture();
  state.writeInbound();
  const configA = state.config('owner-a', 'thread-a', 'turn-a');
  const configB = state.config('owner-b', 'thread-b', 'turn-b');
  const capabilityA = await claim(configA);
  const boundA = await bindDelivery(configA);
  const preflightStarted = deferred();
  const releasePreflight = deferred();
  const harness = makeClient({ preflightStarted, releasePreflight });
  const current = makeContext(configA, capabilityA, harness.client);

  const sendPromise = callTool(current, 'discord_channel_send', {
    channelId: 'c1', replyTo: 'm1', content: 'current reply',
  });
  await preflightStarted.promise;
  let claimSettled = false;
  const claimPromise = Promise.resolve(claim(configB, boundA)).then((owner) => {
    claimSettled = true;
    return owner;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const settledBeforeSend = claimSettled;
  releasePreflight.resolve();
  await sendPromise;
  const capabilityB = await claimPromise;

  assert.equal(settledBeforeSend, false);
  assert.equal(harness.counts().sendCount, 1);
  assert.deepEqual(readOwner(configA.paths.ownerPath), capabilityB);
});

test('successor owner claim also fences a stale explicit followup', async () => {
  const state = fixture();
  state.writeInbound();
  const configA = state.config('owner-a', 'thread-a', 'turn-a');
  const configB = state.config('owner-b', 'thread-b', 'turn-b');
  const capabilityA = await claim(configA);
  const boundA = await bindDelivery(configA);
  await claim(configB, boundA);
  const harness = makeClient();
  const stale = makeContext(configA, capabilityA, harness.client);

  await assert.rejects(
    callTool(stale, 'discord_channel_send', {
      channelId: 'c1', replyTo: 'm1', followup: true, content: 'stale followup',
    }),
    (error) => error.code === 'sender_capability_stale',
  );
  assert.deepEqual(harness.counts(), { preflightCount: 0, sendCount: 0 });
});

test('delivered turn mismatch fails before preflight', async () => {
  const state = fixture();
  state.writeInbound({ threadId: 'thread-a', turnId: 'turn-current' });
  const config = state.config('owner-a', 'thread-a', 'turn-stale');
  const capability = await claim(config);
  await bindDelivery(config, { threadId: 'thread-a', turnId: 'turn-current' });
  const harness = makeClient();
  const context = makeContext(config, capability, harness.client);

  await assert.rejects(
    callTool(context, 'discord_channel_send', {
      channelId: 'c1', replyTo: 'm1', content: 'wrong turn',
    }),
    (error) => error.code === 'sender_turn_mismatch',
  );
  assert.deepEqual(harness.counts(), { preflightCount: 0, sendCount: 0 });
});

test('foreign instance and state capabilities fail before preflight', async () => {
  const state = fixture();
  const config = state.config('owner-a', 'thread-a', 'turn-a');
  const capability = await claim(config);
  await bindDelivery(config);

  for (const [mutation, code] of [
    [{ instance: 'codex02' }, 'sender_instance_mismatch'],
    [{ stateDir: path.join(state.stateDir, 'foreign') }, 'sender_state_dir_mismatch'],
  ]) {
    const harness = makeClient();
    const context = makeContext(config, { ...capability, ...mutation }, harness.client);
    await assert.rejects(
      callTool(context, 'discord_channel_send', {
        channelId: 'c1', replyTo: 'm1', content: 'foreign context',
      }),
      (error) => error.code === code,
    );
    assert.deepEqual(harness.counts(), { preflightCount: 0, sendCount: 0 });
  }
});

test('delivered source mismatch fails before preflight', async () => {
  const state = fixture();
  const config = state.config('owner-a', 'thread-a', 'turn-a');
  const capability = await claim(config);
  await bindDelivery(config);
  const harness = makeClient();
  const context = makeContext(config, capability, harness.client);

  await assert.rejects(
    callTool(context, 'discord_channel_send', {
      channelId: 'c1', replyTo: 'm2', content: 'wrong source',
    }),
    (error) => error.code === 'sender_source_mismatch',
  );
  assert.deepEqual(harness.counts(), { preflightCount: 0, sendCount: 0 });
});
