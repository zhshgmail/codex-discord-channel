'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { createDelivery, readDeliveryQueueStatus } = require('./delivery');
const { createAppServerHost } = require('./app-server-host');

// An explicitly configured, trusted local adapter. Nothing in a Discord
// message selects code, an assignment, or an admission policy.
function createGatewayDelivery(config, logger, deliveryDeps = {}, deps = {}) {
  const factory = deps.createDelivery || createDelivery;
  const modulePath = config.env?.CODEX_DISCORD_GATEWAY_DELIVERY_MODULE;
  const configPath = config.env?.CODEX_DISCORD_GATEWAY_DELIVERY_CONFIG;
  if (!modulePath && !configPath) return factory(config, logger, deliveryDeps);
  if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(configPath || '')) {
    throw new Error('Gateway delivery module and config must both be absolute local paths.');
  }
  const adapter = createRequire(modulePath)(modulePath);
  if (typeof adapter.createGatewayDelivery !== 'function') {
    throw new Error('Gateway delivery module must export createGatewayDelivery.');
  }
  return adapter.createGatewayDelivery({
    config, logger, deliveryDeps, configPath,
    getQueueStatus: () => readDeliveryQueueStatus(config, deliveryDeps),
    createDelivery: factory,
    createAppServerHost: deps.createAppServerHost || createAppServerHost,
  });
}

module.exports = { createGatewayDelivery };
