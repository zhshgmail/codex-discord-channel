# Atomic TTY Submission Plan

**Goal:** Make each verified Discord TTY delivery arrive as one explicit paste event followed by one submit event, without depending on a later message.

**Observed failure:** The live gateway writes plain prompt bytes and then starts a second injector for `CR` after a 500 ms delay. Codex can classify the plain-byte stream as a paste burst and treat Enter as pasted text instead of submission. The separate writes also leave an interleaving window. A gateway delivery logged at `2026-07-17T01:43:06.619Z` did not become a user turn in the exact visible TUI rollout until `2026-07-17T02:36:15.297Z`.

**Safety contract:** Receiver admission remains durable and non-blocking. Injection occurs only through the existing explicit flush seam after readiness includes verifiable source and evidence. Busy composers, modal UI, or existing draft text remain queued. `owner.json` is not a message gate.

## Tasks

1. Add failing delivery tests for one-write bracketed paste plus submit, FIFO separation of consecutive messages, long Unicode content, and not-ready/draft preservation.
2. Frame sanitized prompt bytes with terminal bracketed-paste delimiters and append the configured submit sequence in the same injector invocation.
3. Keep uncertain injection fail-closed so the FIFO cannot duplicate a message after an ambiguous write result.
4. Run targeted tests, the full package checks, plugin validation, and an isolated real Codex TUI smoke test when host constraints allow it.
5. Review the diff and commit on `fix/discord-tty-submit-20260716` without deploying or pushing.
