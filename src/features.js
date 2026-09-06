import { readRecord, writeRecord, leaseRecord, releaseRecord } from "./store.js";
import { userId, optionsObject, readProfile, saveProfile, clearProfile } from "./preferences.js";
import { REGION_CHOICES } from "./commands.js";
import { MODE_CHOICES, queueName } from "./league.js";
import { brandedEmbed } from "./branding.js";
import { readState, trackerEntries } from "./monitor.js";
import { buildStatsResponse, buildRecentResponse, loadMoreMatches, aggregateMatches, parseRiotId, UserFacingError } from "./index.js";
import { rankScore } from "./ranks.js";

const VIEW_TTL = 60 * 60_000;
export const MAX_HISTORY = 300;
const emptyMentions = { parse: [] };
export const featureMessage = (content, embeds = []) => ({ content, embeds: embeds.map(brandedEmbed), allowed_mentions: emptyMentions });
const viewInteraction = (view) => ({ data: { name: view.kind, options: Object.entries(view.query).map(([name, value]) => ({ name, value })) } });

export function validateTimezone(timezone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); }
  catch { throw new UserFacingError("Use an IANA time zone such as America/New_York or Europe/London."); }
  return timezone;
}

export async function profileCommand(interaction, env) {
  const action = interaction.data.options?.[0]?.name;
  if (action === "clear") {
    await clearProfile(interaction, env);
    return featureMessage("Your saved defaults for this server have been cleared.");
  }
  const profile = await readProfile(interaction, env);
  if (action === "set") {
    const options = optionsObject(interaction);
    if (options.summoner !== undefined) options.summoner = parseRiotId(options.summoner).display;
    if (options.region !== undefined && !REGION_CHOICES.some(([, value]) => value === options.region)) throw new UserFacingError("Choose a supported region.");
    if (options.mode !== undefined && !MODE_CHOICES.some(({ value }) => value === options.mode)) throw new UserFacingError("Choose a supported mode.");
    if (options.timezone !== undefined) validateTimezone(options.timezone);
    Object.assign(profile, options);
    await saveProfile(interaction, env, profile);
  }
  return featureMessage("", [{ title: "Your LeagueStats defaults", description: [
    `Account: ${profile.summoner ?? "Not set — use /profile set summoner:..."}`,
    `Region: ${(profile.region ?? "na").toUpperCase()}`,
    `Mode: ${profile.mode ? queueName(profile.mode) : "All modes"}`,
    `Lookups: ${profile.private ? "Only you" : "Visible in channel"}`,
    `Session time zone: ${profile.timezone ?? "America/New_York"}`,
    "Explicit command options override these defaults. This does not enroll an account in the monitor.",
  ].join("\n") }]);
}

