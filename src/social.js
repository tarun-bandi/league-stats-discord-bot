import { aggregateMatches, parseRiotId, resolveAccount, getRegion, getMode, loadMoreMatches, UserFacingError } from "./index.js";
import { optionsObject, userId } from "./preferences.js";
import { featureMessage } from "./features.js";
import { readState, trackerEntries } from "./monitor.js";
import { readRecord, writeRecord, leaseRecord, releaseRecord } from "./store.js";
import { LEADERBOARD_METRICS } from "./commands.js";
import { queueName, modeNote } from "./league.js";

const TTL = 3600_000;
const asInteraction = (query) => ({ data: { options: Object.entries(query).map(([name, value]) => ({ name, value })) } });
const safeName = (name) => name.replace(/[\\`*_~|<>]/g, "");
const integer = (value, fallback, max) => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new UserFacingError(`Choose a whole number from 1 to ${max}.`);
  return n;
};

async function playerStats(query, env, window, count) {
  const interaction = asInteraction(query);
  const account = await resolveAccount(env, parseRiotId(query.summoner), getRegion(interaction));
  const snapshot = { startTime: window.startTime, endTime: window.endTime, account, matches: [], offset: 0 };
  await loadMoreMatches(interaction, env, snapshot, count);
  const { rows, ...stats } = aggregateMatches(snapshot.matches, account.puuid, query.days);
  return { name: safeName(`${account.gameName}#${account.tagLine}`), puuid: account.puuid, ...stats,
    hours: rows.reduce((sum, row) => sum + row.duration, 0) / 3600, capped: snapshot.more };
}

export function rankPlayers(players, metric, minimum) {
  return players.filter((p) => p.games >= minimum && Number.isFinite(p[metric]))
    .sort((a, b) => b[metric] - a[metric] || a.name.localeCompare(b.name))
    .map((player, i, sorted) => ({ ...player, position: sorted.findIndex((other) => other[metric] === player[metric]) + 1 }));
}
const format = (metric, value) => value == null ? "N/A" : `${Number(value).toFixed(metric === "games" ? 0 : metric === "winRate" ? 1 : 2)}${metric === "winRate" ? "%" : metric === "hours" ? "h" : ""}`;
const context = (view) => `Last ${view.query.days} days • ${view.query.mode ? queueName(view.query.mode) : "All modes"} • Through <t:${view.endTime}:f>`;

const lineFields = (name, lines) => Array.from({ length: Math.ceil(lines.length / 5) }, (_, i) => ({ name: i ? `${name} (continued)` : name, value: lines.slice(i * 5, i * 5 + 5).join("\n") }));

export function renderLeaderboard(view) {
  const metric = view.query.metric;
  const label = LEADERBOARD_METRICS.find(([, key]) => key === metric)[0];
  const pending = view.roster.length - view.players.length;
  const ranked = rankPlayers(view.players, metric, view.query.min_games);
  const excluded = view.players.filter((p) => p.games < view.query.min_games || !Number.isFinite(p[metric]));
  const payload = featureMessage("", [{ title: `Tracked roster — ${label}${pending ? " (incomplete)" : ""}`,
    description: `${context(view)}\nNA • ${view.players.length}/${view.roster.length} players loaded • Minimum ${view.query.min_games} sampled games\n${pending ? "Load the remaining players before treating these as final standings." : "Standings cover the active roster captured when this card was created."}\n${modeNote(view.query.mode) || ""}`,
    fields: [
      ...lineFields(pending ? "Provisional standings" : "Standings", ranked.length ? ranked.map((p) => `**${p.position}. ${p.name}** — ${format(metric, p[metric])} • ${p.wins}W–${p.losses}L (${p.games}g${p.capped ? ", capped" : ""})`) : ["No qualifying players loaded."]),
      ...lineFields("Not qualified", excluded.map((p) => `${p.name}: ${p.games} games${!Number.isFinite(p[metric]) ? "; metric unavailable" : ""}`)),
    ], footer: { text: "Newest 30 games per player in this window • Capped samples can omit older games • Ties share a rank" },
  }]);
  payload.components = [{ type: 1, components: [{ type: 2, style: 1, label: pending ? "Load next player" : "All players loaded", custom_id: `social:${view.id}:next`, disabled: !pending }] }];
  return payload;
}

