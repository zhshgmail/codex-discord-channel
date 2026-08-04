'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
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
    message_id: 'm1', channel_id: 'c1', fail_if_not_exists: true,
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
