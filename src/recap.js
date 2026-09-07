import { readState, trackerEntries, monitorEnabled } from "./monitor.js";
import { readRecord, writeRecord, leaseRecord, releaseRecord } from "./store.js";
import { featureMessage } from "./features.js";
import { assertMonitorAdmin } from "./tracking.js";
import { UserFacingError } from "./errors.js";
import { rankScore } from "./ranks.js";
import { retryAt } from "./data-cache.js";

const DAY = 86400_000, WEEK = 7 * DAY, HOUR = 3600_000;
const QUEUES = { RANKED_SOLO_5x5: "Solo/Duo", RANKED_FLEX_SR: "Flex" };
const safe = (s) => String(s).replace(/[\\`*_~|<>@]/g, "").slice(0, 80);
const stamp = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const configKey = (env) => `weekly:${env.DISCORD_GUILD_ID}`;

export function assertRecapGuild(interaction, env) {
  if (!env.DISCORD_GUILD_ID || interaction.guild_id !== env.DISCORD_GUILD_ID) throw new UserFacingError("Recaps are only available in the configured tracking server.");
}

// Monday 16:00 UTC; fixed UTC schedule avoids DST ambiguity.
export function recapBoundary(now) {
  const date = new Date(now);
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - (date.getUTCDay() + 6) % 7, 16);
  return monday > now ? monday - WEEK : monday;
}

export function weeklyLp(history, queue, start, end) {
  const points = (history ?? []).filter((p) => Date.parse(p.at) >= start && Date.parse(p.at) < end).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (points.length < 2) return { delta: null, reason: "insufficient rank history" };
  const valid = (r) => r && rankScore(r) !== null && [r.leaguePoints, r.wins, r.losses].every(Number.isFinite);
  for (let i = 0; i < points.length; i++) {
    const rank = points[i].entries?.[queue], old = points[i - 1]?.entries?.[queue];
    if (!valid(rank)) return { delta: null, reason: "unranked or missing observations" };
    if (i && (Date.parse(points[i].at) - Date.parse(points[i - 1].at) > 48 * HOUR || rank.wins < old.wins || rank.losses < old.losses)) return { delta: null, reason: "tracking gap or ranked reset" };
  }
  const first = points[0], last = points.at(-1);
  const score = (r) => Math.min(28, rankScore(r)) * 100 + r.leaguePoints;
  return { delta: score(last.entries[queue]) - score(first.entries[queue]), first: Date.parse(first.at), last: Date.parse(last.at),
    partial: Date.parse(first.at) > start + HOUR || Date.parse(last.at) < end - HOUR };
}

export function recapPayload(state, start, end) {
  const players = trackerEntries(state).filter(({ tracker: t }) => !t.removed_at).slice(0, 10).map(({ tracker: t }) => {
    const seen = new Set();
    const games = Object.values(t.reported_games).filter((g) => {
      const at = Date.parse(g.start_time);
      if (g.status !== "completed" || !["WIN", "LOSS"].includes(g.result) || at < start || at >= end || !Number.isFinite(at) || !g.match_id || seen.has(g.match_id)) return false;
      seen.add(g.match_id); return true;
    }).sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
    const wins = games.filter((g) => g.result === "WIN").length;
    let streak = 0, longest = 0;
    for (const game of games) { streak = game.result === "LOSS" ? streak + 1 : 0; longest = Math.max(streak, longest); }
    return { name: safe(t.summoner.riot_id), games: games.length, wins, longest, paused: t.monitor_paused,
      lp: Object.fromEntries(Object.keys(QUEUES).map((q) => [q, weeklyLp((t.rank_history ?? []).filter((p) => !t.monitor_started_at || Date.parse(p.at) >= Date.parse(t.monitor_started_at)), q, start, end)])) };
  });
  const highlights = [];
  const most = [...players].sort((a, b) => b.games - a.games)[0];
  if (most?.games) highlights.push(`Most observed games: **${most.name} (${most.games})**`);
  const best = players.filter((p) => p.games >= 5).sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games)[0];
  if (best) highlights.push(`Best win rate (5+ observed games): **${best.name} (${(best.wins / best.games * 100).toFixed(1)}%)**`);
  const loss = [...players].sort((a, b) => b.longest - a.longest)[0];
  if (loss?.longest >= 2) highlights.push(`Longest observed loss streak: **${loss.name} (${loss.longest})**`);
  for (const [queue, label] of Object.entries(QUEUES)) {
    const climber = players.filter((p) => p.lp[queue].delta > 0 && !p.lp[queue].partial).sort((a, b) => b.lp[queue].delta - a.lp[queue].delta)[0];
    if (climber) highlights.push(`Biggest observed ${label} climber: **${climber.name} (${signed(climber.lp[queue].delta)} LP)**`);
  }
  return featureMessage("", [{ title: "Weekly server summary", description: `${stamp(start)} → ${stamp(end)} (end exclusive)\n${highlights.join("\n") || "Not enough observed activity for weekly highlights yet."}`,
    fields: players.map((p) => ({ name: `${p.name}${p.paused ? " (paused)" : ""}`, value: [
      p.games ? `${p.wins}W–${p.games - p.wins}L • ${(p.wins / p.games * 100).toFixed(1)}% • ${p.games} observed games` : "No completed games observed in this period.",
      ...Object.entries(QUEUES).map(([q, label]) => { const lp = p.lp[q]; return lp.delta === null ? `${label}: LP unavailable (${lp.reason})` : `${label}: **${signed(lp.delta)} LP**${lp.partial ? " (partial period)" : ""}\nObserved ${stamp(lp.first)} → ${stamp(lp.last)}`; }),
    ].join("\n") })), footer: { text: "Saved monitor observations only; pauses/outages can leave gaps. All modes; shared matches count per player. LP is net ranked progress, including promotions/demotions, not a per-game estimate. Ties use roster order." } }]);
}

export async function summaryCommand(interaction, env, now = Date.now()) {
  assertRecapGuild(interaction, env);
  return recapPayload(await readState(env.MONITOR_DB), now - WEEK, now);
}

export async function weeklyCommand(interaction, env, now = Date.now()) {
  assertMonitorAdmin(interaction, env);
  const action = interaction.data.options?.[0]?.name;
  const key = configKey(env);
  if (!await readRecord(env.MONITOR_DB, key)) {
    // INSERT-only initialization must not overwrite another admin's settings.
    await env.MONITOR_DB.prepare("INSERT OR IGNORE INTO bot_records(record_key,payload,expires_at) VALUES(?1,?2,0)").bind(key, JSON.stringify({ enabled: false })).run();
  }
  const owner = crypto.randomUUID();
  if (!await leaseRecord(env.MONITOR_DB, key, owner, now)) throw new UserFacingError("Weekly recap settings are busy. Try again shortly.");
  try {
    const settings = await readRecord(env.MONITOR_DB, key);
    if (action === "enable") {
      if (!/^\d+$/.test(interaction.channel_id ?? "")) throw new UserFacingError("Use this command in the destination server channel.");
      if (!settings.enabled) settings.nextDue = recapBoundary(now) + WEEK;
      Object.assign(settings, { enabled: true, channel: interaction.channel_id });
      await writeRecord(env.MONITOR_DB, key, settings);
    } else if (action === "disable") {
      settings.enabled = false;
      await writeRecord(env.MONITOR_DB, key, settings);
    } else if (action !== "status") throw new UserFacingError("Choose enable, disable or status.");
    return featureMessage(`${settings.enabled ? `Weekly recaps enabled in channel ${settings.channel}. Mondays at 16:00 UTC; next: ${stamp(settings.nextDue)}.` : "Weekly recaps are disabled."}\nUse /summary for the last seven days now.${settings.lastStatus ? `\nLast delivery: ${settings.lastStatus}.` : ""}`);
  } finally { await releaseRecord(env.MONITOR_DB, key, owner); }
}

export async function runWeeklyRecap(env, now = Date.now(), fetchImpl = fetch) {
  if (!env.MONITOR_DB || !env.DISCORD_GUILD_ID || !monitorEnabled(env)) return;
  const key = configKey(env), initial = await readRecord(env.MONITOR_DB, key);
  if (!initial?.enabled || now < initial.nextDue || now < (initial.retryAt ?? 0)) return;
  const owner = crypto.randomUUID();
  if (!await leaseRecord(env.MONITOR_DB, key, owner, now)) return;
  try {
    const settings = await readRecord(env.MONITOR_DB, key);
    if (!settings?.enabled || now < settings.nextDue || now < (settings.retryAt ?? 0)) return;
    const end = recapBoundary(now);
    // A durable attempt marker prevents duplicate messages after an ambiguous
    // network failure or a crash between Discord accepting and D1 saving.
    if (settings.attempt === end) {
      settings.lastStatus = "delivery uncertain; automatic resend suppressed (use /summary)";
      settings.nextDue = end + WEEK;
      await writeRecord(env.MONITOR_DB, key, settings); return;
    }
    if (!env.DISCORD_BOT_TOKEN || !/^\d+$/.test(settings.channel ?? "")) throw new Error("Weekly recap delivery is not configured");
    const payload = recapPayload(await readState(env.MONITOR_DB), end - WEEK, end);
    settings.attempt = end;
    await writeRecord(env.MONITOR_DB, key, settings);
    let response;
    try {
      response = await fetchImpl(`https://discord.com/api/v10/channels/${settings.channel}/messages`, {
        method: "POST", signal: AbortSignal.timeout(10000), headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
    } catch { settings.lastStatus = "delivery uncertain; automatic resend suppressed (use /summary)"; }
    if (response?.ok) { settings.lastStatus = "sent"; settings.nextDue = end + WEEK; }
    else if (response && response.status >= 400 && response.status < 500) {
      delete settings.attempt;
      settings.lastStatus = `HTTP ${response.status}; will retry`;
      settings.retryAt = response.status === 429 ? Math.max(now + 60000, retryAt(response.headers.get("Retry-After"), now)) : now + HOUR;
    } else { settings.lastStatus = "delivery uncertain; automatic resend suppressed (use /summary)"; settings.nextDue = end + WEEK; }
    await writeRecord(env.MONITOR_DB, key, settings);
  } finally { await releaseRecord(env.MONITOR_DB, key, owner); }
}
