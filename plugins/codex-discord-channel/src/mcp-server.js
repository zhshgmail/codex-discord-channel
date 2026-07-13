'use strict';

const readline = require('node:readline');
const { loadConfig } = require('./config');
const {
  createDelivery,
  readDeliveryQueueStatus,
  readLastInboundContext,
  resolveReplyTarget,
} = require('./delivery');
const { sendDiscordMessage, startDiscordClient } = require('./discord-client');
const { readDiscordHistory } = require('./history');
const { claimOwner, createOwner, readOwner } = require('./owner-state');

const SERVER_NAME = 'Codex Discord Channel';
const SERVER_VERSION = '0.2.0';
const MAX_TOOL_RESULT_BYTES = 64 * 1024;

function makeLogger() {
  return (level, message, meta) => {
    const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
    process.stderr.write(`${new Date().toISOString()} ${level} ${message}${suffix}\n`);
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text, structuredContent = {}) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function historyToolResult(history) {
  return textResult(JSON.stringify(history), {
    channel: {
      id: history.channelId,
      name: history.channelName,
    },
    source: history.source,
    page: {
      hasMore: history.hasMore,
      nextBefore: history.nextBefore,
    },
    messageCount: history.messages.length,
  });
}

function historyToolResultFits(history) {
  return Buffer.byteLength(JSON.stringify(historyToolResult(history)), 'utf8') <= MAX_TOOL_RESULT_BYTES;
}

function toolList() {
  return [
    {
      name: 'discord_channel_status',
      title: 'Discord Channel Status',
      description: 'Read the current Discord channel plugin status for this Codex session.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'discord_channel_read_owner',
      title: 'Read Discord Channel Owner',
      description: 'Read the active owner for this Discord bot instance.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'discord_channel_claim_owner',
      title: 'Claim Discord Channel Owner',
      description: 'Claim this process as the active owner for the selected Discord bot instance.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'discord_channel_read_history',
      title: 'Read Discord Channel History',
      description: 'Read bounded recent history from an authorized Discord channel.',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: {
            type: 'string',
            pattern: '^[1-9]\\d{16,19}$',
            description: 'Optional Discord channel id. Defaults to the last accepted inbound Discord message.',
          },
          before: {
            type: 'string',
            pattern: '^[1-9]\\d{16,19}$',
            description: 'Optional exclusive Discord message id cursor.',
          },
          limit: { type: 'integer', minimum: 1, maximum: 25, default: 20 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: 'discord_channel_send',
      title: 'Send Discord Message',
      description: 'Send a Discord message through the session-owned bot.',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string', description: 'Optional Discord channel id. Defaults to the last accepted inbound Discord message.' },
          content: { type: 'string', description: 'Message text to send.' },
          replyTo: { type: 'string', description: 'Optional Discord message id to reply to.' },
        },
        required: ['content'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
  ];
}

function historyArgsWithDefaultChannel(args, config) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (Object.hasOwn(args, 'channelId')) return args;

  let inbound;
  try {
    inbound = readLastInboundContext(config);
  } catch {
    throw new Error('history_target_not_allowed');
  }
  const channelId = typeof inbound?.channelId === 'string' ? inbound.channelId.trim() : '';
  if (!channelId) throw new Error('history_target_not_allowed');
  return { ...args, channelId };
}

function makeContext(config, discordState) {
  return {
    config,
    discordState,
    claim() {
      return claimOwner(config.paths.ownerPath, createOwner(config));
    },
  };
}

async function callTool(context, name, args = {}) {
  if (name === 'discord_channel_status') {
    const owner = readOwner(context.config.paths.ownerPath);
    const deliveryQueue = readDeliveryQueueStatus(context.config);
    const deliveryMode = String(context.config.deliveryMode || '').toLowerCase();
    const persistenceEnabled = deliveryMode === 'tty';
    const payload = {
      instance: context.config.paths.instance,
      stateDir: context.config.paths.stateDir,
      accessPath: context.config.paths.accessPath,
      ownerPath: context.config.paths.ownerPath,
      envLoaded: context.config.envLoaded,
      tokenConfigured: context.config.tokenConfigured,
      proxyConfigured: Boolean(context.config.proxyUrl),
      insecureTls: context.config.insecureTls,
      loginDisabled: context.config.loginDisabled,
      deliveryMode: context.config.deliveryMode,
      ttyConfigured: Boolean(context.config.tty),
      ttyPidConfigured: Boolean(context.config.ttyPid),
      ttyUseSudo: context.config.ttyUseSudo,
      ttyPromptFormat: context.config.ttyPromptFormat,
      deliverySafety: persistenceEnabled ? 'queue_only' : 'persistence_disabled',
      composerReadinessSignal: persistenceEnabled ? 'unavailable' : 'not_applicable',
      ...deliveryQueue,
      discordStarted: context.discordState.started,
      discordReason: context.discordState.reason || null,
      currentOwner: owner,
      thisOwnerId: context.config.ownerId,
    };
    return textResult(JSON.stringify(payload, null, 2), payload);
  }

  if (name === 'discord_channel_read_owner') {
    const owner = readOwner(context.config.paths.ownerPath);
    return textResult(JSON.stringify(owner, null, 2), { owner });
  }

  if (name === 'discord_channel_claim_owner') {
    const owner = context.claim();
    return textResult(`Claimed Discord channel owner for instance ${owner.instance}.`, { owner });
  }

  if (name === 'discord_channel_send') {
    const target = resolveReplyTarget(args, context.config);
    const sent = await sendDiscordMessage(context.discordState.client, { ...args, ...target });
    return textResult(`Sent Discord message ${sent.messageId}.`, sent);
  }

  if (name === 'discord_channel_read_history') {
    const history = await readDiscordHistory({
      args: historyArgsWithDefaultChannel(args, context.config),
      config: context.config,
      client: context.discordState.client,
      fitsOutput: historyToolResultFits,
    });
    return historyToolResult(history);
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(context, message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Use this plugin to claim a Discord bot instance, inspect the persistent inbound queue, and send Discord replies. Inbound TTY delivery is queue-only until the host exposes verifiable structured delivery.',
    });
    return;
  }
  if (method === 'ping') {
    sendResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: toolList() });
    return;
  }
  if (method === 'tools/call') {
    try {
      const args = params != null && Object.hasOwn(params, 'arguments') ? params.arguments : {};
      const result = await callTool(context, params?.name, args);
      sendResult(id, result);
    } catch (error) {
      sendError(id, -32602, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

async function main() {
  const logger = makeLogger();
  const config = loadConfig();
  claimOwner(config.paths.ownerPath, createOwner(config));
  const delivery = createDelivery(config, logger);
  const discordState = await startDiscordClient({ config, delivery, logger }).catch((error) => {
    logger('ERROR', 'Discord startup failed', { error: error instanceof Error ? error.message : String(error) });
    return { started: false, client: null, reason: 'startup_failed' };
  });
  const context = makeContext(config, discordState);

  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void handleRequest(context, message);
  });
}

module.exports = {
  SERVER_VERSION,
  callTool,
  handleRequest,
  main,
  toolList,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
