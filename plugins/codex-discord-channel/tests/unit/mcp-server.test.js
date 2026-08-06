'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../../src/config');
const { callTool, handleRequest, toolList } = require('../../src/mcp-server');
const { beginReply } = require('../../src/reply-delivery');

const CHANNEL_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const USER_ID = '300000000000000001';
const BOT_ID = '900000000000000001';

function historyContext({ inbound = null, fetchError = null, messages = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'access.json'), JSON.stringify({
    version: 1,
    groups: { [CHANNEL_ID]: { allowFrom: [USER_ID] } },
  }));
  if (inbound) {
    fs.writeFileSync(path.join(stateDir, 'last-inbound.json'), JSON.stringify(inbound));
  }

  const calls = [];
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: {
      started: true,
      client: {
        user: { id: BOT_ID },
        channels: {
          async fetch(channelId) {
            calls.push({ channelId });
            return {
              id: channelId,
              guildId: GUILD_ID,
              type: 0,
              name: 'general',
              messages: {
                async fetch(options) {
                  calls.push(options);
                  if (fetchError) throw fetchError;
                  return new Map((messages || [{
                    id: '500000000000000001',
                    channelId,
                    guildId: GUILD_ID,
                    createdTimestamp: 1,
                    author: { id: USER_ID, username: 'Alice', bot: false },
                    content: 'hello from history',
                    attachments: new Map(),
                  }]).map((message) => [message.id, message]));
                },
              },
            };
          },
        },
      },
    },
    claim() {
      throw new Error('not used');
    },
  };
  return { calls, context };
}

async function captureHandleRequest(context, message) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    await handleRequest(context, message);
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output.trim());
}

test('history tool discovery exposes a strict bounded read-only schema', () => {
  const tool = toolList().find((item) => item.name === 'discord_channel_read_history');

  assert.deepEqual(tool, {
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
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  });
});

test('send tool discovery requires an exact source or explicit followup', () => {
  const tool = toolList().find((item) => item.name === 'discord_channel_send');

  assert.deepEqual(tool.inputSchema.required, ['channelId', 'content']);
  assert.deepEqual(tool.inputSchema.anyOf, [
    { required: ['replyTo'] },
    {
      required: ['followup'],
      properties: { followup: { const: true } },
    },
  ]);
});

test('history tool returns structured authorized history for explicit arguments', async () => {
  const fixture = historyContext();

  const result = await callTool(fixture.context, 'discord_channel_read_history', {
    channelId: CHANNEL_ID,
    before: '500000000000000002',
    limit: 1,
  });

  assert.equal(result.structuredContent.channel.id, CHANNEL_ID);
  assert.equal(result.structuredContent.messageCount, 1);
  assert.deepEqual(fixture.calls, [
    { channelId: CHANNEL_ID },
    { limit: 2, before: '500000000000000002' },
  ]);
  assert.equal(JSON.parse(result.content[0].text).messages[0].content, 'hello from history');
  assert.equal(result.content[0].text, JSON.stringify(JSON.parse(result.content[0].text)));
  assert.equal(Object.hasOwn(result.structuredContent, 'messages'), false);
});

test('history CallToolResult stays within 64 KiB and exposes message data exactly once', async () => {
  const attachments = new Map(Array.from({ length: 10 }, (_, index) => [String(index), {
    id: String(index),
    name: `attachment-${index}`,
    size: 123,
    contentType: 'text/plain',
    url: `https://example.test/${'u'.repeat(2000)}`,
  }]));
  const messages = Array.from({ length: 6 }, (_, index) => ({
    id: `50000000000000000${6 - index}`,
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    createdTimestamp: 6 - index,
    author: { id: USER_ID, username: 'Alice', bot: false },
    content: '\u0000'.repeat(30000),
    attachments,
  }));
  const fixture = historyContext({ messages });

  const result = await callTool(fixture.context, 'discord_channel_read_history', {
    channelId: CHANNEL_ID,
    limit: 6,
  });

  const history = JSON.parse(result.content[0].text);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 64 * 1024);
  assert.ok(history.messages.length > 0);
  assert.equal(history.hasMore, true);
  assert.equal(history.nextBefore, history.messages.at(-1).messageId);
  assert.equal(result.content[0].text, JSON.stringify(history));
  assert.deepEqual(result.structuredContent, {
    channel: { id: CHANNEL_ID, name: 'general' },
    source: 'guild',
    page: { hasMore: true, nextBefore: history.nextBefore },
    messageCount: history.messages.length,
  });
});

