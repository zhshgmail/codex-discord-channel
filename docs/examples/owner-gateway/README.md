# Optional original-owner gateway connection

This candidate connects a trusted owner adapter to **`codex-discord-channel gateway`**, the normal alias receiver. It does not change `mcp-server.main`, create another socket, enable a task, or deploy an instance. Without the two explicit local settings, delivery uses the existing default factory.

The communication code loads an owner-provided CommonJS module exporting `createGatewayDelivery(args)`. It receives the original `config`, `logger`, automatic-reply dependency, `createDelivery`, `createAppServerHost`, an absolute adapter config path and a read-only queue-status function. The adapter must return the original delivery interface and preserve its receiver/FIFO/receipt protections. This is trusted executable configuration, not a sandbox or a module name supplied by a message.

`autoport-factory.cjs` is a concrete owner-side example using the [fixed original callbacks](https://gitcode.com/zhengshencn_hwca/npu-autoport-pipeline/blob/f901cf9cd1ea50a9ef49f37ca832ae72bb377119/docs/examples/native-assignment-continuation/OWNER_CALLBACKS.md). The owner keeps the assignment, Plan/STATE, explicit admissions, latest intent/STOP, handles/results/UNKNOWN and cumulative budget. No business selector is added to the communication plugin.

The fixed callback needs the adjacent **proposed** `owner-callback-fences.patch` before using this adapter. It adds a synchronous `beforeSubmit` hook and deferred terminal recording. The adapter fails closed if either capability is missing. Apply this patch in an owned Autoport checkout at the fixed ref; it has not been applied to Autoport main by this work.

```sh
git apply /absolute/path/to/owner-callback-fences.patch
```

Use an owner-controlled adapter binding (absolute paths, no tokens):

```json
{
  "callbackModulePath": "/absolute/owner/autoport-owner-callbacks.cjs",
  "connectorModulePath": "/absolute/owner/owner-receiver-connection.cjs",
  "ownerConfigPath": "/absolute/owner/owner-config.json"
}
```

The full original owner config must already exist; its schema is in the linked `OWNER_CALLBACKS.md`. Keep `deploymentEnabled: false` during preparation. The owner supplies admissions. To opt in in a separately authorized alias upgrade/restart window, set its local configuration:

```text
CODEX_DISCORD_GATEWAY_DELIVERY_MODULE=/absolute/path/to/autoport-factory.cjs
CODEX_DISCORD_GATEWAY_DELIVERY_CONFIG=/absolute/owner/adapter-binding.json
```

The factory creates one host and passes that same object to both callback and delivery. Ordinary input and active-turn steer keep the exact Discord envelope, with a separate trusted local context containing the stable input ID, admissions path, latest snapshot path and durable outcomes path. The native Owner must read the latest files and make an explicit admission; context delivery does not prove it did so. Rebinding an assignment requires an explicit adapter restart. The example reads the latest outcome as context, while the ledger remains the complete record.

Terminal handling uses the existing queue coordination lock. Pending/uncertain Discord inputs and inactive receivers defer dispatch while retaining the exact terminal; the next natural terminal or explicit owner recheck can consume retained causes. Dispatch rechecks current receiver authority before send. Deactivation after reservation stays conservatively UNKNOWN for native reconciliation, with no automatic retry. Destruction detaches subscriptions and releases the host.

## Validation boundary

Source tests cover the actual `runGateway` factory call and failure cleanup, default behavior, explicit module selection, ordinary/active input context and FIFO retention on context failure. The separate integration consumer connects this example, the fixed owner connector and the patched actual callbacks through the same injected host/client, including two observations before admission, one combined submission, STOP/budget/disabled state, pending FIFO, receiver loss, reconstruction deduplication and cleanup. No production Discord/WebSocket, real model, NPU, long unattended run or native Owner file consumption is certified by these controls.

The existing installed version is 0.3.26. This candidate is based on its source `cfcd0e1`; the current remote default `a6f3705` is older (0.3.23). The patch must be integrated with the maintained release lineage without removing its intervening transport fixes. This branch does not release a version or change installed caches/generations.
