'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MessagePayload } = require('discord.js');
const { sendViaRest } = require('../../bin/codex-discord-channel');
const { beginReply } = require('../../src/reply-delivery');

const ARGS = { channelId: 'c1', replyTo: 'm1', followup: false };

function fixture(overrides = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-cli-send-'));
  return {
    stateDir,
    config: {
      token: 'test-token',
      tokenConfigured: true,
      botUserId: 'bot1',
      paths: {
        envFile: path.join(stateDir, '.env'),
        stateDir,
        replyReceiptDir: path.join(stateDir, 'reply-receipts'),
      },
      ...overrides,
    },
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body === undefined ? '' : JSON.stringify(body); },
  };
}

function restHarness(options = {}) {
  const requests = [];
  const messages = new Map();
  let postCount = 0;
  const source = Object.hasOwn(options, 'source')
    ? options.source
    : { id: 'm1', channel_id: 'c1', content: 'source', author: { id: 'user1' } };

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method || 'GET';
    const request = { method, pathname: parsed.pathname, search: parsed.search, body: init.body };
    requests.push(request);

    if (method === 'GET' && parsed.pathname.endsWith('/messages/m1')) {
      return source
        ? response(200, source)
        : response(404, { code: 10008, message: 'Unknown Message' });
    }
    if (method === 'GET' && parsed.pathname.endsWith('/messages')) {
      return response(200, [...messages.values()]);
    }
    if (method === 'GET' && parsed.pathname.includes('/messages/')) {
      const messageId = parsed.pathname.split('/').at(-1);
      const message = messages.get(messageId);
      return message
        ? response(200, message)
        : response(404, { code: 10008, message: 'Unknown Message' });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/messages')) {
      postCount += 1;
      if (options.post) return options.post({ init, messages, postCount, requests });
      const payload = JSON.parse(init.body);
      const message = {
        id: `out-${postCount}`,
        channel_id: 'c1',
        content: payload.content,
        nonce: payload.nonce,
        message_reference: payload.message_reference,
        author: { id: 'bot1' },
      };
      messages.set(message.id, message);
      return response(200, message);
    }
    throw new Error(`Unexpected Discord REST request: ${method} ${parsed.pathname}${parsed.search}`);
  };

  return { fetchImpl, messages, requests, postCount: () => postCount };
}

function runCli(config, fetchImpl, content = 'answer') {
  return sendViaRest(ARGS, {
    config,
    fetchImpl,
    configureNetwork() {},
    async readStdin() { return content; },
    writeOutput() {},
  });
}

function discordJsMessageBody(options) {
  const channel = {
    client: { options: { allowedMentions: undefined, failIfNotExists: true } },
    messages: {
      resolveId(reference) {
        return typeof reference === 'string' ? reference : reference?.id;
      },
    },
  };
  return MessagePayload.create(channel, options).resolveBody().body;
}

test('CLI reply POST matches the real discord.js MessagePayload contract', async () => {
  const { config } = fixture();
  const harness = restHarness();

  const sent = await runCli(config, harness.fetchImpl);
  const post = harness.requests.find((item) => item.method === 'POST');
  const actual = JSON.parse(post.body);
  const expected = JSON.parse(JSON.stringify(discordJsMessageBody({
    content: 'answer',
    nonce: actual.nonce,
    enforceNonce: true,
    reply: { messageReference: 'm1', failIfNotExists: true },
  })));

  assert.deepEqual(actual, expected);
  assert.equal(sent.messageId, 'out-1');
});

test('CLI confirms exact stable GET identity when Discord omits the POST nonce', async () => {
  const { config } = fixture();
  const harness = restHarness({
    post({ init, messages, postCount }) {
      const payload = JSON.parse(init.body);
      const responseMessage = {
        id: `out-${postCount}`, channel_id: 'c1', content: payload.content,
        nonce: payload.nonce, message_reference: payload.message_reference,
        author: { id: 'bot1' },
      };
      const durableMessage = { ...responseMessage };
      delete durableMessage.nonce;
      messages.set(durableMessage.id, durableMessage);
      return response(200, responseMessage);
    },
  });

  const sent = await runCli(config, harness.fetchImpl);

  assert.equal(sent.messageId, 'out-1');
  assert.equal(sent.duplicateSuppressed, false);
  assert.equal(harness.postCount(), 1);
});

