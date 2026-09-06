const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];
const DIVISIONS = ["IV", "III", "II", "I"];
const RANK_QUEUES = { RANKED_SOLO_5x5: "Ranked Solo/Duo", RANKED_FLEX_SR: "Ranked Flex" };
export const RANK_POLL_MS = 5 * 60 * 1000;

export function rankScore(rank) {
  const tier = TIERS.indexOf(rank?.tier);
  const division = DIVISIONS.indexOf(rank?.rank);
  return tier < 0 || (tier < 7 && division < 0) ? null : tier * 4 + (tier >= 7 ? 0 : division);
}

export function rankLabel(rank) {
  return `${rank.tier}${TIERS.indexOf(rank.tier) >= 7 ? "" : ` ${rank.rank}`} • ${rank.leaguePoints} LP`;
}

// Mutate only the monitor's working copy. Delivery must succeed before it is saved.
export function observeRanks(tracker, entries, detectionIso) {
  if (!Array.isArray(entries)) throw new Error("Riot ranked entries are invalid");
  const previous = tracker.rank_snapshot;
  const gap = Date.parse(detectionIso) - Date.parse(tracker.rank_checked_at ?? "");
  const current = {};
  const alerts = [];
  for (const entry of entries) {
    const queue = RANK_QUEUES[entry.queueType];
    if (!queue) continue;
    if (rankScore(entry) === null || ![entry.wins, entry.losses, entry.leaguePoints].every(Number.isFinite)) {
      throw new Error("Riot ranked entry is incomplete");
    }
    const next = Object.fromEntries(["tier", "rank", "leaguePoints", "wins", "losses"].map((key) => [key, entry[key]]));
    current[entry.queueType] = next;
    const old = previous?.[entry.queueType];
    // Initial placement, a long observation gap, and season-reset counters establish a baseline.
    if (!old || !Number.isFinite(gap) || gap > 48 * 60 * 60 * 1000 || gap < 0 ||
        next.wins < old.wins || next.losses < old.losses || rankScore(old) === null ||
        rankScore(next) >= rankScore(old)) continue;
    const key = `${entry.queueType}:${detectionIso}:${next.tier}:${next.rank}`;
    tracker.reported_rank_changes ??= {};
    if (tracker.reported_rank_changes[key]) continue;
    const record = {
      kind: "demotion", status: "completed", queue,
      from_rank: old, to_rank: next, detected_at: detectionIso,
      start_time: detectionIso, source: "riot-league-v4",
    };
    tracker.reported_rank_changes[key] = record;
    alerts.push(record);
  }
  tracker.rank_snapshot = current;
  tracker.rank_checked_at = detectionIso;
  return alerts;
}
