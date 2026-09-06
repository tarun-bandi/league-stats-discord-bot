import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function testDb(state) {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of ["0001_monitor_state.sql", "0002_bot_records.sql"]) sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
  if (state) sqlite.prepare("INSERT INTO monitor_state(state_key,state_json,updated_at) VALUES(?,?,?)").run("league-game-monitor", JSON.stringify(state), new Date().toISOString());
  return { sqlite, queries: 0, prepare(sql) {
    const db = this;
    return { bind(...args) { return {
      async first() { db.queries++; return sqlite.prepare(sql).get(...args) ?? null; },
      async run() { db.queries++; const result = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
    }; } };
  } };
}

export const tracker = (name = "Test", extra = {}) => ({ summoner: { riot_id: `${name}#NA1`, puuid: name, riot_account_checked_at: new Date().toISOString() }, baseline: {}, newest_completed_match: { id: "NA1_100", started_at: "2026-09-01T00:00:00Z" }, riot_newest_completed_match_id: "NA1_100", reported_games: {}, ...extra });
export const stateFixture = () => ({ ...tracker(), additional_summoners: { b: tracker("Other"), c: tracker("Third") } });
export const interaction = (name, options = {}, extra = {}) => ({ type: 2, id: "1000", application_id: "123", token: "test-interaction-token", guild_id: "456", channel_id: "789", member: { user: { id: "111" }, permissions: "32" }, data: { name, options: Object.entries(options).map(([name, value]) => ({ name, value })) }, ...extra });
export const subcommand = (name, action, options = {}, extra = {}) => {
  const command = interaction(name, {}, extra);
  command.data.options = [{ type: 1, name: action, options: Object.entries(options).map(([name, value]) => ({ name, value })) }];
  return command;
};
export const envFixture = (db) => ({ MONITOR_DB: db, DISCORD_BOT_TOKEN: "test-bot-token", RIOT_API_KEY: "fixture", DISCORD_APPLICATION_ID: "123", DISCORD_GUILD_ID: "456", DISCORD_ALERT_CHANNEL_ID: "789", MONITOR_ENABLED: "true" });

export const game = (id, champion = "Zed", puuid = "Test", win = true, timestamp = Date.now() - 3600_000) => ({ metadata: { matchId: `NA1_${id}` }, info: { gameStartTimestamp: timestamp, gameDuration: 1800, queueId: 420, participants: [
  { puuid, championName: champion, championId: champion === "Zed" ? 238 : 31, win, kills: 8, deaths: 4, assists: 8, totalMinionsKilled: 180, totalDamageDealtToChampions: 24000, goldEarned: 12000, visionScore: 20 },
] } });

export function mockLookup(t, games, { onRequest = () => {}, ranked = [] } = {}) {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input); onRequest(url, init);
    if (url.hostname === "discord.com") return Response.json({ id: "999" });
    if (url.pathname.includes("/realms/")) return Response.json({ v: "16.17.1" });
    if (url.pathname.endsWith("champion.json")) return Response.json({ data: { Zed: { key: "238", id: "Zed", name: "Zed" }, Chogath: { key: "31", id: "Chogath", name: "Cho'Gath" } } });
    if (url.pathname.includes("accounts/by-riot-id")) return Response.json({ puuid: "Test", gameName: "Test", tagLine: "NA1" });
    if (url.pathname.includes("league/v4")) return Response.json(ranked);
    if (url.pathname.endsWith("/ids")) {
      const start = Number(url.searchParams.get("start") ?? 0); const count = Number(url.searchParams.get("count"));
      const startTime = Number(url.searchParams.get("startTime") ?? 0);
      return Response.json(games.filter((match) => match.info.gameStartTimestamp >= startTime * 1000).slice(start, start + count).map((match) => match.metadata.matchId));
    }
    const match = games.find((match) => url.pathname.endsWith(`/${match.metadata.matchId}`));
    if (!match) throw new Error(`Unexpected request: ${url.pathname}`);
    return Response.json(match);
  });
}
