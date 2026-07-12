'use strict';

const { decideAccess, loadAccessState } = require('./access-state');
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

async function resolveReferencedMessage(message, accessState) {
  if (
    !message.guildId ||
    !message.reference?.messageId ||
    !Object.hasOwn(accessState.groups, String(message.channelId || '')) ||
    typeof message.fetchReference !== 'function'
  ) {
    return null;
  }

  try {
    return await message.fetchReference();
  } catch {
    return null;
  }
}

async function startDiscordClient({ config, delivery, logger }) {
  if (!config.tokenConfigured || config.loginDisabled) {
    log(logger, 'INFO', 'Discord login disabled or token missing');
    return { started: false, client: null, reason: config.tokenConfigured ? 'login_disabled' : 'token_missing' };
  }
  configureNetwork(config, logger);

  const {
    Client,
    Events,
    GatewayIntentBits,
    Partials,
  } = require('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author?.id && client.user?.id && message.author.id === client.user.id) {
        return;
      }
      const receiver = isActiveDiscordReceiver(config);
      if (!receiver.active) {
        log(logger, 'INFO', 'Ignoring Discord message because another gateway process is active', {
          reason: receiver.reason,
          activePid: receiver.pid,
          channelId: message.channelId,
          messageId: message.id,
        });
        return;
      }
      const accessState = loadAccessState(config.paths.accessPath);
      const referencedMessage = await resolveReferencedMessage(message, accessState);
      const normalized = normalizeDiscordMessage(message, referencedMessage);
      normalized.botUserId = client.user?.id || config.botUserId || '';
      const decision = decideAccess(accessState, normalized);
      if (!decision.allowed) {
        log(logger, 'INFO', 'Discord message denied by access policy', {
          reason: decision.reason,
          channelId: normalized.channelId,
          messageId: normalized.messageId,
        });
        return;
      }
      const result = await delivery.deliver(normalized);
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
  });

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
  configureNetwork,
  resolveReferencedMessage,
  sendDiscordMessage,
  startDiscordClient,
};