test('history tool defaults a missing channelId from last inbound context', async () => {
  const fixture = historyContext({ inbound: { channelId: CHANNEL_ID, messageId: '500000000000000009' } });

  const result = await callTool(fixture.context, 'discord_channel_read_history', { limit: 1 });

  assert.equal(result.structuredContent.channel.id, CHANNEL_ID);
  assert.deepEqual(fixture.calls, [
    { channelId: CHANNEL_ID },
    { limit: 2 },
  ]);
});

test('history JSON-RPC defaults only an absent arguments property', async () => {
  const inbound = { channelId: CHANNEL_ID, messageId: '500000000000000009' };
  const absent = historyContext({ inbound });
  const success = await captureHandleRequest(absent.context, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'discord_channel_read_history' },
  });

  assert.equal(JSON.parse(success.result.content[0].text).channelId, CHANNEL_ID);
  assert.deepEqual(absent.calls, [
    { channelId: CHANNEL_ID },
    { limit: 21 },
  ]);

  for (const args of [null, false, 0, '']) {
    const malformed = historyContext({ inbound });
    const response = await captureHandleRequest(malformed.context, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'discord_channel_read_history', arguments: args },
    });
    assert.equal(response.error?.message, 'invalid_history_args');
    assert.deepEqual(malformed.calls, []);
  }
});

test('history tool rejects an explicit null channelId instead of defaulting it', async () => {
  const fixture = historyContext({ inbound: { channelId: CHANNEL_ID, messageId: '500000000000000009' } });

  await assert.rejects(
    callTool(fixture.context, 'discord_channel_read_history', { channelId: null }),
    (error) => error.message === 'invalid_history_args',
  );
  assert.deepEqual(fixture.calls, []);
});

test('history tool rejects an explicit numeric channelId instead of defaulting it', async () => {
  const fixture = historyContext({ inbound: { channelId: CHANNEL_ID, messageId: '500000000000000009' } });

  await assert.rejects(
    callTool(fixture.context, 'discord_channel_read_history', { channelId: 123 }),
    (error) => error.message === 'invalid_history_args',
  );
  assert.deepEqual(fixture.calls, []);
});

test('history tool rejects explicit blank channelId values instead of defaulting them', async () => {
  for (const channelId of ['', '   ']) {
    const fixture = historyContext({ inbound: { channelId: CHANNEL_ID, messageId: '500000000000000009' } });

    await assert.rejects(
      callTool(fixture.context, 'discord_channel_read_history', { channelId }),
      (error) => error.message === 'invalid_history_args',
    );
    assert.deepEqual(fixture.calls, []);
  }
});

test('history tool sanitizes Discord permission and general fetch failures', async () => {
  const permissionSecret = 'permission-secret-fixture';
  const permissionError = Object.assign(new Error(permissionSecret), { status: 403 });
  const inaccessible = historyContext({ fetchError: permissionError });
  await assert.rejects(
    callTool(inaccessible.context, 'discord_channel_read_history', { channelId: CHANNEL_ID }),
    (error) => error.message === 'history_channel_inaccessible'
      && !error.message.includes(permissionSecret),
  );

  const fetchSecret = 'fetch-secret-fixture';
  const failed = historyContext({ fetchError: new Error(fetchSecret) });
  await assert.rejects(
    callTool(failed.context, 'discord_channel_read_history', { channelId: CHANNEL_ID }),
    (error) => error.message === 'history_fetch_failed'
      && !error.message.includes(fetchSecret),
  );
});

