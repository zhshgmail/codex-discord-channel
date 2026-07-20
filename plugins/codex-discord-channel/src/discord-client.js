'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { decideAccess, decideGuildEnvelopeAccess, loadAccessState } = require('./access-state');
const { normalizeDiscordMessage } = require('./delivery');
const { isActiveDiscordReceiver } = require('./receiver-state');

function log(logger, level, message, meta) {
  if (typeof logger === 'function') logger(level, message, meta);
}

function configureNetwork(config, logger) {
  if (config.insecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  try {
    const { Agent, ProxyAgent, setGlobalDispatcher } = require('undici');
    if (config.proxyUrl) {
      setGlobalDispatcher(new ProxyAgent({
        uri: config.proxyUrl,
        requestTls: { rejectUnauthorized: !config.insecureTls },
        proxyTls: { rejectUnauthorized: !config.insecureTls },
      }));
      log(logger, 'INFO', 'Configured Discord HTTP proxy');
    } else if (config.insecureTls) {
      setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
    }
  } catch (error) {
    log(logger, 'WARN', 'Failed to configure Discord network dispatcher', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (config.proxyUrl && !('bun' in process.versions)) {
    try {
      process.versions.bun = 'codex-discord-channel';
      log(logger, 'INFO', 'Configured Discord gateway to use global WebSocket');
    } catch (error) {
      log(logger, 'WARN', 'Failed to configure Discord gateway WebSocket mode', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function getDiscordReceiverOwnershipPath(config = {}) {
  if (config.paths?.receiverOwnershipPath) return config.paths.receiverOwnershipPath;
  const gatewayPidPath = config.paths?.gatewayPidPath || '';
  return gatewayPidPath ? `${gatewayPidPath}.generation` : '';
}

function readDiscordReceiverOwnership(config = {}, deps = {}) {
  const ownershipPath = getDiscordReceiverOwnershipPath(config);
  if (!ownershipPath) return null;
  const fsImpl = deps.fs || fs;
  try {
    const record = JSON.parse(fsImpl.readFileSync(ownershipPath, 'utf8'));
    if (
      record?.version !== 1 ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.generation !== 'string' ||
      record.generation === '' ||
      typeof record.claimedAt !== 'string'
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

function claimDiscordReceiverOwnership(config = {}, deps = {}) {
  const checkReceiver = deps.isActiveDiscordReceiver || isActiveDiscordReceiver;
  const receiver = checkReceiver(config);
  if (!receiver.active) {
    throw new Error(`Cannot claim Discord receiver ownership: ${receiver.reason || 'inactive_receiver'}.`);
  }
  const ownershipPath = getDiscordReceiverOwnershipPath(config);
  if (!ownershipPath) throw new Error('Discord receiver ownership path is not configured.');
  const fsImpl = deps.fs || fs;
  const generation = (deps.randomUUID || randomUUID)();
  const record = {
    version: 1,
    pid: Number(receiver.pid) || process.pid,
    generation,
    claimedAt: new Date().toISOString(),
  };
  fsImpl.mkdirSync(path.dirname(ownershipPath), { recursive: true, mode: 0o700 });
  const temp = `${ownershipPath}.${record.pid}.${generation}.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fsImpl.renameSync(temp, ownershipPath);
  } finally {
    try {
      fsImpl.rmSync(temp, { force: true });
    } catch {}
  }

  const rechecked = checkReceiver(config);
  if (!rechecked.active || (Number(rechecked.pid) || process.pid) !== record.pid) {
    throw new Error('Discord receiver ownership changed while claiming its generation.');
  }
  return record;
}

function isCurrentDiscordReceiverOwnership(config = {}, expected, deps = {}) {
  const receiver = (deps.isActiveDiscordReceiver || isActiveDiscordReceiver)(config);
  if (!receiver.active) return receiver;
  const persisted = readDiscordReceiverOwnership(config, deps);
  if (
    !expected ||
    !persisted ||
    persisted.pid !== expected.pid ||
    persisted.generation !== expected.generation ||
    (Number(receiver.pid) || process.pid) !== expected.pid
  ) {
    return {
      active: false,
      reason: 'gateway_generation_changed',
      pid: Number(receiver.pid) || 0,
    };
  }
  return {
    active: true,
    reason: 'gateway_generation_match',
    pid: expected.pid,
    generation: expected.generation,
  };
}

async function resolveReferencedMessage(message, accessState) {
  if (
    !message.guildId ||
    !message.reference?.messageId ||
    typeof message.fetchReference !== 'function'
  ) {
    return null;
  }

  const envelopeDecision = decideGuildEnvelopeAccess(accessState, normalizeDiscordMessage(message));
  if (!envelopeDecision.allowed) return null;

  try {
    return await message.fetchReference();
  } catch {
    return null;
  }
}

function createDiscordMessageHandler({
  config,
  delivery,
  logger,
  client,
  receiverOwnership = null,
  deps = {},
}) {
  let messageOperations = Promise.resolve();
  const verifyReceiverOwnership = () => {
    if (!receiverOwnership) {
      return (deps.isActiveDiscordReceiver || isActiveDiscordReceiver)(config);
    }
    return (deps.isCurrentDiscordReceiverOwnership || isCurrentDiscordReceiverOwnership)(
      config,
      receiverOwnership,
      deps,
    );
  };
  const admitMessage = async (message) => {
    try {
      if (message.author?.id && client.user?.id && message.author.id === client.user.id) {
        return null;
      }
      const receiver = verifyReceiverOwnership();
      if (!receiver.active) {
        log(logger, 'INFO', 'Ignoring Discord message because another gateway process is active', {
          reason: receiver.reason,
          activePid: receiver.pid,
          channelId: message.channelId,
          messageId: message.id,
        });
        return null;
      }
      const accessState = (deps.loadAccessState || loadAccessState)(config.paths?.accessPath);
      const referencedMessage = await resolveReferencedMessage(message, accessState);
      const receiverAfterReference = verifyReceiverOwnership();
      if (!receiverAfterReference.active) {
        log(logger, 'INFO', 'Ignoring Discord message because receiver ownership changed', {
          reason: receiverAfterReference.reason,
          activePid: receiverAfterReference.pid,
          channelId: message.channelId,
          messageId: message.id,
        });
        return null;
      }
      const normalized = normalizeDiscordMessage(message, referencedMessage);
      normalized.botUserId = client.user?.id || config.botUserId || '';
      const decision = decideAccess(accessState, normalized);
      if (!decision.allowed) {
        log(logger, 'INFO', 'Discord message denied by access policy', {
          reason: decision.reason,
          channelId: normalized.channelId,
          messageId: normalized.messageId,
        });
        return null;
      }
      const result = await delivery.enqueue(normalized, { verifyReceiverOwnership });
      return { normalized, result };
    } catch (error) {
      log(logger, 'ERROR', 'Discord message handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
  const drainAdmittedMessage = async (admission) => {
    if (!admission) return;
    const { normalized } = admission;
    try {
      const result = admission.result.status === 'accepted'
        ? await delivery.flush()
        : admission.result;
      log(logger, 'INFO', 'Discord message delivery result', {
        status: result.status,
        reason: result.reason,
        channelId: normalized.channelId,
        messageId: normalized.messageId,
      });
    } catch (error) {
      log(logger, 'ERROR', 'Discord message handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (message) => {
    const result = messageOperations.then(
      () => admitMessage(message),
      () => admitMessage(message),
    );
    messageOperations = result.catch(() => {});
    return result.then(drainAdmittedMessage);
  };
}

async function startDiscordClient({ config, delivery, logger, deps = {} }) {
  if (!config.tokenConfigured || config.loginDisabled) {
    log(logger, 'INFO', 'Discord login disabled or token missing');
    return { started: false, client: null, reason: config.tokenConfigured ? 'login_disabled' : 'token_missing' };
  }
  configureNetwork(config, logger);

  const receiver = (deps.isActiveDiscordReceiver || isActiveDiscordReceiver)(config);
  let receiverOwnership = null;
  if (receiver.active) {
    if (typeof delivery.coordinateReceiverOwnership !== 'function') {
      throw new Error('Discord delivery does not provide durable receiver ownership coordination.');
    }
    receiverOwnership = await delivery.coordinateReceiverOwnership(
      () => claimDiscordReceiverOwnership(config, deps),
    );
  }

  const {
    Client,
    Events,
    GatewayIntentBits,
    Partials,
  } = deps.discord || require('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  if (receiverOwnership) {
    client.on(Events.MessageCreate, createDiscordMessageHandler({
      config,
      delivery,
      logger,
      client,
      receiverOwnership,
      deps,
    }));
  }

  await client.login(config.token);
  log(logger, 'INFO', 'Discord gateway connected', {
    user: client.user?.tag || client.user?.id || 'unknown',
  });
  return { started: true, client };
}

async function sendDiscordMessage(client, args) {
  if (!client) {
    throw new Error('Discord client is not running. Configure DISCORD_BOT_TOKEN and restart the plugin session.');
  }
  if (!args || typeof args.channelId !== 'string' || args.channelId.trim() === '') {
    throw new Error('channelId is required.');
  }
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    throw new Error('content is required.');
  }
  const channel = await client.channels.fetch(args.channelId.trim());
  if (!channel || typeof channel.send !== 'function') {
    throw new Error('Target channel cannot receive messages.');
  }
  const payload = { content: args.content };
  if (typeof args.replyTo === 'string' && args.replyTo.trim() !== '') {
    payload.reply = { messageReference: args.replyTo.trim(), failIfNotExists: false };
  }
  const sent = await channel.send(payload);
  return { channelId: sent.channelId, messageId: sent.id };
}

module.exports = {
  claimDiscordReceiverOwnership,
  configureNetwork,
  createDiscordMessageHandler,
  isCurrentDiscordReceiverOwnership,
  readDiscordReceiverOwnership,
  resolveReferencedMessage,
  sendDiscordMessage,
  startDiscordClient,
};
