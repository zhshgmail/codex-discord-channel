# Guarded scheduled reports

Source-only deduplication treats each hourly report as the same answer forever. The fix gives each explicitly authorized report occurrence its own receipt and Discord nonce, while retaining the original exact-source receipt unchanged. Same-occurrence retries, concurrency, lost confirmation, and reconciliation still use the original durable guard. `followup` is rejected for scheduled reports. No backlog burst: an unsent expired slot is rejected; an existing old receipt may still reconcile.

An operator configures `scheduled-reports.json` in this instance state directory, based on a real owner instruction. Do not write this file or install over a live instance as part of source tests. Replace the example target with that instance's authorized channel and original request:

```json
{
  "version": 1,
  "reports": {
    "hourly-progress": {
      "enabled": true,
      "channelId": "AUTHORIZED_CHANNEL_ID",
      "replyTo": "ORIGINAL_REQUEST_ID",
      "intervalMinutes": 60,
      "startsAt": "2026-10-28T00:00:00.000Z"
    }
  }
}
```

At an actual scheduled occurrence the existing MCP send tool receives the same exact channel/source/content plus:

```json
{"scheduledReport":{"id":"hourly-progress","occurrence":"2026-10-28T16:00:00.000Z"}}
```

The runtime checks the configured target and cadence, rejects future/off-cadence/unconfigured calls before POST, then reuses guarded send with a namespace derived from the schedule and occurrence. The source message remains the real authority; it is never replaced by a fabricated Discord parent. An old source-reply receipt is neither deleted nor reset. Readback still requires exact outgoing id/channel/parent/content/bot identity.

Tests exercise the actual MCP call path against an in-memory Discord transport, including its real preflight, nonce, POST, confirmation, and duplicate behavior. This is isolated source validation, not live delivery or installed acceptance. Follow the existing plugin skill deployment window and isolated alias acceptance before any live activation; no running Codex02/Codex01 plugin or state has been modified.