test('status reports non-secret Discord startup diagnostics', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), [
    'DISCORD_BOT_TOKEN=secret-token',
    'DISCORD_PROXY_URL=http://127.0.0.1:8080',
    'DISCORD_INSECURE_TLS=true',
  ].join('\n'));
  fs.writeFileSync(path.join(stateDir, 'pending-delivery.json'), JSON.stringify({
    version: 1,
    items: [{ normalized: { messageId: 'm1', content: 'queued-secret-content' } }],
    blocked: {
      reason: 'shared_app_server_socket_missing',
      at: '2026-07-13T00:00:00.000Z',
    },
  }));

  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: { started: false, client: null, reason: 'startup_failed' },
    delivery: {
      status() {
        return { configured: true, available: false, reason: 'shared_app_server_socket_missing' };
      },
    },
    claim() {
      throw new Error('not used');
    },
  };

  const result = await callTool(context, 'discord_channel_status');
  assert.equal(result.structuredContent.envLoaded, true);
  assert.equal(result.structuredContent.tokenConfigured, true);
  assert.equal(result.structuredContent.proxyConfigured, true);
  assert.equal(result.structuredContent.insecureTls, true);
  assert.equal(result.structuredContent.discordStarted, false);
  assert.equal(result.structuredContent.discordReason, 'startup_failed');
  assert.equal(result.structuredContent.deliverySafety, 'structured_only');
  assert.equal(result.structuredContent.structuredDeliveryState, 'unavailable');
  assert.equal(result.structuredContent.sharedAppServerConfigured, true);
  assert.equal(result.structuredContent.sharedAppServerAvailable, false);
  assert.equal(result.structuredContent.sharedAppServerReason, 'shared_app_server_socket_missing');
  assert.equal(Object.hasOwn(result.structuredContent, 'ttyAutoSubmitCompat'), false);
  assert.equal(result.structuredContent.deliveryQueueDepth, 1);
  assert.equal(result.structuredContent.deliveryBlockedReason, 'shared_app_server_socket_missing');
  assert.equal(result.structuredContent.deliveryBlockedAt, '2026-07-13T00:00:00.000Z');
  assert.equal(result.structuredContent.deliveryQueuePath, path.join(stateDir, 'pending-delivery.json'));
  assert.equal(result.content[0].text.includes('secret-token'), false);
  assert.equal(result.content[0].text.includes('127.0.0.1:8080'), false);
  assert.equal(result.content[0].text.includes('queued-secret-content'), false);
});

test('status sanitizes malformed delivery queue errors', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'pending-delivery.json'),
    '{"version":1,"items":[{"normalized":{"content":"queued-secret-content"}}],BROKEN',
  );

  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: { started: false, client: null, reason: 'startup_failed' },
    claim() {
      throw new Error('not used');
    },
  };

  const result = await callTool(context, 'discord_channel_status');
  assert.equal(result.structuredContent.deliveryBlockedReason, 'delivery_queue_unreadable');
  assert.equal(
    result.structuredContent.deliveryQueueError,
    'Unable to read persistent Discord delivery queue.',
  );
  assert.equal(JSON.stringify(result).includes('queued-secret-content'), false);
});

test('status reports when inbound persistence is disabled', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({
    HOME: home,
    DISCORD_INSTANCE: 'codex01',
    CODEX_DISCORD_DELIVERY_MODE: 'off',
  }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: { started: false, client: null, reason: 'token_missing' },
    claim() {
      throw new Error('not used');
    },
  };

  const result = await callTool(context, 'discord_channel_status');
  assert.equal(result.structuredContent.deliverySafety, 'persistence_disabled');
  assert.equal(result.structuredContent.structuredDeliveryState, 'disabled');
});

test('status ignores legacy TTY settings and reports structured-only delivery', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({
    HOME: home,
    DISCORD_INSTANCE: 'codex01',
    CODEX_DISCORD_DELIVERY_MODE: 'tty',
    CODEX_DISCORD_TTY_AUTO_SUBMIT_COMPAT: 'true',
  }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: { started: true, client: null, reason: null },
    delivery: {
      status() {
        return { configured: true, available: false, reason: 'shared_app_server_socket_missing' };
      },
    },
    claim() {
      throw new Error('not used');
    },
  };

  const result = await callTool(context, 'discord_channel_status');
  assert.equal(result.structuredContent.deliveryMode, 'app-server');
  assert.equal(result.structuredContent.ignoredDeliveryMode, 'tty');
  assert.equal(result.structuredContent.deliverySafety, 'structured_only');
  assert.equal(result.structuredContent.structuredDeliveryState, 'unavailable');
  assert.equal(Object.hasOwn(result.structuredContent, 'ttyConfigured'), false);
  assert.equal(Object.hasOwn(result.structuredContent, 'ttyAutoSubmitCompat'), false);
});

