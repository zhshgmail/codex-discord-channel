'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const { normalizeAccessState } = require('../../src/access-state');
const { createDiscordMessageHandler } = require('../../src/discord-client');

const eventsPath = process.env.CODEX_DISCORD_TEST_SHUTDOWN_EVENTS;
if (!eventsPath) throw new Error('CODEX_DISCORD_TEST_SHUTDOWN_EVENTS is required');

function record(event) {
  fs.appendFileSync(eventsPath, `${JSON.stringify({ event })}\n`);
}

let receiverActive = true;
let releaseReference;
let handling;

const delivery = {
  async activateReplySender() {
    record('reply_sender_activated');
    return { status: 'idle', reason: 'reply_queue_empty' };
  },
  async enqueue() {
    record('enqueue_called');
    return { status: 'accepted', reason: 'discord_message_persisted' };
  },
  async flush() {
    record('flush_called');
    return { status: 'delivered', reason: 'turn_accepted' };
  },
  deactivateReceiver() {
    receiverActive = false;
    record('receiver_deactivated');
  },
  async coordinateReceiverOwnership(callback) {
    record('authority_release_started');
    const result = await callback();
    record('authority_release_finished');
    return result;
  },
  destroy() {
    record('delivery_destroyed');
  },
};

const config = {
  botUserId: 'bot',
  env: {},
  paths: {
    accessPath: '/unused/access.json',
    ownerPath: '/unused/owner.json',
  },
};

const discordClient = {
  configureNetwork() {},
  releaseDiscordReceiverOwnership() {
    record('authority_released');
    return true;
  },
  async startDiscordClient({ logger }) {
    let markReferenceStarted;
    const referenceStarted = new Promise((resolve) => {
      markReferenceStarted = resolve;
    });
    const referenceReleased = new Promise((resolve) => {
      releaseReference = resolve;
    });
    const receiverOwnership = {
      version: 2,
      pid: process.pid,
      generation: 'shutdown-test-generation',
      claimedAt: '2026-07-20T00:00:00.000Z',
      fallback: null,
    };
    const handler = createDiscordMessageHandler({
      config,
      delivery,
      logger,
      client: { user: { id: 'bot' } },
      receiverOwnership,
      deps: {
        isCurrentDiscordReceiverOwnership: () => ({
          active: receiverActive,
          reason: receiverActive ? 'gateway_generation_match' : 'gateway_generation_changed',
        }),
        loadAccessState: () => normalizeAccessState({
          groups: { group: { requireMention: false } },
        }),
      },
    });
    handling = handler({
      guildId: 'guild',
      channelId: 'group',
      id: 'inflight-message',
      author: { id: 'peer', username: 'Peer', bot: false },
      content: 'in flight',
      attachments: [],
      reference: { messageId: 'parent' },
      async fetchReference() {
        record('reference_fetch_started');
        markReferenceStarted();
        await referenceReleased;
        record('reference_fetch_finished');
        return { author: { id: 'parent' }, content: 'parent' };
      },
    });
    await referenceStarted;

    return {
      started: true,
      receiverOwnership,
      client: {
        async destroy() {
          record('client_destroy_started');
          releaseReference();
          await handling;
          record('client_destroy_finished');
        },
      },
    };
  },
};

const drainLoop = {
  startGatewayDrainLoop() {
    record('drain_loop_started');
    setImmediate(() => {
      record('gateway_ready_with_inflight_admission');
      process.stdout.write('fixture-ready\n');
    });
    return {
      async stop() {
        record('drain_stop_started');
        await handling;
        record('drain_stop_finished');
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (parent?.filename?.endsWith(path.join('bin', 'codex-discord-channel'))) {
    if (request === '../src/config') return { loadConfig: () => config };
    if (request === '../src/discord-client') return discordClient;
    if (request === '../src/delivery') {
      return { createDelivery: () => delivery, resolveReplyTarget: () => ({}) };
    }
    if (request === '../src/gateway-drain-loop') return drainLoop;
    if (request === '../src/owner-state') {
      return { claimOwner() {}, createOwner() { return {}; } };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
