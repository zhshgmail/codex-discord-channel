'use strict';

const fs = require('node:fs');
const path = require('node:path');

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function defaultAccessState() {
  return {
    version: 1,
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    mentionPatterns: [],
    replyToMode: 'reply',
    textChunkLimit: 1900,
    chunkMode: 'split',
  };
}

function normalizeAccessState(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('access.json must contain an object');
  }
  const state = defaultAccessState();
  state.version = Number.isInteger(payload.version) ? payload.version : state.version;
  state.dmPolicy = ['pairing', 'closed', 'open'].includes(payload.dmPolicy) ? payload.dmPolicy : state.dmPolicy;
  state.allowFrom = asStringArray(payload.allowFrom);
  state.mentionPatterns = asStringArray(payload.mentionPatterns);
  state.replyToMode = typeof payload.replyToMode === 'string' ? payload.replyToMode : state.replyToMode;
  state.textChunkLimit = Number.isInteger(payload.textChunkLimit) ? payload.textChunkLimit : state.textChunkLimit;
  state.chunkMode = typeof payload.chunkMode === 'string' ? payload.chunkMode : state.chunkMode;

  const groups = payload.groups && typeof payload.groups === 'object' && !Array.isArray(payload.groups) ? payload.groups : {};
  for (const [channelId, rawGroup] of Object.entries(groups)) {
    const group = rawGroup && typeof rawGroup === 'object' && !Array.isArray(rawGroup) ? rawGroup : {};
    state.groups[channelId] = {
      requireMention: group.requireMention !== false,
      allowFrom: asStringArray(group.allowFrom),
      allowBots: group.allowBots === true,
    };
  }
  return state;
}

function ensureAccessFile(accessPath) {
  fs.mkdirSync(path.dirname(accessPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(accessPath)) {
    fs.writeFileSync(accessPath, `${JSON.stringify(defaultAccessState(), null, 2)}\n`, { mode: 0o600 });
  }
}

function loadAccessState(accessPath) {
  ensureAccessFile(accessPath);
  const payload = JSON.parse(fs.readFileSync(accessPath, 'utf8'));
  return normalizeAccessState(payload);
}

function mentionsBot(content, botUserId, patterns = []) {
  const text = String(content || '');
  if (botUserId && (text.includes(`<@${botUserId}>`) || text.includes(`<@!${botUserId}>`))) {
    return true;
  }
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(text);
    } catch {
      return false;
    }
  });
}

function decideAccess(state, message) {
  if (message.source === 'dm') {
    if (state.dmPolicy === 'open') return { allowed: true, reason: 'dm_open' };
    if (state.allowFrom.includes(message.authorId)) return { allowed: true, reason: 'dm_allowlisted' };
    if (state.dmPolicy === 'pairing') {
      return { allowed: false, reason: 'dm_pairing_required', requiresPairingCode: true };
    }
    return { allowed: false, reason: 'dm_closed' };
  }

  const group = state.groups[message.channelId];
  if (!group) return { allowed: false, reason: 'guild_channel_not_enabled' };

  if (message.authorIsBot && group.allowBots !== true) {
    return { allowed: false, reason: 'bot_author_denied' };
  }

  if (group.allowFrom.length > 0 && !group.allowFrom.includes(message.authorId)) {
    return { allowed: false, reason: 'guild_sender_denied' };
  }

  const currentMessageMentionsBot = mentionsBot(message.content, message.botUserId, state.mentionPatterns);
  const replyAuthorIsBot = message.botUserId && message.repliedToAuthorId === message.botUserId;
  const referencedMessageMentionsBot = mentionsBot(
    message.repliedToContent,
    message.botUserId,
    state.mentionPatterns,
  );
  if (
    group.requireMention &&
    !currentMessageMentionsBot &&
    !replyAuthorIsBot &&
    !referencedMessageMentionsBot
  ) {
    return { allowed: false, reason: 'guild_mention_required' };
  }

  return { allowed: true, reason: 'guild_allowed' };
}

const GUILD_HISTORY_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

function dmCounterpartyId(target, botUserId) {
  if (target.recipient?.id) return String(target.recipient.id);
  const recipients = Array.from(target.recipients?.values?.() || []);
  const counterparty = recipients.find((recipient) => String(recipient?.id || '') !== botUserId);
  return String(counterparty?.id || '');
}

function decideHistoryTarget(state, target, botUserId) {
  if (!target || typeof target !== 'object') {
    return { allowed: false, reason: 'history_target_not_allowed' };
  }

  if (target.type === 1 && !target.guildId) {
    const counterpartyId = dmCounterpartyId(target, botUserId);
    if (!counterpartyId) return { allowed: false, reason: 'history_target_not_allowed' };
    if (state.dmPolicy === 'open') {
      return { allowed: true, reason: 'dm_open', source: 'dm', counterpartyId };
    }
    if (state.allowFrom.includes(counterpartyId)) {
      return { allowed: true, reason: 'dm_allowlisted', source: 'dm', counterpartyId };
    }
    return { allowed: false, reason: 'history_target_not_allowed' };
  }

  const channelId = String(target.id || '');
  if (
    target.guildId &&
    GUILD_HISTORY_CHANNEL_TYPES.has(target.type) &&
    Object.hasOwn(state.groups, channelId)
  ) {
    return { allowed: true, reason: 'guild_channel_enabled', source: 'guild' };
  }
  return { allowed: false, reason: 'history_target_not_allowed' };
}

function allowHistoryMessage(state, target, message, botUserId) {
  const targetDecision = decideHistoryTarget(state, target, botUserId);
  if (!targetDecision.allowed) return false;

  const authorId = String(message?.author?.id || '');
  if (!authorId) return false;
  if (authorId === botUserId) return true;

  if (targetDecision.source === 'dm') {
    return authorId === targetDecision.counterpartyId;
  }

  const group = state.groups[String(target.id)];
  if (message.author?.bot && group.allowBots !== true) return false;
  if (group.allowFrom.length > 0 && !group.allowFrom.includes(authorId)) return false;
  return true;
}

module.exports = {
  allowHistoryMessage,
  decideAccess,
  decideHistoryTarget,
  defaultAccessState,
  ensureAccessFile,
  loadAccessState,
  mentionsBot,
  normalizeAccessState,
};
