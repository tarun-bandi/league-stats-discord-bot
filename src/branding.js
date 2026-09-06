export const BRAND = {
  name: "LeagueStats",
  color: 0x5383e8,
  url: "https://github.com/tarun-bandi/league-stats-discord-bot",
};

export function brandedEmbed(embed) {
  return {
    color: BRAND.color,
    author: { name: BRAND.name, url: BRAND.url },
    ...embed,
    footer: { text: "Public Riot data • No mentions", ...embed.footer },
  };
}
