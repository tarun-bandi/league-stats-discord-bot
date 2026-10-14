import { UserFacingError } from "./errors.js";
import { cacheKey, cacheRead, cacheWrite, retryAt } from "./data-cache.js";
import { parseRiotId, getMode, getRegion } from "./index.js";
import { optionsObject } from "./preferences.js";
import { featureMessage, startOfDay } from "./features.js";
import { getChampionCatalog, championInfo } from "./champions.js";

const TTL = 5 * 60_000;
const QUEUES = { SOLORANKED: 420, FLEXRANKED: 440, ARAM: 450 };
const normalize = (s) => String(s).trim().toLowerCase();
const safeName = (s) => String(s).replace(/[\\`*_~|<>]/g, "");
export function opggUrl(riotId, region) {
  const id = parseRiotId(riotId);
  return `https://op.gg/lol/summoners/${encodeURIComponent(region)}/${encodeURIComponent(id.gameName)}-${encodeURIComponent(id.tagLine)}`;
}
const fail = () => new UserFacingError("Riot is rate-limited and OP.GG's public match data is unavailable. Try again after the cooldown.");

export function parseOpgg(html, riotId, region, fetchedAt = Date.now()) {
  const nodes = [];
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      const value = JSON.parse(script[1]);
      for (const root of Array.isArray(value) ? value : [value]) nodes.push(...(root["@graph"] ?? [root]));
    } catch { /* Ignore unrelated invalid structured data; require a valid profile below. */ }
  }
  const person = nodes.find((n) => n["@type"] === "Person" && normalize(n.name) === normalize(riotId));
  const identifiers = Object.fromEntries((person?.identifier ?? []).map((p) => [p.name, p.value]));
  if (!person || normalize(identifiers.region) !== normalize(region)) throw fail();
  const profile = nodes.find((n) => n["@type"] === "ProfilePage" && n.mainEntity?.["@id"] === person["@id"]);
  const list = nodes.find((n) => n["@type"] === "ItemList" && n["@id"] === String(person["@id"]).replace(/#summoner$/, "#recent-games"));
  if (!profile || !Array.isArray(list?.itemListElement) || list.itemListElement.length > 100) throw fail();
  const seen = new Set(), rows = [];
  for (const entry of list.itemListElement) {
    const item = entry.item, props = Object.fromEntries((item?.additionalProperty ?? []).map((p) => [p.name, p.value]));
    if (item?.agent?.["@id"] !== person["@id"] || !item.actionStatus?.endsWith("/CompletedActionStatus")) throw fail();
    // Remakes and placements without explicit W/L are not losses.
    if (!["WIN", "LOSE"].includes(props.result)) continue;
    const timestamp = Date.parse(item.startTime);
    if (!props.matchId || !props.champion || !Number.isFinite(timestamp) || ![props.kills, props.deaths, props.assists].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw fail();
    if (seen.has(props.matchId)) continue;
    seen.add(props.matchId);
    rows.push({ id: props.matchId, timestamp, champion: props.champion, queue: QUEUES[props.queueType] ?? null,
      queueType: props.queueType, win: props.result === "WIN", kills: props.kills, deaths: props.deaths, assists: props.assists });
  }
  return { name: safeName(person.name), rows: rows.sort((a, b) => b.timestamp - a.timestamp), fetchedAt,
    profileUpdatedAt: Number.isFinite(Date.parse(profile.dateModified)) ? Date.parse(profile.dateModified) : null,
    url: opggUrl(riotId, region) };
}

async function publicProfile(riotId, region, env) {
  const key = await cacheKey("opgg-profile", [normalize(riotId), region]);
  const cached = await cacheRead(env, key);
  if (cached?.blocked) throw fail();
  if (cached?.rows) return { ...cached, cached: true };
  const url = opggUrl(riotId, region);
  try {
    // Public HTML only; no Riot credentials, browser automation or private API calls.
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(6000), headers: { Accept: "text/html", "User-Agent": "LeagueStats/1.0 (+https://github.com/tarun-bandi/league-stats-discord-bot)" } });
    if (!response.ok) {
      const ttl = response.status === 429 ? Math.max(TTL, retryAt(response.headers.get("Retry-After")) - Date.now()) : TTL;
      await cacheWrite(env, key, { blocked: true }, ttl);
      throw fail();
    }
    if (!response.headers.get("content-type")?.includes("text/html")) throw fail();
    const reader = response.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2_000_000) { await reader.cancel(); throw fail(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const result = parseOpgg(new TextDecoder().decode(bytes), riotId, region);
    await cacheWrite(env, key, result, TTL);
    return result;
  } catch (error) {
    if (!await cacheRead(env, key)) await cacheWrite(env, key, { blocked: true }, TTL);
    throw error instanceof UserFacingError ? error : fail();
  }
}

export async function opggStats(query, env, window, count = 30) {
  const region = String(query.region ?? "na").toLowerCase();
  getRegion({ data: { options: [{ name: "region", value: region }] } });
  const mode = Number(query.mode ?? 0);
  if (mode && !Object.values(QUEUES).includes(mode)) throw new UserFacingError("Riot is rate-limited. OP.GG fallback currently supports All modes, Solo/Duo, Flex and ARAM only.");
  const id = parseRiotId(query.summoner).display;
  const profile = await publicProfile(id, region, env);
  let rows = profile.rows.filter((r) => r.timestamp >= window.startTime * 1000 && r.timestamp <= window.endTime * 1000 && (!mode || r.queue === mode));
  if (query.champion) {
    const catalog = await getChampionCatalog();
    const chosen = championInfo(catalog, query.champion);
    if (!chosen) throw new UserFacingError("Champion names are unavailable or unrecognized; retry without the champion filter.");
    rows = rows.filter((r) => championInfo(catalog, r.champion)?.id === chosen.id);
  }
  rows = rows.slice(0, count);
  const games = rows.length, wins = rows.filter((r) => r.win).length;
  const sum = (field) => rows.reduce((n, r) => n + r[field], 0);
  return { name: profile.name, accountId: `${region}:${normalize(id)}`, source: "opgg", sourceUrl: profile.url,
    fetchedAt: profile.fetchedAt, profileUpdatedAt: profile.profileUpdatedAt, sourceCached: Boolean(profile.cached),
    rows, games, wins, losses: games - wins, winRate: games ? wins / games * 100 : 0,
    kda: sum("deaths") ? (sum("kills") + sum("assists")) / sum("deaths") : sum("kills") + sum("assists"),
    csPerMinute: null, hours: null, averageDamagePerMinute: null, averageVision: null,
    capped: true, availableSample: profile.rows.length };
}

export function sourceNote(player) {
  return player.source === "opgg" ? `[OP.GG fallback](${player.sourceUrl}) • ${player.availableSample} public recent matches before filtering${player.sourceCached ? " • cached" : ""} • fetched <t:${Math.floor(player.fetchedAt / 1000)}:R>${player.profileUpdatedAt ? ` • profile updated <t:${Math.floor(player.profileUpdatedAt / 1000)}:R>` : " • profile update time unknown"}` : "";
}

export async function buildOpggResponse(interaction, env) {
  const query = optionsObject(interaction), kind = interaction.data.name;
  query.mode = getMode(interaction);
  const endTime = Math.floor(Date.now() / 1000);
  const days = Math.max(1, Math.min(30, Number(query.days ?? 7)));
  const startTime = kind === "session" ? Math.floor(startOfDay(Date.now(), query.timezone ?? "America/New_York") / 1000) : kind === "recent" ? 0 : endTime - days * 86400;
  const p = await opggStats(query, env, { startTime, endTime }, kind === "recent" ? Math.max(1, Math.min(10, Number(query.count ?? 5))) : 30);
  return featureMessage("", [{ title: `${p.name} — ${kind} (OP.GG fallback)`,
    description: `${sourceNote(p)}\n${p.games ? `**${p.wins}W–${p.losses}L • ${p.winRate.toFixed(1)}% win rate • ${p.kda.toFixed(2)} KDA**` : "No matching games in OP.GG's available recent sample."}`,
    fields: kind === "recent" && p.games ? p.rows.map((r) => ({ name: `${safeName(r.champion)} • ${r.win ? "WIN" : "LOSS"}`, value: `${r.kills}/${r.deaths}/${r.assists} • <t:${Math.floor(r.timestamp / 1000)}:f>` })) : [],
    footer: { text: "Limited public sample; may be stale or incomplete. Rank, duration, CS/min, damage, vision and LP are unavailable." },
  }]);
}
