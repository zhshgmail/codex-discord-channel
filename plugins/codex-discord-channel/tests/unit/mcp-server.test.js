'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../../src/config');
const { callTool, toolList } = require('../../src/mcp-server');

const CHANNEL_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const USER_ID = '300000000000000001';
const BOT_ID = '900000000000000001';

function historyContext({ inbound = null, fetchError = null } = {}) {
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
                  return new Map([[
                    '500000000000000001',
                    {
                      id: '500000000000000001',
                      channelId,
                      guildId: GUILD_ID,
                      createdTimestamp: 1,
                      author: { id: USER_ID, username: 'Alice', bot: false },
                      content: 'hello from history',
                      attachments: new Map(),
                    },
                  ]]);
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

  assert.equal(result.structuredContent.channelId, CHANNEL_ID);
  assert.equal(result.structuredContent.messages[0].content, 'hello from history');
  assert.deepEqual(fixture.calls, [
    { channelId: CHANNEL_ID },
    { limit: 2, before: '500000000000000002' },
  ]);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('history tool defaults a missing channelId from last inbound context', async () => {
  const fixture = historyContext({ inbound: { channelId: CHANNEL_ID, messageId: '500000000000000009' } });

  const result = await callTool(fixture.context, 'discord_channel_read_history', { limit: 1 });

  assert.equal(result.structuredContent.channelId, CHANNEL_ID);
  assert.deepEqual(fixture.calls, [
    { channelId: CHANNEL_ID },
    { limit: 2 },
  ]);
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