export function startOfDay(now, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: validateTimezone(timezone), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (at) => Object.fromEntries(formatter.formatToParts(new Date(at)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const day = parts(now);
  const midnight = Date.UTC(day.year, day.month - 1, day.day);
  let estimate = midnight;
  for (let i = 0; i < 3; i++) {
    const p = parts(estimate);
    const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    estimate += midnight - local;
  }
  return estimate;
}

export function observedLp(history, currentEntries, since) {
  const lines = [];
  for (const current of currentEntries ?? []) {
    const first = history?.find((point) => Date.parse(point.at) >= since && point.entries?.[current.queueType]);
    const old = first?.entries[current.queueType];
    if (!old || current.wins < old.wins || current.losses < old.losses || !Number.isFinite(old.leaguePoints) || !Number.isFinite(current.leaguePoints) || rankScore(old) === null || rankScore(current) === null) continue;
    const points = (rank) => Math.min(28, rankScore(rank)) * 100 + rank.leaguePoints;
    const delta = points(current) - points(old);
    lines.push(`${current.queueType === "RANKED_SOLO_5x5" ? "Solo/Duo" : "Flex"}: ${delta >= 0 ? "+" : ""}${delta} LP since <t:${Math.floor(Date.parse(first.at) / 1000)}:t>`);
  }
  return lines.join("\n") || "No same-day tracked rank baseline yet. LP history is recorded going forward, not reconstructed.";
}

export async function buildSessionResponse(interaction, env, snapshot = {}) {
  const options = optionsObject(interaction);
  const timezone = validateTimezone(options.timezone ?? "America/New_York");
  snapshot.startTime ??= Math.floor(startOfDay(Date.now(), timezone) / 1000);
  snapshot.endTime ??= Math.floor(Date.now() / 1000);
  const base = await buildStatsResponse(interaction, env, snapshot);
  const stats = aggregateMatches(snapshot.matches, snapshot.account.puuid, 1);
  let lp = "No tracked rank history available.";
  if (env.MONITOR_DB) {
    const state = await readState(env.MONITOR_DB);
    const tracker = trackerEntries(state).find(({ tracker }) => tracker.summoner.puuid === snapshot.account.puuid)?.tracker;
    lp = observedLp(tracker?.rank_history, snapshot.rankedEntries, snapshot.startTime * 1000);
  }
  const champions = new Map();
  for (const row of stats.rows) {
    const champion = champions.get(row.champion) ?? { name: row.champion, wins: 0, games: 0 };
    champion.games++; champion.wins += Number(row.win); champions.set(row.champion, champion);
  }
  const best = [...champions.values()].sort((a, b) => b.wins - a.wins || b.games - a.games)[0];
  const minutes = Math.floor(stats.rows.reduce((sum, row) => sum + row.duration, 0) / 60);
  return featureMessage("", [{ ...base.embeds[0], title: `${snapshot.account.gameName}#${snapshot.account.tagLine} — today's session`,
    description: stats.games ? `**${stats.wins}W–${stats.losses}L • ${stats.winRate.toFixed(1)}% win rate**\n${Math.floor(minutes / 60)}h ${minutes % 60}m played across ${stats.games} games.` : "No completed games started today in this mode.",
    fields: [
      { name: "Best champion (most wins)", value: best ? `${best.name}: ${best.wins}W–${best.games - best.wins}L` : "No games yet" },
      { name: "Performance", value: `${stats.kda.toFixed(2)} KDA • ${stats.csPerMinute.toFixed(1)} CS/min` },
      { name: "Observed LP change", value: lp },
    ],
    footer: { text: `${timezone} • Games started since local midnight • ${snapshot.more ? `Newest ${snapshot.matches.length} games; load more for older games today` : "All games returned for today"}` },
  }]);
}

export function cardComponents(view) {
  const button = (label, action, disabled = false) => ({ type: 2, style: 2, label, custom_id: `ls:${view.id}:${action}`, disabled });
  const count = Number(view.query.count ?? 5);
  const limited = view.snapshot.matches.length >= MAX_HISTORY;
  if (view.kind === "recent") return [{ type: 1, components: [
    button("Previous", "previous", !view.snapshot.page),
    button("Next", "next", limited && (view.snapshot.page + 1) * count >= view.snapshot.matches.length || !view.snapshot.more && (view.snapshot.page + 1) * count >= view.snapshot.matches.length),
    button("Stats", "stats"), button("Refresh", "refresh"),
  ] }];
  const components = [{ type: 1, components: view.kind === "stats" ? [
    button("7 days", "days7"), button("30 days", "days30"), button("Recent games", "recent"),
    button("Load 30 more", "more", !view.snapshot.more || limited), button("Refresh", "refresh"),
  ] : [button("Load 30 more", "more", !view.snapshot.more || limited), button("Refresh", "refresh")] }];
  if (view.kind === "stats") components.push({ type: 1, components: [button("Choose champion", "champion"), button("All champions", "all", !view.query.champion)] });
  return components;
}

async function renderView(view, env) {
  const interaction = viewInteraction(view);
  const payload = await (view.kind === "recent" ? buildRecentResponse : view.kind === "session" ? buildSessionResponse : buildStatsResponse)(interaction, env, view.snapshot);
  payload.components = cardComponents(view);
  if (view.snapshot.more && view.snapshot.matches.length >= MAX_HISTORY) payload.content = "History limit reached: 300 games in this view. Narrow the date range or mode for a more focused sample.";
  return payload;
}

export async function createLookup(interaction, env) {
  const query = optionsObject(interaction);
  if (!query.summoner) throw new UserFacingError("Choose a summoner, or save one with `/profile set summoner:...` first.");
  const view = { id: crypto.randomUUID(), kind: interaction.data.name, owner: userId(interaction), guild: interaction.guild_id, channel: interaction.channel_id,
    query, snapshot: { page: 0 }, expires: Date.now() + VIEW_TTL };
  const payload = await renderView(view, env);
  await writeRecord(env.MONITOR_DB, `view:${view.id}`, view, view.expires);
  return payload;
}

export async function resolveView(interaction, env) {
  const [, id, action] = String(interaction.data.custom_id).split(":");
  if (!/^[0-9a-f-]{36}$/.test(id ?? "") || !["previous", "next", "stats", "refresh", "days7", "days30", "recent", "more", "champion", "all", "choose"].includes(action)) throw new UserFacingError("This control is not supported.");
  const view = await readRecord(env.MONITOR_DB, `view:${id}`);
  if (!view) throw new UserFacingError("This card expired after an hour. Run the command again for a fresh card.");
  if (view.owner !== userId(interaction) || view.guild !== interaction.guild_id || view.channel !== interaction.channel_id) throw new UserFacingError("Only the person who requested this card can change it. Run your own `/stats` or `/recent`.");
  return { view, action };
}

export function championModal(view) {
  return { type: 9, data: { title: "Choose champion", custom_id: `ls:${view.id}:choose`, components: [{ type: 1, components: [{
    type: 4, custom_id: "champion", label: "Champion name (blank for all)", style: 1, required: false, max_length: 100, value: view.query.champion ?? "",
  }] }] } };
}

export async function updateLookup(interaction, env) {
  const { view, action } = await resolveView(interaction, env);
  const owner = crypto.randomUUID();
  const key = `view:${view.id}`;
  if (!await leaseRecord(env.MONITOR_DB, key, owner)) throw new UserFacingError("This card is already updating. Try again in a moment.");
  try {
    // Re-read inside the lease so concurrent clicks cannot rewind loaded history.
    const fresh = await readRecord(env.MONITOR_DB, key);
    if (!fresh) throw new UserFacingError("This card has expired. Run the command again.");
    Object.assign(view, fresh);
    if (action === "more" && view.snapshot.more && view.snapshot.matches.length < MAX_HISTORY) await loadMoreMatches(viewInteraction(view), env, view.snapshot, Math.min(30, MAX_HISTORY - view.snapshot.matches.length));
    if (action === "next") {
      const count = Number(view.query.count ?? 5);
      const next = (view.snapshot.page + 1) * count;
      if (next >= view.snapshot.matches.length && view.snapshot.more && view.snapshot.matches.length < MAX_HISTORY) await loadMoreMatches(viewInteraction(view), env, view.snapshot, Math.min(count, MAX_HISTORY - view.snapshot.matches.length));
      if (next < view.snapshot.matches.length) view.snapshot.page++;
    }
    if (action === "previous") view.snapshot.page = Math.max(0, view.snapshot.page - 1);
    if (["stats", "recent", "days7", "days30", "refresh"].includes(action)) {
      if (["stats", "recent"].includes(action)) view.kind = action;
      if (action.startsWith("days")) { view.kind = "stats"; view.query.days = Number(action.slice(4)); }
      view.snapshot = { page: 0 };
    }
    if (action === "all") delete view.query.champion;
    if (action === "choose") {
      const value = interaction.data.components?.flatMap((row) => row.components ?? []).find((field) => field.custom_id === "champion")?.value?.trim();
      if (value) view.query.champion = value; else delete view.query.champion;
    }
    const payload = await renderView(view, env);
    await writeRecord(env.MONITOR_DB, key, view, view.expires);
    return payload;
  } finally { await releaseRecord(env.MONITOR_DB, key, owner); }
}
