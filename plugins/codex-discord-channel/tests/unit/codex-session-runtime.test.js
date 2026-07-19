'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const SCRIPT = path.resolve(
  __dirname,
  '../../skills/codex-session-runtime-status/scripts/codex-session-runtime',
);
const THREAD_ID = '019f7a7d-6131-7a20-ae8f-bd93654b28ab';
const OTHER_THREAD_ID = '019f7a7d-6131-7a20-ae8f-bd93654b28ac';

function createCodexHome(files) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-status-'));
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '07', '19');
  fs.mkdirSync(sessionsDir, { recursive: true });

  for (const [name, records] of Object.entries(files)) {
    const body = records
      .map((record) => (typeof record === 'string' ? record : JSON.stringify(record)))
      .join('\n');
    fs.writeFileSync(path.join(sessionsDir, name), `${body}\n`);
  }

  return codexHome;
}

function sessionMeta(threadId) {
  return { type: 'session_meta', payload: { id: threadId } };
}

function turnContext(model, effort) {
  return { type: 'turn_context', payload: { model, effort } };
}

function runStatus(codexHome, { threadId, envThreadId } = {}) {
  const args = ['--json', '--codex-home', codexHome];
  if (threadId !== undefined) args.push('--thread-id', threadId);

  const result = spawnSync(SCRIPT, args, {
    encoding: 'utf8',
    env: {
      HOME: path.dirname(codexHome),
      LANG: 'C.UTF-8',
      PATH: process.env.PATH,
      ...(envThreadId === undefined ? {} : { CODEX_THREAD_ID: envThreadId }),
    },
  });

  return {
    ...result,
    json: result.stdout ? JSON.parse(result.stdout) : null,
  };
}

test('reports model and effort only for the exact requested session', () => {
  const codexHome = createCodexHome({
    [`rollout-2026-07-19T01-00-00-${THREAD_ID}.jsonl`]: [
      sessionMeta(THREAD_ID),
      turnContext('gpt-5.5', 'high'),
    ],
    [`rollout-2026-07-19T02-00-00-${OTHER_THREAD_ID}.jsonl`]: [
      sessionMeta(OTHER_THREAD_ID),
      turnContext('newest-but-wrong', 'low'),
    ],
  });

  const result = runStatus(codexHome, {
    threadId: THREAD_ID,
    envThreadId: OTHER_THREAD_ID,
  });

  assert.equal(result.status, 0);
  assert.deepEqual(result.json, {
    effort: 'high',
    model: 'gpt-5.5',
    status: 'ok',
    thread_id: THREAD_ID,
  });
  assert.equal(result.stderr, '');
});

test('fails closed without an explicit or environment thread id', () => {
  const codexHome = createCodexHome({
    [`rollout-2026-07-19T01-00-00-${THREAD_ID}.jsonl`]: [
      sessionMeta(THREAD_ID),
      turnContext('must-not-be-selected', 'high'),
    ],
  });

  const result = runStatus(codexHome);

  assert.notEqual(result.status, 0);
  assert.deepEqual(result.json, {
    effort: 'UNKNOWN',
    model: 'UNKNOWN',
    reason: 'missing_thread_id',
    status: 'unknown',
    thread_id: null,
  });
  assert.doesNotMatch(result.stdout + result.stderr, /must-not-be-selected/);
});

test('uses CODEX_THREAD_ID when --thread-id is absent', () => {
  const codexHome = createCodexHome({
    [`rollout-2026-07-19T01-00-00-${THREAD_ID}.jsonl`]: [
      sessionMeta(THREAD_ID),
      turnContext('gpt-env', 'medium'),
    ],
  });

  const result = runStatus(codexHome, { envThreadId: THREAD_ID });

  assert.equal(result.status, 0);
  assert.equal(result.json.model, 'gpt-env');
  assert.equal(result.json.effort, 'medium');
});

