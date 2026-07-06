'use strict';

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function normalizeDiscordMessage(message) {
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : Array.from(message.attachments?.values?.() || []);
  return {
    source: message.guildId ? 'guild' : 'dm',
    channelId: message.channelId,
    guildId: message.guildId || null,
    messageId: message.id,
    authorId: message.author?.id || message.authorId || '',
    authorName: message.author?.username || message.authorName || '',
    authorIsBot: Boolean(message.author?.bot || message.authorIsBot),
    content: message.content || '',
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType || null,
      size: attachment.size || null,
    })),
  };
}

function formatEnvelope(normalized) {
  const header = [
    '<channel source="discord"',
    ` channel_id="${escapeAttr(normalized.channelId)}"`,
    normalized.guildId ? ` guild_id="${escapeAttr(normalized.guildId)}"` : '',
    ` message_id="${escapeAttr(normalized.messageId)}"`,
    ` author_id="${escapeAttr(normalized.authorId)}"`,
    ` author_name="${escapeAttr(normalized.authorName)}"`,
    ' reply="required">',
  ].join('');
  const attachmentText = normalized.attachments.length > 0
    ? `\n\n[attachments]\n${normalized.attachments.map((item) => `- ${item.name || item.id}: ${item.url}`).join('\n')}`
    : '';
  return `${header}\n${normalized.content}${attachmentText}\n</channel>`;
}

function createDelivery(config, logger = () => {}) {
  return {
    deliver(normalized) {
      const envelope = formatEnvelope(normalized);
      logger('WARN', 'Codex host channel push is not available; inbound message normalized but not injected', {
        channelId: normalized.channelId,
        messageId: normalized.messageId,
      });
      return {
        status: 'unsupported',
        reason: 'codex_channel_api_unavailable',
        envelope,
      };
    },
  };
}

module.exports = {
  createDelivery,
  escapeAttr,
  formatEnvelope,
  normalizeDiscordMessage,
};
