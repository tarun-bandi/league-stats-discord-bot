import { queueName, matchMetrics, metricsSummary } from "./league.js";
import { brandedEmbed } from "./branding.js";
import { observeRanks, rankLabel, RANK_POLL_MS } from "./ranks.js";
import { syncDiscordApplication } from "./application.js";
import { getChampionCatalog, championInfo } from "./champions.js";

const STATE_KEY = "league-game-monitor";
const DISCORD_API = "https://discord.com/api/v10";
const EASTERN_TIME_ZONE = "America/New_York";
const EMPTY_MENTIONS = { parse: [] };
const LEASE_MS = 4 * 60 * 1000;
const RIOT_CURSOR_LIMIT = 100;
const STALE_LIVE_MS = 6 * 60 * 60 * 1000;

const NA_REGION = {
  platform: "na1",
  regional: "americas",
};

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRiotId(value) {
  const input = String(value ?? "").trim();
  const separator = input.lastIndexOf("#");
  if (separator <= 0 || separator === input.length - 1) {
    throw new Error("Monitor state contains an invalid Riot ID");
  }
  return {
    gameName: input.slice(0, separator).trim(),
    tagLine: input.slice(separator + 1).trim(),
  };
}

function trackerEntries(state) {
  return [
    { stateKey: "na:hellothere#9494", tracker: state },
    ...Object.entries(state.additional_summoners ?? {}).map(
      ([stateKey, tracker]) => ({ stateKey, tracker }),
    ),
  ];
}

function validateTracker(tracker, label) {
  if (!isObject(tracker)) throw new Error(`${label} tracker is missing`);
  if (!isObject(tracker.summoner) || !tracker.summoner.riot_id) {
    throw new Error(`${label} summoner is missing`);
  }
  parseRiotId(tracker.summoner.riot_id);
  if (!isObject(tracker.baseline)) throw new Error(`${label} baseline is missing`);
  if (
    tracker.newest_completed_match !== null &&
    !isObject(tracker.newest_completed_match)
  ) {
    throw new Error(`${label} completed-match cursor is invalid`);
  }
  if (!isObject(tracker.reported_games)) {
    throw new Error(`${label} reported-games map is invalid`);
  }
  for (const key of ["rank_snapshot", "reported_rank_changes"]) {
    if (tracker[key] !== undefined && !isObject(tracker[key])) throw new Error(`${label} ${key} is invalid`);
  }
}

export function validateMonitorState(state) {
  if (!isObject(state)) throw new Error("Monitor state is not an object");
  if (!isObject(state.additional_summoners)) {
    throw new Error("Monitor additional-summoners map is missing");
  }

  const entries = trackerEntries(state);
  if (entries.length !== 3) {
    throw new Error(`Expected 3 monitor trackers, found ${entries.length}`);
  }
  for (const { stateKey, tracker } of entries) {
    validateTracker(tracker, stateKey);
  }
  return state;
}

export function monitorEnabled(env) {
  return ENABLED_VALUES.has(String(env.MONITOR_ENABLED ?? "").trim().toLowerCase());
}

function botChannelId(env, override) {
  const channelId = String(override ?? env.DISCORD_ALERT_CHANNEL_ID ?? "").trim();
  if (!/^\d+$/.test(channelId)) {
    throw new Error("DISCORD_ALERT_CHANNEL_ID is not configured");
  }
  return channelId;
}