test('fails closed when filename identity and session metadata mismatch', () => {
  const codexHome = createCodexHome({
    [`rollout-2026-07-19T01-00-00-${THREAD_ID}.jsonl`]: [
      sessionMeta(OTHER_THREAD_ID),
      turnContext('wrong-session', 'high'),
    ],
  });

  const result = runStatus(codexHome, { threadId: THREAD_ID });

  assert.notEqual(result.status, 0);
  assert.equal(result.json.status, 'unknown');
  assert.equal(result.json.reason, 'session_meta_mismatch');
  assert.equal(result.json.model, 'UNKNOWN');
  assert.equal(result.json.effort, 'UNKNOWN');
  assert.doesNotMatch(result.stdout + result.stderr, /wrong-session/);
});

test('fails closed when the exact session JSONL is malformed', () => {
  const secret = 'TOP-SECRET-MALFORMED-CONTENT';
  const codexHome = createCodexHome({
    [`rollout-2026-07-19T01-00-00-${THREAD_ID}.jsonl`]: [
      sessionMeta(THREAD_ID),
      `{"type":"event_msg","payload":"${secret}"`,
      turnContext('must-not-leak', 'high'),
    ],
  });

  const result = runStatus(codexHome, { threadId: THREAD_ID });

  assert.notEqual(result.status, 0);
  assert.equal(result.json.reason, 'malformed_session');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  assert.doesNotMatch(result.stdout + result.stderr, /must-not-leak/);
});

test('uses the latest turn_context in append order', () => {
  const codexHome = createCodexHome({
    [`rollout-2026-07-19T01-00-00-${THREAD_ID}.jsonl`]: [
      sessionMeta(THREAD_ID),
      turnContext('gpt-old', 'low'),
      { type: 'event_msg', payload: { message: 'irrelevant' } },
      turnContext('gpt-current', 'xhigh'),
    ],
  });

  const result = runStatus(codexHome, { threadId: THREAD_ID });

  assert.equal(result.status, 0);
  assert.equal(result.json.model, 'gpt-current');
  assert.equal(result.json.effort, 'xhigh');
});

test('does not backfill a partial latest turn_context', () => {
  const codexHome = createCodexHome({
    [`rollout-2026-07-19T01-00-00-${THREAD_ID}.jsonl`]: [
      sessionMeta(THREAD_ID),
      turnContext('gpt-old', 'high'),
      { type: 'turn_context', payload: { model: 'gpt-partial' } },
    ],
  });

  const result = runStatus(codexHome, { threadId: THREAD_ID });

  assert.notEqual(result.status, 0);
  assert.deepEqual(result.json, {
    effort: 'UNKNOWN',
    model: 'UNKNOWN',
    reason: 'turn_context_partial',
    status: 'unknown',
    thread_id: THREAD_ID,
  });
});

test('never emits prompt, message, token, secret, path, or history content', () => {
  const sensitiveValues = [
    'PRIVATE-USER-PROMPT',
    'PRIVATE-MESSAGE-CONTENT',
    'sk-private-token-value',
    'PRIVATE-DISCORD-SECRET',
  ];
  const codexHome = createCodexHome({
    [`rollout-2026-07-19T01-00-00-${THREAD_ID}.jsonl`]: [
      sessionMeta(THREAD_ID),
      { type: 'response_item', payload: { prompt: sensitiveValues[0] } },
      { type: 'event_msg', payload: { message: sensitiveValues[1] } },
      { type: 'metadata', payload: { token: sensitiveValues[2], secret: sensitiveValues[3] } },
      turnContext('gpt-safe', 'high'),
    ],
  });

  const result = runStatus(codexHome, { threadId: THREAD_ID });

  assert.equal(result.status, 0);
  assert.deepEqual(Object.keys(result.json).sort(), ['effort', 'model', 'status', 'thread_id']);
  assert.equal(result.json.model, 'gpt-safe');
  for (const value of sensitiveValues) {
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(value));
  }
  assert.doesNotMatch(result.stdout + result.stderr, /response_item|event_msg|prompt|message|token|secret|sessions/);
});
