// IDs verified against https://static.developer.riotgames.com/docs/lol/queues.json.
export const QUEUES = {
  0: "Custom", 400: "Normal Draft", 420: "Ranked Solo/Duo",
  430: "Normal Blind", 440: "Ranked Flex", 450: "ARAM", 480: "Swiftplay",
  490: "Quickplay", 700: "Clash", 720: "ARAM Clash",
  830: "Co-op vs. AI", 840: "Co-op vs. AI", 850: "Co-op vs. AI",
  870: "Co-op vs. AI Intro", 880: "Co-op vs. AI Beginner", 890: "Co-op vs. AI Intermediate",
  900: "ARURF", 1020: "One for All", 1300: "Nexus Blitz",
  1400: "Ultimate Spellbook", 1700: "Arena", 1710: "Arena (16 players)",
  1810: "Swarm (solo)", 1820: "Swarm (duo)", 1830: "Swarm (trio)",
  1840: "Swarm (squad)", 1900: "URF", 2300: "Brawl", 2400: "ARAM Mayhem",
};

export const MODE_CHOICES = [
  { name: "All modes", value: 0 },
  ...[420, 440, 450, 2400, 480, 490, 400, 1710, 1700, 1900, 900, 2300, 700, 720, 1400, 1020, 1300]
    .map((value) => ({ name: QUEUES[value], value })),
];

export function queueName(id, fallback = "League game") {
  return QUEUES[id] ?? `${fallback || "League game"}${id == null ? "" : ` (queue ${id})`}`;
}

export function modeNote(queueId) {
  return Number(queueId) === 2400
    ? "ARAM Mayhem: Riot may omit completed matches. Missing results are never estimated."
    : "";
}

export function matchMetrics(participant = {}, duration = 0) {
  const number = (key) => typeof participant[key] === "number" && Number.isFinite(participant[key])
    ? participant[key] : null;
  const minutes = duration / 60;
  const cs = number("totalMinionsKilled");
  const jungleCs = number("neutralMinionsKilled");
  return {
    kills: number("kills"), deaths: number("deaths"), assists: number("assists"),
    cs_per_minute: minutes > 0 && cs !== null ? (cs + (jungleCs ?? 0)) / minutes : null,
    damage: number("totalDamageDealtToChampions"),
    damage_per_minute: minutes > 0 && number("totalDamageDealtToChampions") !== null
      ? number("totalDamageDealtToChampions") / minutes : null,
    gold: number("goldEarned"), vision: number("visionScore"),
    placement: number("placement") || number("subteamPlacement"),
    penta_kills: number("pentaKills"),
  };
}

export function metricsSummary(metrics) {
  if (!metrics) return "";
  const parts = [];
  if ([metrics.kills, metrics.deaths, metrics.assists].every((n) => n != null)) {
    parts.push(`**${metrics.kills}/${metrics.deaths}/${metrics.assists}** K/D/A`);
  }
  if (metrics.cs_per_minute != null) parts.push(`${metrics.cs_per_minute.toFixed(1)} CS/min`);
  if (metrics.damage != null) parts.push(`${(metrics.damage / 1000).toFixed(1)}k damage`);
  if (metrics.vision != null) parts.push(`${metrics.vision} vision`);
  if (metrics.placement) parts.push(`Placement #${metrics.placement}`);
  if (metrics.penta_kills) parts.push(`${metrics.penta_kills} pentakill${metrics.penta_kills === 1 ? "" : "s"}`);
  return parts.join(" • ");
}
