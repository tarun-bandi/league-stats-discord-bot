import { opggUrl } from "./opgg.js";
import { readState, trackerEntries } from "./monitor.js";
import { optionsObject } from "./preferences.js";
import { assertRecapGuild } from "./recap.js";
import { rankScore, rankLabel } from "./ranks.js";
import { UserFacingError } from "./errors.js";
import { parseRiotId } from "./index.js";
import { featureMessage } from "./features.js";
import { renderLpChart } from "./lp-chart.js";

const HOUR = 3600_000;
export const GRAPH_QUEUES = { solo: 'RANKED_SOLO_5x5', flex: 'RANKED_FLEX_SR' };
const LABELS = { solo: 'Solo/Duo', flex: 'Flex' };
const normalized = (s) => String(s).trim().toLowerCase();
const timestamp = (at) => `<t:${Math.floor(at / 1000)}:f>`;
const safe = (s) => String(s).replace(/[\\`*_~|<>@]/g, '');
const progress = (rank) => rankScore(rank) === null || ![rank?.leaguePoints, rank?.wins, rank?.losses].every((v) => Number.isFinite(v) && v >= 0)
  ? null : Math.min(28, rankScore(rank)) * 100 + rank.leaguePoints;

export function lpSeries(tracker, queue, start, end) {
  const history = [...(tracker.rank_history ?? [])].filter((p) => Number.isFinite(Date.parse(p.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const boundaries = [tracker.monitor_started_at, ...(tracker.baseline_history ?? []).map((b) => b.at)].map(Date.parse).filter(Number.isFinite);
  const segments = [], points = []; let previous = null, segment = null;
  for (const entry of history) {
    const at = Date.parse(entry.at);
    if (at < start || at > end) continue;
    const rank = entry.entries?.[queue], score = progress(rank);
    if (score === null) { previous = null; segment = null; continue; }
    const next = { at, rank, score };
    if (previous?.at === at) {
      // Conflicting observations at one instant are not ordered evidence.
      if (JSON.stringify(previous.rank) !== JSON.stringify(rank)) { previous = null; segment = null; }
      continue;
    }
    const broken = !previous || at - previous.at > 2 * HOUR || rank.wins < previous.rank.wins || rank.losses < previous.rank.losses || boundaries.some((b) => b > previous.at && b <= at);
    if (broken) { segment = []; segments.push(segment); }
    segment.push(next); points.push(next); previous = next;
  }
  const first = points[0], last = points.at(-1);
  const peak = points.reduce((best, p) => !best || p.score > best.score || p.score === best.score && rankScore(p.rank) > rankScore(best.rank) ? p : best, null);
  return { points, segments, first, last, peak,
    delta: points.length >= 2 && segments.length === 1 ? last.score - first.score : null,
    partial: !first || first.at > start + HOUR || last.at < end - HOUR || segments.length > 1 };
}

export async function lpGraphCommand(interaction, env, now = Date.now()) {
  assertRecapGuild(interaction, env);
  const query = optionsObject(interaction), days = Number(query.days ?? 7), selected = query.queue ?? 'both';
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new UserFacingError('Choose 1–30 days.');
  if (!['both', 'solo', 'flex'].includes(selected)) throw new UserFacingError('Choose Solo/Duo, Flex or both queues.');
  const id = parseRiotId(query.summoner).display;
  const state = await readState(env.MONITOR_DB);
  const tracker = trackerEntries(state).find(({ tracker: t }) => normalized(t.summoner.riot_id) === normalized(id))?.tracker;
  if (!tracker) throw new UserFacingError('No saved rank history for that account. An admin can enroll it with /track add; earlier LP cannot be reconstructed from match results.');
  const start = now - days * 24 * HOUR, embeds = [], files = [];
  for (const kind of selected === 'both' ? ['solo', 'flex'] : [selected]) {
    const series = lpSeries(tracker, GRAPH_QUEUES[kind], start, now);
    const description = [
      `Requested: ${timestamp(start)} → ${timestamp(now)}`,
      series.first ? `Observed: ${timestamp(series.first.at)} → ${timestamp(series.last.at)} • ${series.points.length} observations` : 'No saved ranked observations in this period.',
      series.delta === null ? 'Net LP: unavailable (insufficient or interrupted history).' : `Observed net LP: **${series.delta >= 0 ? '+' : ''}${series.delta}**`,
      series.peak ? `Highest observed: **${rankLabel(series.peak.rank)}**\nLast observed: **${rankLabel(series.last.rank)}**` : '',
      series.partial ? '**Partial coverage** — missing dates are not backfilled.' : '',
      series.partial ? `Older snapshots may be available on [OP.GG](${opggUrl(tracker.summoner.riot_id, 'na')}); automatic LP backfill is not available.` : '',
      tracker.removed_at ? 'Archived tracker; no new observations.' : tracker.monitor_paused ? 'Tracking is paused.' : '',
    ].filter(Boolean).join('\n');
    const embed = { title: `${safe(tracker.summoner.riot_id)} — ${LABELS[kind]} LP`, description,
      footer: { text: 'Source: saved Riot rank observations. UTC dates. Breaks mark gaps over 2h, unranked periods, resets or resumed tracking. Master+ shares one LP scale. No historical LP is inferred from match outcomes.' } };
    if (series.points.length) {
      const filename = `lp-${kind}.png`;
      const data = await renderLpChart(series, start, now, LABELS[kind], kind === 'solo' ? [83, 191, 242] : [177, 147, 255]);
      embed.image = { url: `attachment://${filename}` };
      files.push({ filename, data });
    }
    embeds.push(embed);
  }
  return { ...featureMessage('', embeds), files };
}

// Discord supports file attachments when editing an interaction response.
// Keep binary data out of payload_json and let FormData set its own boundary.
export function responseBody(payload) {
  const { files, ...data } = payload;
  if (!files?.length) return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...data, attachments: files.map((file, id) => ({ id, filename: file.filename })) }));
  files.forEach((file, id) => form.append(`files[${id}]`, new Blob([file.data], { type: 'image/png' }), file.filename));
  return { body: form };
}
