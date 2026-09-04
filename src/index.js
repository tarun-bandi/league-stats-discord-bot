import { COMMANDS, REGION_CHOICES } from "./commands.js";
import { monitorStatus, runLeagueMonitor } from "./monitor.js";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_STATS_MATCHES = 30;
const EASTERN_TIME_ZONE = "America/New_York";
const EMPTY_MENTIONS = { parse: [] };

const REGIONS = {
  na: { platform: "na1", regional: "americas", label: "NA" },
  euw: { platform: "euw1", regional: "europe", label: "EUW" },
  eune: { platform: "eun1", regional: "europe", label: "EUNE" },
  kr: { platform: "kr", regional: "asia", label: "KR" },
  br: { platform: "br1", regional: "americas", label: "BR" },
  lan: { platform: "la1", regional: "americas", label: "LAN" },
  las: { platform: "la2", regional: "americas", label: "LAS" },
  oce: { platform: "oc1", regional: "sea", label: "OCE" },
  jp: { platform: "jp1", regional: "asia", label: "JP" },
  tr: { platform: "tr1", regional: "europe", label: "TR" },
  ru: { platform: "ru", regional: "europe", label: "RU" },
  ph: { platform: "ph2", regional: "sea", label: "PH" },
  sg: { platform: "sg2", regional: "sea", label: "SG" },
  th: { platform: "th2", regional: "sea", label: "TH" },
  tw: { platform: "tw2", regional: "sea", label: "TW" },
  vn: { platform: "vn2", regional: "sea", label: "VN" },
};

const QUEUES = {
  0: "Custom",
  400: "Normal Draft",
  420: "Ranked Solo/Duo",
  430: "Normal Blind",
  440: "Ranked Flex",
  450: "ARAM",
  490: "Quickplay",
  700: "Clash",
  830: "Co-op vs. AI",
  840: "Co-op vs. AI",
  850: "Co-op vs. AI",
  900: "URF",
  1020: "One for All",
  1300: "Nexus Blitz",
  1400: "Ultimate Spellbook",
  1700: "Arena",
};

export class UserFacingError extends Error {}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function message(content, { ephemeral = false, embeds = [] } = {}) {
  return {
    content,
    embeds,
    allowed_mentions: EMPTY_MENTIONS,
    ...(ephemeral ? { flags: 64 } : {}),
  };
}

function immediateMessage(content, options) {
  return json({ type: 4, data: message(content, options) });
}

function deferredMessage() {
  return json({
    type: 5,
    data: { allowed_mentions: EMPTY_MENTIONS },
  });
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal value");
  }

  return new Uint8Array(
    hex.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)),
  );
}

async function verifyDiscordRequest(request, publicKeyHex) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const body = await request.text();

  if (!signature || !timestamp || !publicKeyHex) {
    return { valid: false, body };
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    const valid = await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );

    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

export function parseRiotId(value) {
  const input = String(value ?? "").trim();
  const separator = input.lastIndexOf("#");
  if (separator <= 0 || separator === input.length - 1) {
    throw new UserFacingError("Use a Riot ID in `Game Name#TAG` format.");
  }

  const gameName = input.slice(0, separator).trim();
  const tagLine = input.slice(separator + 1).trim();
  if (!gameName || !tagLine || gameName.length > 64 || tagLine.length > 16) {
    throw new UserFacingError("That Riot ID is not valid. Use `Game Name#TAG`.");
  }

  return { gameName, tagLine, display: `${gameName}#${tagLine}` };
}

function optionValue(interaction, name, fallback) {
  return (
    interaction.data?.options?.find((option) => option.name === name)?.value ??
    fallback
  );
}

function getRegion(interaction) {
  const key = String(optionValue(interaction, "region", "na")).toLowerCase();
  const region = REGIONS[key];
  if (!region) {
    throw new UserFacingError("That League region is not supported.");
  }
  return region;
}

