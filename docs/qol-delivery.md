# QoL delivery and acceptance

Requested scope: all seven improvements proposed in the Codex task.

- [x] Personal defaults: `/profile set/show/clear`; optional summoner on lookups;
  saved region/mode; explicit options override defaults; private to each guild/user.
- [x] Interactive stat cards: 7/30 days, champion change, recent, refresh;
  owner-only controls, expired-card recovery, no mentions.
- [x] Admin tracking: add/remove/list/pause/resume, dynamic validated roster;
  fresh baselines, identity checks, shared monitor lease, preserved archived records
  and completion edits, no historical replay.
- [x] `/session`: today's W/L, time played, best champion, observed LP change
  where snapshots exist; explicit timezone, bounded sample and missing-data labels.
- [x] Deeper champion history: cached load-more batches beyond 30, deduplicated,
  bounded resource use, clear coverage and exhaustion/cap labels.
- [x] Less clutter: paginated recent cards, optional private lookup responses,
  admin live+completed versus completed-only delivery policy.
- [x] Credential health: durable owner notification on confirmed auth failure and
  recovery; no recurring spam, no secret values; retry failed delivery safely.

Verification: unit/integration tests for every requirement, signed Discord request
tests, D1 migration tests, request-budget tests, dry run, deployed health/schema,
and real Discord smoke as recorded below. Mutating admin controls and saved-default
writes are exercised against the real schema in isolated SQLite, not by changing
the owner's production settings. Credential outages are simulated in tests, not
by invalidating the working production key.
Never reset live monitor history, restore the retired webhook, or expand CI token
scope. Apply additive D1 migrations with the owner's existing Wrangler login.

Initial authoritative state: main clean at `10960e8`, 55 tests, three trackers in
legacy D1 JSON; bot-only cron healthy at last previous smoke.

Implementation verification (2026-09-06): all seven code paths implemented; 80
tests pass, including signed Discord interactions and the actual additive schema
in in-memory SQLite. Tests cover private defaults before acknowledgment, explicit
overrides, ownership/expiry/concurrency controls, the 300-game cap, paginated caches,
first-game detection for accounts without history, ten-account monitor budgeting,
archived live completion edits, and concurrent outage/recovery notification handling.
Wrangler D1 returned one transient 7403 error; a repeated read and migration-list
check succeeded with the existing OAuth login. No credential scopes were expanded.
Pre-migration monitor-state backup: `/private/tmp/leaguestats-before-qol-20260906.sql`.

Production evidence:

- Applied the additive migrations with the existing Wrangler OAuth account;
  no new token or broader CI permissions were needed.
- Release `c7907a2` passed both CI and Deploy workflows on GitHub.
- All 226 preexisting reported-game records (116/76/34 per tracker) and their
  Discord message IDs were retained after deployment. No history was reset.
- Public Worker, command schema and monitor health checks passed. Commands synced;
  credential health is `ok`, with no pending notice or delivery error. The monitor
  advanced from `2026-09-06T15:36:50Z` to `2026-09-06T15:44:50Z`, with all three
  trackers active and the existing live + completed alert policy unchanged.
- Native Discord smoke in #league-alerts: private TIXBS stats, 7-to-30-day switch,
  expanded sample from 30 to 60 games, champion modal selecting Xerath (28 games
  from the retained 60-game sample), recent page 1/2/back and Refresh all succeeded.
- Private HelloThere `/session` returned 2W–1L, 1h36m, champion portrait and LP
  explicitly labeled since the first same-day observation. `/profile show` returned
  the current unset defaults privately; no personal preference was overwritten.
- No live tracker was paused/removed, no production credential was invalidated,
  and no outage test DM or channel-wide announcement was sent.
