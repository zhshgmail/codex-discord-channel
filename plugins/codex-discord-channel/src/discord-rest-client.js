'use strict';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

function normalizeRestMessage(message) {
  if (!message || typeof message !== 'object') return null;
  return {
    id: String(message.id || ''),
    channelId: String(message.channel_id || ''),
    content: String(message.content || ''),
    nonce: String(message.nonce || ''),
    reference: {
      messageId: String(message.message_reference?.message_id || ''),
    },
    author: { id: String(message.author?.id || '') },
  };
}

function discordRestError(response, body) {
  const status = Number(response?.status) || 0;
  const error = new Error(`Discord REST request failed with HTTP ${status || 'unknown'}.`);
  error.status = status;
  error.statusCode = status;
  const code = body?.code;
  if (Number.isInteger(code) || /^\d+$/.test(String(code || ''))) {
    error.code = Number(code);
  }
  return error;
}

async function requestDiscord(fetchImpl, token, route, init = {}) {
  const response = await fetchImpl(`${DISCORD_API_BASE}${route}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const bodyText = await response.text();
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {}
  if (!response.ok) throw discordRestError(response, body);
  return body;
}

function createDiscordRestClient({ token, botUserId, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('Discord REST fetch implementation is unavailable.');
  const channels = new Map();

  function channelFor(channelId) {
    if (channels.has(channelId)) return channels.get(channelId);
    const encodedChannelId = encodeURIComponent(channelId);
    const channel = {
      id: channelId,
      messages: {
        async fetch(query) {
          if (typeof query === 'string') {
            const body = await requestDiscord(
              fetchImpl,
              token,
              `/channels/${encodedChannelId}/messages/${encodeURIComponent(query)}`,
            );
            return normalizeRestMessage(body);
          }
          const limit = Math.max(1, Math.min(100, Number(query?.limit) || 50));
          const body = await requestDiscord(
            fetchImpl,
            token,
            `/channels/${encodedChannelId}/messages?limit=${limit}`,
          );
          return new Map((Array.isArray(body) ? body : []).map((message) => {
            const normalized = normalizeRestMessage(message);
            return [normalized.id, normalized];
          }));
        },
      },
      async send(payload) {
        const body = { content: payload.content };
        if (typeof payload.nonce === 'string' && payload.nonce !== '') {
          body.nonce = payload.nonce;
          body.enforce_nonce = payload.enforceNonce === true;
        }
        if (payload.reply?.messageReference) {
          body.message_reference = {
            message_id: payload.reply.messageReference,
            channel_id: channelId,
            fail_if_not_exists: payload.reply.failIfNotExists === true,
          };
        }
        const sent = await requestDiscord(
          fetchImpl,
          token,
          `/channels/${encodedChannelId}/messages`,
          { method: 'POST', body: JSON.stringify(body) },
        );
        return normalizeRestMessage(sent);
      },
    };
    channels.set(channelId, channel);
    return channel;
  }

  return {
    user: { id: String(botUserId || '') },
    channels: {
      async fetch(channelId) {
        return channelFor(String(channelId || ''));
      },
    },
  };
}

module.exports = {
  createDiscordRestClient,
  normalizeRestMessage,
};
