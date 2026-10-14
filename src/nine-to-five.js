import { readState, trackerEntries, monitorEnabled } from "./monitor.js";
import { readRecord, writeRecord, leaseRecord, releaseRecord } from "./store.js";
import { brandedEmbed } from "./branding.js";
import { easternParts, shiftDate, workdayWindow, workdayCount, WORKDAY_ZONE } from "./workday.js";
import { optionsObject } from "./preferences.js";
import { UserFacingError } from "./index.js";

const JOB_KEY = "nine-to-five:schedule";
const dayKey = (date) => `nine-to-five:day:${date}`;
const escape = (value) => String(value).replace(/[\\`*_~|<>]/g, "\\$&").replace(/[\r\n]/g, " ").slice(0, 100);

export function workdayRows(state, date, now, savedRoster = []) {
  const { start, end } = workdayWindow(date);
  return trackerEntries(state).map(({ stateKey, tracker }) => {
    const count = workdayCount(tracker, date, now);
    const enrolled = Date.parse(tracker.monitor_started_at ?? tracker.initialized_at ?? "");
    const paused = Boolean(tracker.monitor_paused || tracker.removed_at);
    const checked = Date.parse(tracker.last_check_at ?? state.last_check_at ?? "");
    return {
      stateKey, riotId: tracker.summoner.riot_id, count,
      partial: paused || enrolled > start,
      delayed: !Number.isFinite(checked) || checked < Math.min(now, end) - 10 * 60_000,
      include: savedRoster.includes(stateKey) || count > 0 || (!paused && (!Number.isFinite(enrolled) || enrolled < end)),
    };
  }).filter((row) => row.include).sort((a, b) => b.count - a.count || a.riotId.localeCompare(b.riotId));
}

export function workdayPayload(rows, date, now) {
  const { start, end } = workdayWindow(date);
  const label = now < start ? "Window has not started" : now < end ? "So far today" : "Daily report";
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const lines = rows.slice(0, 25).map((row) => `**${escape(row.riotId)}** — **${row.count}** ${row.count === 1 ? "game" : "games"}${row.partial ? " · partial tracking" : ""}`);
  if (rows.length > 25) lines.push(`Plus ${rows.length - 25} other past trackers; included in the total.`);
  const notes = [
    "Counts games **starting at 9:00 AM through 4:59:59 PM** in America/New_York. All modes; live games count once.",
    "Uses monitored games since enrollment. Late data updates this report; unavailable Riot games cannot be counted.",
  ];
  if (rows.some((row) => row.partial)) notes.push("Partial tracking: added/resumed during the window, or paused/archived; unobserved games are excluded.");
  if (rows.some((row) => row.delayed)) notes.push("⚠️ Monitor data is delayed for some players; these counts may be incomplete.");
  return {
    content: "", allowed_mentions: { parse: [] },
    embeds: [brandedEmbed({
      title: `🕘 9–5 tracker — ${date}`,
      description: `**${label} · ${total} player-games**\n\n${lines.join("\n") || "No active tracked players."}\n\n${notes.join("\n")}`,
      footer: { text: "Every day after 5 PM Eastern • Public Riot data • No mentions" },
    })],
  };
}

export async function nineToFiveCommand(interaction, env, now = Date.now()) {
  if (!env.DISCORD_GUILD_ID || interaction.guild_id !== env.DISCORD_GUILD_ID) throw new UserFacingError("The 9–5 tracker is available in the configured alerts server.");
  const options = optionsObject(interaction);
  const state = await readState(env.MONITOR_DB);
  const date = easternParts(now).date;
  let rows = workdayRows(state, date, now);
  if (options.summoner) {
    rows = rows.filter((row) => row.riotId.toLowerCase() === String(options.summoner).trim().toLowerCase());
    if (!rows.length) throw new UserFacingError("That summoner is not in today's tracking roster. Choose a tracked account or omit summoner for everyone.");
  }
  return workdayPayload(rows, date, now);
}

export async function nineToFiveStatus(env) {
  const job = env.MONITOR_DB ? await readRecord(env.MONITOR_DB, JOB_KEY) : null;
  return {
    enabled: monitorEnabled(env), timeZone: WORKDAY_ZONE, window: "09:00–17:00",
    postAt: "17:00", everyDay: true, firstDate: job?.firstDate ?? null,
    nextDate: job?.nextDate ?? null, lastReportDate: job?.lastReportDate ?? null,
    lastSentAt: job?.lastSentAt ?? null, deliveryError: Boolean(job?.deliveryError),
  };
}

async function deliverDay(env, state, date, now, fetchImpl) {
  const saved = await readRecord(env.MONITOR_DB, dayKey(date)) ?? {
    channelId: String(env.DISCORD_ALERT_CHANNEL_ID), nonce: crypto.randomUUID().slice(0, 24),
  };
  if (!/^\d+$/.test(saved.channelId) || !env.DISCORD_BOT_TOKEN) throw new Error("9–5 Discord delivery is not configured");
  const rows = workdayRows(state, date, now, saved.roster);
  const payload = workdayPayload(rows, date, now);
  const signature = JSON.stringify(payload);
  if (saved.messageId && saved.signature === signature) return { changed: false, saved };
  // Persist the nonce before the first attempt. Discord deduplicates ambiguous
  // retries within its recent-nonce window; durable IDs handle later retries.
  if (!saved.messageId) await writeRecord(env.MONITOR_DB, dayKey(date), saved);
  const response = await fetchImpl(`https://discord.com/api/v10/channels/${saved.channelId}/messages${saved.messageId ? `/${saved.messageId}` : ""}`, {
    method: saved.messageId ? "PATCH" : "POST",
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, ...(!saved.messageId ? { nonce: saved.nonce, enforce_nonce: true } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`9–5 Discord delivery failed (${response.status})`);
  const message = await response.json();
  if (!/^\d+$/.test(String(message.id ?? ""))) throw new Error("9–5 delivery returned no message ID");
  Object.assign(saved, { messageId: String(message.id), signature, roster: rows.map((row) => row.stateKey), updatedAt: new Date(now).toISOString() });
  await writeRecord(env.MONITOR_DB, dayKey(date), saved);
  return { changed: true, saved };
}

export async function runNineToFive(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (!monitorEnabled(env)) return { status: "disabled" };
  // A report must never fabricate zeroes from missing/corrupt monitor history.
  const state = await readState(env.MONITOR_DB);
  const local = easternParts(now);
  const dueDate = local.hour >= 17 ? local.date : shiftDate(local.date, -1);
  const initial = { firstDate: local.date, nextDate: local.date, reconcileOffset: 0 };
  await env.MONITOR_DB.prepare("INSERT INTO bot_records(record_key,payload) VALUES(?1,?2) ON CONFLICT(record_key) DO NOTHING").bind(JOB_KEY, JSON.stringify(initial)).run();
  const owner = crypto.randomUUID();
  if (!await leaseRecord(env.MONITOR_DB, JOB_KEY, owner)) return { status: "busy" };
  try {
    const job = await readRecord(env.MONITOR_DB, JOB_KEY);
    try {
      let changed = 0;
      // One overdue report per tick: recover missed days without a channel burst.
      if (job.nextDate <= dueDate) {
        const result = await deliverDay(env, state, job.nextDate, now, fetchImpl);
        changed += Number(result.changed);
        job.lastReportDate = job.nextDate;
        job.lastSentAt = result.saved.updatedAt;
        job.nextDate = shiftDate(job.nextDate, 1);
        await writeRecord(env.MONITOR_DB, JOB_KEY, job);
      }
      // Round-robin the last seven posted days to incorporate delayed results.
      // At most two Discord requests, independent of the Riot monitor's budget.
      if (job.lastReportDate) {
        const date = shiftDate(job.lastReportDate, -(job.reconcileOffset ?? 0));
        if (date >= job.firstDate) changed += Number((await deliverDay(env, state, date, now, fetchImpl)).changed);
        job.reconcileOffset = ((job.reconcileOffset ?? 0) + 1) % 7;
      }
      delete job.deliveryError;
      await writeRecord(env.MONITOR_DB, JOB_KEY, job);
      return { status: "ok", changed };
    } catch (error) {
      job.deliveryError = true;
      await writeRecord(env.MONITOR_DB, JOB_KEY, job);
      throw error;
    }
  } finally { await releaseRecord(env.MONITOR_DB, JOB_KEY, owner); }
}
