---
name: codex-session-runtime-status
description: Use when someone asks which model or reasoning effort the current Codex session is actually running, including Discord status questions such as "what model are you running?", "你现在什么模型？", or "思考级别是什么？".
---

# Codex Session Runtime Status

Report only runtime values proven for the exact current thread.

## Workflow

1. Run the bundled `scripts/codex-session-runtime --json`. Pass
   `--thread-id UUID` only when the exact thread ID is explicitly known; the
   script otherwise requires `CODEX_THREAD_ID`. Use `--codex-home PATH` only
   for an intentional alternate Codex home.
2. On `status: "ok"`, reply in the user's language and keep it concise. For
   Chinese, use `模型：<model>` and `思考级别：<effort>`.
3. On a nonzero exit or `status: "unknown"`, say the current runtime could not
   be verified. Do not fill a partial result or guess.

The rollout JSONL for the exact thread is the sole runtime authority. Never
choose the newest session. SQLite is only a cross-check; `config.toml` and
model caches are defaults/catalogs, not current-runtime evidence. Never expose
thread IDs, paths, prompts, messages, tokens, secrets, or history in the reply.