test('CLI stable GET confirmation rejects foreign message identity fields', async () => {
  const attacks = [
    ['message id', { id: 'foreign-id' }],
    ['channel', { channel_id: 'foreign-channel' }],
    ['content', { content: 'foreign-content' }],
    ['reply source', { message_reference: { message_id: 'foreign-source' } }],
    ['bot author', { author: { id: 'foreign-bot' } }],
  ];

  for (const [label, mutation] of attacks) {
    const { config } = fixture();
    const harness = restHarness({
      post({ init, messages, postCount }) {
        const payload = JSON.parse(init.body);
        const responseMessage = {
          id: `out-${postCount}`, channel_id: 'c1', content: payload.content,
          nonce: payload.nonce, message_reference: payload.message_reference,
          author: { id: 'bot1' },
        };
        const durableMessage = { ...responseMessage, ...mutation };
        delete durableMessage.nonce;
        messages.set(responseMessage.id, durableMessage);
        return response(200, responseMessage);
      },
    });

    await assert.rejects(
      runCli(config, harness.fetchImpl),
      (error) => error.code === 'reply_confirmation_mismatch',
      label,
    );
    assert.equal(harness.postCount(), 1, label);
  }
});

test('CLI nonce mismatch preserves the durable id and permanently suppresses another POST', async () => {
  const { config } = fixture();
  const harness = restHarness({
    post({ init, messages, postCount }) {
      const payload = JSON.parse(init.body);
      const responseMessage = {
        id: `out-${postCount}`, channel_id: 'c1', content: payload.content,
        nonce: 'foreign-nonce', message_reference: payload.message_reference,
        author: { id: 'bot1' },
      };
      const durableMessage = { ...responseMessage };
      delete durableMessage.nonce;
      messages.set(durableMessage.id, durableMessage);
      return response(200, responseMessage);
    },
  });

  await assert.rejects(
    runCli(config, harness.fetchImpl),
    (error) => error.code === 'reply_send_response_nonce_mismatch',
  );
  const requestsAfterMismatch = harness.requests.length;
  const retry = await runCli(config, harness.fetchImpl);
  const [receiptName] = fs.readdirSync(config.paths.replyReceiptDir);
  const receipt = JSON.parse(fs.readFileSync(
    path.join(config.paths.replyReceiptDir, receiptName),
    'utf8',
  ));

  assert.equal(harness.postCount(), 1);
  assert.equal(harness.requests.length, requestsAfterMismatch);
  assert.equal(retry.duplicateSuppressed, true);
  assert.equal(retry.reason, 'source_message_reply_nonce_mismatch');
  assert.equal(retry.messageId, 'out-1');
  assert.equal(receipt.status, 'uncertain');
  assert.equal(receipt.outboundMessageId, 'out-1');
  assert.equal(receipt.errorCode, 'reply_send_response_nonce_mismatch');
});

test('CLI nonce mismatch cannot reconcile to another exact nonce match', async () => {
  const { config } = fixture();
  const harness = restHarness({
    post({ init, messages }) {
      const payload = JSON.parse(init.body);
      const responseMessage = {
        id: 'out-1', channel_id: 'c1', content: payload.content,
        nonce: 'foreign-nonce', message_reference: payload.message_reference,
        author: { id: 'bot1' },
      };
      const durableMessage = { ...responseMessage };
      delete durableMessage.nonce;
      messages.set(durableMessage.id, durableMessage);
      messages.set('substitute-id', {
        ...durableMessage, id: 'substitute-id', nonce: payload.nonce,
      });
      return response(200, responseMessage);
    },
  });

  await assert.rejects(
    runCli(config, harness.fetchImpl),
    (error) => error.code === 'reply_send_response_nonce_mismatch',
  );
  const requestsAfterMismatch = harness.requests.length;
  const retry = await runCli(config, harness.fetchImpl);

  assert.equal(harness.postCount(), 1);
  assert.equal(harness.requests.length, requestsAfterMismatch);
  assert.equal(retry.duplicateSuppressed, true);
  assert.equal(retry.reason, 'source_message_reply_nonce_mismatch');
  assert.equal(retry.messageId, 'out-1');
  assert.notEqual(retry.messageId, 'substitute-id');
});

test('CLI lost-ack replay reuses the enforced nonce and confirms one durable message', async () => {
  const { config } = fixture();
  let acceptedResponse = null;
  const harness = restHarness({
    post({ init, messages, postCount }) {
      const payload = JSON.parse(init.body);
      if (!acceptedResponse) {
        acceptedResponse = {
          id: `out-${postCount}`, channel_id: 'c1', content: payload.content,
          nonce: payload.nonce, message_reference: payload.message_reference,
          author: { id: 'bot1' },
        };
        const durableMessage = { ...acceptedResponse };
        delete durableMessage.nonce;
        messages.set(durableMessage.id, durableMessage);
        throw new Error('response lost after Discord accepted the message');
      }
      assert.equal(payload.nonce, acceptedResponse.nonce);
      assert.equal(payload.enforce_nonce, true);
      return response(200, acceptedResponse);
    },
  });

  await assert.rejects(runCli(config, harness.fetchImpl), /response lost/);
  const retry = await runCli(config, harness.fetchImpl);
  const duplicate = await runCli(config, harness.fetchImpl);

  assert.equal(harness.postCount(), 2);
  assert.equal(harness.messages.size, 1);
  assert.equal(retry.messageId, 'out-1');
  assert.equal(retry.duplicateSuppressed, false);
  assert.equal(duplicate.duplicateSuppressed, true);
  assert.equal(duplicate.reason, 'source_message_already_replied');
});

