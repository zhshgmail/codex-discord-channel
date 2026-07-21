'use strict';

const { loadConfig } = require('./config');
const { createDelivery, resolveReplyTarget } = require('./delivery');
const { configureNetwork, releaseDiscordReceiverOwnership, startDiscordClient } = require('./discord-client');
const { createAppServerHost } = require('./app-server-host');
const { startGatewayDrainLoop } = require('./gateway-drain-loop');
const { claimOwner, createOwner } = require('./owner-state');
const { runSession } = require('./session-launcher');

function usage() {
  process.stderr.write([
    'Usage:',
    '  codex-discord-channel                   # run MCP server',
    '  codex-discord-channel gateway           # run Discord gateway without MCP stdio',
    '  codex-discord-channel gateway-probe [--timeout-ms MS] [--exercise-turn]',
    '  codex-discord-channel runtime-deps-check',
    '  codex-discord-channel send [--channel CHANNEL_ID] [--reply-to MESSAGE_ID]',
    '  codex-discord-session [CODEX_ARGS...]   # start/reuse app-server and attach a future session',
    '',
    'The send command reads message text from stdin. Without --channel it replies to the last accepted inbound Discord message.',
  ].join('\n'));
  process.stderr.write('\n');
}

function parseSendArgs(argv) {
  const args = { channelId: '', replyTo: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--channel') {
      args.channelId = argv[index + 1] || '';
      index += 1;
    } else if (arg === '--reply-to') {
      args.replyTo = argv[index + 1] || '';
      index += 1;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function parseGatewayProbeArgs(argv) {
  const args = { exerciseTurn: false, timeoutMs: 10000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--timeout-ms') {
      const raw = argv[index + 1] || '';
      if (!/^\d+$/.test(raw) || Number(raw) <= 0 || Number(raw) > 300000) {
        throw new Error('Gateway probe timeout must be a positive integer no greater than 300000.');
      }
      args.timeoutMs = Number(raw);
      index += 1;
    } else if (arg === '--exercise-turn') {
      args.exerciseTurn = true;
    } else {
      throw new Error(`Unknown gateway probe argument: ${arg}`);
    }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { text += chunk; });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(text));
  });
}

async function sendViaRest(args) {
  const content = (await readStdin()).trim();
  if (!content) throw new Error('stdin message content is required');

  const config = loadConfig();
  const target = resolveReplyTarget(args, config);
  if (!config.tokenConfigured) throw new Error(`Discord token is not configured in ${config.paths.envFile}`);
  configureNetwork(config, () => {});

  const payload = { content };
  if (target.replyTo) {
    payload.message_reference = {
      message_id: target.replyTo,
      channel_id: target.channelId,
      fail_if_not_exists: false,
    };
  }
  const response = await fetch(`https://discord.com/api/v10/channels/${target.channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = {};
  }
  if (!response.ok) throw new Error(`Discord send failed ${response.status}: ${body.message || bodyText}`);
  process.stdout.write(`${JSON.stringify({ channelId: body.channel_id, messageId: body.id })}\n`);
}

function makeLogger() {
  return (level, message, meta) => {
    const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`;
    process.stderr.write(`${new Date().toISOString()} ${level} ${message}${suffix}\n`);
  };
}

function enabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

async function runGateway() {
  const logger = makeLogger();
  const config = loadConfig();
  const delivery = createDelivery(config, logger);
  let discordState;
  try {
    discordState = await startDiscordClient({ config, delivery, logger, claimReceiver: true });
  } catch (error) {
    delivery.destroy();
    throw error;
  }
  if (!discordState.started) {
    delivery.destroy();
    throw new Error(`Discord gateway did not start: ${discordState.reason || 'unknown'}`);
  }
  const drainLoop = startGatewayDrainLoop({
    config,
    delivery,
    receiverOwnership: discordState.receiverOwnership,
    logger,
  });
  if (enabled(config.env.CODEX_DISCORD_GATEWAY_CLAIM_OWNER)) {
    try {
      claimOwner(config.paths.ownerPath, createOwner(config));
    } catch (error) {
      logger('ERROR', 'Failed to update optional Discord owner metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const keepAlive = setInterval(() => {}, 2 ** 30);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    if (typeof delivery.deactivateReceiver === 'function') delivery.deactivateReceiver();
    try {
      if (discordState.client?.destroy) await discordState.client.destroy();
    } catch {}
    await drainLoop.stop();
    try {
      await delivery.coordinateReceiverOwnership(() => releaseDiscordReceiverOwnership(
        config,
        discordState.receiverOwnership,
      ));
    } catch {}
    if (typeof delivery.destroy === 'function') delivery.destroy();
  };
  process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
}

async function boundedGatewayProbe(host, args, deps = {}) {
  const schedule = deps.setTimeout || setTimeout;
  const cancel = deps.clearTimeout || clearTimeout;
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = schedule(
      () => reject(new Error(`Gateway probe timed out after ${args.timeoutMs} ms.`)),
      args.timeoutMs,
    );
  });
  try {
    return await Promise.race([
      (async () => {
        const target = await host.resolveTarget();
        if (!target.available) throw new Error(`Structured target unavailable: ${target.reason}`);
        let turnStarted = false;
        if (args.exerciseTurn) {
          if (target.status !== 'idle') throw new Error(`Structured target is not idle: ${target.status}`);
          await host.startTurn({
            threadId: target.threadId,
            clientUserMessageId: `discord:gateway-probe:${process.pid}:${Date.now()}`,
            input: [{ type: 'text', text: '[Discord gateway probe]' }],
          }, target);
          turnStarted = true;
        }
        return {
          available: true,
          status: target.status,
          threadId: target.threadId,
          turnStarted,
        };
      })(),
      timeout,
    ]);
  } finally {
    cancel(timer);
    host.destroy();
  }
}

async function runGatewayProbe(args) {
  const config = {
    ...loadConfig(),
    appServerConnectTimeoutMs: args.timeoutMs,
    appServerRequestTimeoutMs: args.timeoutMs,
  };
  return boundedGatewayProbe(createAppServerHost(config), args);
}

function runtimeDepsCheck() {
  const discord = require('discord.js');
  const undici = require('undici');
  const ws = require('ws');
  return {
    discordJs: typeof discord.Client === 'function',
    undici: typeof undici.fetch === 'function',
    ws: typeof ws.WebSocket === 'function' || typeof ws === 'function',
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === 'mcp') {
    if (command === 'mcp' && rest.length > 0) throw new Error('mcp does not accept arguments.');
    await require('./mcp-server').main();
    return;
  }
  if (command === 'send') {
    const args = parseSendArgs(rest);
    if (args.help) return usage();
    await sendViaRest(args);
    return;
  }
  if (command === 'gateway') return runGateway();
  if (command === 'gateway-probe') {
    const result = await runGatewayProbe(parseGatewayProbeArgs(rest));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'runtime-deps-check') {
    if (rest.length > 0) throw new Error('runtime-deps-check does not accept arguments.');
    process.stdout.write(`${JSON.stringify(runtimeDepsCheck())}\n`);
    return;
  }
  if (command === 'session') {
    const code = await runSession(rest);
    process.exitCode = code;
    return;
  }
  if (command === '-h' || command === '--help') return usage();
  throw new Error(`Unknown command: ${command}`);
}

module.exports = {
  boundedGatewayProbe,
  main,
  parseGatewayProbeArgs,
  parseSendArgs,
  readStdin,
  runGatewayProbe,
  runSession,
  runtimeDepsCheck,
  sendViaRest,
};