async function cachedJson(url, init, ttlSeconds) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(url, { method: "GET" });
  if (cache && ttlSeconds > 0) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached.json();
  }

  const response = await fetch(url, init);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const body = await response.json();
  if (cache && ttlSeconds > 0) {
    const cachedResponse = new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ttlSeconds}`,
      },
    });
    await cache.put(cacheKey, cachedResponse);
  }
  return body;
}

async function riotJson(env, url, ttlSeconds = 0) {
  if (!env.RIOT_API_KEY) {
    throw new UserFacingError("LeagueStats is missing its Riot API credential.");
  }

  try {
    return await cachedJson(
      url,
      { headers: { "X-Riot-Token": env.RIOT_API_KEY } },
      ttlSeconds,
    );
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    if (error.status === 401 || error.status === 403) {
      throw new UserFacingError(
        "The Riot API credential is invalid or expired. Ask the bot owner to refresh it.",
      );
    }
    if (error.status === 429) {
      throw new UserFacingError("Riot is rate-limiting requests. Try again shortly.");
    }
    if (error.status === 404) {
      throw new UserFacingError("Riot could not find that account or game.");
    }
    throw new UserFacingError("Riot data is temporarily unavailable. Try again shortly.");
  }
}

async function resolveAccount(env, riotId, region) {
  const url = `https://${region.regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotId.gameName)}/${encodeURIComponent(riotId.tagLine)}`;
  return riotJson(env, url, 3600);
}

async function getRankedEntries(env, puuid, region) {
  const url = `https://${region.platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
  try {
    return await riotJson(env, url, 60);
  } catch (error) {
    if (error instanceof UserFacingError && /could not find/i.test(error.message)) {
      return [];
    }
    throw error;
  }
}

async function getMatchIds(env, puuid, region, { count, startTime }) {
  const query = new URLSearchParams({ start: "0", count: String(count) });
  if (startTime) query.set("startTime", String(startTime));
  const url = `https://${region.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?${query}`;
  return riotJson(env, url, 45);
}

