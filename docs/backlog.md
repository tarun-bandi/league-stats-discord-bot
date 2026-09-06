# Backlog implementation

Tracks the six requests from the Backlog document, plus branding.

| Request | Implementation |
| --- | --- |
| Autofill / available summoners | D1-backed autocomplete on `/stats`, `/recent`, `/live`; canonical names follow monitor renames; arbitrary IDs still work |
| Derank messages | Solo/Duo and Flex tier/division-drop alerts, silent initial baseline, grouped-message preservation and failure tests |
| Open source | MIT license, contribution guide, security policy and public repository |
| CI/CD | PR/main tests and dry-run build; main deployment tests before publishing; public health/command smoke; scoped Cloudflare secrets required |
| More modes / ARAM Mayhem | `mode` selector on stats/recent, current queue labels in all responses and alerts, honest Mayhem data limitations |
| More payload information | Damage, vision, gold averages, K/D/A, CS/min, placement, pentakills; payload inventory in `payload.md` |
| Champion logos and polish | Riot Data Dragon champion portraits on every recent-game card, live/completed alerts, live responses and the most-played champion on stats; existing bot identity unchanged |

Real demotions cannot be manufactured as a production smoke. Synthetic tests
cover the transitions; production establishes its first silent rank baseline.
The next real demotion will exercise delivery through the existing bot channel.