test('send tool rejects a guarded reply without exact source identity', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'last-inbound.json'), JSON.stringify({
    channelId: 'c1',
    messageId: 'm1',
  }));

  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: {
      started: true,
      client: {
        channels: {
          async fetch(channelId) {
            return {
              async send(payload) {
                return { channelId, id: 'sent1' };
              },
            };
          },
        },
      },
    },
    claim() {
      throw new Error('not used');
    },
  };

  await assert.rejects(
    callTool(context, 'discord_channel_send', { content: 'hello back' }),
    /channelId and replyTo are required/,
  );
});

test('send tool suppresses a second reply to the same inbound message', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'last-inbound.json'), JSON.stringify({
    channelId: 'c1',
    messageId: 'm1',
  }));

  const sends = [];
  const messages = new Map();
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: {
      started: true,
      client: {
        user: { id: 'bot1' },
        channels: {
          async fetch(channelId) {
            return {
              messages: {
                async fetch(query) {
                  if (query === 'm1') return { id: 'm1', channelId };
                  if (typeof query === 'string') return messages.get(query) || null;
                  return new Map(messages.entries());
                },
              },
              async send(payload) {
                sends.push({ channelId, payload });
                const response = {
                  channelId,
                  id: 'sent1',
                  nonce: payload.nonce,
                  content: payload.content,
                  reference: { messageId: payload.reply.messageReference },
                  author: { id: 'bot1' },
                };
                const durable = { ...response };
                delete durable.nonce;
                messages.set(durable.id, durable);
                return response;
              },
            };
          },
        },
      },
    },
  };

  const first = await callTool(context, 'discord_channel_send', {
    channelId: 'c1',
    replyTo: 'm1',
    content: 'first',
  });
  const repeated = await callTool(context, 'discord_channel_send', {
    channelId: 'c1',
    replyTo: 'm1',
    content: 'automatic continuation',
  });

  assert.equal(first.structuredContent.duplicateSuppressed, false);
  assert.equal(repeated.structuredContent.duplicateSuppressed, true);
  assert.equal(repeated.structuredContent.reason, 'source_message_already_replied');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.reply.messageReference, 'm1');
  assert.equal(sends[0].payload.reply.failIfNotExists, true);
  assert.equal(sends[0].payload.enforceNonce, true);
  assert.match(sends[0].payload.nonce, /^cdr-[0-9a-f]{21}$/);
});

test('send tool recovers a failed network send without consuming the exact source reply', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const messages = new Map();
  const sends = [];
  let failFirst = true;
  const channel = {
    messages: {
      async fetch(query) {
        if (query === 'm1') return { id: 'm1', channelId: 'c1' };
        if (typeof query === 'string') return messages.get(query) || null;
        return new Map(messages.entries());
      },
    },
    async send(payload) {
      sends.push(payload);
      if (failFirst) {
        failFirst = false;
        throw new Error('fetch failed');
      }
      const message = {
        id: 'sent-after-retry',
        channelId: 'c1',
        nonce: payload.nonce,
        content: payload.content,
        reference: { messageId: payload.reply.messageReference },
        author: { id: 'bot1' },
      };
      messages.set(message.id, message);
      return message;
    },
  };
  const context = {
    config,
    discordState: {
      started: true,
      client: {
        user: { id: 'bot1' },
        channels: { async fetch() { return channel; } },
      },
    },
  };
  const args = { channelId: 'c1', replyTo: 'm1', content: 'answer' };

  await assert.rejects(callTool(context, 'discord_channel_send', args), /fetch failed/);
  assert.equal(messages.size, 0);
  const receiptFiles = fs.readdirSync(config.paths.replyReceiptDir);
  assert.equal(receiptFiles.length, 1);
  const uncertain = JSON.parse(fs.readFileSync(
    path.join(config.paths.replyReceiptDir, receiptFiles[0]),
    'utf8',
  ));
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.sourceMessageId, 'm1');
  assert.equal(uncertain.outboundMessageId, undefined);
  const retry = await callTool(context, 'discord_channel_send', args);
  const duplicate = await callTool(context, 'discord_channel_send', args);

  assert.equal(sends.length, 2);
  assert.equal(sends[0].nonce, sends[1].nonce);
  assert.equal(sends[1].reply.messageReference, 'm1');
  assert.equal(retry.structuredContent.messageId, 'sent-after-retry');
  assert.equal(retry.structuredContent.duplicateSuppressed, false);
  assert.equal(duplicate.structuredContent.duplicateSuppressed, true);
  assert.equal(duplicate.structuredContent.messageId, 'sent-after-retry');
});

