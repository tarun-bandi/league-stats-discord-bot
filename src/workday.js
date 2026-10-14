// Calendar dates and boundaries are Eastern, not fixed UTC offsets (DST matters).
export const WORKDAY_ZONE = "America/New_York";
const clock = new Intl.DateTimeFormat("en-CA", {
  timeZone: WORKDAY_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function easternParts(now) {
  const parts = Object.fromEntries(clock.formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function workdayWindow(date) {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) throw new Error("Invalid workday date");
  const atHour = (hour) => {
    const target = midnight + hour * 3600_000;
    let utc = target;
    for (let i = 0; i < 2; i++) {
      const parts = Object.fromEntries(clock.formatToParts(new Date(utc)).map(({ type, value }) => [type, value]));
      const wall = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
      utc += target - wall;
    }
    return utc;
  };
  return { start: atHour(9), end: atHour(17) };
}

const gameId = (game, fallback) => String(game.riot_game_id ?? game.live_game_id ?? game.match_id ?? fallback).replace(/^(?:NA1_|live:)/i, "");

// Retain live observations even in completed-only alert mode. They are counts,
// not alert records: no message IDs/cursors are changed and no extra Riot calls.
export function rememberWorkdayGame(tracker, game, now) {
  if (!game) return;
  const start = Date.parse(game.start_time);
  if (!Number.isFinite(start)) return;
  const local = easternParts(start);
  tracker.nine_to_five_games ??= {};
  const id = gameId(game, game.start_time);
  if (local.hour >= 9 && local.hour < 17) {
    tracker.nine_to_five_games[id] = {
      riot_game_id: id, start_time: game.start_time, status: game.status,
    };
  } else delete tracker.nine_to_five_games[id];
  for (const [key, record] of Object.entries(tracker.nine_to_five_games)) {
    if (Date.parse(record.start_time) < now - 14 * 86400_000) delete tracker.nine_to_five_games[key];
  }
}

export function workdayCount(tracker, date, now) {
  const { start, end } = workdayWindow(date);
  const games = new Map();
  // Completed records override their live snapshots, including corrected starts.
  for (const source of [tracker.nine_to_five_games ?? {}, tracker.reported_games]) {
    for (const [key, game] of Object.entries(source)) {
      if (!["live", "completed"].includes(game.status) || game.kind) continue;
      games.set(gameId(game, key), game);
    }
  }
  return [...games.values()].filter((game) => {
    const timestamp = Date.parse(game.start_time);
    return timestamp >= start && timestamp < end && timestamp <= now;
  }).length;
}
