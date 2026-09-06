# Contributing

Use Node.js 22+ and pnpm 10. Run `pnpm install --frozen-lockfile`, `pnpm test`,
and `pnpm exec wrangler deploy --dry-run` before opening a pull request.

Keep test fixtures synthetic. Never commit player-state backups, bot tokens,
Riot keys, interaction tokens, or Cloudflare credentials. Do not send test
messages from tests; mock `fetch` and D1.

Changes to monitoring must preserve every previous cursor and reported record,
keep queues/accounts independent, suppress mentions, and test failure behavior.
Never baseline an existing installation again. Add tests for new mode IDs or
rank transitions and cite Riot's public source in `docs/payload.md`.

The CI workflow runs for pull requests without production secrets. Production
deployment runs only from this repository's main branch after tests pass.
Schema changes are reconciled using the encrypted bot token at runtime.