export async function createSocial(interaction, env) {
  const options = optionsObject(interaction);
  const query = { ...options, days: integer(options.days, 7, 30), mode: getMode(interaction) };
  const endTime = Math.floor(Date.now() / 1000);
  const window = { startTime: endTime - query.days * 86400, endTime };
  if (interaction.data.name === "compare") {
    parseRiotId(query.summoner); parseRiotId(query.opponent);
    const region = getRegion(interaction);
    // Two players × 15 details plus account/ID cache operations stay under 50 subrequests.
    const players = [];
    for (const summoner of [query.summoner, query.opponent]) players.push(await playerStats({ ...query, summoner }, env, window, 15));
    if (players[0].puuid === players[1].puuid) throw new UserFacingError("Choose two different accounts to compare.");
    return featureMessage("", [{ title: "Player comparison", description: `${context({ query, endTime })}\n${region.label} • Same period and mode for both players.\n${modeNote(query.mode) || ""}`,
      fields: players.map((p) => ({ name: p.name, inline: true, value: p.games ? [
        `**${p.wins}W–${p.losses}L • ${format("winRate", p.winRate)}**`, `${p.games} sampled games${p.capped ? " (capped)" : ""} • ${format("hours", p.hours)} played`,
        `${format("kda", p.kda)} KDA`, `${format("csPerMinute", p.csPerMinute)} CS/min`,
        `${format("damage", p.averageDamagePerMinute)} damage/min`, `${format("vision", p.averageVision)} avg vision`,
      ].join("\n") : "No completed games returned in this period and mode." })),
      footer: { text: "Newest 15 games per player • Older games may be omitted • Descriptive stats, not a skill rating" },
    }]);
  }
  if (!env.DISCORD_GUILD_ID || interaction.guild_id !== env.DISCORD_GUILD_ID) throw new UserFacingError("Use /leaderboard in the configured tracking server.");
  query.region = "na"; // The tracked roster is NA; personal region defaults must not change it.
  query.metric = options.metric ?? "winRate";
  if (!LEADERBOARD_METRICS.some(([, key]) => key === query.metric)) throw new UserFacingError("Choose a supported leaderboard metric.");
  query.min_games = integer(options.min_games, 5, 30);
  const state = await readState(env.MONITOR_DB);
  const roster = [...new Set(trackerEntries(state).filter(({ tracker }) => !tracker.removed_at && !tracker.monitor_paused).map(({ tracker }) => tracker.summoner.riot_id))];
  if (!roster.length) throw new UserFacingError("No active tracked players. An admin can add or resume accounts with /track.");
  const view = { id: crypto.randomUUID(), owner: userId(interaction), guild: interaction.guild_id, channel: interaction.channel_id,
    query: { days: query.days, mode: query.mode, region: "na", metric: query.metric, min_games: query.min_games }, ...window, roster, players: [], expires: Date.now() + TTL };
  view.players.push(await playerStats({ ...view.query, summoner: roster[0] }, env, window, 30));
  await writeRecord(env.MONITOR_DB, `social:${view.id}`, view, view.expires);
  return renderLeaderboard(view);
}

export async function resolveSocial(interaction, env) {
  const [prefix, id, action, extra] = String(interaction.data.custom_id).split(":");
  if (prefix !== "social" || !/^[0-9a-f-]{36}$/.test(id) || action !== "next" || extra) throw new UserFacingError("Unsupported leaderboard control.");
  const view = await readRecord(env.MONITOR_DB, `social:${id}`);
  if (!view) throw new UserFacingError("This leaderboard expired after an hour. Run /leaderboard again.");
  if (view.owner !== userId(interaction) || view.guild !== interaction.guild_id || view.channel !== interaction.channel_id) throw new UserFacingError("Only the requester can load this leaderboard. Run /leaderboard for your own card.");
  return view;
}

export async function updateSocial(interaction, env) {
  const initial = await resolveSocial(interaction, env);
  const key = `social:${initial.id}`, owner = crypto.randomUUID();
  if (!await leaseRecord(env.MONITOR_DB, key, owner)) throw new UserFacingError("This leaderboard is already updating. Try again shortly.");
  try {
    const view = await resolveSocial(interaction, env);
    if (view.players.length < view.roster.length) {
      const player = await playerStats({ ...view.query, summoner: view.roster[view.players.length] }, env, view, 30);
      view.players.push(player);
      await writeRecord(env.MONITOR_DB, key, view, view.expires);
    }
    return renderLeaderboard(view);
  } finally { await releaseRecord(env.MONITOR_DB, key, owner); }
}
