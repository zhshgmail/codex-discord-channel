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

  if (group.requireMention && !mentionsBot(message.content, message.botUserId, state.mentionPatterns)) {
    return { allowed: false, reason: 'guild_mention_required' };
  }

  return { allowed: true, reason: 'guild_allowed' };
}

module.exports = {
  decideAccess,
  defaultAccessState,
  ensureAccessFile,
  loadAccessState,
  mentionsBot,
  normalizeAccessState,
};
