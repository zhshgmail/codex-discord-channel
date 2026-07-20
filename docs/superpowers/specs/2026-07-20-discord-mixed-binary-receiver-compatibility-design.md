# Discord Mixed-Binary Receiver Compatibility Design

## Scope

Repair only A6-incumbent to A7-successor receiver failback. Preserve the A7
atomic authority compare-and-swap, generation fencing, all-A7 fallback, durable
queue deduplication, target-down recovery, generation-safe shutdown, and
state-path authority. Do not access live state, services, or terminal devices.

## Root Cause

A6 reads `session-gateway.pid` with `Number.parseInt()`. A7 atomically replaces
that file with JSON beginning with `{`, so a still-running A6 incumbent reports
`gateway_pid_missing`. A7 can interpret its fallback after a successor dies,
but the unchanged A6 binary cannot.

No static file can make unchanged A6 observe the successor PID while that
process lives and the incumbent PID after it dies. The mixed-version handoff
must therefore leave A6 eligible throughout the compatibility interval. The
existing process-safe queue lock and Discord identity deduplication remain the
exactly-once boundary if both binaries observe the same event.

## Authority Views

Pure A7 authority remains the existing one-line version-2 JSON record.

When an A7 successor retains a version-1 A6 fallback, it leaves
`session-gateway.pid` and `.generation` byte-for-byte unchanged and atomically
writes its version-2 record to `session-gateway.pid.v2`. A7 readers prefer this
staged authority; A6 continues to read its legacy files. The staged record's
exact file token remains the compare-and-swap value, and malformed staged state
fails closed over the legacy view. No helper process is introduced.

## Failback

After a post-commit A7 crash, no state mutation is required: A7 readers select
the live fallback after finding the primary dead, while actual A6 code still
reads its unchanged PID and generation.

On graceful A7 release, a live version-1 fallback is restored by removing only
the staged authority. A6 generation checks remain valid. If A6 shuts down while
A7 is live, its `clearPid()` removes only the legacy view and A7 continues from
the staged record. All-A7 fallback promotion remains version-2 JSON.

## Tests

A mixed-binary test loads a byte-identical vendored `src/receiver-state.js` from
exact A6 commit `c09749a018253e79ac939be1e2a5809756209437`, guarded by SHA-256
`511c574c2636b6e4238c8bdd1c137eadf4321988a0e81f00c8bede32bed5906f`.
It proves historical A6 behavior after post-commit successor death, graceful A7
release, and graceful A6 shutdown while A7 remains live.

Existing focused and full tests continue to prove atomic CAS, all-A7 fallback,
handoff-race dedupe, target-down queue/restart exactly-once behavior,
generation-safe shutdown, session/thread rotation independence, and the ban on
terminal-input and child-process injection paths.
