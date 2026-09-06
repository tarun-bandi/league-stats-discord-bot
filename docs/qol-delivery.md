# QoL delivery and acceptance

Requested scope: all seven improvements proposed in the Codex task.

- [ ] Personal defaults: `/profile set/show/clear`; optional summoner on lookups;
  saved region/mode; explicit options override defaults; private to each guild/user.
- [ ] Interactive stat cards: 7/30 days, champion change, recent, refresh;
  owner-only controls, expired-card recovery, no mentions.
- [ ] Admin tracking: add/remove/list/pause/resume, dynamic validated roster;
  fresh baselines, identity checks, shared monitor lease, preserved archived records
  and completion edits, no historical replay.
- [ ] `/session`: today's W/L, time played, best champion, observed LP change
  where snapshots exist; explicit timezone, bounded sample and missing-data labels.
- [ ] Deeper champion history: cached load-more batches beyond 30, deduplicated,
  bounded resource use, clear coverage and exhaustion/cap labels.
- [ ] Less clutter: paginated recent cards, optional private lookup responses,
  admin live+completed versus completed-only delivery policy.
- [ ] Credential health: durable owner notification on confirmed auth failure and
  recovery; no recurring spam, no secret values; retry failed delivery safely.

Verification: unit/integration tests for every requirement, signed Discord request
tests, D1 migration tests, request-budget tests, dry run, deployed health/schema,
and real Discord smoke of defaults/buttons/history/session/privacy/admin controls.
Never reset live monitor history, restore the retired webhook, or expand CI token
scope. Apply additive D1 migrations with the owner's existing Wrangler login.

Initial authoritative state: main clean at `10960e8`, 55 tests, three trackers in
legacy D1 JSON; bot-only cron healthy at last previous smoke. Not completed yet.

Implementation checkpoint (2026-09-06): all seven code paths implemented; 76
tests pass, including signed Discord interactions and the actual additive schema
in in-memory SQLite. Production migration/deployment and UI smoke still pending.
Wrangler D1 returned one transient 7403 error; a repeated read and migration-list
check succeeded with the existing OAuth login. No credential scopes were expanded.
Pre-migration monitor-state backup: `/private/tmp/leaguestats-before-qol-20260906.sql`.