function requireBotToken(env) {
  const token = String(env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");
  return token;
}

export function monitorConfiguration(env) {
  return {
    configured: Boolean(
      env.MONITOR_DB &&
        env.RIOT_API_KEY &&
        env.DISCORD_BOT_TOKEN &&
        env.DISCORD_ALERT_CHANNEL_ID,
    ),
    enabled: monitorEnabled(env),
    transport: "bot",
  };
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

function formatEasternDate(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

function normalizedGameId(value) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/^[A-Z0-9]+_/i, "");
}

function normalizedText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function sameApproximateStart(first, second) {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  return (
    Number.isFinite(firstMs) &&
    Number.isFinite(secondMs) &&
    Math.abs(firstMs - secondMs) <= 10 * 60 * 1000
  );
}

async function riotJson(
  env,
  url,
  { allowNotFound = false, allowInvalidIdentifier = false } = {},
) {
  if (!env.RIOT_API_KEY) throw new Error("RIOT_API_KEY is not configured");
  const response = await fetch(url, {
    headers: { "X-Riot-Token": env.RIOT_API_KEY },
  });
  if (allowNotFound && response.status === 404) return null;
  if (allowInvalidIdentifier && [400, 404].includes(response.status)) return null;
  if (!response.ok) {
    const pathname = new URL(url).pathname;
    const endpoint = pathname.includes("/accounts/by-puuid/")
      ? "account-by-puuid"
      : pathname.includes("/accounts/by-riot-id/")
        ? "account-by-riot-id"
        : pathname.includes("/matches/by-puuid/")
          ? "match-list"
          : pathname.includes("/lol/match/v5/matches/")
            ? "match-detail"
            : pathname.includes("/active-games/by-summoner/")
              ? "active-game"
              : "unknown-endpoint";
    let detail = "";
    try {
      const body = await response.clone().json();
      detail = String(body?.status?.message ?? body?.message ?? "").slice(0, 200);
    } catch {
      // Riot did not return a JSON error body.
    }
    const error = new Error(
      `Riot API ${endpoint} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}


async function resolveTrackedAccount(env, tracker, detectionMs) {
  const summoner = tracker.summoner;
  const checkedAt = Date.parse(summoner.riot_account_checked_at ?? "");
  if (
    summoner.puuid &&
    Number.isFinite(checkedAt) &&
    detectionMs - checkedAt < 24 * 60 * 60 * 1000
  ) {
    return summoner;
  }

  let account;
  if (summoner.puuid) {
    const url = `https://${NA_REGION.regional}.api.riotgames.com/riot/account/v1/accounts/by-puuid/${encodeURIComponent(summoner.puuid)}`;
    account = await riotJson(env, url, { allowInvalidIdentifier: true });
  }
  if (!account) {
    const riotId = parseRiotId(summoner.riot_id);
    const url = `https://${NA_REGION.regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotId.gameName)}/${encodeURIComponent(riotId.tagLine)}`;
    account = await riotJson(env, url);
  }

  summoner.puuid = account.puuid;
  summoner.riot_id = `${account.gameName}#${account.tagLine}`;
  summoner.riot_account_checked_at = new Date(detectionMs).toISOString();
  return summoner;
}

async function matchIds(env, puuid, startTime) {
  const query = new URLSearchParams({
    start: "0",
    count: String(RIOT_CURSOR_LIMIT),
  });
  if (startTime) query.set("startTime", String(startTime));
  const url = `https://${NA_REGION.regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?${query}`;
  return riotJson(env, url);
}

async function matchDetail(env, matchId, { allowNotFound = false } = {}) {
  const url = `https://${NA_REGION.regional}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  return riotJson(env, url, { allowNotFound });
}

async function matchDetails(env, ids, cache = new Map()) {
  for (let index = 0; index < ids.length; index += 10) {
    const chunk = ids.slice(index, index + 10).filter((id) => !cache.has(id));
    const details = await Promise.all(chunk.map((id) => matchDetail(env, id)));
    for (let offset = 0; offset < chunk.length; offset += 1) {
      cache.set(chunk[offset], details[offset]);
    }
    if (index + 10 < ids.length) {
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
  }
  return ids.map((id) => cache.get(id));
}

function participantFor(match, puuid) {
  return match.info?.participants?.find((entry) => entry.puuid === puuid);
}

export function completedGame(match, tracker, detectionIso) {
  const puuid = tracker.summoner.puuid;
  const participant = participantFor(match, puuid);
  if (!participant) throw new Error("Tracked summoner is missing from Riot match data");
  const matchId = match.metadata?.matchId;
  if (!matchId) throw new Error("Riot match data is missing its match ID");
  const startMs = Number(match.info?.gameStartTimestamp);
  if (!Number.isFinite(startMs)) throw new Error("Riot match start time is invalid");
  return {
    status: "completed",
    champion: participant.championName || "Unknown",
    champion_id: participant.championId,
    queue: queueName(match.info?.queueId, match.info?.gameMode),
    queue_id: match.info?.queueId,
    metrics: matchMetrics(participant, Number(match.info?.gameDuration) || 0),
    start_time: new Date(startMs).toISOString(),
    result: participant.win ? "WIN" : "LOSS",
    duration: formatDuration(match.info?.gameDuration),
    detected_at: detectionIso,
    match_id: matchId,
    riot_game_id: normalizedGameId(match.info?.gameId ?? matchId),
    source: "riot",
  };
}

function matchesSavedCursor(match, tracker) {
  const saved = tracker.newest_completed_match;
  if (!saved?.started_at) return false;
  const participant = participantFor(match, tracker.summoner.puuid);
  if (!participant) return false;
  const start = new Date(Number(match.info?.gameStartTimestamp)).toISOString();
  const championMatches =
    !saved.champion ||
    normalizedText(saved.champion) === normalizedText(participant.championName);
  const queueMatches =
    !saved.queue ||
    normalizedText(saved.queue) ===
      normalizedText(queueName(match.info?.queueId, match.info?.gameMode));
  return championMatches && queueMatches && sameApproximateStart(start, saved.started_at);
}

function findReportedByMatchId(tracker, matchId, riotGameId) {
  const normalized = normalizedGameId(riotGameId ?? matchId);
  return Object.entries(tracker.reported_games).find(([key, record]) => {
    if (key === matchId) return true;
    return [record.match_id, record.riot_game_id, record.live_game_id]
      .map(normalizedGameId)
      .filter(Boolean)
      .includes(normalized);
  });
}

function pendingLiveRecords(tracker) {
  return Object.entries(tracker.reported_games).filter(
    ([, record]) => record.status === "live",
  );
}

function isStaleLiveRecord(record, detectionIso) {
  const startedMs = Date.parse(record.start_time ?? "");
  const detectedMs = Date.parse(detectionIso);
  return (
    Number.isFinite(startedMs) &&
    Number.isFinite(detectedMs) &&
    detectedMs - startedMs >= STALE_LIVE_MS
  );
}

function unavailableCompletion(record, detectionIso) {
  Object.assign(record, {
    status: "completed",
    result: "UNAVAILABLE",
    duration: "Unavailable",
    completed_detected_at: detectionIso,
    completion_source: "riot-match-unavailable",
  });
}

function pendingLivePatch(recordKey, record) {
  return {
    recordKey,
    record,
    patch_message_id: record.discord_message_id ?? null,
    patch_channel_id: record.discord_channel_id ?? null,
  };
}

export async function reconcilePendingLiveGames(
  env,
  tracker,
  detectionIso,
  matchDetailImpl = matchDetail,
) {
  const reconciled = [];
  for (const [recordKey, record] of pendingLiveRecords(tracker)) {
    const gameId = normalizedGameId(record.riot_game_id ?? record.live_game_id);
    if (!gameId) continue;
    let match;
    try {
      match = await matchDetailImpl(env, `NA1_${gameId}`, {
        allowNotFound: true,
      });
    } catch (error) {
      // Mayhem match details may be forbidden even with a healthy credential.
      // Every tracker still checks Spectator-v5, so an expired key fails the run.
      if (error?.httpStatus === 403 && record.queue_id === 2400 && !isStaleLiveRecord(record, detectionIso)) continue;
      if (error?.httpStatus !== 403 || !isStaleLiveRecord(record, detectionIso)) {
        throw error;
      }
      unavailableCompletion(record, detectionIso);
      reconciled.push(pendingLivePatch(recordKey, record));
      continue;
    }
    if (!match) {
      if (isStaleLiveRecord(record, detectionIso)) {
        unavailableCompletion(record, detectionIso);
        reconciled.push(pendingLivePatch(recordKey, record));
      }
      continue;
    }

    const game = completedGame(match, tracker, detectionIso);
    Object.assign(record, game, {
      status: "completed",
      live_game_id: record.live_game_id ?? game.riot_game_id,
    });
    reconciled.push(pendingLivePatch(recordKey, record));
  }
  return reconciled;
}

export function findCorrelatedLiveRecord(tracker, game) {
  const exact = findReportedByMatchId(tracker, game.match_id, game.riot_game_id);
  if (exact?.[1]?.status === "live") return exact;
  return Object.entries(tracker.reported_games).find(([, record]) => {
    return (
      record.status === "live" &&
      normalizedText(record.champion) === normalizedText(game.champion) &&
      normalizedText(record.queue) === normalizedText(game.queue) &&
      sameApproximateStart(record.start_time, game.start_time)
    );
  });
}

function updateCompletedCursor(tracker, game) {
  if (
    tracker.newest_completed_match?.id &&
    !tracker.newest_completed_match.legacy_opgg_match_id &&
    !/^NA1_/i.test(tracker.newest_completed_match.id)
  ) {
    game.legacy_opgg_match_id = tracker.newest_completed_match.id;
  }
  tracker.newest_completed_match = {
    id: game.match_id,
    champion: game.champion,
    queue: game.queue,
    started_at: game.start_time,
    result: game.result,
    duration: game.duration,
    source: "riot",
    ...(game.legacy_opgg_match_id
      ? { legacy_opgg_match_id: game.legacy_opgg_match_id }
      : {}),
  };
  tracker.riot_newest_completed_match_id = game.match_id;
}

async function completedUpdates(env, tracker, detectionIso) {
  const targetMs = Date.parse(tracker.newest_completed_match?.started_at ?? "");
  const startTime = tracker.riot_newest_completed_match_id
    ? undefined
    : Number.isFinite(targetMs)
      ? Math.max(0, Math.floor((targetMs - 10 * 60 * 1000) / 1000))
      : undefined;
  const ids = await matchIds(env, tracker.summoner.puuid, startTime);
  if (!ids.length) return [];

  const detailCache = new Map();
  let cursor = tracker.riot_newest_completed_match_id;
  let cursorIndex = cursor ? ids.indexOf(cursor) : -1;

  if (!cursor) {
    const details = await matchDetails(env, ids, detailCache);
    cursorIndex = details.findIndex((match) => matchesSavedCursor(match, tracker));
    if (cursorIndex === -1) {
      tracker.riot_newest_completed_match_id = ids[0];
      tracker.riot_cursor_initialized_at = detectionIso;
      return [];
    }
    cursor = ids[cursorIndex];
    tracker.riot_newest_completed_match_id = cursor;
    tracker.riot_cursor_initialized_at = detectionIso;
  }

  if (cursorIndex === -1) {
    throw new Error(
      `Saved Riot match cursor is outside the newest ${RIOT_CURSOR_LIMIT} games`,
    );
  }

  const newIds = ids.slice(0, cursorIndex);
  if (!newIds.length) return [];
  const details = await matchDetails(env, newIds, detailCache);
  const updates = details
    .map((match) => completedGame(match, tracker, detectionIso))
    .sort((first, second) => Date.parse(first.start_time) - Date.parse(second.start_time));

  for (const game of updates) {
    const correlated = findCorrelatedLiveRecord(tracker, game);
    if (correlated) {
      const [recordKey, record] = correlated;
      Object.assign(record, game, {
        status: "completed",
        live_game_id: record.live_game_id ?? game.riot_game_id,
      });
      game.record_key = recordKey;
      game.record = record;
      game.patch_message_id = record.discord_message_id ?? null;
      game.patch_channel_id = record.discord_channel_id ?? null;
      continue;
    }

    const alreadyReported = findReportedByMatchId(
      tracker,
      game.match_id,
      game.riot_game_id,
    );
    if (alreadyReported) continue;
    const record = { ...game };
    tracker.reported_games[game.match_id] = record;
    game.record_key = game.match_id;
    game.record = record;
    game.is_new_alert = true;
  }

  updateCompletedCursor(tracker, updates.at(-1));
  return updates;
}

async function activeGame(env, tracker, detectionIso, names) {
  const url = `https://${NA_REGION.platform}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(tracker.summoner.puuid)}`;
  const game = await riotJson(env, url, { allowNotFound: true });
  if (!game) return null;
  const gameId = normalizedGameId(game.gameId);
  if (!gameId) throw new Error("Riot live-game data is missing its game ID");
  const participant = game.participants?.find(
    (entry) => entry.puuid === tracker.summoner.puuid,
  );
  if (!participant) throw new Error("Tracked summoner is missing from live-game data");
  const startMs = Number(game.gameStartTime) > 0 ? Number(game.gameStartTime) : Date.now();
  return {
    status: "live",
    champion:
      championInfo(names, participant.championId)?.name ??
      `Champion ${participant.championId ?? "unknown"}`,
    champion_icon_url: championInfo(names, participant.championId)?.icon,
    queue: queueName(game.gameQueueConfigId, game.gameMode),
    queue_id: game.gameQueueConfigId,
    start_time: new Date(startMs).toISOString(),
    detected_at: detectionIso,
    live_game_id: gameId,
    riot_game_id: gameId,
    match_id: null,
    source: "riot",
  };
}

function addLiveUpdate(tracker, game) {
  if (!game) return null;
  const alreadyReported = findReportedByMatchId(
    tracker,
    game.match_id,
    game.live_game_id,
  );
  tracker.newest_live_game_id = game.live_game_id;
  if (alreadyReported) return null;
  const recordKey = `live:${game.live_game_id}`;
  const record = { ...game };
  tracker.reported_games[recordKey] = record;
  game.record_key = recordKey;
  game.record = record;
  game.is_new_alert = true;
  return game;
}

function renderGame(riotId, record) {
  if (record.kind === "demotion") {
    return `**${riotId} — Demoted**\n${record.queue}\n${rankLabel(record.from_rank)} → **${rankLabel(record.to_rank)}**\nDetected: ${formatEasternDate(record.detected_at)}`;
  }
  const lines = [
    `**${riotId}**`,
    `${record.champion} • ${record.queue}`,
    `Started: ${formatEasternDate(record.start_time)}`,
    `Detected: ${formatEasternDate(record.detected_at)}`,
  ];
  if (record.status === "live") {
    lines.push("Status: **Live**");
  } else {
    lines.push(`Result: **${record.result}** • Duration: ${record.duration}`);
    if (metricsSummary(record.metrics)) lines.push(metricsSummary(record.metrics));
  }
  return lines.join("\n");
}

export function monitorPayload(items) {
  const embeds = items.map(({ riotId, record }) => brandedEmbed({
    color: record.kind === "demotion" || record.result === "LOSS" ? 0xe05d6f : record.result === "WIN" ? 0x2ecc71 : 0x5383e8,
    title: record.kind === "demotion" ? "Rank update" : "League Game Monitor",
    description: renderGame(riotId, record),
    ...(record.champion_icon_url ? { thumbnail: { url: record.champion_icon_url } } : {}),
  }));
  const totalLength = embeds.reduce((sum, embed) => sum + embed.title.length + embed.description.length + embed.author.name.length + embed.footer.text.length, 0);
  if (!embeds.length || embeds.length > 10 || totalLength > 6000) {
    throw new Error("Discord monitor payload is empty or too large");
  }
  return {
    content: "",
    embeds,
    allowed_mentions: EMPTY_MENTIONS,
  };
}

async function discordRequest(fetchImpl, url, init, action) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`Discord ${action} failed with HTTP ${response.status}`);
  }
  return response;
}

