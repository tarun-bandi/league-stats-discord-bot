# LeagueStats Discord Bot

Cloudflare Worker for League of Legends Discord slash commands and a one-minute game monitor.

## Features

- `/help`, `/stats`, `/recent`, `/live`, and `/ping`
- Arbitrary Riot IDs and supported League regions for interactive commands
- One-minute Cloudflare Cron Trigger for three configured NA accounts
- Riot Match-v5 and Spectator-v5 monitoring
- D1-backed durable cursors, live-game correlation, and Discord message IDs
- One Discord alert per game, authored by the LeagueStats bot and edited when the game completes
- Discord mentions disabled in every response

## Cloudflare bindings

- `DISCORD_PUBLIC_KEY` — Worker secret used to verify Discord interactions
- `RIOT_API_KEY` — Worker secret used for Riot API requests
- `DISCORD_BOT_TOKEN` — Worker secret used to create and edit monitor alerts
- `DISCORD_ALERT_CHANNEL_ID` — destination channel for monitor alerts
- `MONITOR_ENABLED` — explicit monitor kill switch; only `true`, `1`, `yes`, or `on` enables checks
- `MONITOR_DB` — D1 binding containing the authoritative monitor state

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

Before enabling bot-authored monitor alerts, verify channel permissions with a
temporary create/edit/delete smoke message:

```sh
DISCORD_ALERT_CHANNEL_ID=... DISCORD_BOT_TOKEN_FILE=/secure/path/token \
  pnpm smoke:alert
```
