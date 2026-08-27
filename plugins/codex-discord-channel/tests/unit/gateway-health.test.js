'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  readGatewayHealthStatus,
  writeGatewayHealth,
} = require('../../src/gateway-health');

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdc-gateway-health-'));
  const config = {
    paths: {
      gatewayHealthPath: path.join(stateDir, 'gateway-health.json'),
      gatewayPidPath: path.join(stateDir, 'session-gateway.pid'),
      stateDir,
    },
  };
  const receiverOwnership = {
    version: 2,
    pid: process.pid,
    generation: 'gateway-generation',
    claimedAt: '2026-08-08T00:00:00.000Z',
    fallback: null,
  };
  fs.writeFileSync(config.paths.gatewayPidPath, `${JSON.stringify(receiverOwnership)}\n`);
  return { config, receiverOwnership, stateDir };
}

test('gateway health exposes the live receiver rather than an MCP-local client', () => {
  const { config, receiverOwnership } = fixture();
  writeGatewayHealth(config, {
    receiverOwnership,
    discordStarted: true,
    discordReason: null,
    structured: { configured: true, available: true, reason: null },
    queue: {
      deliveryQueueDepth: 3,
      deliveryReadyCount: 2,
      deliveryUncertainCount: 1,
      deliveryBlockedReason: null,
    },
    lastDrain: {
      status: 'delivered',
      reason: 'turn_accepted',
      at: '2026-08-08T00:00:01.000Z',
    },
    resources: {
      rssBytes: 1234,
      heapUsedBytes: 456,
      caches: { guilds: 1, channels: 2, users: 3 },
    },
    memoryLimitBytes: 9999,
  }, { now: () => Date.parse('2026-08-08T00:00:02.000Z') });

  assert.deepEqual(readGatewayHealthStatus(config, {
    now: () => Date.parse('2026-08-08T00:00:02.000Z'),
  }), {
    gatewayHealthPath: config.paths.gatewayHealthPath,
    gatewayHealthValid: true,
    gatewayReceiverPresent: true,
    gatewayLive: true,
    gatewayHealthReason: null,
    gatewayPid: process.pid,
    gatewayGeneration: 'gateway-generation',
    gatewayUpdatedAt: '2026-08-08T00:00:02.000Z',
    gatewayDiscordStarted: true,
    gatewayDiscordReason: null,
    gatewayStructuredDeliveryState: 'available',
    gatewaySharedAppServerConfigured: true,
    gatewaySharedAppServerAvailable: true,
    gatewaySharedAppServerReason: null,
    gatewayLastDrainStatus: 'delivered',
    gatewayLastDrainReason: 'turn_accepted',
    gatewayLastDrainAt: '2026-08-08T00:00:01.000Z',
    gatewayObservedQueueDepth: 3,
    gatewayObservedReadyCount: 2,
    gatewayObservedUncertainCount: 1,
    gatewayObservedBlockedReason: null,
    gatewayRssBytes: 1234,
    gatewayHeapUsedBytes: 456,
    gatewayMemoryLimitBytes: 9999,
    gatewayDiscordCacheCounts: { guilds: 1, channels: 2, users: 3 },
  });
  assert.equal(fs.statSync(config.paths.gatewayHealthPath).mode & 0o777, 0o600);
});

test('a health record from a superseded receiver is explicitly stale', () => {
  const { config, receiverOwnership } = fixture();
  writeGatewayHealth(config, {
    receiverOwnership,
    discordStarted: true,
    structured: { configured: true, available: true, reason: null },
  });
  fs.writeFileSync(config.paths.gatewayPidPath, `${JSON.stringify({
    ...receiverOwnership,
    generation: 'successor-generation',
  })}\n`);

  const status = readGatewayHealthStatus(config);
  assert.equal(status.gatewayHealthValid, true);
  assert.equal(status.gatewayLive, false);
  assert.equal(status.gatewayHealthReason, 'gateway_health_stale');
  assert.equal(status.gatewayDiscordStarted, false);
  assert.equal(status.gatewayStructuredDeliveryState, 'unavailable');
});

test('a live receiver with an expired heartbeat is explicitly unavailable', () => {
  const { config, receiverOwnership } = fixture();
  writeGatewayHealth(config, {
    receiverOwnership,
    discordStarted: true,
    structured: { configured: true, available: true, reason: null },
  }, { now: () => Date.parse('2026-08-08T00:00:00.000Z') });

  const status = readGatewayHealthStatus(config, {
    now: () => Date.parse('2026-08-08T00:03:01.000Z'),
  });
  assert.equal(status.gatewayReceiverPresent, true);
  assert.equal(status.gatewayLive, false);
  assert.equal(status.gatewayHealthReason, 'gateway_health_expired');
  assert.equal(status.gatewayDiscordStarted, false);
});

test('missing and malformed health records fail visibly without leaking raw content', () => {
  const { config } = fixture();
  assert.equal(readGatewayHealthStatus(config).gatewayHealthReason, 'gateway_health_missing');
  fs.writeFileSync(config.paths.gatewayHealthPath, '{secret-broken');
  const malformed = readGatewayHealthStatus(config);
  assert.equal(malformed.gatewayHealthValid, false);
  assert.equal(malformed.gatewayLive, false);
  assert.equal(malformed.gatewayHealthReason, 'gateway_health_invalid');
  assert.equal(JSON.stringify(malformed).includes('secret-broken'), false);
});
