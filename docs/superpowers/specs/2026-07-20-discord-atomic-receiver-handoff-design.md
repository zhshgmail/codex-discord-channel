# Discord Atomic Receiver Handoff Design

## Scope

Repair only Discord gateway receiver startup and takeover on the A7 branch. Do
not alter NPU Autoport, iQuest, live services, Codex configuration/state, access
policy, structured turn payloads, or terminal behavior.

## Receiver Authority

`session-gateway.pid` becomes the only authoritative receiver record. Its
atomic JSON record contains the current PID, generation, claim time, and an
optional incumbent fallback. The former `.generation` file is read only to
migrate an existing integer PID record; new claims do not write it.

A receiver is effective when either:

- its PID and generation are the current record and that process is alive; or
- it matches the fallback and the committed successor process is dead.

This keeps an A7 incumbent eligible after a successor crashes immediately
after authority commit. `owner.json` remains status/handoff metadata and never
participates in message admission.

## Startup And Handoff

Every explicit gateway logs in to Discord and proves that the durable queue can
be opened before attempting receiver authority.

When a live incumbent exists, the successor also proves app-server target
readiness. It then acquires the delivery queue lock, verifies that the
authority snapshot has not changed, arms its Discord listener with a candidate
generation, and atomically renames the candidate record over
`session-gateway.pid`. The incumbent remains effective before that rename; the
successor is effective after it. Queue admission rechecks generation while
holding the same queue lock, so a message races entirely before or after the
commit and Discord identity deduplication prevents replay.

When no live incumbent exists, target readiness is not a startup gate. The
gateway still logs in, proves durable queue readiness, arms its listener, and
atomically claims authority. Accepted messages persist while the app-server is
unavailable and the existing reconnect path drains them after recovery or a
restart.

If two starters observe no incumbent, only the unchanged authority snapshot
may commit. The loser removes its listener and exits without replacing the
winner.

## Failure Handling

Before commit, a crash leaves the prior record untouched. After commit, the
listener is already armed. If the successor process dies after commit, an A7
incumbent named as fallback becomes effective without a second state-file
mutation. Graceful shutdown compares the exact generation before releasing or
promoting fallback ownership.

The authority commit is the final required operation in startup. Compatibility
reads of legacy integer PID plus `.generation` state do not create new split
state.

## Tests

Deterministic tests cover crashes after Discord login, durable queue readiness,
target readiness, listener arm, and authority commit. Race tests cover two
simultaneous sole starters and an in-flight incumbent admission crossing the
commit. A sole-receiver test starts with an unavailable app-server, persists an
event, restarts with a ready target, and proves exactly one delivery.

Existing tests continue to cover access gates, pre-drain persistence, socket
timeout fencing/reconnect, foreign-lease expiry wake-up, owner metadata
semantics, and the production-source ban on terminal injection.
