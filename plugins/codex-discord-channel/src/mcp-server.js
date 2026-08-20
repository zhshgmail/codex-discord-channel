'use strict';

const readline = require('node:readline');
const { loadMcpConfig } = require('./mcp-config');
const {
  createDelivery,
  readDeliveryQueueStatus,
  readLastInboundContext,
} = require('./delivery');
const {
  confirmDiscordMessage,
  prepareDiscordMessageSend,
  reconcileDiscordMessage,
  sendDiscordMessage,
  startDiscordClient,
} = require('./discord-client');
const { readDiscordHistory } = require('./history');
const { claimOwner, createOwner, readOwner } = require('./owner-state');
const { sendDiscordReplyOnce } = require('./reply-delivery');

const SERVER_NAME = 'Codex Discord Channel';
const SERVER_VERSION = '0.3.0';
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
          channelId: { type: 'string', description: 'Exact Discord channel id. Required for replies and followups.' },
          content: { type: 'string', description: 'Message text to send.' },
          replyTo: { type: 'string', description: 'Exact source Discord message id. Required unless followup is true.' },
          followup: {
            type: 'boolean',
            default: false,
            description: 'Explicitly allow an additional message after this source Discord message was already answered.',
          },
          followupKey: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            pattern: '^[A-Za-z0-9._:-]+$',
            description: 'Stable caller-chosen idempotency key for one explicit followup.',
          },
        },
        required: ['channelId', 'content'],
        anyOf: [
          {
            required: ['replyTo'],
            not: { required: ['followup'] },
          },
          {
            required: ['replyTo', 'followup', 'followupKey'],
            properties: { followup: { const: true } },
          },
        ],
        additionalProperties: false,
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

function makeContext(config, discordState, delivery = null) {
  return {
    config,
    discordState,
    delivery,
    claim() {
      return claimOwner(config.paths.ownerPath, createOwner(config));
    },
  };
}

async function callTool(context, name, args = {}) {
  if (name === 'discord_channel_status') {
    const owner = readOwner(context.config.paths.ownerPath);
    const deliveryQueue = readDeliveryQueueStatus(context.config);
    const deliveryDisabled = context.config.deliveryMode === 'off';
    const structured = context.delivery?.status?.() || {
      configured: Boolean(context.config.appServerUrl),
      available: false,
      reason: context.config.appServerUrl
        ? 'shared_app_server_not_connected'
        : 'shared_app_server_unconfigured',
    };
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
      ignoredDeliveryMode: context.config.ignoredDeliveryMode,
      deliverySafety: deliveryDisabled ? 'persistence_disabled' : 'structured_only',
      structuredDeliveryState: deliveryDisabled
        ? 'disabled'
        : (structured.available ? 'available' : 'unavailable'),
      sharedAppServerConfigured: Boolean(structured.configured),
      sharedAppServerAvailable: Boolean(structured.available),
      sharedAppServerReason: structured.reason || null,
      gatewayPidPath: context.config.paths.gatewayPidPath,
      replyReceiptDir: context.config.paths.replyReceiptDir,
      ownerIsReceiveGate: false,
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
    const sent = await sendDiscordReplyOnce({
      args,
      config: context.config,
      content: args.content,
      preflight: (target, identity) => prepareDiscordMessageSend(
        context.discordState.client,
        { ...args, ...target, ...identity },
      ),
      sender: (target, prepared, identity) => sendDiscordMessage(
        context.discordState.client,
        { ...args, ...target, ...identity },
        prepared,
      ),
      confirmer: (target, prepared, sent, receipt) => confirmDiscordMessage(
        context.discordState.client,
        { ...args, ...target, nonce: receipt.nonce, enforceNonce: true },
        prepared,
        sent,
      ),
      reconciler: (target, prepared, receipt) => reconcileDiscordMessage(
        context.discordState.client,
        { ...args, ...target, nonce: receipt.nonce, enforceNonce: true },
        prepared,
        receipt,
      ),
    });
    const message = sent.duplicateSuppressed
      ? `Suppressed duplicate Discord reply for source message ${sent.sourceMessageId}.`
      : `Sent Discord message ${sent.messageId}.`;
    return textResult(message, sent);
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
        'Use this plugin to inspect the persistent Discord inbound queue and send replies. Inbound delivery uses only a shared app-server; unavailable structured delivery remains queued and never falls back to terminal input.',
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
  const config = loadMcpConfig();
  claimOwner(config.paths.ownerPath, createOwner(config));
  const delivery = createDelivery(config, logger);
  const discordState = await startDiscordClient({ config, delivery, logger }).catch((error) => {
    logger('ERROR', 'Discord startup failed', { error: error instanceof Error ? error.message : String(error) });
    return { started: false, client: null, reason: 'startup_failed' };
  });
  const context = makeContext(config, discordState, delivery);

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
