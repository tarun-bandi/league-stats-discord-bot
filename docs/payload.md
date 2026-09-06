# What Riot's payload can tell us

LeagueStats uses Riot's public developer APIs. Available fields vary by queue
and endpoint. A missing field is unavailable, not zero.

| Source | Now displayed | Other available fields worth future exploration |
| --- | --- | --- |
| Match-v5 participant | Champion, W/L, K/D/A, CS/min, champion damage, vision, gold averages, pentakills, placement when supplied | Items, summoner spells, runes, team position, wards placed/killed, healing, shielding, objective damage, turret takedowns |
| Match-v5 match | Queue, start time, duration, match ID | Map, patch version, team objectives, surrender/remake flags |
| League-v4 | Rank, LP, W/L, Solo/Duo and Flex demotions | Inactive/veteran/hot-streak flags when supplied |
| Spectator-v5 | Current game, champion, queue, start time | Team lineups, bans, summoner spells and perks when supplied |
| Match-v5 timeline (not currently requested) | — | Gold/XP over time, item purchases, kills, objectives and positional events |

`/stats` adds average champion damage/minute, vision score and gold. `/recent`
and completed monitor alerts include K/D/A, CS/min, damage, vision and placement
or pentakills when present. These use the already-fetched match payload, with no
additional per-game requests. Averages only include records that have the field.
Damage means **damage to champions**, not total damage to minions/monsters.
Arena placement is shown separately from Riot's win flag.

Champion portraits come from Riot Data Dragon's current champion catalog. Every
`/recent` game and monitor game uses its own thumbnail; `/live` uses the current
champion and `/stats` uses the most-played champion. Canonical IDs handle names
such as Cho'Gath and Wukong correctly. Portrait data is cached for 24 hours;
artwork failure leaves the text result working. No Discord bot-avatar change is
required. Ten recent games use ten embeds, within Discord's message limits.

## Modes

`/stats` and `/recent` have a `mode` selector. Filters are sent to Match-v5
**before** the 30-game stats / 10-game recent limit is applied. Default: all modes.
The monitor watches all returned queues. No extra Discord subchannels are needed.

Supported named modes include Solo/Duo, Flex, ARAM, ARAM Mayhem, Swiftplay,
Quickplay, Draft, Arena, URF/ARURF, Brawl, Clash/ARAM Clash, One for All,
Nexus Blitz, Ultimate Spellbook and Swarm. Unknown queues retain their numeric
ID and Riot mode name instead of being mislabeled as ranked.

ARAM Mayhem is queue **2400**. Riot can omit or forbid its completed matches even
when Spectator reports a live game. We still report live games when provided;
results/duration remain unavailable if Riot never returns them. The existing
six-hour stale-live reconciliation closes such alerts without inventing a
winner or sending a second game alert. A Mayhem-specific unavailable match does
not block checks of the other accounts. There is no private-client/API fallback.

## Demotion rules

Ranks are sampled every five minutes and after detected ranked completions.
Solo/Duo and Flex snapshots are independent. Only a lower tier/division emits
an alert; LP-only changes and promotions do not. Master/Grandmaster/Challenger
are ordered above Diamond, without fictional divisions.

First observations, returning from unranked, reduced win/loss counters (season
reset), and gaps over 48 hours establish a silent baseline. Demotion records
live in `reported_rank_changes`, leaving all `reported_games` untouched. If a
message includes both games and a demotion, later game completion edits rebuild
the entire group. Discord failure prevents the working state from being saved.

Sources: [Riot queue IDs](https://static.developer.riotgames.com/docs/lol/queues.json),
[Riot API reference](https://developer.riotgames.com/apis),
[Riot League documentation](https://developer.riotgames.com/docs/lol).