function botHeaders(env) {
  return {
    Authorization: `Bot ${requireBotToken(env)}`,
    "Content-Type": "application/json",
  };
}

export async function postDiscordBot(env, items, fetchImpl = fetch) {
  const channelId = botChannelId(env);
  const response = await discordRequest(
    fetchImpl,
    `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      headers: botHeaders(env),
      body: JSON.stringify(monitorPayload(items)),
    },
    "bot POST",
  );
  const message = await response.json();
  if (!message?.id) throw new Error("Discord bot POST did not return a message ID");
  return String(message.id);
}

export async function patchDiscordBot(
  env,
  messageId,
  items,
  channelId = null,
  fetchImpl = fetch,
) {
  const resolvedChannelId = botChannelId(env, channelId);
  await discordRequest(
    fetchImpl,
    `${DISCORD_API}/channels/${encodeURIComponent(resolvedChannelId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: botHeaders(env),
      body: JSON.stringify(monitorPayload(items)),
    },
    "bot PATCH",
  );
}

export async function deleteDiscordBotMessage(
  env,
  messageId,
  channelId = null,
  fetchImpl = fetch,
) {
  const resolvedChannelId = botChannelId(env, channelId);
  await discordRequest(
    fetchImpl,
    `${DISCORD_API}/channels/${encodeURIComponent(resolvedChannelId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE", headers: botHeaders(env) },
    "bot DELETE",
  );
}

function smokePayload(description) {
  return {
    content: "",
    embeds: [
      {
        color: 0x5383e8,
        title: "LeagueStats alert smoke test",
        description,
      },
    ],
    allowed_mentions: EMPTY_MENTIONS,
  };
}

export async function smokeDiscordBot(env, fetchImpl = fetch) {
  const channelId = botChannelId(env);
  const createResponse = await discordRequest(
    fetchImpl,
    `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      headers: botHeaders(env),
      body: JSON.stringify(smokePayload("Creating a temporary bot-authored alert.")),
    },
    "smoke POST",
  );
  const message = await createResponse.json();
  if (!message?.id) throw new Error("Discord smoke POST did not return a message ID");
  const messageId = String(message.id);

  try {
    await discordRequest(
      fetchImpl,
      `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: botHeaders(env),
        body: JSON.stringify(
          smokePayload("PASS: the bot created and edited this alert successfully."),
        ),
      },
      "smoke PATCH",
    );
  } catch (error) {
    await deleteDiscordBotMessage(env, messageId, channelId, fetchImpl).catch(() => {});
    throw error;
  }

  await deleteDiscordBotMessage(env, messageId, channelId, fetchImpl);
  return { status: "ok" };
}

function recordsForMessage(state, messageId) {
  const records = [];
  for (const { tracker } of trackerEntries(state)) {
    for (const record of [...Object.values(tracker.reported_games), ...Object.values(tracker.reported_rank_changes ?? {})]) {
      if (String(record.discord_message_id ?? "") === String(messageId)) {
        records.push({ riotId: tracker.summoner.riot_id, record });
      }
    }
  }
  records.sort(
    (first, second) =>
      Date.parse(first.record.start_time) - Date.parse(second.record.start_time),
  );
  return records;
}

async function acquireLease(db, nowMs, owner) {
  const result = await db
    .prepare(
      "UPDATE monitor_state SET lease_until = ?1, lease_owner = ?2 WHERE state_key = ?3 AND lease_until < ?4",
    )
    .bind(nowMs + LEASE_MS, owner, STATE_KEY, nowMs)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

async function releaseLease(db, owner) {
  await db
    .prepare(
      "UPDATE monitor_state SET lease_until = 0, lease_owner = NULL WHERE state_key = ?1 AND lease_owner = ?2",
    )
    .bind(STATE_KEY, owner)
    .run();
}

async function readState(db) {
  const row = await db
    .prepare("SELECT state_json FROM monitor_state WHERE state_key = ?1")
    .bind(STATE_KEY)
    .first();
  if (!row?.state_json) throw new Error("Cloudflare monitor state is missing");
  let state;
  try {
    state = JSON.parse(row.state_json);
  } catch {
    throw new Error("Cloudflare monitor state is corrupt");
  }
  return validateMonitorState(state);
}

async function saveState(db, owner, state, detectionIso) {
  const result = await db
    .prepare(
      "UPDATE monitor_state SET state_json = ?1, lease_until = 0, lease_owner = NULL, updated_at = ?2 WHERE state_key = ?3 AND lease_owner = ?4",
    )
    .bind(JSON.stringify(state), detectionIso, STATE_KEY, owner)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("Cloudflare monitor state lease was lost before save");
  }
}

export async function commitMonitorChanges(
  env,
  { state, owner, detectionIso, newAlerts, patchTargets },
  { fetchImpl = fetch, saveStateImpl = saveState } = {},
) {
  if (newAlerts.length) {
    const messageId = await postDiscordBot(env, newAlerts, fetchImpl);
    for (const alert of newAlerts) {
      alert.record.discord_message_id = messageId;
      alert.record.discord_transport = "bot";
      alert.record.discord_channel_id = botChannelId(env);
    }
    state.discord = isObject(state.discord) ? state.discord : {};
    state.discord.last_message_id = messageId;
  }

  for (const target of patchTargets.values()) {
    await patchDiscordBot(
      env,
      target.messageId,
      recordsForMessage(state, target.messageId),
      target.channelId,
      fetchImpl,
    );
  }

  state.last_check_at = detectionIso;
  state.monitor_runtime = "cloudflare-worker-cron";
  await saveStateImpl(env.MONITOR_DB, owner, state, detectionIso);
}

export async function monitorStatus(env) {
  const configuration = monitorConfiguration(env);
  if (!env.MONITOR_DB) return configuration;
  const state = await readState(env.MONITOR_DB);
  return {
    ...configuration,
    stateValid: true,
    lastCheckAt: state.last_check_at ?? null,
    pendingLiveAlerts: trackerEntries(state).reduce(
      (total, { tracker }) => total + pendingLiveRecords(tracker).length,
      0,
    ),
    summoners: trackerEntries(state).map(({ tracker }) => tracker.summoner.riot_id),
    rankMonitoring: {
      queues: ["Ranked Solo/Duo", "Ranked Flex"],
      baselineReady: trackerEntries(state).every(({ tracker }) => Boolean(tracker.rank_checked_at)),
      lastCheckedAt: trackerEntries(state).map(({ tracker }) => tracker.rank_checked_at ?? null),
    },
    application: {
      commandsSynced: Boolean(state.discord?.command_schema_hash),
    },
  };
}

export async function runLeagueMonitor(env, options = {}) {
  if (!monitorEnabled(env)) return { status: "disabled" };
  if (!env.MONITOR_DB) throw new Error("MONITOR_DB is not configured");
  if (!env.RIOT_API_KEY) throw new Error("RIOT_API_KEY is not configured");
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_ALERT_CHANNEL_ID) {
    throw new Error("Discord bot transport is not configured");
  }

  const detectionMs = Number(options.detectionTimestamp ?? Date.now());
  const owner = crypto.randomUUID();
  if (!(await acquireLease(env.MONITOR_DB, detectionMs, owner))) {
    return { status: "busy" };
  }

  try {
    const previous = await readState(env.MONITOR_DB);
    const state = structuredClone(previous);
    const detectionIso = new Date(detectionMs).toISOString();
    const names = await getChampionCatalog();
    const newAlerts = [];
    const patchTargets = new Map();

    for (const { stateKey, tracker } of trackerEntries(state)) {
      await resolveTrackedAccount(env, tracker, detectionMs);
      const reconciled = await reconcilePendingLiveGames(
        env,
        tracker,
        detectionIso,
      );
      for (const game of reconciled) {
        game.record.champion_icon_url = championInfo(names, game.record.champion_id ?? game.record.champion)?.icon ?? game.record.champion_icon_url;
        if (game.patch_message_id) {
          patchTargets.set(String(game.patch_message_id), {
            messageId: String(game.patch_message_id),
            channelId: game.patch_channel_id,
          });
        }
      }
      const completed = await completedUpdates(env, tracker, detectionIso);
      for (const game of completed) {
        if (game.record) game.record.champion_icon_url = championInfo(names, game.champion_id ?? game.champion)?.icon ?? game.record.champion_icon_url;
        if (game.is_new_alert) {
          newAlerts.push({ stateKey, riotId: tracker.summoner.riot_id, record: game.record });
        }
        if (game.patch_message_id) {
          patchTargets.set(String(game.patch_message_id), {
            messageId: String(game.patch_message_id),
            channelId: game.patch_channel_id,
          });
        }
      }

      const live = await activeGame(env, tracker, detectionIso, names);
      const newLive = addLiveUpdate(tracker, live);
      if (newLive) {
        newAlerts.push({
          stateKey,
          riotId: tracker.summoner.riot_id,
          record: newLive.record,
        });
      }
      const lastRankMs = Date.parse(tracker.rank_checked_at ?? "");
      if (!Number.isFinite(lastRankMs) || detectionMs - lastRankMs >= RANK_POLL_MS ||
          completed.some((game) => [420, 440].includes(game.queue_id))) {
        const ranked = await riotJson(env,
          `https://${NA_REGION.platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(tracker.summoner.puuid)}`);
        for (const record of observeRanks(tracker, ranked, detectionIso)) {
          newAlerts.push({ stateKey, riotId: tracker.summoner.riot_id, record });
        }
      }
    }

    await syncDiscordApplication(env, state);
    await commitMonitorChanges(env, {
      state,
      owner,
      detectionIso,
      newAlerts,
      patchTargets,
    });
    return {
      status: "ok",
      newAlerts: newAlerts.length,
      updatedMessages: patchTargets.size,
      transport: "bot",
    };
  } catch (error) {
    await releaseLease(env.MONITOR_DB, owner).catch(() => {});
    throw error;
  }
}
