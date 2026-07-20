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

## Authority Format

Pure A7 authority remains the existing one-line version-2 JSON record.

When an A7 successor retains a version-1 A6 fallback, it atomically writes one
compatibility-framed authority file:

```text
<a6-fallback-pid>
<version-2-json-record>
```

A6 parses the leading integer and continues to recognize itself. A7 parses the
structured body and continues to use PID plus generation for current/fallback
selection and compare-and-swap snapshots. The parser accepts the frame only
when its prefix equals the structured version-1 fallback PID; malformed or
mismatched frames fail closed.

The commit still consists of one temporary-file write and one rename over
`session-gateway.pid`. The exact file token remains the compare-and-swap value.
No new sidecar authority and no helper process are introduced.

## Failback

After a post-commit A7 crash, no state mutation is required: A7 readers select
the live fallback after finding the primary dead, while actual A6 code still
reads its own PID from the frame.

On graceful A7 release, a live version-1 fallback is restored as the legacy
integer PID record. Its existing `.generation` record is left untouched, so
A6 generation checks remain valid and a later A7 reader can still migrate it.
All-A7 fallback promotion remains version-2 JSON.

## Tests

A mixed-binary test extracts and loads `src/receiver-state.js` from exact A6
commit `c09749a018253e79ac939be1e2a5809756209437`. It creates an A6 authority,
commits an A7 successor with the current module, and proves that the historical
A6 implementation remains active after both simulated post-commit successor
death and graceful successor release.

Existing focused and full tests continue to prove atomic CAS, all-A7 fallback,
handoff-race dedupe, target-down queue/restart exactly-once behavior,
generation-safe shutdown, session/thread rotation independence, and the ban on
terminal-input and child-process injection paths.
