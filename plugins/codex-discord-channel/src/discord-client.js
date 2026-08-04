'use strict';

const { decideAccess, decideGuildEnvelopeAccess, loadAccessState } = require('./access-state');
const { normalizeDiscordMessage } = require('./delivery');
const {
  commitReceiverOwnership,
  createReceiverOwnership,
  effectiveReceiverOwnership,
  isActiveDiscordReceiver,
  isCurrentReceiverOwnership,
  readReceiverAuthoritySnapshot,
  releaseReceiverOwnership,
} = require('./receiver-state');

function log(logger, level, message, meta) {
  if (typeof logger !== 'function') return;
  try {
    logger(level, message, meta);
  } catch {}
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

function isCurrentDiscordReceiverOwnership(config = {}, expected, deps = {}) {
  return isCurrentReceiverOwnership(config, expected, deps);
}

function releaseDiscordReceiverOwnership(config = {}, expected, deps = {}) {
  return releaseReceiverOwnership(config, expected, deps);
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
          policyChannelId: normalized.policyChannelId,
          threadParentId: normalized.threadParentId,
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
        ? await delivery.flush({ verifyReceiverOwnership })
        : admission.result;
      log(logger, 'INFO', 'Discord message delivery result', {
        status: result.status,
        reason: result.reason,
        channelId: normalized.channelId,
        policyChannelId: normalized.policyChannelId,
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

async function startDiscordClient({ config, delivery, logger, claimReceiver = false, deps = {} }) {
  if (!config.tokenConfigured || config.loginDisabled) {
    log(logger, 'INFO', 'Discord login disabled or token missing');
    return { started: false, client: null, reason: config.tokenConfigured ? 'login_disabled' : 'token_missing' };
  }
  configureNetwork(config, logger);

  const authoritySnapshot = readReceiverAuthoritySnapshot(config, deps);
  if (claimReceiver && !authoritySnapshot.valid) {
    throw new Error('Discord receiver authority record is invalid.');
  }
  const effectiveOwnership = effectiveReceiverOwnership(authoritySnapshot, deps)?.record || null;
  const receiver = (deps.isActiveDiscordReceiver || isActiveDiscordReceiver)(config, deps);
  const shouldReceive = claimReceiver || receiver.active;

  const {
    Client,
    Events,
    GatewayIntentBits,
    Partials,
  } = deps.discord || require('discord.js');

  const intents = [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ];
  if (config.messageContentIntent !== false) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  const client = new Client({
    intents,
    partials: [Partials.Channel],
  });

  try {
    await client.login(config.token);
    let receiverOwnership = null;
    if (shouldReceive) {
      if (typeof delivery.ensurePersistenceReady !== 'function') {
        throw new Error('Discord delivery does not provide durable queue readiness checks.');
      }
      if (typeof delivery.coordinateReceiverOwnership !== 'function') {
        throw new Error('Discord delivery does not provide durable receiver ownership coordination.');
      }
      await delivery.ensurePersistenceReady();
      if (effectiveOwnership) {
        if (typeof delivery.ensureReady !== 'function') {
          throw new Error('Discord delivery does not provide app-server readiness checks.');
        }
        await delivery.ensureReady();
      }
      const candidate = createReceiverOwnership(effectiveOwnership, deps);
      receiverOwnership = await delivery.coordinateReceiverOwnership(() => {
        const handler = createDiscordMessageHandler({
          config,
          delivery,
          logger,
          client,
          receiverOwnership: candidate,
          deps,
        });
        client.on(Events.MessageCreate, handler);
        try {
          return commitReceiverOwnership(config, authoritySnapshot, candidate, deps);
        } catch (error) {
          if (typeof client.off === 'function') client.off(Events.MessageCreate, handler);
          throw error;
        }
      });
      if (typeof delivery.activateReceiver === 'function') {
        await delivery.activateReceiver(() => (
          deps.isCurrentDiscordReceiverOwnership || isCurrentDiscordReceiverOwnership
        )(config, receiverOwnership, deps));
      }
    }
    log(logger, 'INFO', 'Discord gateway connected', {
      user: client.user?.tag || client.user?.id || 'unknown',
    });
    return { started: true, client, receiverOwnership };
  } catch (error) {
    try {
      if (typeof client.destroy === 'function') await client.destroy();
    } catch {}
    throw error;
  }
}

function validateDiscordMessageSend(client, args) {
  if (!client) {
    throw new Error('Discord client is not running. Configure DISCORD_BOT_TOKEN and restart the plugin session.');
  }
  if (!args || typeof args.channelId !== 'string' || args.channelId.trim() === '') {
    throw new Error('channelId is required.');
  }
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    throw new Error('content is required.');
  }
}

async function prepareDiscordMessageSend(client, args) {
  validateDiscordMessageSend(client, args);
  const channel = await client.channels.fetch(args.channelId.trim());
  if (!channel || typeof channel.send !== 'function') {
    throw new Error('Target channel cannot receive messages.');
  }
  const payload = { content: args.content };
  if (typeof args.nonce === 'string' && args.nonce !== '') {
    payload.nonce = args.nonce;
    payload.enforceNonce = args.enforceNonce === true;
  }
  if (typeof args.replyTo === 'string' && args.replyTo.trim() !== '') {
    payload.reply = { messageReference: args.replyTo.trim(), failIfNotExists: false };
  }
  return { channel, payload };
}

async function sendDiscordMessage(client, args, prepared = null) {
  const dispatch = prepared || await prepareDiscordMessageSend(client, args);
  const { channel, payload } = dispatch;
  const sent = await channel.send(payload);
  return { channelId: sent.channelId, messageId: sent.id };
}

function messageReplySourceId(message) {
  return String(message?.reference?.messageId || message?.messageReference?.messageId || '');
}

function messageMatchesReplyIdentity(client, message, args, expectedMessageId = '') {
  if (!message) return false;
  if (expectedMessageId && String(message.id || '') !== String(expectedMessageId)) return false;
  if (String(message.channelId || '') !== String(args.channelId || '')) return false;
  if (String(message.nonce || '') !== String(args.nonce || '')) return false;
  if (String(message.content || '') !== String(args.content || '')) return false;
  if (messageReplySourceId(message) !== String(args.replyTo || '')) return false;
  const botUserId = String(client?.user?.id || '');
  return !botUserId || String(message.author?.id || '') === botUserId;
}

function replyConfirmationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function fetchReplyMessage(channel, messageId) {
  if (typeof channel?.messages?.fetch !== 'function') {
    throw replyConfirmationError('reply_confirmation_unavailable');
  }
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if (error?.status === 404 || error?.statusCode === 404 || error?.code === 10008) return null;
    throw replyConfirmationError('reply_confirmation_failed');
  }
}

async function confirmDiscordMessage(client, args, prepared, sent) {
  const channel = prepared?.channel || await client?.channels?.fetch?.(args.channelId);
  const message = await fetchReplyMessage(channel, sent.messageId);
  if (!messageMatchesReplyIdentity(client, message, args, sent.messageId)) {
    throw replyConfirmationError('reply_confirmation_mismatch');
  }
  return { channelId: String(message.channelId), messageId: String(message.id) };
}

function messageValues(collection) {
  if (Array.isArray(collection)) return collection;
  if (collection && typeof collection.values === 'function') return [...collection.values()];
  return [];
}

async function reconcileDiscordMessage(client, args, prepared, receipt) {
  const channel = prepared?.channel || await client?.channels?.fetch?.(args.channelId);
  if (!channel || typeof channel.messages?.fetch !== 'function') {
    throw replyConfirmationError('reply_reconciliation_unavailable');
  }
  if (receipt?.outboundMessageId) {
    const exact = await fetchReplyMessage(channel, receipt.outboundMessageId);
    if (messageMatchesReplyIdentity(client, exact, args, receipt.outboundMessageId)) {
      return { found: true, channelId: String(exact.channelId), messageId: String(exact.id) };
    }
  }
  let recent;
  try {
    recent = await channel.messages.fetch({ limit: 100 });
  } catch {
    throw replyConfirmationError('reply_reconciliation_failed');
  }
  const match = messageValues(recent).find((message) => (
    messageMatchesReplyIdentity(client, message, args)
  ));
  return match
    ? { found: true, channelId: String(match.channelId), messageId: String(match.id) }
    : { found: false };
}

module.exports = {
  confirmDiscordMessage,
  configureNetwork,
  createDiscordMessageHandler,
  isCurrentDiscordReceiverOwnership,
  releaseDiscordReceiverOwnership,
  prepareDiscordMessageSend,
  reconcileDiscordMessage,
  resolveReferencedMessage,
  sendDiscordMessage,
  startDiscordClient,
  validateDiscordMessageSend,
};
