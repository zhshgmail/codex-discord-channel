'use strict';

const { allowHistoryMessage, decideHistoryTarget, loadAccessState } = require('./access-state');

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CONTENT_LENGTH = 16 * 1024;
const MAX_ATTACHMENTS = 10;
const ALLOWED_ARGS = new Set(['channelId', 'before', 'limit']);
const SNOWFLAKE_PATTERN = /^[1-9]\d{16,19}$/;
const MAX_SNOWFLAKE = (1n << 64n) - 1n;

function invalidHistoryArgs() {
  throw new Error('invalid_history_args');
}

function ownString(args, key) {
  if (!Object.hasOwn(args, key)) return null;
  if (typeof args[key] !== 'string') invalidHistoryArgs();
  const value = args[key].trim();
  if (!value) invalidHistoryArgs();
  return value;
}

function validateSnowflake(value) {
  if (value === null) return '';
  if (!SNOWFLAKE_PATTERN.test(value) || BigInt(value) > MAX_SNOWFLAKE) invalidHistoryArgs();
  return value;
}

function validateHistoryArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalidHistoryArgs();
  if (Object.keys(args).some((key) => !ALLOWED_ARGS.has(key))) invalidHistoryArgs();

  const channelId = validateSnowflake(ownString(args, 'channelId'));
  const before = validateSnowflake(ownString(args, 'before'));
  const limit = Object.hasOwn(args, 'limit') ? args.limit : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) invalidHistoryArgs();
  return { channelId, before, limit };
}

function boundedString(value, maxLength) {
  return String(value || '').slice(0, maxLength);
}

function collectionValues(value) {
  if (Array.isArray(value)) return value;
  return Array.from(value?.values?.() || []);
}

function compareNewestFirst(left, right) {
  const leftTime = Number(left.createdTimestamp || 0);
  const rightTime = Number(right.createdTimestamp || 0);
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftId = String(left.id || '');
  const rightId = String(right.id || '');
  return leftId === rightId ? 0 : (leftId < rightId ? 1 : -1);
}

function normalizeAttachments(attachments) {
  return collectionValues(attachments).slice(0, MAX_ATTACHMENTS).map((attachment) => ({
    id: boundedString(attachment?.id, 32),
    name: boundedString(attachment?.name, 256),
    size: Number.isSafeInteger(attachment?.size) && attachment.size >= 0 ? attachment.size : 0,
    contentType: boundedString(attachment?.contentType, 128),
    url: boundedString(attachment?.url, 2048),
  }));
}

function resolvedReply(message, state, target, fetchedById, botUserId) {
  const reference = message.reference;
  if (!reference?.messageId || String(reference.channelId || '') !== String(target.id || '')) return null;
  const referenced = fetchedById.get(String(reference.messageId));
  if (!referenced?.author?.id || !allowHistoryMessage(state, target, referenced, botUserId)) return null;
  return {
    messageId: String(referenced.id),
    authorId: String(referenced.author.id),
    authorName: boundedString(referenced.author.username || referenced.author.displayName, 256),
  };
}

function normalizeHistoryMessage(message, state, target, fetchedById, botUserId) {
  let createdAt = '';
  if (message.createdAt instanceof Date) {
    createdAt = message.createdAt.toISOString();
  } else if (Number.isFinite(message.createdTimestamp)) {
    createdAt = new Date(message.createdTimestamp).toISOString();
  }
  return {
    source: target.guildId ? 'guild' : 'dm',
    channelId: String(target.id || ''),
    guildId: target.guildId ? String(target.guildId) : null,
    messageId: String(message.id || ''),
    createdAt,
    authorId: String(message.author?.id || ''),
    authorName: boundedString(message.author?.username || message.author?.displayName, 256),
    authorIsBot: Boolean(message.author?.bot),
    content: boundedString(message.content, MAX_CONTENT_LENGTH),
    attachments: normalizeAttachments(message.attachments),
    replyTo: resolvedReply(message, state, target, fetchedById, botUserId),
  };
}

function outputBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function fitFirstMessage(result, normalized, messageId) {
  const candidate = () => ({
    ...result,
    messages: [normalized],
    hasMore: true,
    nextBefore: messageId,
  });
  while (outputBytes(candidate()) > MAX_OUTPUT_BYTES && normalized.attachments.length > 0) {
    normalized.attachments.pop();
  }
  while (outputBytes(candidate()) > MAX_OUTPUT_BYTES && normalized.content.length > 0) {
    normalized.content = normalized.content.slice(0, Math.floor(normalized.content.length / 2));
  }
  return candidate();
}

async function fetchTarget(client, channelId) {
  try {
    const target = await client?.channels?.fetch?.(channelId);
    if (!target) throw new Error('missing channel');
    return target;
  } catch {
    throw new Error('history_channel_inaccessible');
  }
}

function isDiscordPermissionError(error) {
  return error?.status === 403 || error?.statusCode === 403 || error?.code === 50013;
}

async function fetchMessages(target, options) {
  try {
    if (typeof target.messages?.fetch !== 'function') throw new Error('unsupported channel');
    return await target.messages.fetch(options);
  } catch (error) {
    if (isDiscordPermissionError(error)) throw new Error('history_channel_inaccessible');
    throw new Error('history_fetch_failed');
  }
}

async function readDiscordHistory({ args, config, client }) {
  const validated = validateHistoryArgs(args);
  if (!validated.channelId) throw new Error('history_target_not_allowed');

  let state;
  try {
    state = loadAccessState(config?.paths?.accessPath);
  } catch {
    throw new Error('history_fetch_failed');
  }

  const target = await fetchTarget(client, validated.channelId);
  const botUserId = String(client?.user?.id || config?.botUserId || '');
  const targetDecision = decideHistoryTarget(state, target, botUserId);
  if (!targetDecision.allowed) throw new Error('history_target_not_allowed');

  const fetchOptions = { limit: validated.limit + 1 };
  if (validated.before) fetchOptions.before = validated.before;
  const fetched = collectionValues(await fetchMessages(target, fetchOptions)).sort(compareNewestFirst);
  const fetchedById = new Map(fetched.map((item) => [String(item.id || ''), item]));
  const page = fetched.slice(0, validated.limit);
  const rawHasMore = fetched.length > validated.limit;
  const allowed = page.filter((item) => allowHistoryMessage(state, target, item, botUserId));

  const result = {
    channelId: String(target.id || validated.channelId),
    channelName: boundedString(target.name || target.recipient?.username, 256),
    source: targetDecision.source,
    messages: [],
    hasMore: rawHasMore,
    nextBefore: rawHasMore && page.length > 0 ? String(page.at(-1).id || '') : '',
  };

  let budgetTruncated = false;
  for (const item of allowed) {
    const normalized = normalizeHistoryMessage(item, state, target, fetchedById, botUserId);
    const messageId = String(item.id || '');
    let candidate = {
      ...result,
      messages: [...result.messages, normalized],
      hasMore: true,
      nextBefore: messageId,
    };
    if (result.messages.length === 0 && outputBytes(candidate) > MAX_OUTPUT_BYTES) {
      candidate = fitFirstMessage(result, normalized, messageId);
    }
    if (outputBytes(candidate) > MAX_OUTPUT_BYTES) {
      budgetTruncated = true;
      break;
    }
    result.messages.push(normalized);
  }

  if (budgetTruncated) {
    result.hasMore = true;
    result.nextBefore = result.messages.at(-1)?.messageId || '';
  }
  return result;
}

module.exports = {
  readDiscordHistory,
  validateHistoryArgs,
};