test('CLI reconciles fetch failure then confirms exact source thread and readback', async () => {
  const { config } = fixture();
  let failFirst = true;
  const harness = restHarness({
    post({ init, messages, postCount }) {
      if (failFirst) {
        failFirst = false;
        throw new Error('fetch failed');
      }
      const payload = JSON.parse(init.body);
      const message = {
        id: `out-${postCount}`, channel_id: 'c1', content: payload.content,
        nonce: payload.nonce, message_reference: payload.message_reference,
        author: { id: 'bot1' },
      };
      messages.set(message.id, message);
      return response(200, message);
    },
  });

  await assert.rejects(runCli(config, harness.fetchImpl), /fetch failed/);
  assert.equal(harness.messages.size, 0);
  const retry = await runCli(config, harness.fetchImpl);
  const requestsAfterConfirmation = harness.requests.length;
  const duplicate = await runCli(config, harness.fetchImpl);

  assert.equal(harness.postCount(), 2);
  const posts = harness.requests.filter((item) => item.method === 'POST');
  const firstPayload = JSON.parse(posts[0].body);
  const retryPayload = JSON.parse(posts[1].body);
  assert.equal(firstPayload.nonce, retryPayload.nonce);
  assert.equal(retryPayload.enforce_nonce, true);
  assert.deepEqual(retryPayload.message_reference, {
    message_id: 'm1', fail_if_not_exists: true,
  });
  assert.ok(harness.requests.some((item) => item.pathname.endsWith(`/messages/${retry.messageId}`)));
  assert.equal(retry.duplicateSuppressed, false);
  assert.equal(duplicate.duplicateSuppressed, true);
  assert.equal(duplicate.reason, 'source_message_already_replied');
  assert.equal(harness.requests.length, requestsAfterConfirmation);
});

test('CLI creates no message for a missing or cross-channel exact source', async () => {
  for (const source of [null, { id: 'm1', channel_id: 'other-channel' }]) {
    const { config } = fixture();
    const harness = restHarness({ source });

    await assert.rejects(runCli(config, harness.fetchImpl), /Exact Discord reply source/);
    assert.equal(harness.postCount(), 0);
    assert.deepEqual(fs.readdirSync(config.paths.replyReceiptDir), []);
  }
});

test('CLI releases a structured Discord 4xx claim while preserving retry rights', async () => {
  const { config } = fixture();
  let rejectFirst = true;
  const harness = restHarness({
    post({ init, messages, postCount }) {
      if (rejectFirst) {
        rejectFirst = false;
        return response(400, { code: 50035, message: 'Invalid Form Body' });
      }
      const payload = JSON.parse(init.body);
      const message = {
        id: `out-${postCount}`, channel_id: 'c1', content: payload.content,
        nonce: payload.nonce, message_reference: payload.message_reference,
        author: { id: 'bot1' },
      };
      messages.set(message.id, message);
      return response(200, message);
    },
  });

  await assert.rejects(runCli(config, harness.fetchImpl), /HTTP 400/);
  assert.deepEqual(fs.readdirSync(config.paths.replyReceiptDir), []);
  const retry = await runCli(config, harness.fetchImpl);
  assert.equal(harness.postCount(), 2);
  assert.equal(retry.messageId, 'out-2');
});

test('CLI rejects a foreign receipt before any Discord REST request', async () => {
  const { config } = fixture();
  const claimed = await beginReply(config, { channelId: 'c1', sourceMessageId: 'm1' }, 'answer');
  const receipt = JSON.parse(fs.readFileSync(claimed.file, 'utf8'));
  receipt.channelId = 'foreign-channel';
  fs.writeFileSync(claimed.file, `${JSON.stringify(receipt)}\n`);
  let networkCount = 0;

  const result = await runCli(config, async () => {
    networkCount += 1;
    throw new Error('must not fetch');
  });
  assert.equal(networkCount, 0);
  assert.equal(result.duplicateSuppressed, true);
  assert.equal(result.reason, 'source_message_reply_receipt_identity_mismatch');
});

test('CLI cannot reconcile without an expected bot author identity', async () => {
  const { config } = fixture({ botUserId: '' });
  const claimed = await beginReply(config, { channelId: 'c1', sourceMessageId: 'm1' }, 'answer');
  const receipt = JSON.parse(fs.readFileSync(claimed.file, 'utf8'));
  receipt.status = 'uncertain';
  fs.writeFileSync(claimed.file, `${JSON.stringify(receipt)}\n`);
  let networkCount = 0;

  await assert.rejects(runCli(config, async () => {
    networkCount += 1;
    throw new Error('must not fetch');
  }), /Expected Discord bot author identity is unavailable/);
  assert.equal(networkCount, 0);
});
