const STATE_KEY = "league-game-monitor";
const EASTERN_TIME_ZONE = "America/New_York";
const EMPTY_MENTIONS = { parse: [] };
const LEASE_MS = 4 * 60 * 1000;
const RIOT_CURSOR_LIMIT = 100;

const NA_REGION = {
  platform: "na1",
  regional: "americas",
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

function queueName(queueId, fallback = "League game") {
  return QUEUES[queueId] ?? fallback;
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

async function riotJson(env, url, { allowNotFound = false } = {}) {
  if (!env.RIOT_API_KEY) throw new Error("RIOT_API_KEY is not configured");
  const response = await fetch(url, {
    headers: { "X-Riot-Token": env.RIOT_API_KEY },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`Riot API failed with HTTP ${response.status}`);
  return response.json();
}

async function publicJson(url, ttlSeconds) {
  const cache = globalThis.caches?.default;
  const request = new Request(url);
  if (cache) {
    const cached = await cache.match(request);
    if (cached) return cached.json();
  }
  const response = await fetch(request);
  if (!response.ok) throw new Error(`Public data failed with HTTP ${response.status}`);
  const body = await response.json();
  if (cache) {
    await cache.put(
      request,
      new Response(JSON.stringify(body), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${ttlSeconds}`,
        },
      }),
    );
  }
  return body;
}

async function championNames() {
  try {
    const realm = await publicJson(
      "https://ddragon.leagueoflegends.com/realms/na.json",
      86400,
    );
    const champions = await publicJson(
      `https://ddragon.leagueoflegends.com/cdn/${encodeURIComponent(realm.v)}/data/en_US/champion.json`,
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
    account = await riotJson(env, url, { allowNotFound: true });
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

async function matchDetail(env, matchId) {
  const url = `https://${NA_REGION.regional}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  return riotJson(env, url);
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

function completedGame(match, tracker, detectionIso) {
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
    queue: queueName(match.info?.queueId, match.info?.gameMode),
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
      names.get(Number(participant.championId)) ??
      `Champion ${participant.championId ?? "unknown"}`,
    queue: queueName(game.gameQueueConfigId, game.gameMode),
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
  }
  return lines.join("\n");
}

export function monitorPayload(items) {
  const description = items
    .map(({ riotId, record }) => renderGame(riotId, record))
    .join("\n\n");
  if (!description || description.length > 4000) {
    throw new Error("Discord monitor payload is empty or too large");
  }
  return {
    content: "",
    embeds: [
      {
        color: 0x5383e8,
        title: "League Game Monitor",
        description,
      },
    ],
    allowed_mentions: EMPTY_MENTIONS,
  };
}

function webhookBase(env) {
  if (!env.DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL is not configured");
  }
  return String(env.DISCORD_WEBHOOK_URL).split("?")[0].replace(/\/$/, "");
}

async function postDiscord(env, items) {
  const response = await fetch(`${webhookBase(env)}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(monitorPayload(items)),
  });
  if (!response.ok) throw new Error(`Discord POST failed with HTTP ${response.status}`);
  const message = await response.json();
  if (!message?.id) throw new Error("Discord POST did not return a message ID");
  return String(message.id);
}

async function patchDiscord(env, messageId, items) {
  const response = await fetch(
    `${webhookBase(env)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(monitorPayload(items)),
    },
  );
  if (!response.ok) {
    throw new Error(`Discord PATCH failed with HTTP ${response.status}`);
  }
}

function recordsForMessage(state, messageId) {
  const records = [];
  for (const { tracker } of trackerEntries(state)) {
    for (const record of Object.values(tracker.reported_games)) {
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

export async function monitorStatus(env) {
  if (!env.MONITOR_DB) return { configured: false };
  const state = await readState(env.MONITOR_DB);
  return {
    configured: Boolean(env.DISCORD_WEBHOOK_URL && env.RIOT_API_KEY),
    stateValid: true,
    lastCheckAt: state.last_check_at ?? null,
    summoners: trackerEntries(state).map(({ tracker }) => tracker.summoner.riot_id),
  };
}

export async function runLeagueMonitor(env, options = {}) {
  if (!env.MONITOR_DB) throw new Error("MONITOR_DB is not configured");
  if (!env.DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL is not configured");
  }
  if (!env.RIOT_API_KEY) throw new Error("RIOT_API_KEY is not configured");

  const detectionMs = Number(options.detectionTimestamp ?? Date.now());
  const owner = crypto.randomUUID();
  if (!(await acquireLease(env.MONITOR_DB, detectionMs, owner))) {
    return { status: "busy" };
  }

  try {
    const previous = await readState(env.MONITOR_DB);
    const state = structuredClone(previous);
    const detectionIso = new Date(detectionMs).toISOString();
    const names = await championNames();
    const newAlerts = [];
    const patchMessageIds = new Set();

    for (const { stateKey, tracker } of trackerEntries(state)) {
      await resolveTrackedAccount(env, tracker, detectionMs);
      const completed = await completedUpdates(env, tracker, detectionIso);
      for (const game of completed) {
        if (game.is_new_alert) {
          newAlerts.push({ stateKey, riotId: tracker.summoner.riot_id, record: game.record });
        }
        if (game.patch_message_id) patchMessageIds.add(game.patch_message_id);
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
    }

    if (newAlerts.length) {
      const messageId = await postDiscord(env, newAlerts);
      for (const alert of newAlerts) {
        alert.record.discord_message_id = messageId;
      }
      state.discord = isObject(state.discord) ? state.discord : {};
      state.discord.last_message_id = messageId;
    }

    for (const messageId of patchMessageIds) {
      await patchDiscord(env, messageId, recordsForMessage(state, messageId));
    }

    state.last_check_at = detectionIso;
    state.monitor_runtime = "cloudflare-worker-cron";
    await saveState(env.MONITOR_DB, owner, state, detectionIso);
    return {
      status: "ok",
      newAlerts: newAlerts.length,
      updatedMessages: patchMessageIds.size,
    };
  } catch (error) {
    await releaseLease(env.MONITOR_DB, owner).catch(() => {});
    throw error;
  }
}