async function getMatch(env, matchId, region) {
  const url = `https://${region.regional}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  // A Cache API lookup/write counts against the Workers Free subrequest limit.
  // Fetch match details directly so a 30-game stats request stays below 50.
  return riotJson(env, url);
}

async function getMatches(env, matchIds, region) {
  const matches = [];
  for (let index = 0; index < matchIds.length; index += 10) {
    const chunk = matchIds.slice(index, index + 10);
    matches.push(...(await Promise.all(chunk.map((id) => getMatch(env, id, region)))));
    if (index + 10 < matchIds.length) {
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
  }
  return matches;
}

function participantFor(match, puuid) {
  return match.info?.participants?.find((participant) => participant.puuid === puuid);
}

function queueName(queueId, fallback = "League game") {
  return QUEUES[queueId] ?? fallback;
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}

function formatEasternDate(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function easternDay(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

export function aggregateMatches(matches, puuid, days) {
  const rows = matches
    .map((match) => {
      const participant = participantFor(match, puuid);
      if (!participant) return null;
      const duration = Number(match.info?.gameDuration) || 0;
      return {
        matchId: match.metadata?.matchId ?? "unknown",
        timestamp: Number(match.info?.gameStartTimestamp) || 0,
        champion: participant.championName || "Unknown",
        win: Boolean(participant.win),
        kills: Number(participant.kills) || 0,
        deaths: Number(participant.deaths) || 0,
        assists: Number(participant.assists) || 0,
        cs:
          (Number(participant.totalMinionsKilled) || 0) +
          (Number(participant.neutralMinionsKilled) || 0),
        duration,
        queue: queueName(match.info?.queueId, match.info?.gameMode),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.timestamp - a.timestamp);

  const games = rows.length;
  const wins = rows.filter((row) => row.win).length;
  const kills = rows.reduce((sum, row) => sum + row.kills, 0);
  const deaths = rows.reduce((sum, row) => sum + row.deaths, 0);
  const assists = rows.reduce((sum, row) => sum + row.assists, 0);
  const totalCs = rows.reduce((sum, row) => sum + row.cs, 0);
  const totalSeconds = rows.reduce((sum, row) => sum + row.duration, 0);
  const activeDays = new Set(rows.map((row) => easternDay(row.timestamp))).size;
  const champions = new Map();

  for (const row of rows) {
    const current = champions.get(row.champion) ?? { games: 0, wins: 0 };
    current.games += 1;
    current.wins += row.win ? 1 : 0;
    champions.set(row.champion, current);
  }

  const topChampions = [...champions.entries()]
    .sort((a, b) => b[1].games - a[1].games || b[1].wins - a[1].wins)
    .slice(0, 3)
    .map(([name, value]) => ({ name, ...value }));

  let streak = 0;
  let streakWin = null;
  for (const row of rows) {
    if (streakWin === null) streakWin = row.win;
    if (row.win !== streakWin) break;
    streak += 1;
  }

  return {
    rows,
    games,
    wins,
    losses: games - wins,
    winRate: games ? (wins / games) * 100 : 0,
    calendarGamesPerDay: games / days,
    activeGamesPerDay: activeDays ? games / activeDays : 0,
    activeDays,
    kda: deaths ? (kills + assists) / deaths : kills + assists,
    averageKills: games ? kills / games : 0,
    averageDeaths: games ? deaths / games : 0,
    averageAssists: games ? assists / games : 0,
    csPerMinute: totalSeconds ? totalCs / (totalSeconds / 60) : 0,
    averageDuration: games ? totalSeconds / games : 0,
    topChampions,
    streak: streak ? `${streak}${streakWin ? "W" : "L"}` : "—",
  };
}

function rankedSummary(entries) {
  const preferred =
    entries.find((entry) => entry.queueType === "RANKED_SOLO_5x5") ??
    entries.find((entry) => entry.queueType === "RANKED_FLEX_SR");
  if (!preferred) return "Unranked";

  const games = preferred.wins + preferred.losses;
  const winRate = games ? (preferred.wins / games) * 100 : 0;
  const queue =
    preferred.queueType === "RANKED_SOLO_5x5" ? "Solo/Duo" : "Flex";
  return `${queue}: ${preferred.tier} ${preferred.rank} • ${preferred.leaguePoints} LP • ${preferred.wins}W–${preferred.losses}L (${formatPercent(winRate)})`;
}

function topChampionSummary(champions) {
  if (!champions.length) return "No games in this period";
  return champions
    .map(
      (champion) =>
        `${champion.name} ${champion.games}g (${formatPercent((champion.wins / champion.games) * 100)})`,
    )
    .join(" • ");
}

async function buildStatsResponse(interaction, env) {
  const riotId = parseRiotId(optionValue(interaction, "summoner", ""));
  const days = Math.max(1, Math.min(30, Number(optionValue(interaction, "days", 7))));
  const region = getRegion(interaction);
  const account = await resolveAccount(env, riotId, region);
  const startTime = Math.floor((Date.now() - days * 86400_000) / 1000);

  const [matchIds, rankedEntries] = await Promise.all([
    getMatchIds(env, account.puuid, region, {
      count: MAX_STATS_MATCHES,
      startTime,
    }),
    getRankedEntries(env, account.puuid, region),
  ]);
  const matches = await getMatches(env, matchIds, region);
  const stats = aggregateMatches(matches, account.puuid, days);
  const canonicalId = `${account.gameName ?? riotId.gameName}#${account.tagLine ?? riotId.tagLine}`;
  const capped = matchIds.length === MAX_STATS_MATCHES;

  return message("", {
    embeds: [
      {
        color: 0x5383e8,
        title: `${canonicalId} — last ${days} day${days === 1 ? "" : "s"}`,
        description: stats.games
          ? `**${stats.wins}W–${stats.losses}L • ${formatPercent(stats.winRate)} win rate**`
          : "No League games found in this period.",
        fields: [
          { name: "Rank", value: rankedSummary(rankedEntries), inline: false },
          {
            name: "Games per day",
            value: `${stats.calendarGamesPerDay.toFixed(2)} calendar avg • ${stats.activeGamesPerDay.toFixed(2)} on ${stats.activeDays} active day${stats.activeDays === 1 ? "" : "s"}`,
            inline: false,
          },
          {
            name: "Performance",
            value: `${stats.averageKills.toFixed(1)}/${stats.averageDeaths.toFixed(1)}/${stats.averageAssists.toFixed(1)} avg • ${stats.kda.toFixed(2)} KDA • ${stats.csPerMinute.toFixed(1)} CS/min`,
            inline: false,
          },
          {
            name: "Pace",
            value: `${formatDuration(stats.averageDuration)} avg game • ${stats.streak} current streak`,
            inline: false,
          },
          {
            name: "Top champions",
            value: topChampionSummary(stats.topChampions),
            inline: false,
          },
        ],
        footer: {
          text: `${region.label} • Times/days use America/New_York${capped ? ` • Capped at the ${MAX_STATS_MATCHES} newest games` : ""}`,
        },
      },
    ],
  });
}