test('send tool creates no message when exact source binding is missing or cross-channel', async () => {
  for (const source of [null, { id: 'm1', channelId: 'other-channel' }]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
    const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
    let sendCount = 0;
    const context = {
      config,
      discordState: {
        started: true,
        client: {
          user: { id: 'bot1' },
          channels: { async fetch() {
            return {
              messages: { async fetch() { return source; } },
              async send() { sendCount += 1; },
            };
          } },
        },
      },
    };

    await assert.rejects(callTool(context, 'discord_channel_send', {
      channelId: 'c1', replyTo: 'm1', content: 'answer',
    }), /Exact Discord reply source/);
    assert.equal(sendCount, 0);
    assert.deepEqual(fs.readdirSync(config.paths.replyReceiptDir), []);
  }
});

test('send tool releases a structured Discord 4xx claim for an exact retry', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const messages = new Map();
  let rejectFirst = true;
  let sendCount = 0;
  const channel = {
    messages: {
      async fetch(query) {
        if (query === 'm1') return { id: 'm1', channelId: 'c1' };
        if (typeof query === 'string') return messages.get(query) || null;
        return new Map(messages.entries());
      },
    },
    async send(payload) {
      sendCount += 1;
      if (rejectFirst) {
        rejectFirst = false;
        const error = new Error('Invalid Form Body');
        error.status = 400;
        error.code = 50035;
        throw error;
      }
      const message = {
        id: 'retry-id', channelId: 'c1', content: payload.content, nonce: payload.nonce,
        reference: { messageId: payload.reply.messageReference }, author: { id: 'bot1' },
      };
      messages.set(message.id, message);
      return message;
    },
  };
  const context = {
    config,
    discordState: { started: true, client: {
      user: { id: 'bot1' }, channels: { async fetch() { return channel; } },
    } },
  };
  const args = { channelId: 'c1', replyTo: 'm1', content: 'answer' };

  await assert.rejects(callTool(context, 'discord_channel_send', args), /Invalid Form Body/);
  assert.deepEqual(fs.readdirSync(config.paths.replyReceiptDir), []);
  const retry = await callTool(context, 'discord_channel_send', args);
  assert.equal(sendCount, 2);
  assert.equal(retry.structuredContent.messageId, 'retry-id');
});

test('send tool rejects a foreign receipt before Discord network access', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const claimed = await beginReply(config, { channelId: 'c1', sourceMessageId: 'm1' }, 'answer');
  const foreign = JSON.parse(fs.readFileSync(claimed.file, 'utf8'));
  foreign.sourceMessageId = 'foreign-source';
  fs.writeFileSync(claimed.file, `${JSON.stringify(foreign)}\n`);
  let networkCount = 0;
  const context = {
    config,
    discordState: { started: true, client: {
      user: { id: 'bot1' },
      channels: { async fetch() { networkCount += 1; throw new Error('must not fetch'); } },
    } },
  };

  const result = await callTool(context, 'discord_channel_send', {
    channelId: 'c1', replyTo: 'm1', content: 'answer',
  });
  assert.equal(networkCount, 0);
  assert.equal(result.structuredContent.duplicateSuppressed, true);
  assert.equal(result.structuredContent.reason, 'source_message_reply_receipt_identity_mismatch');
});

test('send tool cannot reconcile when the expected bot author is unavailable', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const claimed = await beginReply(config, { channelId: 'c1', sourceMessageId: 'm1' }, 'answer');
  const uncertain = JSON.parse(fs.readFileSync(claimed.file, 'utf8'));
  uncertain.status = 'uncertain';
  fs.writeFileSync(claimed.file, `${JSON.stringify(uncertain)}\n`);
  let sendCount = 0;
  const context = {
    config,
    discordState: { started: true, client: {
      user: { id: '' },
      channels: { async fetch() {
        return {
          messages: { async fetch() {
            return { id: 'm1', channelId: 'c1', content: 'answer', nonce: uncertain.nonce,
              reference: { messageId: 'm1' }, author: { id: 'foreign-bot' } };
          } },
          async send() { sendCount += 1; },
        };
      } },
    } },
  };

  await assert.rejects(callTool(context, 'discord_channel_send', {
    channelId: 'c1', replyTo: 'm1', content: 'answer',
  }), /Expected Discord bot author identity is unavailable/);
  assert.equal(sendCount, 0);
});
