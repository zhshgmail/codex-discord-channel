# Stable Discord Instance Identity

## Problem

Codex session ids, top-level thread ids, and active turn ids rotate during
`/clear`, compaction, transport replacement, and ordinary restart. They are
valid only as short-lived app-server addresses. Treating any of them as an
owner, receiver, account, workspace, or recovery identity makes a healthy
Discord instance disappear or reconnect to stale state.

This design removes those volatile ids from identification and authorization.
It does not remove exact thread and turn addresses from structured delivery:
the app-server protocol still requires them to route one request and prove its
durable acknowledgement.

## Identity And Authority Layers

| Layer | Stable inputs | Authority | Explicitly forbidden inputs |
| --- | --- | --- | --- |
| Instance | normalized alias, canonical `CODEX_HOME`, canonical private Discord state directory | exact account binding files plus the instance-local launcher boundary | Codex session/thread/turn ids, `CODEX_DISCORD_OWNER_ID` |
| Live generation | instance identity, launcher lock, generation nonce, exact PID/start ticks/process group, argv, socket inode | atomic generation manifest and procfs verification | owner metadata, remembered thread ids |
| Discord receiver | instance state directory, exact PID/generation authority record | atomic `session-gateway.pid` CAS plus process liveness | `owner.json`, Codex session/thread/turn ids |
| Delivery route | current connection, current top-level thread, exact active turn when steering | bounded live app-server inventory and notifications | use as account, owner, receiver, or recovery authority |
| Discord reply | source channel/message, bot author, nonce, returned message id | guarded receipt plus exact Discord readback | mutable last-inbound state or Codex ids |

The instance exposes a diagnostic `instanceIdentity` fingerprint computed from
the stable instance tuple. The fingerprint is not a secret and does not grant
authority. It is a deterministic join key that lets status and `owner.json`
show whether two processes were configured for the same instance without
borrowing a Codex id.

## Owner Metadata

`owner.json` version 2 contains the stable instance identity and local process
metadata. It contains no owner, session, or thread id. Rewriting the file on a
new MCP process does not change the instance identity and never changes the
active receiver. `CODEX_DISCORD_OWNER_ID`, `CODEX_THREAD_ID`,
`CODEX_SESSION_ID`, and `CODEX_TARGET_THREAD_ID` cannot affect configuration.

## Transport Replacement

The launcher no longer reads a captured thread id to select the replacement
TUI after an app-server socket generation change. It preserves the original
global Codex options and workspace context, discards prompt/image inputs that
must not be replayed, and runs `resume --last` under the same isolated Codex
account and instance generation.

The supervised TUI lease may still carry the current thread address so the
gateway can prove which loaded top-level route belongs to that live TUI. The
lease is authorized by its random lease id plus supervisor PID/start ticks; the
thread address is payload, not identity or authority. A stale or ambiguous
route fails delivery closed and is rediscovered from the live app-server.

## Migration And Compatibility

- Existing version-1 `owner.json` is readable as historical metadata but is
  overwritten with version 2 on the next MCP or gateway start.
- The receiver authority and Discord exactly-once receipt formats do not
  change.
- The runtime bundles must be rebuilt from the exact source revision before
  release.
- Installation and live process migration remain separate owner-approved
  gates. Repository GREEN is not live Discord acceptance.

## Acceptance

Repository acceptance requires tests that prove:

1. changing every volatile Codex id leaves the stable instance fingerprint
   unchanged;
2. changing the account or state binding changes the fingerprint;
3. `owner.json` contains no session/thread owner identity;
4. socket-generation recovery uses `resume --last` and never emits or submits
   the captured thread id; and
5. the full source, bundled-runtime, smoke, and syntax checks pass.

Live acceptance additionally requires the exact visible Codex02 TUI to receive
a new Discord message, rotate with `/clear`, receive a second message in the
new route, and read back any outbound reply from Discord. The instance
fingerprint must remain unchanged across the rotation.