async function buildRecentResponse(interaction, env) {
  const riotId = parseRiotId(optionValue(interaction, "summoner", ""));
  const count = Math.max(1, Math.min(10, Number(optionValue(interaction, "count", 5))));
  const region = getRegion(interaction);
  const account = await resolveAccount(env, riotId, region);
  const matchIds = await getMatchIds(env, account.puuid, region, { count });
  const matches = await getMatches(env, matchIds, region);
  const stats = aggregateMatches(matches, account.puuid, 1);
  const canonicalId = `${account.gameName ?? riotId.gameName}#${account.tagLine ?? riotId.tagLine}`;

  const description = stats.rows.length
    ? stats.rows
        .map(
          (row) =>
            `${row.win ? "🟢" : "🔴"} **${row.champion}** • ${row.kills}/${row.deaths}/${row.assists} • ${row.queue} • ${formatDuration(row.duration)}\n${formatEasternDate(row.timestamp)}`,
        )
        .join("\n\n")
    : "No recent League games found.";

  return message("", {
    embeds: [
      {
        color: 0x5383e8,
        title: `${canonicalId} — recent games`,
        description,
        footer: { text: `${region.label} • America/New_York` },
      },
    ],
  });
}

async function getChampionNames() {
  try {
    const realm = await cachedJson(
      "https://ddragon.leagueoflegends.com/realms/na.json",
      {},
      86400,
    );
    const champions = await cachedJson(
      `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(realm.v)}/data/en_US/champion.json`,
      {},
      86400,
    );
    return new Map(
      Object.values(champions.data ?? {}).map((champion) => [
        Number(champion.key),
        champion.name,
      ]),
    );
  } catch {
    return new Map();
  }
}

async function buildLiveResponse(interaction, env) {
  const riotId = parseRiotId(optionValue(interaction, "summoner", ""));
  const region = getRegion(interaction);
  const account = await resolveAccount(env, riotId, region);
  const url = `https://${region.platform}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(account.puuid)}`;
  let game;
  try {
    game = await riotJson(env, url, 20);
  } catch (error) {
    if (error instanceof UserFacingError && /could not find/i.test(error.message)) {
      const canonicalId = `${account.gameName ?? riotId.gameName}#${account.tagLine ?? riotId.tagLine}`;
      return message(`**${canonicalId}** is not currently in a game.`, {
        embeds: [],
      });
    }
    throw error;
  }

  const participant = game.participants?.find((entry) => entry.puuid === account.puuid);
  const championNames = await getChampionNames();
  const champion =
    championNames.get(Number(participant?.championId)) ??
    `Champion ${participant?.championId ?? "unknown"}`;
  const canonicalId = `${account.gameName ?? riotId.gameName}#${account.tagLine ?? riotId.tagLine}`;
  const start = Number(game.gameStartTime) || Date.now();

  return message("", {
    embeds: [
      {
        color: 0x57b15b,
        title: `${canonicalId} — Live`,
        fields: [
          { name: "Champion", value: champion, inline: true },
          {
            name: "Queue",
            value: queueName(game.gameQueueConfigId, game.gameMode),
            inline: true,
          },
          { name: "Started", value: formatEasternDate(start), inline: false },
        ],
        footer: { text: `${region.label} • America/New_York` },
      },
    ],
  });
}

