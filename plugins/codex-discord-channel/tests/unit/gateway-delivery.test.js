'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGateway } = require('../../bin/codex-discord-channel');
const { createGatewayDelivery } = require('../../src/gateway-delivery');
const { createDelivery, readDeliveryQueueStatus } = require('../../src/delivery');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, config: { env: {}, deliveryMode: 'app-server', deliveryActivationId: 'test',
    paths: { stateDir: dir, deliveryQueuePath: path.join(dir, 'queue.json'), lastInboundPath: path.join(dir, 'last.json') } } };
}
const message = id => ({ channelId: 'channel', messageId: id, authorId: 'user', authorName: 'user',
  source: 'dm', content: 'ordinary input', attachments: [] });

test('normal gateway uses the default delivery and cleans up on receiver start failure', async t => {
  const { config } = fixture(t); let destroyed = 0; const expected = { destroy() { destroyed++; } };
  await assert.rejects(runGateway(config, {
    logger: () => {}, createDiscordRestClient: () => ({}),
    createDelivery: () => expected,
    startDiscordClient: async args => { assert.equal(args.delivery, expected); assert.equal(args.claimReceiver, true); throw Error('isolated-start-failure'); },
  }), /isolated-start-failure/);
  assert.equal(destroyed, 1);
});

test('normal gateway loads only the explicitly configured local adapter, with original reply dependency', async t => {
  const { dir, config } = fixture(t); const modulePath = path.join(dir, 'adapter.cjs');
  fs.writeFileSync(modulePath, `exports.createGatewayDelivery = args => {
    if (!args.deliveryDeps.sendAutomaticReply) throw Error('reply dependency missing');
    if (args.configPath !== ${JSON.stringify(path.join(dir, 'binding.json'))}) throw Error('config mismatch');
    const result = args.createDelivery(args.config, args.logger, args.deliveryDeps);
    result.usedAdapter = true; return result;
  };`);
  config.env.CODEX_DISCORD_GATEWAY_DELIVERY_MODULE = modulePath;
  config.env.CODEX_DISCORD_GATEWAY_DELIVERY_CONFIG = path.join(dir, 'binding.json');
  let destroyed = 0;
  await assert.rejects(runGateway(config, {
    logger: () => {}, createDiscordRestClient: () => ({}), createDelivery: () => ({ destroy() { destroyed++; } }),
    startDiscordClient: async args => { assert.equal(args.delivery.usedAdapter, true); throw Error('adapter-reached-receiver'); },
  }), /adapter-reached-receiver/);
  assert.equal(destroyed, 1);
});

test('invalid opt-in cannot silently fall back to default delivery', t => {
  const { config } = fixture(t); let created = false;
  config.env.CODEX_DISCORD_GATEWAY_DELIVERY_MODULE = './from-message.cjs';
  assert.throws(() => createGatewayDelivery(config, () => {}, {}, { createDelivery() { created = true; } }), /absolute/);
  assert.equal(created, false);
});

test('ordinary idle and active inputs retain routing plus current owner context; context failure preserves FIFO', async t => {
  const { config } = fixture(t); const requests = []; let fail = true; let version = 1;
  let target = { available: true, status: 'idle', threadId: 'thread' };
  const host = { resolveTarget: async () => target, status: () => target,
    startTurn: async (params, actual) => { requests.push({ params, actual }); return { turn: { id: 'turn' } }; },
    hasDelivered: async (_thread, id) => requests.some(r => r.params.clientUserMessageId === id),
    destroy() {} };
  const delivery = createDelivery(config, () => {}, { structuredHost: host, getInputContext(fact) {
    if (fail) throw Error('context-unavailable');
    return JSON.stringify({ ...fact, snapshot: `version-${version}` });
  } });
  t.after(() => delivery.destroy());
  await assert.rejects(delivery.deliver(message('one')), /context-unavailable/);
  assert.equal(requests.length, 0);
  assert.equal(readDeliveryQueueStatus(config).deliveryQueueDepth, 1);
  assert.equal(readDeliveryQueueStatus(config).deliveryBlockedReason, null);
  fail = false; await delivery.flush();
  target = { ...target, status: 'active', activeTurnId: 'turn' }; version = 2;
  await delivery.deliver(message('two'));
  assert.equal(requests.length, 2);
  for (const [i, id] of ['one', 'two'].entries()) {
    assert.match(requests[i].params.input[0].text, new RegExp(`replyTo="${id}"`));
    const ctx = JSON.parse(requests[i].params.input[1].text);
    assert.equal(ctx.clientUserMessageId, `discord:channel:${id}`);
    assert.equal(ctx.snapshot, `version-${i + 1}`);
  }
  assert.equal(requests[1].actual.activeTurnId, 'turn');
  assert.equal(readDeliveryQueueStatus(config).deliveryQueueDepth, 0);
});
