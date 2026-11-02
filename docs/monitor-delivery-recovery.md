# Recovering an uncertain monitor delivery

An uncertain POST blocks **all game/rank monitor observations, completion edits,
and new alerts**, not just the affected player. Slash commands are separate;
commands using saved monitor history may show stale data. Other scheduled features
have separate delivery state. Disabling `MONITOR_ENABLED` also pauses scheduled
features that honor that switch.

## Detection and practical effort

Poll `/monitor/status` externally and notify an operator when
`delivery.status == "needs_review"`. HTTP 200 and the root health check alone do
not mean monitoring is progressing. Also watch an aging `lastCheckAt` and a
persistent `checkpoint_pending` (which normally clears next tick). This repository
does not configure an on-call notification service; without one, time to notice is
unbounded. Send incident notifications through a separate route, not this blocked
Discord delivery path.

For one readily identifiable message and an operator with working Cloudflare and
Discord access, budget **5–15 minutes of hands-on work after detection**. This is
an engineering estimate, not measured incident data or an SLA. Add any remaining
monitor lease time (up to four minutes after its last renewal), credential/access
delays, and roughly one minute for the next cron tick after resuming. An ambiguous
or deleted message can require much longer; there is no safe fixed recovery time
when delivery cannot be proven either way. We have no failure-rate measurements.

## Confirmed delivery runbook

1. Set the existing `MONITOR_ENABLED` secret to `false` through Cloudflare or
   `pnpm exec wrangler secret put MONITOR_ENABLED`. Confirm status reports disabled.
   Wait until the stored monitor lease has expired; do not forcibly clear a live
   lease. Freeze other operator state edits during reconciliation.
2. With authorized D1 access, export/back up `monitor_state` and the
   `bot_records` row whose `record_key` is `monitor:delivery`. Keep backups private;
   they contain player data. The receipt must have `expires_at = 0`.

   ```sql
   SELECT state_key, lease_owner, lease_until, updated_at
   FROM monitor_state WHERE state_key = 'league-game-monitor';
   SELECT payload, expires_at FROM bot_records WHERE record_key = 'monitor:delivery';
   ```

3. In the receipt's `channelId`, inspect bot-authored messages around `attemptedAt`.
   Match **every** receipt item (player, game identity/start time, or rank transition)
   to the grouped message. Copy its message ID/link. If using Discord's API, verify
   the author and channel too; a returned matching nonce is supporting evidence,
   not a permanent searchable delivery ledger. Do not use a partial history view,
   missing search result, or a possibly deleted message as proof of non-delivery.
4. If status is already `sent` with the verified ID, skip the SQL change and resume.
   Otherwise, only after confirming delivery, substitute the three placeholders
   below with the exact receipt nonce, attempt timestamp and verified numeric
   message ID. Run against the intended remote D1 database, e.g.
   `pnpm exec wrangler d1 execute league-stats-monitor --remote --file=reconcile.sql`.
   Inspect the file first. This updates only the receipt and returns the updated
   payload; **zero returned rows means stop and re-read**, not remove the guards.

   ```sql
   UPDATE bot_records
   SET payload = json_set(payload, '$.status', 'sent', '$.messageId', 'VERIFIED_MESSAGE_ID')
   WHERE record_key = 'monitor:delivery'
     AND expires_at = 0
     AND json_extract(payload, '$.status') = 'sending'
     AND json_extract(payload, '$.nonce') = 'EXPECTED_NONCE'
     AND json_extract(payload, '$.attemptedAt') = 'EXPECTED_ATTEMPT_AT'
     AND EXISTS (
       SELECT 1 FROM monitor_state
       WHERE state_key = 'league-game-monitor'
         AND lease_until < unixepoch('now') * 1000
     )
   RETURNING payload;
   ```

5. Preserve `items`, `channelId`, `nonce` and `attemptedAt`. Re-enable monitoring.
   On the next tick, recovery checkpoints the delivered records before any Riot
   calls or new POSTs. Verify `needs_review` disappears, `lastCheckAt` advances,
   and the affected records contain the verified Discord ID. Check that subsequent
   completion updates edit that message and no duplicate appears. `checkpoint_pending`
   can briefly recur if the same tick sends a different batch.

Only remove a receipt when non-delivery has been independently established; keep
an audit of the evidence and use the same nonce/time/expired-lease guards. If that
cannot be established, keep monitoring blocked and investigate. A corrupt or
conflicting receipt needs investigation, not a baseline reset. Never erase
reported-game maps, overwrite the whole state from the backup, or advance cursors
to make the error disappear.

## What players see after recovery

The confirmed alert is retained rather than reposted. Completed games catch up
chronologically in batches of at most five per tracker, subject to the shared
Riot request budget and ten-alert batch limit, so a backlog may take several ticks.
Live games that start and end during the outage cannot get a retrospective live
alert, but their completed results can be recovered from match history. A cursor
outside the newest 100 games requires further intervention. Rank polling observes
current snapshots, so intermediate transitions can be missed; after a gap over
48 hours it establishes a new rank baseline instead of emitting a demotion.

The quickest low-risk availability improvements are external notification and this
prevalidated confirmed-send procedure. A future authenticated reconciliation tool
could verify the candidate Discord message and apply the guarded update. Automatic
history matching must not infer non-delivery from absence. Allowing unrelated
players to proceed would require independent receipts/queues and cursor commits;
that is a larger change than bypassing the existing global safety gate.