function helpResponse() {
  const examples = [
    "`/stats summoner:HelloThere#9494`",
    "`/stats summoner:Knaye East#YEEZY`",
    "`/stats summoner:TIXBS Chaos#NA1`",
  ].join("\n");

  return message("", {
    embeds: [
      {
        color: 0x5383e8,
        title: "LeagueStats help",
        description:
          "Look up any summoner with a Riot ID in `Game Name#TAG` format. NA is the default region.",
        fields: [
          {
            name: "Quick stats",
            value: examples,
            inline: false,
          },
          {
            name: "Commands",
            value:
              "`/stats` — win rate, games/day, rank, KDA, CS/min, champions\n`/recent` — recent match list\n`/live` — current game status\n`/ping` — bot health",
            inline: false,
          },
          {
            name: "More examples",
            value:
              "`/stats summoner:Faker#KR1 region:Korea days:30`\n`/recent summoner:HelloThere#9494 count:10`\n`/live summoner:Knaye East#YEEZY`",
            inline: false,
          },
        ],
        footer: { text: "Stats use public Riot data • No mentions are generated" },
      },
    ],
  });
}

async function editOriginalResponse(interaction, payload) {
  const url = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Discord follow-up failed with HTTP ${response.status}`);
  }
}

async function runDeferredCommand(interaction, env) {
  try {
    let payload;
    switch (interaction.data?.name) {
      case "stats":
        payload = await buildStatsResponse(interaction, env);
        break;
      case "recent":
        payload = await buildRecentResponse(interaction, env);
        break;
      case "live":
        payload = await buildLiveResponse(interaction, env);
        break;
      default:
        payload = message("Unknown command.");
    }
    await editOriginalResponse(interaction, payload);
  } catch (error) {
    console.error(
      "LeagueStats command failed",
      interaction.data?.name ?? "unknown-command",
      error instanceof Error ? error.message : String(error),
    );
    const content =
      error instanceof UserFacingError
        ? error.message
        : "LeagueStats hit an unexpected error. Try again shortly.";
    try {
      await editOriginalResponse(interaction, message(content));
    } catch (responseError) {
      console.error(
        "LeagueStats response update failed",
        responseError instanceof Error
          ? responseError.message
          : String(responseError),
      );
      // Discord may have invalidated the interaction token. Nothing else can be sent safely.
    }
  }
}

export default {
  async scheduled(controller, env) {
    try {
      await runLeagueMonitor(env, {
        detectionTimestamp: controller.scheduledTime || Date.now(),
      });
    } catch (error) {
      console.error(
        "League Game Monitor failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  },

  async fetch(request, env, context) {
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.pathname === "/commands") {
        return json(COMMANDS);
      }
      if (url.pathname === "/monitor/status") {
        try {
          return json(await monitorStatus(env));
        } catch {
          return json(
            {
              configured: Boolean(
                env.MONITOR_DB && env.DISCORD_WEBHOOK_URL && env.RIOT_API_KEY,
              ),
              stateValid: false,
            },
            503,
          );
        }
      }
      return json({
        ok: true,
        service: "LeagueStats Discord interactions bot",
        configured: {
          discord: Boolean(env.DISCORD_PUBLIC_KEY),
          riot: Boolean(env.RIOT_API_KEY),
          monitor: Boolean(env.MONITOR_DB && env.DISCORD_WEBHOOK_URL),
        },
        regions: REGION_CHOICES.map(([name, value]) => ({ name, value })),
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const { valid, body } = await verifyDiscordRequest(
      request,
      env.DISCORD_PUBLIC_KEY,
    );
    if (!valid) {
      return new Response("Invalid Discord signature", { status: 401 });
    }

    let interaction;
    try {
      interaction = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (interaction.type === 1) {
      return json({ type: 1 });
    }

    if (interaction.type !== 2) {
      return immediateMessage("Unsupported interaction.", { ephemeral: true });
    }

    if (interaction.data?.name === "ping") {
      return immediateMessage("LeagueStats is online. 🏓");
    }

    if (interaction.data?.name === "help") {
      return json({ type: 4, data: helpResponse() });
    }

    if (["stats", "recent", "live"].includes(interaction.data?.name)) {
      context.waitUntil(runDeferredCommand(interaction, env));
      return deferredMessage();
    }

    return immediateMessage("Unknown command. Try `/help`.", {
      ephemeral: true,
    });
  },
};
