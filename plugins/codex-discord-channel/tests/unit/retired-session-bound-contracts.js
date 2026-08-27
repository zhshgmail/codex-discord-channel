'use strict';

// These tests document the v0.3.14-v0.3.16 session-bound design.  That design
// is deliberately retired: DISCORD_STATE_DIR is now the durable identity and
// session/thread/turn ids are transient RPC coordinates only.  Keeping the old
// bodies as skipped executable history makes the removal explicit without
// letting a prohibited contract remain a release gate.
const RETIRED = new Set([
  'host requires a fresh matching supervised TUI lease before selecting a loaded thread',
  'fresh host binds a launching lease to one resumed root without thread/started',
  'surviving host rebinds a replacement launching lease without thread/started',
  'host verifies the real supervised remote TUI child in procfs',
  'system-error recovery fails closed when the root status changes before submission',
  'fresh recovery still fails closed after proving multiple loaded roots',
  'fresh recovery bounds loaded-thread parent inspection at 32 candidates',
  'websocket reconnect after hidden thread rotation does not reuse the stale current thread',
  'latest top-level thread/started notification selects the rotated TUI thread among loaded history',
  'in-flight thread read cannot overwrite a newer top-level thread notification',
  'in-flight loaded-thread list cannot restore an older thread after rotation',
  'rotated current thread remains selectable beyond the first loaded-thread page',
  'host rejects a malformed cursor before accepting the current thread on that page',
  'host rejects malformed loaded-thread page data after a valid target page',
  'host rejects a repeated cursor before accepting the current thread on that page',
  'host fails closed when the shared app-server has no exact loaded thread',
  'accepted turn response keeps active delivery available when its notification is missed',
  'request-timeout reconnect retains the exact accepted active turn',
  'rejected timeout-recovery turn is discarded before the next target resolution',
  'verified idle target survives a gateway process restart through a durable checkpoint',
  'durable target checkpoint records every bounded loaded-thread page',
  'gateway restart retains a durable active target when an unrelated loaded child closed',
  'gateway restart retains a durable active target when an unrelated loaded child started',
  'gateway restart rejects malformed parent lineage for an added thread',
  'gateway restart rejects self-parent and orphan lineage for an added thread',
  'gateway restart rejects a multi-node cycle in added thread lineage',
  'same-runtime topology refresh rejects a multi-node cycle before replacing its checkpoint',
  'topology revision retries share one bounded resolution budget',
  'failed added-thread proof cannot be persisted by a later active notification',
  'gateway restart bounds added-thread lineage reads',
  'gateway restart bounds unique empty pagination cursors',
  'gateway restart discards a durable active target when a new top-level root appeared',
  'gateway restart discards a durable active target when the target thread is no longer loaded',
  'trusted local A-to-B active-turn mismatch retries once as one exact-readback delivery',
  'trusted local top-level-to-goal-continuation mismatch retries the UUIDv4 turn once',
  'v7-to-v4-to-v4 mismatch stops after two rejects and retains the latest goal turn',
  'untrusted active-turn rejection text never changes identity and forces exact revalidation',
  'active-turn mismatch does not retry after connection, revision, or root changes',
  'active-turn mismatch does not retry across a supervised TUI lease change',
  'disconnect after the one active-turn retry is uncertain and never submits a third call',
  'delayed same-root thread start preserves a proven same-lease checkpoint',
  'startTurn rejects a resolved target after a newer thread generation is selected',
  'exact lifecycle signal proves delivery for a resolved ephemeral TUI thread',
  'missing or stale TUI lease cannot authorize ephemeral lifecycle delivery proof',
  'first durable turn binding owns the final when its uncertain ack completes after a later source',
  'active-turn uncertain restart retains exact turn and becomes waiting only after proof',
  'matching lifecycle signal plus rollout evidence completes without a full thread read',
  'positive ack then real rollout UserMessage proof terminally reconciles uncertain without replay',
  'activation archives stale backlog before target resolution and delivers a fresh message',
  'cross-version activation archives ready and uncertain backlog before delivering fresh input',
  'activation archives matching-id queue entries older than its durable time watermark',
  'post-activation admission archives a Discord event created before the watermark',
  'archived Discord identity remains deduplicated after activation',
  'startup drain advances a crashed accepted head and submits the next FIFO item',
  'startup drain probes an unreconciled crashed head once and defers it visibly',
  'foreign delivery lease schedules one expiry wake and drains without replay',
  'reconnect drain reconciles an accepted head before submitting the next FIFO item',
  'uncertain structured acknowledgement is visible but cannot block later FIFO items',
  'successful response without a persisted user item is not marked complete',
  'unsupported acknowledgement recovery remains structured_ack_uncertain',
  'remote unsupported acknowledgement read remains structured_ack_uncertain',
  'unpersisted successful response reconciles later without replay',
  'uncertain acknowledgement reconciles by client id without replaying turn/start',
  'expired uncertain delivery remains fail closed and never replays turn/start',
  'uncertain reconciliation rotates fairly without replaying later items',
  'legacy global acknowledgement block migrates to retry lane without blocking later FIFO',
  'post-accept uncertainty persists replay identity and reconciles after restart',
  'shell launcher resumes the exact captured thread after app-server replacement',
  'recovery begin receives milliseconds from the configured Node clock',
  'recovery inserts exact resume after preserving global flags when no resume was supplied',
  'recovery discards the original prompt instead of replaying it after resume',
  'recovery discards image prompt inputs instead of replaying them after resume',
]);

function stateDirContractTest(nodeTest) {
  return new Proxy(nodeTest, {
    apply(target, thisArg, args) {
      const implementation = RETIRED.has(args[0]) ? target.skip : target;
      return Reflect.apply(implementation, thisArg, args);
    },
  });
}

module.exports = { RETIRED, stateDirContractTest };
