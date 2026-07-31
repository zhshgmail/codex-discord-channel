# Known Issues And Operational Boundaries

This page records user-visible failures that can otherwise look successful in
gateway logs. It deliberately separates transport acceptance, durable thread
delivery, and model behavior.

## Acknowledged Turn Missing From The Visible Thread

### Symptom

The gateway logs both:

```text
Accepted queued Discord message through the shared app-server
Discord message delivery result {"status":"delivered","reason":"turn_accepted"}
```

and `pending-delivery.json` moves the Discord identity into `completed`, but the
message is absent from the exact target thread's rollout and the visible TUI.
The owner sees no response even though the queue is empty.

### Cause

Releases through `0.2.0+git.9b74c5c20047` treated a successful
`turn/start` or `turn/steer` response as the final completion boundary. The
stable `clientUserMessageId` read-back check was used only when the request
acknowledgement was uncertain. A positive response followed by a missing user
item therefore produced a false completed record and suppressed replay.

This is an acknowledgement-boundary defect. It is not an access-policy,
mention, Discord login, or FIFO persistence failure.

### Observed Stale-Runtime Recurrence

On 2026-07-30/31, a user-reported missing Discord message was investigated
after the fix was already present in the repository at `508c340`. The active
`codex01` systemd unit was still executing the older affected runtime
`0.2.0+git.9b74c5c20047`, and that process had started before the fix was
published. The queue continued to record positive `turn_accepted` results.

This establishes a deployment-identity gap: a fixed checkout does not repair
an already-running gateway. It does not, by itself, attribute a particular
missing message when that message's Discord id is unavailable. For an exact
incident verdict, apply the four diagnosis steps below to that id.

### Fixed Behavior

After a positive structured response, the gateway now reads the exact target
thread and requires a `userMessage` with the same stable
`clientUserMessageId`. Only that proof can move the Discord identity into
`completed`.

If the user item is not observable, the queue head remains durable and status
reports `structured_ack_uncertain`. Periodic reconciliation checks for the
stable client id and completes without a second `turn/start` or `turn/steer`
request once the item appears.

### Diagnosis

1. Find the message id in `last-inbound.json`.
2. Find the same identity in `pending-delivery.json`.
3. Check `session-gateway.log` for the access-policy and delivery result.
4. Inspect the exact current thread rollout, not merely the newest rollout.

The failure is present when the identity is in `completed`, the gateway reports
`turn_accepted`, and the exact rollout has no matching Discord envelope.

### Remaining Boundary

Read-back proves that the user item is durably attached to the intended Codex
thread. It does not prove that the model understood every instruction, produced
a reply, or completed the requested work. Those are application-level
acceptance conditions and must be verified separately.

## Mentioned Guild Message Is Not Accepted

Check `access.json`, not `owner.json`:

- the exact guild channel or thread must exist under `groups`;
- the sender must be allowed;
- bot senders require `allowBots: true`;
- with `requireMention: true`, the message must match the current bot user id,
  a configured `mentionPatterns` entry, `@everyone`, or the documented reply
  audience rules.

`owner.json` records status and handoff metadata only. It must never gate an
individual inbound message because `/clear` can rotate thread identity while
the same Discord state path remains active.

## Thread Message Is Denied Although Its Parent Channel Is Enabled

### Symptom

The Discord gateway remains connected and logs current events, but a message
inside a newly created thread is denied with `guild_channel_not_enabled`. The
same mentioned sender is accepted in the parent channel.

### Cause

Releases through `0.2.1+git.92d5d37cc13b` looked up guild policy only by the
message's exact `channelId`. Discord threads have their own channel IDs, so an
enabled parent channel did not authorize any thread created below it. History
lookup encoded the same incorrect exact-ID requirement in a unit test.

### Fixed Behavior

An exact thread policy remains an optional override. Otherwise, public,
private, and announcement threads inherit `requireMention`, `allowFrom`, and
`allowBots` from an enabled parent channel. The actual thread ID remains the
delivery and reply destination. Ordinary text channels do not inherit policy
from category parents, and threads below unknown parents remain fail-closed.

This matches the Claude Code Discord plugin's access boundary: policy is keyed
by `thread.parentId`, while replies continue to use the thread's own ID.

## Gateway Is Healthy But Messages Go To No Visible Console

The gateway and visible TUI must share the same externally reachable Codex
app-server. Start the TUI with `codex --remote <same-endpoint> ...`; a direct
TUI uses a private embedded server that this gateway cannot prove or target.

Verify `session-gateway.pid` before investigating model behavior. Exactly one
effective receiver generation may accept Discord events. Keep the retired
`discord-codex-bridge` service disabled so it cannot compete for the bot.

## Installed Plugin Changes Do Not Appear In An Existing Session

An already-open MCP transport does not hot-load replaced plugin code. Install
the new plugin version, migrate the gateway under change control, and start a
new Codex thread. Use a versioned runtime directory so the durable delivery
activation boundary cannot replay an old backlog.
