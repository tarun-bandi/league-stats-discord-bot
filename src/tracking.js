import { acquireLease, releaseLease, readState, saveState, trackerEntries, validateMonitorState, resolveTrackedAccount } from "./monitor.js";
import { optionsObject } from "./preferences.js";
import { parseRiotId, UserFacingError } from "./index.js";

const normalize = (value) => String(value).trim().toLowerCase();
export function assertMonitorAdmin(interaction, env) {
  let permissions = 0n;
  try { permissions = BigInt(interaction.member?.permissions ?? "0"); } catch { /* Deny malformed permissions. */ }
  if (!(permissions & (8n | 32n))) throw new UserFacingError("Manage Server or Administrator permission is required.");
  if (!env.DISCORD_GUILD_ID || interaction.guild_id !== env.DISCORD_GUILD_ID) throw new UserFacingError("Tracking controls are only available in the configured alerts server.");
}

async function riot(env, path) {
  const response = await fetch(path, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
  if ([401, 403].includes(response.status)) throw new UserFacingError("The Riot credential is invalid or expired. Tracking was not changed.");
  if (!response.ok) throw new UserFacingError(`Riot request failed (${response.status}); tracking was not changed.`);
  return response.json();
}

async function freshBaseline(env, tracker, now) {
  const ids = await riot(env, `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(tracker.summoner.puuid)}/ids?start=0&count=1`);
  if (!Array.isArray(ids)) throw new Error("Invalid match baseline");
  const previous = tracker.newest_completed_match;
  if (ids[0]) {
    const match = await riot(env, `https://americas.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(ids[0])}`);
    if (!match.info?.participants?.some((p) => p.puuid === tracker.summoner.puuid)) throw new Error("Cannot verify baseline account");
    tracker.newest_completed_match = { id: ids[0], started_at: new Date(match.info.gameStartTimestamp).toISOString(), source: "riot" };
  } else tracker.newest_completed_match = null;
  tracker.riot_newest_completed_match_id = ids[0] ?? null;
  tracker.baseline_history ??= [];
  tracker.baseline_history.push({ at: now, previous_cursor: previous, cursor: tracker.newest_completed_match });
  tracker.baseline = { ...(tracker.baseline ?? {}), initialized_at: now, cutoff: tracker.newest_completed_match };
  tracker.riot_cursor_initialized_at = now;
  tracker.monitor_started_at = now;
  tracker.newest_live_game_id = null;
  tracker.monitor_paused = false;
  delete tracker.removed_at;
  // A resumed player's old rank must not produce an old demotion alert.
  delete tracker.rank_checked_at;
  delete tracker.rank_snapshot;
}

export async function trackingCommand(interaction, env) {
  assertMonitorAdmin(interaction, env);
  const action = interaction.data.options?.[0]?.name;
  const options = optionsObject(interaction);
  const owner = crypto.randomUUID();
  const now = new Date().toISOString();
  if (!await acquireLease(env.MONITOR_DB, Date.now(), owner)) throw new UserFacingError("The monitor is checking games. Try again in a few seconds.");
  try {
    const state = await readState(env.MONITOR_DB);
    const entries = trackerEntries(state);
    if (action === "list") return `Tracking roster (${entries.length} saved; up to 10 active):\n${entries.slice(0, 25).map(({ tracker }) => `${tracker.summoner.riot_id} — ${tracker.removed_at ? "archived" : tracker.monitor_paused ? "paused" : "active"}`).join("\n")}\nAlerts: ${state.alert_mode === "completed" ? "completed only" : "live + completed"}. Archived history is retained.`;
    state.roster_version = 2;
    let result;
    if (action === "alerts") {
      if (!["all", "completed"].includes(options.mode)) throw new UserFacingError("Choose a supported alert mode.");
      state.alert_mode = options.mode;
      result = `Alert mode is now ${options.mode === "all" ? "live + completed" : "completed only"}. Existing live messages will still receive completion edits.`;
    } else if (action === "notifications") {
      if (!/^\d+$/.test(String(options.owner ?? ""))) throw new UserFacingError("Select a notification recipient.");
      state.health_notification_owner = String(options.owner);
      result = "Credential failure/recovery notifications will be sent privately to the selected user. No mentions are generated.";
    } else {
      const riotId = parseRiotId(options.summoner);
      let entry = entries.find(({ tracker }) => normalize(tracker.summoner.riot_id) === normalize(riotId.display));
      if (["add", "resume"].includes(action) && (!entry || entry.tracker.monitor_paused || entry.tracker.removed_at) && entries.filter(({ tracker }) => !tracker.monitor_paused && !tracker.removed_at).length >= 10) throw new UserFacingError("Ten accounts are already active. Pause or archive one before enabling another.");
      if (action === "add") {
        const account = await riot(env, `https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotId.gameName)}/${encodeURIComponent(riotId.tagLine)}`);
        if (!account.puuid || !account.gameName || !account.tagLine) throw new Error("Incomplete Riot identity");
        entry ??= entries.find(({ tracker }) => tracker.summoner.puuid === account.puuid);
        if (entry && !entry.tracker.removed_at) throw new UserFacingError("That account is already tracked. Use /track resume if it is paused.");
        if (entry && entry.tracker.summoner.puuid !== account.puuid) throw new UserFacingError("That Riot ID belongs to a different account than its saved tracker; no history was changed.");
        const tracker = entry?.tracker ?? { summoner: {}, baseline: {}, newest_completed_match: null, reported_games: {}, initialized_at: now };
        Object.assign(tracker.summoner, { riot_id: `${account.gameName}#${account.tagLine}`, puuid: account.puuid, riot_account_checked_at: now });
        await freshBaseline(env, tracker, now);
        if (!entry) state.additional_summoners[`na:${crypto.randomUUID()}`] = tracker;
        result = `Now tracking ${tracker.summoner.riot_id} from this point forward. Existing completed games will not be announced.`;
      } else {
        if (!entry) throw new UserFacingError("That account is not in the saved roster. Use /track list.");
        if (action === "pause" || action === "remove") {
          entry.tracker.monitor_paused = true;
          if (action === "remove") entry.tracker.removed_at = now;
          result = `${entry.tracker.summoner.riot_id} is ${action === "remove" ? "archived" : "paused"}. History is retained and existing live alerts will finish.`;
        } else if (action === "resume") {
          if (!entry.tracker.monitor_paused && !entry.tracker.removed_at) throw new UserFacingError("That tracker is already active.");
          // Resolve by stable ID, never trust a reused Riot ID when resuming.
          await resolveTrackedAccount(env, entry.tracker, Date.now(), { force: true });
          await freshBaseline(env, entry.tracker, now);
          result = `Resumed ${entry.tracker.summoner.riot_id} from now. Games played while paused will not be replayed.`;
        } else throw new UserFacingError("Unknown tracking action.");
      }
    }
    validateMonitorState(state);
    await saveState(env.MONITOR_DB, owner, state, now);
    return result;
  } finally { await releaseLease(env.MONITOR_DB, owner); }
}
