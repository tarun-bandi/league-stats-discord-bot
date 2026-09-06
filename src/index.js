import {
  COMMANDS,
  MONITORED_SUMMONER_DEFAULTS,
  REGION_CHOICES,
} from "./commands.js";
import {
  monitorConfiguration,
  monitorEnabled,
  monitorStatus,
  runLeagueMonitor,
} from "./monitor.js";
import { MODE_CHOICES, queueName, modeNote, matchMetrics, metricsSummary } from "./league.js";
import { brandedEmbed } from "./branding.js";
import { getChampionCatalog, championInfo, championThumbnail, championAutocompleteChoices } from "./champions.js";
import { riotKeyFingerprint } from "./riot-key.js";
import { readProfile, withDefaults, commandOptions, optionsObject } from "./preferences.js";
import { createLookup, updateLookup, resolveView, championModal, profileCommand, featureMessage } from "./features.js";
import { trackingCommand, assertMonitorAdmin } from "./tracking.js";
import { readRecord, purgeExpiredRecords } from "./store.js";

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
    embeds: embeds.map(brandedEmbed),
    allowed_mentions: EMPTY_MENTIONS,
    ...(ephemeral ? { flags: 64 } : {}),
  };
}

function immediateMessage(content, options) {
  return json({ type: 4, data: message(content, options) });
}

function deferredMessage(ephemeral = false) {
  return json({
    type: 5,
    data: { allowed_mentions: EMPTY_MENTIONS, ...(ephemeral ? { flags: 64 } : {}) },
  });
}

