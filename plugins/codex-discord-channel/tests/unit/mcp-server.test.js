'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../../src/config');
const { callTool, handleRequest, toolList } = require('../../src/mcp-server');

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

  const config = loadConfig({ HOME: home, DISCORD_INSTANCE: 'codex01' }, { cwd: '/workspace' });
  const context = {
    config,
    discordState: { started: false, client: null, reason: 'startup_failed' },
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
  assert.equal(result.content[0].text.includes('secret-token'), false);
  assert.equal(result.content[0].text.includes('127.0.0.1:8080'), false);
});

test('send tool defaults to last inbound Discord message when channelId is omitted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-home-'));
  const stateDir = path.join(home, '.codex', 'channels', 'discord', 'codex01');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'last-inbound.json'), JSON.stringify({
    channelId: 'c1',
    messageId: 'm1',
  }));

  const sends = [];
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
                sends.push({ channelId, payload });
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

  const result = await callTool(context, 'discord_channel_send', { content: 'hello back' });
  assert.equal(result.structuredContent.channelId, 'c1');
  assert.equal(result.structuredContent.messageId, 'sent1');
  assert.deepEqual(sends, [{
    channelId: 'c1',
    payload: {
      content: 'hello back',
      reply: { messageReference: 'm1', failIfNotExists: false },
    },
  }]);
});
