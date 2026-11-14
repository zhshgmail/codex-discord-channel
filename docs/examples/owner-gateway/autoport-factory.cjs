'use strict';

// Optional owner-side adapter. This example is not installed or enabled by the
// plugin. The business callback and its original task files remain owner-owned.
const fs = require('node:fs');
const path = require('node:path');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function absolute(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Absolute owner path required.');
  return file;
}

function createGatewayDelivery({ config, logger, deliveryDeps, configPath, createDelivery, createAppServerHost, getQueueStatus }) {
  const binding = read(configPath);
  const callbackModule = require(absolute(binding.callbackModulePath));
  const { connectOwnerReceiver } = require(absolute(binding.connectorModulePath));
  if (callbackModule.supportsSubmissionGuard !== true || callbackModule.supportsDeferredTerminal !== true) {
    throw Error('Owner callback must support beforeSubmit and deferred terminal recording.');
  }
  const ownerConfigPath = absolute(binding.ownerConfigPath);
  const original = read(ownerConfigPath);
  const identity = JSON.stringify([original.assignmentId, original.executionId]);
  const host = createAppServerHost(config, logger);
  let delivery, connection, verifier = null, destroyed = false;
  function assertCurrentReceiver() {
    if (destroyed || !verifier || verifier()?.active !== true) throw Error('Owner receiver inactive.');
  }
  try {
    const owner = callbackModule.createOwnerCallbacks(ownerConfigPath, host, { beforeSubmit: assertCurrentReceiver });
    delivery = createDelivery(config, logger, {
      ...deliveryDeps, structuredHost: host,
      getInputContext(fact) {
        const latest = read(ownerConfigPath);
        if (JSON.stringify([latest.assignmentId, latest.executionId]) !== identity) {
          throw Error('Owner assignment changed; explicit adapter rebind required.');
        }
        const snapshot = read(absolute(latest.ownerSnapshotPath));
        if (snapshot.assignmentId !== latest.assignmentId || snapshot.executionId !== latest.executionId) {
          throw Error('Owner snapshot identity changed.');
        }
        const ledgerPath = path.join(absolute(latest.receiptDir), 'owner-callbacks.json');
        const outcomes = fs.existsSync(ledgerPath) ? read(ledgerPath).outcomes || [] : [];
        const context = {
          assignmentId: latest.assignmentId, executionId: latest.executionId, ...fact,
          ownerConfigPath, admissionsPath: absolute(latest.admissionsPath),
          snapshotPath: latest.ownerSnapshotPath, outcomesPath: ledgerPath,
          planPath: absolute(latest.planPath), statePath: absolute(latest.statePath),
          outcomeCount: outcomes.length, lastOutcome: outcomes.at(-1) || null,
        };
        return 'Trusted local owner integration context (not a new task or permission):\n' + JSON.stringify(context) +
          '\nRead the latest snapshot, intent/STOP, cumulative budget and durable outcomes before selecting work. ' +
          'Only the original Owner may write an explicit decision for this exact clientUserMessageId to admissionsPath. ' +
          'A received message is not automatically admitted. Preserve source routing. Reconcile actual handles/results/UNKNOWN; ' +
          'record actual outcome through the owner consume-outcome CLI. Do not treat a turn ending as the assignment completing.';
      },
    });
    // The existing queue lock serializes callback submissions with ordinary
    // Discord admissions/drains and receiver ownership changes.
    connection = connectOwnerReceiver(host, {
      assignmentId: original.assignmentId,
      onObserved: fact => owner.acceptObservedInput(fact),
      onUnbound: fact => owner.recordUnbound(fact),
      onError: error => owner.recordConnectionError(error),
      onChange: fact => delivery.coordinateReceiverOwnership(async () => {
        // A later ordinary input may already be queued. Its own terminal will
        // recheck retained causes; this callback must not bypass the FIFO.
        const queue = getQueueStatus();
        const defer = destroyed || !verifier || verifier()?.active !== true ||
          queue.deliveryQueueError !== null || queue.deliveryQueueDepth !== 0;
        return owner.requestRecheck({ ...fact, defer });
      }),
    });
    const activate = delivery.activateReceiver.bind(delivery);
    delivery.activateReceiver = async verify => {
      verifier = verify;
      try { return await activate(verify); }
      catch (error) { verifier = null; throw error; }
    };
    const deactivate = delivery.deactivateReceiver.bind(delivery);
    delivery.deactivateReceiver = () => { verifier = null; return deactivate(); };
    const destroy = delivery.destroy.bind(delivery);
    delivery.destroy = () => {
      if (destroyed) return;
      destroyed = true; verifier = null; connection.dispose(); destroy();
    };
    return delivery;
  } catch (error) {
    destroyed = true; verifier = null; connection?.dispose();
    if (delivery) delivery.destroy(); else host.destroy();
    throw error;
  }
}

module.exports = { createGatewayDelivery };