export function summonerAutocompleteChoices(
  input,
  summoners = MONITORED_SUMMONER_DEFAULTS,
) {
  const query = String(input ?? "").trim().toLowerCase();
  const seen = new Set();

  return summoners
    .map((riotId) => String(riotId ?? "").trim())
    .filter((riotId) => {
      const normalized = riotId.toLowerCase();
      if (!riotId || seen.has(normalized) || !normalized.includes(query)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .slice(0, 25)
    .map((riotId) => ({ name: riotId, value: riotId }));
}

export async function autocompleteResponse(interaction, env) {
  const focused = commandOptions(interaction).find((option) => option.focused);
  if (focused?.name === "champion" && interaction.data?.name === "stats") {
    const catalog = await getChampionCatalog();
    return json({ type: 8, data: { choices: championAutocompleteChoices(catalog, focused.value) } });
  }
  if (
    focused?.name !== "summoner" ||
    !["stats", "recent", "live", "session", "profile", "track"].includes(interaction.data?.name)
  ) {
    return json({ type: 8, data: { choices: [] } });
  }

  let summoners = MONITORED_SUMMONER_DEFAULTS;
  try {
    const status = await monitorStatus(env);
    if (Array.isArray(status.summoners) && status.summoners.length) {
      summoners = status.summoners;
    }
  } catch (error) {
    console.error(
      "LeagueStats autocomplete could not read monitor state",
      error instanceof Error ? error.message : String(error),
    );
  }

  return json({
    type: 8,
    data: {
      choices: summonerAutocompleteChoices(focused.value, summoners),
    },
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

function getMode(interaction) {
  const value = Number(optionValue(interaction, "mode", 0));
  if (!MODE_CHOICES.some((mode) => mode.value === value)) {
    throw new UserFacingError("Choose a supported game mode from the mode option.");
  }
  return value;
}

async function cachedJson(url, init, ttlSeconds, cacheScope = "") {
  const cache = globalThis.caches?.default;
  const cacheUrl = new URL(url);
  if (cacheScope) cacheUrl.searchParams.set("__leaguestats_credential", cacheScope);
  const cacheKey = new Request(cacheUrl, { method: "GET" });
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
      ttlSeconds > 0 ? await riotKeyFingerprint(env.RIOT_API_KEY) : "",
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

export async function getMatchIds(env, puuid, region, { count, startTime, endTime, queue, start = 0 }) {
  const query = new URLSearchParams({ start: String(start), count: String(count) });
  if (startTime) query.set("startTime", String(startTime));
  if (endTime) query.set("endTime", String(endTime));
  if (queue) query.set("queue", String(queue));
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

// Persist only the requested participant's public stat fields, not complete lobbies.
export function compactMatches(matches, puuid) {
  const fields = ["puuid", "championName", "championId", "win", "kills", "deaths", "assists", "totalMinionsKilled", "neutralMinionsKilled", "totalDamageDealtToChampions", "visionScore", "goldEarned", "pentaKills", "placement", "subteamPlacement"];
  return matches.map((match) => ({ metadata: { matchId: match.metadata.matchId }, info: {
    ...Object.fromEntries(["gameStartTimestamp", "gameDuration", "queueId", "gameMode"].map((key) => [key, match.info[key]])),
    participants: [Object.fromEntries(fields.filter((key) => participantFor(match, puuid)?.[key] !== undefined).map((key) => [key, participantFor(match, puuid)[key]]))],
  } }));
}

export async function loadMoreMatches(interaction, env, snapshot, count = 30) {
  const region = getRegion(interaction);
  const ids = await getMatchIds(env, snapshot.account.puuid, region, { count, start: snapshot.offset,
    startTime: snapshot.startTime, endTime: snapshot.endTime, queue: getMode(interaction) });
  const seen = new Set(snapshot.matches.map((match) => match.metadata.matchId));
  const matches = await getMatches(env, [...new Set(ids)].filter((id) => !seen.has(id)), region);
  snapshot.matches.push(...compactMatches(matches, snapshot.account.puuid));
  snapshot.offset += ids.length;
  snapshot.more = ids.length === count;
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
        championId: participant.championId,
        win: Boolean(participant.win),
        kills: Number(participant.kills) || 0,
        deaths: Number(participant.deaths) || 0,
        assists: Number(participant.assists) || 0,
        cs:
          (Number(participant.totalMinionsKilled) || 0) +
          (Number(participant.neutralMinionsKilled) || 0),
        duration,
        queue: queueName(match.info?.queueId, match.info?.gameMode),
        metrics: matchMetrics(participant, duration),
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
  const metricAverage = (key) => {
    const available = rows.map((row) => row.metrics[key]).filter((value) => value != null);
    return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
  };
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
    averageDamagePerMinute: metricAverage("damage_per_minute"),
    averageVision: metricAverage("vision"),
    averageGold: metricAverage("gold"),
    pentaKills: rows.reduce((sum, row) => sum + (row.metrics.penta_kills ?? 0), 0),
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

export async function buildStatsResponse(interaction, env, snapshot = null) {
  const riotId = parseRiotId(optionValue(interaction, "summoner", ""));
  const days = Math.max(1, Math.min(30, Number(optionValue(interaction, "days", 7))));
  const region = getRegion(interaction);
  const mode = getMode(interaction);
  const championInput = optionValue(interaction, "champion", null);
  const catalog = await getChampionCatalog();
  let champion;
  if (championInput !== null) {
    if (!catalog.size) {
      throw new UserFacingError("Champion names are temporarily unavailable. Try again shortly, or omit the champion option for overall stats.");
    }
    champion = championInfo(catalog, championInput);
    if (!champion) {
      throw new UserFacingError("Unknown champion. Choose a champion suggestion or enter its full name, such as Cho'Gath or Wukong.");
    }
  }
  const account = snapshot?.account ?? await resolveAccount(env, riotId, region);
  const startTime = snapshot?.startTime ?? Math.floor((Date.now() - days * 86400_000) / 1000);
  const endTime = snapshot?.endTime ?? Math.floor(Date.now() / 1000);

  const [matchIds, rankedEntries] = snapshot?.matches ? [snapshot.matches.map((match) => match.metadata.matchId), snapshot.rankedEntries] : await Promise.all([
    getMatchIds(env, account.puuid, region, {
      count: MAX_STATS_MATCHES,
      startTime,
      endTime,
      queue: mode,
    }),
    getRankedEntries(env, account.puuid, region),
  ]);
  const matches = snapshot?.matches ?? await getMatches(env, matchIds, region);
  if (snapshot && !snapshot.matches) Object.assign(snapshot, { account, startTime, endTime, rankedEntries,
    matches: compactMatches(matches, account.puuid), offset: matchIds.length, more: matchIds.length === MAX_STATS_MATCHES });
  const selectedMatches = champion ? matches.filter((match) => {
    const participant = participantFor(match, account.puuid);
    return participant && championInfo(catalog, participant.championId ?? participant.championName)?.id === champion.id;
  }) : matches;
  const stats = aggregateMatches(selectedMatches, account.puuid, days);
  const canonicalId = `${account.gameName ?? riotId.gameName}#${account.tagLine ?? riotId.tagLine}`;
  const capped = snapshot ? snapshot.more : matchIds.length === MAX_STATS_MATCHES;
  const sampleNote = champion
    ? `\n${stats.games} ${champion.name} game${stats.games === 1 ? "" : "s"} in the ${matchIds.length} newest game${matchIds.length === 1 ? "" : "s"} returned for this period${mode ? " and mode" : ""}.${capped ? " Older champion games may not be included." : ""}`
    : "";

  return message("", {
    embeds: [
      {
        color: 0x5383e8,
        title: `${canonicalId} — ${champion ? `${champion.name} • ` : ""}last ${days} day${days === 1 ? "" : "s"}`,
        ...championThumbnail(catalog, champion?.id ?? stats.topChampions[0]?.name),
        description: (stats.games
          ? `**${stats.wins}W–${stats.losses}L • ${formatPercent(stats.winRate)} win rate**`
          : `${champion ? `No ${champion.name} games found in this sample.` : "No League games returned by Riot in this period."}${modeNote(mode) ? `\n${modeNote(mode)}` : ""}`) + sampleNote,
        fields: [
          { name: champion ? "Account rank (all champions)" : "Rank", value: rankedSummary(rankedEntries), inline: false },
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
            value: `${formatDuration(stats.averageDuration)} avg game • ${stats.streak} ${champion ? "champion" : "current"} streak`,
            inline: false,
          },
          {
            name: "Impact",
            value: [
              stats.averageDamagePerMinute == null ? null : `${Math.round(stats.averageDamagePerMinute)} champion damage/min`,
              stats.averageVision == null ? null : `${stats.averageVision.toFixed(1)} avg vision`,
              stats.averageGold == null ? null : `${(stats.averageGold / 1000).toFixed(1)}k avg gold`,
              stats.pentaKills ? `${stats.pentaKills} pentakills` : null,
            ].filter(Boolean).join(" • ") || "Not supplied by Riot for these games",
            inline: false,
          },
          ...(!champion ? [{
            name: "Top champions",
            value: topChampionSummary(stats.topChampions),
            inline: false,
          }] : []),
        ],
        footer: {
          text: `${region.label} • ${mode ? queueName(mode) : "All modes"} • America/New_York${capped ? ` • Capped at the ${matchIds.length} newest games` : ""}`,
        },
      },
    ],
  });
}

export async function buildRecentResponse(interaction, env, snapshot = null) {
  const riotId = parseRiotId(optionValue(interaction, "summoner", ""));
  const count = Math.max(1, Math.min(10, Number(optionValue(interaction, "count", 5))));
  const region = getRegion(interaction);
  const mode = getMode(interaction);
  const account = snapshot?.account ?? await resolveAccount(env, riotId, region);
  const endTime = snapshot?.endTime ?? Math.floor(Date.now() / 1000);
  const matchIds = snapshot?.matches ? snapshot.matches.map((match) => match.metadata.matchId) : await getMatchIds(env, account.puuid, region, { count, queue: mode, endTime });
  const matches = snapshot?.matches ?? await getMatches(env, matchIds, region);
  if (snapshot && !snapshot.matches) Object.assign(snapshot, { account, endTime, matches: compactMatches(matches, account.puuid), offset: matchIds.length, more: matchIds.length === count });
  const page = snapshot?.page ?? 0;
  const allRows = aggregateMatches(matches, account.puuid, 1);
  const stats = { ...allRows, rows: allRows.rows.slice(page * count, (page + 1) * count) };
  const canonicalId = `${account.gameName ?? riotId.gameName}#${account.tagLine ?? riotId.tagLine}`;
  const catalog = await getChampionCatalog();

  const description = `No recent games returned by Riot.${modeNote(mode) ? `\n${modeNote(mode)}` : ""}`;

  return message("", {
    embeds: stats.rows.length ? stats.rows.map((row, index) => ({
      title: index === 0 ? `${canonicalId} — recent games${snapshot ? ` • page ${page + 1}` : ""}` : `${canonicalId} — ${page * count + index + 1}`,
      color: row.win ? 0x2ecc71 : 0xe05d6f,
      description: `**${row.champion} • ${row.win ? "WIN" : "LOSS"}**\n${row.queue} • ${formatDuration(row.duration)}\n${metricsSummary(row.metrics)}\n${formatEasternDate(row.timestamp)}`,
      ...championThumbnail(catalog, row.championId ?? row.champion),
      footer: { text: `${region.label} • America/New_York` },
    })) : [
      {
        color: 0x5383e8,
        title: `${canonicalId} — recent games`,
        description,
        footer: { text: `${region.label} • ${mode ? queueName(mode) : "All modes"} • America/New_York` },
      },
    ],
  });
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
  const championNames = await getChampionCatalog();
  const champion =
    championInfo(championNames, participant?.championId)?.name ??
    `Champion ${participant?.championId ?? "unknown"}`;
  const canonicalId = `${account.gameName ?? riotId.gameName}#${account.tagLine ?? riotId.tagLine}`;
  const start = Number(game.gameStartTime) || Date.now();

  return message("", {
    embeds: [
      {
        color: 0x57b15b,
        title: `${canonicalId} — Live`,
        ...championThumbnail(championNames, participant?.championId),
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
          "Use any Riot ID in `Game Name#TAG` format, or save a default with `/profile set`. NA and all modes are the defaults. Add `private:true` to keep a lookup visible only to you.",
        fields: [
          {
            name: "Quick stats",
            value: examples,
            inline: false,
          },
          {
            name: "Commands",
            value:
              "`/stats` — champion stats, period buttons and cached load-more\n`/recent` — paginated recent games\n`/session` — today's record, time played and observed LP\n`/live` — current game\n`/profile set/show/clear` — your account, mode, region and privacy defaults\n`/track` — admin roster, alert mode and credential-notification owner\n`/ping` — bot health",
            inline: false,
          },
          {
            name: "More examples",
            value:
              "`/stats summoner:HelloThere#9494 champion:Zed days:30`\n`/stats summoner:HelloThere#9494 champion:Cho'Gath mode:ARAM`\n`/recent summoner:TIXBS Chaos#NA1 mode:ARAM Mayhem`\n`/live summoner:Knaye East#YEEZY`",
            inline: false,
          },
          {
            name: "Monitor & data",
            value: "Card controls belong to the requester and expire after an hour. Load more scans older games in batches (up to 300); coverage is labeled. Rank remains account-wide.\nAdmins can add/pause/resume/archive NA trackers without erasing history. Existing live messages still finish in completed-only mode.\nARAM Mayhem depends on Riot's API; unavailable games are not invented.\n[Source & setup](https://github.com/tarun-bandi/league-stats-discord-bot)",
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
      case "recent":
      case "session":
        payload = await createLookup(interaction, env);
        break;
      case "live":
        payload = await buildLiveResponse(interaction, env);
        break;
      case "profile":
        payload = await profileCommand(interaction, env);
        break;
      case "track":
        payload = featureMessage(await trackingCommand(interaction, env));
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

async function runComponent(interaction, env) {
  try { await editOriginalResponse(interaction, await updateLookup(interaction, env)); }
  catch (error) {
    // A failed click must not replace a good public card with an error.
    const content = error instanceof UserFacingError ? error.message : "This card could not be updated. Try again shortly.";
    const response = await fetch(`${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message(content, { ephemeral: true })),
    });
    if (!response.ok) console.error("Could not deliver private component error");
  }
}

export default {
  async scheduled(controller, env) {
    try {
      await runLeagueMonitor(env, {
        detectionTimestamp: controller.scheduledTime || Date.now(),
      });
      if (monitorEnabled(env) && env.MONITOR_DB && new Date(controller.scheduledTime || Date.now()).getUTCMinutes() === 0) await purgeExpiredRecords(env.MONITOR_DB);
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
          const status = await monitorStatus(env);
          const health = await readRecord(env.MONITOR_DB, "health:riot");
          return json({ ...status, credentialHealth: { status: health?.status ?? "unknown", changedAt: health?.changedAt ?? null, notificationPending: Boolean(health?.pending?.length), deliveryError: Boolean(health?.deliveryError) } });
        } catch {
          return json(
            {
              ...monitorConfiguration(env),
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
          monitor: monitorConfiguration(env),
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

    if (interaction.type === 4) {
      return autocompleteResponse(interaction, env);
    }

    if ([3, 5].includes(interaction.type)) {
      try {
        const { view, action } = await resolveView(interaction, env);
        if (action === "champion" && interaction.type === 3) return json(championModal(view));
        if (interaction.type === 5 && action !== "choose") throw new UserFacingError("Unknown form.");
        context.waitUntil(runComponent(interaction, env));
        return json({ type: 6 });
      } catch (error) {
        return immediateMessage(error instanceof UserFacingError ? error.message : "This card is temporarily unavailable.", { ephemeral: true });
      }
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

    if (["stats", "recent", "live", "session", "profile", "track"].includes(interaction.data?.name)) {
      try {
        const administrative = ["profile", "track"].includes(interaction.data.name);
        if (interaction.data.name === "track") assertMonitorAdmin(interaction, env);
        // Read preferences before acknowledging so a private default can never
        // accidentally be posted publicly. Storage failure is fail-closed.
        const effective = administrative ? interaction : withDefaults(interaction, await readProfile(interaction, env));
        if (!administrative && !optionsObject(effective).summoner) return immediateMessage("Choose a summoner or save one with `/profile set summoner:...`.", { ephemeral: true });
        context.waitUntil(runDeferredCommand(effective, env));
        return deferredMessage(administrative || Boolean(optionsObject(effective).private));
      } catch (error) {
        return immediateMessage(error instanceof UserFacingError ? error.message : "Your settings could not be loaded. Nothing was posted publicly; try again shortly.", { ephemeral: true });
      }
    }

    return immediateMessage("Unknown command. Try `/help`.", {
      ephemeral: true,
    });
  },
};
