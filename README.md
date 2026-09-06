# LeagueStats Discord Bot

[![CI](https://github.com/tarun-bandi/league-stats-discord-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/tarun-bandi/league-stats-discord-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Cloudflare Worker for League of Legends Discord slash commands and a one-minute game monitor.

## Features

- `/help`, `/stats`, `/recent`, `/session`, `/live`, `/profile`, `/track`, and `/ping`
- Arbitrary Riot IDs and supported League regions for interactive commands
- Monitored-account autocomplete for the `summoner` option on `/stats`, `/recent`, and `/live`
- One-minute Cloudflare Cron Trigger with an admin-managed NA roster
- Riot Match-v5 and Spectator-v5 monitoring
- D1-backed durable cursors, live-game correlation, and Discord message IDs
- One Discord alert per game, authored by the LeagueStats bot and edited when the game completes
- Discord mentions disabled in every response
- Solo/Duo and Flex demotion alerts (tier/division drops, not LP fluctuations)
- Game-mode filters, including ARAM Mayhem, with current queue labels
- Optional `/stats champion` filter with champion-name autocomplete
- Damage, vision, gold, placement and pentakill details where Riot supplies them
- Champion portraits on recent-game cards, live/completed alerts, live responses and stats
- Automatic slash-command registration after a deployment
- Per-user, per-server account/region/mode/privacy defaults
- Owner-only interactive cards, recent pagination and cached history up to 300 games
- Session summaries with time played and observed (not reconstructed) LP changes
- One-time credential-failure/recovery notifications to the configured owner

## Try it

```text
/stats summoner:HelloThere#9494
/stats summoner:TIXBS Chaos#NA1 mode:ARAM
/stats summoner:HelloThere#9494 champion:Zed days:30
/recent summoner:Knaye East#YEEZY mode:ARAM Mayhem
/live summoner:HelloThere#9494
/profile set summoner:TIXBS Chaos#NA1 mode:Ranked Solo/Duo
/stats champion:Xerath private:true
/session
```

Select `summoner` to see the three monitored accounts. Any valid Riot ID still
works. `mode` defaults to all modes; stats cover seven days by default and at most
30 matches initially. Use **Load 30 more** to scan older games in cached batches,
up to 300 per card. Add `champion` to get that champion's win rate, KDA, CS/min, games/day
and impact stats, with its portrait. Champion names are suggested as you type;
punctuation/case and canonical aliases such as Cho'Gath/Chogath and
Wukong/MonkeyKing are accepted. It combines with `days`, `mode` and `region`.
Champion filtering applies **within the games scanned for the chosen
period and mode**, not the newest games on that champion. The response labels
the sample; older champion games may be excluded. Rank stays account-wide.
Omit `champion` for the existing overall stats. Riot may not expose completed ARAM Mayhem matches. See the
[payload and mode guide](docs/payload.md) for exactly what we can show.

## Cloudflare bindings

- `DISCORD_PUBLIC_KEY` — Worker secret used to verify Discord interactions
- `RIOT_API_KEY` — Worker secret used for Riot API requests
- `DISCORD_BOT_TOKEN` — Worker secret used to create and edit monitor alerts
- `DISCORD_ALERT_CHANNEL_ID` — destination channel for monitor alerts
- `MONITOR_ENABLED` — explicit monitor kill switch; only `true`, `1`, `yes`, or `on` enables checks
- `MONITOR_DB` — D1 binding containing the authoritative monitor state
- `DISCORD_APPLICATION_ID` — public bot application ID, enables automatic command reconciliation
- `DISCORD_GUILD_ID` — public alerts-server ID; restricts admin tracking controls

The production Cron Trigger is `* * * * *`. The monitor does not access D1,
Riot, or Discord while `MONITOR_ENABLED` is false. When enabled, it refuses to
access Riot or Discord if its D1 state is missing, corrupt, or invalid.

## Local development

```sh
pnpm install
pnpm test
pnpm wrangler dev
```

Put local-only secrets in `.dev.vars`; that file is ignored by Git.

## Deployment

Apply the additive migrations in `migrations/` (including `0002_bot_records.sql`), seed the `league-game-monitor` row
from a validated state backup, configure the five secrets, and deploy with
Wrangler. Do not enable the Cron Trigger until the state row is present.

Global Discord commands can be bulk-registered with:

```sh
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN_FILE=/secure/path/token \
  pnpm register:commands
```

The registration script reads the bot token from the file and never prints it.
For the running monitor, command schema changes are also registered automatically
on the next successful check. The encrypted runtime bot token stays in Cloudflare,
not in CI. Command reconciliation is skipped while monitoring is disabled.
Autocomplete suggestions are read from the authoritative D1 monitor state, so a
Riot ID rename tracked by the monitor is reflected without another command
registration. The three current IDs are used as a fallback if state is
temporarily unavailable; users may still enter any valid Riot ID.

Before enabling bot-authored monitor alerts, verify channel permissions with a
temporary create/edit/delete smoke message:

```sh
DISCORD_ALERT_CHANNEL_ID=... DISCORD_BOT_TOKEN_FILE=/secure/path/token \
  pnpm smoke:alert
```

## CI/CD

Pull requests run tests and a Wrangler dry-run with no production secrets.
Main-branch pushes run tests, deploy the Worker, then check public health and
the command schema. The production job is serialized and does not cancel a
deployment already in progress. All third-party actions are pinned to commits.

Configure encrypted GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The token is scoped to the intended Cloudflare account;
this deployment needs Workers Scripts edit and D1 read. Keep the five runtime
secrets in Cloudflare. CI does not export secrets, reset D1, run production
migrations, or resurrect the retired webhook. Review production environment
permissions before granting collaborators write access.

## Running your own copy

Change the Worker name, D1 ID/name and public application ID in `wrangler.jsonc`,
the deployment URL in `.github/workflows/deploy.yml`, and the URLs in
`src/branding.js`. Use your own Discord application and Riot API credential.
Riot development keys expire; use an approved personal/production key for
long-running service where appropriate. This repository cannot make a temporary
Riot key permanent.

When rotating `RIOT_API_KEY`, command caches are isolated by a one-way credential
fingerprint. The next monitor check refreshes all tracked account identifiers;
if Riot requires a new encrypted PUUID, the bot verifies that account against a
previously saved Riot match before changing it. Existing cursors, rank baselines
and Discord message records are retained. If identity cannot be verified, the
check fails without saving state; do not reset history to work around it.

The original three-track state remains valid without conversion. Admin roster
commands upgrade its validation version in place; no existing records are erased.
Use `/track add/remove/list/pause/resume` in the configured alerts server with
Manage Server or Administrator permission. Up to ten accounts may be active;
paused/archived records remain available for deduplication and grouped-message edits.
Add/resume establish a fresh completed-match cutoff and do not replay older games.
The one-minute scheduler rotates unfinished work when its request budget is used;
larger rosters or backlogs may take multiple ticks. Each tracker retains its own
cursor. Existing live alerts finish even after pause/removal or an alert-mode change.

`/track alerts mode:Completed only` suppresses new live announcements but retains
completion and demotion alerts. `Live + completed` restores the original policy.
The slash commands can query other regions/accounts without enrolling them.

## Personal defaults and interactive cards

Use `/profile set` to save your summoner, region, mode, private-response preference
and IANA session timezone. `/profile show` and `/profile clear` are private.
Defaults are scoped to the invoking Discord user and server, not shared by friends.
Explicit lookup options win, including `private:false` to share a result.
There is no account-ownership claim: this is a convenience preference for public stats.

Stats cards provide 7/30-day switches, a champion-name form, recent games,
refresh and load-more. Recent cards have previous/next pages. Only the requester
can operate a card, and controls expire after one hour. Expiring cached views keep
only the requested participant's public stat fields; hourly cleanup removes expired
views. No interaction tokens or API credentials are stored in these records.

`/session` covers games started since local midnight (America/New_York by default).
It shows W/L, time played, most wins by champion, KDA and CS/min. LP change is only
shown from a same-day tracked rank observation, with its actual observation time.
It is not an estimate of an unobserved midnight rank. Rank observations are bounded
to the most recent 500 points/32 days; pauses and season resets may leave no valid baseline.

## Credential health

A confirmed Riot authentication failure queues one private failure notice, then
one recovery notice once authenticated requests succeed again. Repeated failures
do not create new events. Failed DM delivery stays queued, uses a stable Discord
nonce on retry, and appears in `/monitor/status` without exposing credentials or
recipient IDs. Discord nonce deduplication has a limited window; it is not a
permanent exactly-once guarantee across a crash after delivery but before storage.
The default recipient is the configured server's owner; admins can select a
different recipient with `/track notifications owner:<user>`. Allow bot DMs for
that recipient. No failure/recovery tests should invalidate a working production key.

See [QoL delivery acceptance](docs/qol-delivery.md) for verification status.

[Backlog coverage](docs/backlog.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

LeagueStats is not endorsed by Riot Games and does not reflect the views or
opinions of Riot Games or anyone officially involved in producing or managing
Riot Games properties. Riot Games and all associated properties are trademarks
or registered trademarks of Riot Games, Inc. The original code is MIT-licensed;
Riot assets and data are not relicensed by this project.
