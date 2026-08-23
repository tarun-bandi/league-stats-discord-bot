# LeagueStats Discord Bot

Cloudflare Worker for League of Legends Discord slash commands and a one-minute game monitor.

## Features

- `/help`, `/stats`, `/recent`, `/live`, and `/ping`
- Arbitrary Riot IDs and supported League regions for interactive commands
- One-minute Cloudflare Cron Trigger for three configured NA accounts
- Riot Match-v5 and Spectator-v5 monitoring
- D1-backed durable cursors, live-game correlation, and Discord message IDs
- One Discord alert per game, with live alerts edited when the game completes
- Discord mentions disabled in every response

## Cloudflare bindings

- `DISCORD_PUBLIC_KEY` — Worker secret used to verify Discord interactions
- `RIOT_API_KEY` — Worker secret used for Riot API requests
- `DISCORD_WEBHOOK_URL` — Worker secret used only by the scheduled monitor
- `MONITOR_DB` — D1 binding containing the authoritative monitor state

The production Cron Trigger is `* * * * *`. The monitor refuses to access Riot
or Discord when its D1 state is missing, corrupt, or invalid.

## Local development

```sh
pnpm install
pnpm test
pnpm wrangler dev
```

Put local-only secrets in `.dev.vars`; that file is ignored by Git.

## Deployment

Apply `migrations/0001_monitor_state.sql`, seed the `league-game-monitor` row
from a validated state backup, configure the three secrets, and deploy with
Wrangler. Do not enable the Cron Trigger until the state row is present.

Global Discord commands can be bulk-registered with:

```sh
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN_FILE=/secure/path/token \
  pnpm register:commands
```

The registration script reads the bot token from the file and never prints it.
