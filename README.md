# LeagueStats Discord Bot

[![CI](https://github.com/tarun-bandi/league-stats-discord-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/tarun-bandi/league-stats-discord-bot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Cloudflare Worker for League of Legends Discord slash commands and a one-minute game monitor.

## Features

- `/help`, `/stats`, `/recent`, `/live`, and `/ping`
- Arbitrary Riot IDs and supported League regions for interactive commands
- Monitored-account autocomplete for the `summoner` option on `/stats`, `/recent`, and `/live`
- One-minute Cloudflare Cron Trigger for three configured NA accounts
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

## Try it

```text
/stats summoner:HelloThere#9494
/stats summoner:TIXBS Chaos#NA1 mode:ARAM
/stats summoner:HelloThere#9494 champion:Zed days:30
/recent summoner:Knaye East#YEEZY mode:ARAM Mayhem
/live summoner:HelloThere#9494
```

Select `summoner` to see the three monitored accounts. Any valid Riot ID still
works. `mode` defaults to all modes; stats cover seven days by default and at most
30 matches. Add `champion` to get that champion's win rate, KDA, CS/min, games/day
and impact stats, with its portrait. Champion names are suggested as you type;
punctuation/case and canonical aliases such as Cho'Gath/Chogath and
Wukong/MonkeyKing are accepted. It combines with `days`, `mode` and `region`.
Champion filtering applies **within the newest 30 games returned for the chosen
period and mode**, not the newest 30 games on that champion. The response labels
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

Apply `migrations/0001_monitor_state.sql`, seed the `league-game-monitor` row
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

The current monitor intentionally validates **three NA trackers**. Their live
configuration and cursors are in D1, not a YAML file. Autocomplete reads that same
state. To change the roster, pause monitoring, back up D1, update only the target
tracker (including its own baseline/cursors), validate the state, then resume.
Never replace the entire state from an old backup or discard reported records.
For a different tracker count, update the validation and tests and reassess Riot
rate limits/Worker subrequests before deploying. The slash commands can query
other accounts without enrolling them in automatic alerts.

[Backlog coverage](docs/backlog.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

LeagueStats is not endorsed by Riot Games and does not reflect the views or
opinions of Riot Games or anyone officially involved in producing or managing
Riot Games properties. Riot Games and all associated properties are trademarks
or registered trademarks of Riot Games, Inc. The original code is MIT-licensed;
Riot assets and data are not relicensed by this project.
