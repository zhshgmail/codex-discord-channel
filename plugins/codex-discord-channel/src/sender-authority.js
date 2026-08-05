'use strict';

const path = require('node:path');
const {
  OWNER_VERSION,
  readOwner,
  sameOwnerCapability,
  sameOwnerLineage,
  withOwnerLock,
} = require('./owner-state');

function senderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireSenderCapability(config, capability, current, args) {
  if (!capability || typeof capability !== 'object') {
    throw senderError(
      'sender_capability_required',
      'Discord send requires a capability issued to the current owner.',
    );
  }
  const expectedInstance = config.paths?.instance || '';
  const expectedStateDir = path.resolve(config.paths?.stateDir || '.');
  if (capability.instance !== expectedInstance) {
    throw senderError('sender_instance_mismatch', 'Discord sender capability belongs to another instance.');
  }
  if (path.resolve(capability.stateDir || '.') !== expectedStateDir) {
    throw senderError('sender_state_dir_mismatch', 'Discord sender capability belongs to another state directory.');
  }
  const exact = sameOwnerCapability(current, capability);
  const deliveryUpgrade = sameOwnerLineage(current, capability);
  if (!exact && !deliveryUpgrade) {
    throw senderError('sender_capability_stale', 'Discord sender capability is stale.');
  }
  if (
    current?.version !== OWNER_VERSION
    || current.instance !== expectedInstance
    || path.resolve(current.stateDir || '.') !== expectedStateDir
  ) {
    throw senderError('sender_capability_stale', 'Discord sender authority is invalid or ambiguous.');
  }

  const channelId = typeof args?.channelId === 'string' ? args.channelId.trim() : '';
  const sourceMessageId = typeof args?.replyTo === 'string' ? args.replyTo.trim() : '';
  if (!channelId || !sourceMessageId) {
    throw senderError(
      'sender_context_ambiguous',
      'Discord send requires an exact source channel and message identity.',
    );
  }
  const delivery = current.delivery;
  if (
    !delivery
    || typeof delivery !== 'object'
    || !delivery.threadId
    || !delivery.sourceMessageId
  ) {
    throw senderError(
      'sender_context_ambiguous',
      'Discord sender authority is not bound to a delivered turn.',
    );
  }
  if (delivery.channelId !== channelId || delivery.sourceMessageId !== sourceMessageId) {
    throw senderError('sender_source_mismatch', 'Discord send does not match the delivered source message.');
  }
  if (!current.threadId || current.threadId !== delivery.threadId) {
    throw senderError('sender_thread_mismatch', 'Discord send does not match the delivered Codex thread.');
  }
  if (current.turnId && delivery.turnId && current.turnId !== delivery.turnId) {
    throw senderError('sender_turn_mismatch', 'Discord send does not match the delivered Codex turn.');
  }
  return current;
}

async function withSenderAdmission({
  args,
  capability,
  config,
  deps = {},
  onCapability,
  operation,
}) {
  if (!capability || typeof capability !== 'object') {
    throw senderError(
      'sender_capability_required',
      'Discord send requires a capability issued to the current owner.',
    );
  }
  if (!config.paths?.ownerPath) {
    throw senderError('sender_context_ambiguous', 'Discord sender owner path is not configured.');
  }
  return withOwnerLock(config.paths.ownerPath, config, deps, async () => {
    const current = readOwner(config.paths.ownerPath, deps);
    const admitted = requireSenderCapability(config, capability, current, args);
    if (!sameOwnerCapability(admitted, capability) && typeof onCapability === 'function') {
      onCapability(admitted);
    }
    return operation(admitted);
  });
}

module.exports = {
  requireSenderCapability,
  withSenderAdmission,
};
