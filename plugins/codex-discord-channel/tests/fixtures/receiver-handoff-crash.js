'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { startDiscordClient } = require('../../src/discord-client');

const stateDir = process.argv[2];
const crashPhase = process.argv[3];
const gatewayPidPath = path.join(stateDir, 'session-gateway.pid');

function checkpoint(phase) {
  if (phase === crashPhase) process.exit(86);
}

class FakeDiscordClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: 'bot', tag: 'bot#0001' };
  }

  async login() {
    checkpoint('discord_login_ready');
  }

  on(event, listener) {
    const result = super.on(event, listener);
    if (event === 'messageCreate') checkpoint('listener_armed');
    return result;
  }

  destroy() {}
}

const fsProxy = {
  ...fs,
  renameSync(source, target) {
    fs.renameSync(source, target);
    if (target !== gatewayPidPath) return;
    try {
      const record = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (record?.version === 2 && record.generation) checkpoint('authority_committed');
    } catch {}
  },
};

const config = {
  tokenConfigured: true,
  loginDisabled: false,
  token: 'test-token',
  botUserId: 'bot',
  deliveryMode: 'app-server',
  paths: {
    stateDir,
    gatewayPidPath,
    deliveryQueuePath: path.join(stateDir, 'pending-delivery.json'),
  },
};

startDiscordClient({
  config,
  claimReceiver: true,
  delivery: {
    async ensurePersistenceReady() {
      checkpoint('durable_queue_ready');
    },
    async ensureReady() {
      checkpoint('target_ready');
      return { available: true, threadId: 'thread-root', status: 'idle' };
    },
    async coordinateReceiverOwnership(operation) {
      return operation();
    },
  },
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
    fs: fsProxy,
    randomUUID: () => 'successor-generation',
  },
}).then(
  () => process.exit(0),
  () => process.exit(2),
);
