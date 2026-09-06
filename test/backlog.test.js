import test from "node:test";
import assert from "node:assert/strict";
import { observeRanks, rankScore } from "../src/ranks.js";
import { queueName, matchMetrics, metricsSummary, MODE_CHOICES } from "../src/league.js";
import { buildStatsResponse, buildRecentResponse } from "../src/index.js";
import { completedGame, commitMonitorChanges, monitorPayload, runLeagueMonitor, reconcilePendingLiveGames } from "../src/monitor.js";
import { syncDiscordApplication } from "../src/application.js";
import { catalogFromData, championInfo, championThumbnail, getChampionCatalog } from "../src/champions.js";

const at = "2026-09-05T22:00:00Z";
const later = "2026-09-05T22:05:00Z";
const ranked = (rank = "II", other = {}) => ({ queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank, wins: 20, losses: 20, leaguePoints: 30, ...other });
const baseline = () => { const tracker = {}; observeRanks(tracker, [ranked()], at); return tracker; };

test("rank baseline is silent; a division drop emits one durable demotion", () => {
  const tracker = baseline();
  assert.equal(tracker.reported_rank_changes, undefined);
  const alerts = observeRanks(tracker, [ranked("III", { losses: 21 })], later);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].from_rank.rank, "II");
  assert.equal(alerts[0].to_rank.rank, "III");
  assert.equal(alerts[0].kind, "demotion");
  assert.equal(observeRanks(tracker, [ranked("III", { losses: 21 })], later).length, 0);
  assert.equal(Object.keys(tracker.reported_rank_changes).length, 1);
});

test("LP losses, promotions, placement, counter resets and stale baselines are silent", () => {
  for (const [entry, time] of [
    [ranked("II", { leaguePoints: 0 }), later],
    [ranked("I"), later],
    [ranked("III", { wins: 0, losses: 1 }), later],
    [ranked("III"), "2026-09-09T00:00:00Z"],
  ]) assert.deepEqual(observeRanks(baseline(), [entry], time), []);
  const tracker = baseline();
  assert.deepEqual(observeRanks(tracker, [], later), []);
  assert.deepEqual(observeRanks(tracker, [ranked("III")], "2026-09-05T22:10:00Z"), []);
});

test("tiers include Emerald and apex; Flex and Solo remain independent", () => {
  assert.ok(rankScore(ranked("IV", { tier: "EMERALD" })) > rankScore(ranked("I", { tier: "PLATINUM" })));
  assert.ok(rankScore(ranked("I", { tier: "MASTER" })) > rankScore(ranked("I", { tier: "DIAMOND" })));
  const tracker = {};
  observeRanks(tracker, [ranked("IV"), ranked("II", { queueType: "RANKED_FLEX_SR" })], at);
  const alerts = observeRanks(tracker, [ranked("I", { tier: "SILVER" }), ranked("III", { queueType: "RANKED_FLEX_SR" })], later);
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((r) => r.queue), ["Ranked Solo/Duo", "Ranked Flex"]);
  assert.throws(() => observeRanks(tracker, [{ ...ranked(), tier: "UNKNOWN" }], later), /incomplete/);
});

test("Mayhem, Swiftplay and new modes have explicit names; unknown IDs remain visible", () => {
  assert.equal(queueName(2400, "KIWI"), "ARAM Mayhem");
  assert.equal(queueName(480), "Swiftplay");
  assert.match(queueName(9876, "NEW_MODE"), /NEW_MODE \(queue 9876\)/);
  assert.ok(MODE_CHOICES.some((m) => m.value === 2400));
});

test("match metrics distinguish missing data from real zero values", () => {
  assert.equal(matchMetrics({}, 1800).vision, null);
  assert.equal(matchMetrics({ visionScore: 0 }, 1800).vision, 0);
  assert.equal(matchMetrics({ totalMinionsKilled: 150 }, 0).cs_per_minute, null);
  const metrics = matchMetrics({ kills: 5, deaths: 0, assists: 10, totalDamageDealtToChampions: 30000, totalMinionsKilled: 180, visionScore: 12, pentaKills: 1, placement: 2 }, 1800);
  assert.equal(metrics.damage_per_minute, 1000);
  assert.match(metricsSummary(metrics), /6.0 CS\/min.*30.0k damage.*12 vision.*Placement #2.*1 pentakill/);
});

test("stats/recent send mode filter to Riot before applying the match cap", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input); urls.push(url);
    return Response.json(url.includes("accounts/by-riot-id") ? { puuid: "test", gameName: "Test", tagLine: "NA1" } : []);
  });
  const interaction = { data: { options: [{ name: "summoner", value: "Test#NA1" }, { name: "mode", value: 2400 }] } };
  for (const build of [buildStatsResponse, buildRecentResponse]) {
    const payload = await build(interaction, { RIOT_API_KEY: "fixture" });
    assert.match(payload.embeds[0].description, /Riot may omit completed matches/);
    assert.equal(payload.embeds[0].author.name, "LeagueStats");
    assert.deepEqual(payload.allowed_mentions.parse, []);
  }
  assert.equal(urls.filter((url) => url.includes("/ids?")).length, 2);
  assert.ok(urls.filter((url) => url.includes("/ids?")).every((url) => new URL(url).searchParams.get("queue") === "2400"));
});

test("demotion and game records survive grouped message rebuild and ID persistence", async () => {
  const rankTracker = baseline();
  const record = observeRanks(rankTracker, [ranked("III")], later)[0];
  const game = completedGame({ metadata: { matchId: "NA1_1" }, info: { gameStartTimestamp: Date.parse(at), gameDuration: 1800, queueId: 2400, participants: [{ puuid: "x", championName: "Lux", win: true, kills: 2, deaths: 3, assists: 20 }] } }, { summoner: { puuid: "x" } }, later);
  const state = { ...rankTracker, summoner: { riot_id: "Test#NA1" }, reported_games: { game }, additional_summoners: {} };
  const items = [{ riotId: "Test#NA1", record }, { riotId: "Test#NA1", record: game }];
  const env = { DISCORD_BOT_TOKEN: "test", DISCORD_ALERT_CHANNEL_ID: "123" };
  const options = { state, owner: "test", detectionIso: later, newAlerts: items, patchTargets: new Map() };
  await commitMonitorChanges(env, options, { fetchImpl: async () => Response.json({ id: "42" }), saveStateImpl: async () => {} });
  assert.equal(record.discord_message_id, "42");
  assert.equal(game.discord_message_id, "42");
  let payload;
  await commitMonitorChanges(env, { ...options, newAlerts: [], patchTargets: new Map([["42", { messageId: "42", channelId: "123" }]]) }, {
    fetchImpl: async (_url, init) => { payload = JSON.parse(init.body); return new Response(null, { status: 204 }); }, saveStateImpl: async () => {},
  });
  const descriptions = payload.embeds.map((embed) => embed.description).join("\n");
  assert.match(descriptions, /Demoted/);
  assert.match(descriptions, /ARAM Mayhem/);
  assert.match(descriptions, /2\/3\/20/);
  assert.deepEqual(payload.allowed_mentions.parse, []);
});

test("application sync is idempotent and uses runtime bot auth without exposing token", async () => {
  const state = {};
  const calls = [];
  const env = { DISCORD_APPLICATION_ID: "123", DISCORD_BOT_TOKEN: "test" };
  const fetchImpl = async (...args) => { calls.push(args); return Response.json({}); };
  await syncDiscordApplication(env, state, fetchImpl);
  await syncDiscordApplication(env, state, fetchImpl);
  assert.deepEqual(calls.map(([url, init]) => [url, init.method]), [
    ["https://discord.com/api/v10/applications/123/commands", "PUT"],
  ]);
  assert.equal(calls[0][1].headers.Authorization, "Bot test");
  assert.equal(JSON.stringify(state).includes("test"), false);
});

test("champion portraits handle punctuation and use Riot's canonical asset IDs", () => {
  const catalog = catalogFromData("16.17.1", { Chogath: { key: "31", id: "Chogath", name: "Cho'Gath" }, MonkeyKing: { key: "62", id: "MonkeyKing", name: "Wukong" } });
  assert.match(championInfo(catalog, "Cho'Gath").icon, /\/Chogath.png$/);
  assert.equal(championInfo(catalog, 31).name, "Cho'Gath");
  assert.match(championInfo(catalog, "Wukong").icon, /\/MonkeyKing.png$/);
  assert.deepEqual(championThumbnail(catalog, "Nonexistent"), {});
});

test("recent gives each game its own champion portrait and respects Discord limits", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/accounts/")) return Response.json({ puuid: "test", gameName: "Test", tagLine: "NA1" });
    if (url.includes("/realms/")) return Response.json({ v: "16.17.1" });
    if (url.includes("champion.json")) return Response.json({ data: { Trundle: { key: "48", id: "Trundle", name: "Trundle" } } });
    if (url.includes("/ids?")) return Response.json(Array.from({ length: 10 }, (_, i) => `NA1_${i}`));
    return Response.json({ metadata: { matchId: url.split("/").at(-1) }, info: { gameStartTimestamp: Date.parse(at), gameDuration: 1800, queueId: 420, participants: [{ puuid: "test", championId: 48, championName: "Trundle", win: false, kills: 1, deaths: 13, assists: 6 }] } });
  });
  const payload = await buildRecentResponse({ data: { options: [{ name: "summoner", value: "Test#NA1" }, { name: "count", value: 10 }] } }, { RIOT_API_KEY: "test" });
  assert.equal(payload.embeds.length, 10);
  assert.ok(payload.embeds.every((embed) => embed.thumbnail.url.endsWith("/Trundle.png")));
  assert.ok(JSON.stringify(payload).length < 6000);
  assert.equal(payload.allowed_mentions.parse.length, 0);
});

test("champion CDN failure does not fail commands", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 500 }));
  assert.equal((await getChampionCatalog()).size, 0);
});

test("unavailable Mayhem match detail stays pending without blocking other accounts", async () => {
  const record = { status: "live", live_game_id: "123", queue_id: 2400, start_time: at };
  const tracker = { reported_games: { game: record } };
  const forbidden = Object.assign(new Error("Forbidden"), { httpStatus: 403 });
  assert.deepEqual(await reconcilePendingLiveGames({}, tracker, later, async () => { throw forbidden; }), []);
  assert.equal(record.status, "live");
});

test("30-game stats plus champion catalog fit the Worker free subrequest budget", async (t) => {
  let subrequests = 0;
  const before = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: { match: async () => { subrequests++; }, put: async () => { subrequests++; } } } });
  t.after(() => before ? Object.defineProperty(globalThis, "caches", before) : delete globalThis.caches);
  t.mock.method(globalThis, "fetch", async (input) => {
    subrequests++;
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/accounts/")) return Response.json({ puuid: "test", gameName: "Test", tagLine: "NA1" });
    if (url.includes("league/v4")) return Response.json([]);
    if (url.includes("/realms/")) return Response.json({ v: "16.17.1" });
    if (url.includes("champion.json")) return Response.json({ data: {} });
    if (url.includes("/ids?")) return Response.json(Array.from({ length: 30 }, (_, i) => `NA1_${i}`));
    return Response.json({ metadata: {}, info: { participants: [], gameDuration: 1800 } });
  });
  await buildStatsResponse({ data: { options: [{ name: "summoner", value: "Test#NA1" }] } }, { RIOT_API_KEY: "test" });
  assert.equal(subrequests + 1, 46); // Includes the deferred Discord reply PATCH.
});

test("full monitor Discord failure preserves stored rank baseline and game history", async (t) => {
  const tracker = (name) => ({ ...baseline(), summoner: { riot_id: `${name}#NA1`, puuid: name, riot_account_checked_at: at }, baseline: {}, newest_completed_match: null, riot_newest_completed_match_id: "NA1_old", reported_games: { old: { status: "completed", discord_message_id: "old-message" } } });
  let stored = JSON.stringify({ ...tracker("A"), additional_summoners: { b: tracker("B"), c: tracker("C") } });
  const original = stored;
  const db = { prepare(sql) { return { bind(...args) { return { first: async () => ({ state_json: stored }), run: async () => { if (sql.includes("SET state_json")) stored = args[0]; return { meta: { changes: 1 } }; } }; } }; } };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("discord.com")) return new Response(null, { status: 500 });
    if (url.includes("/realms/")) return Response.json({ v: "test" });
    if (url.includes("champion.json")) return Response.json({ data: {} });
    if (url.includes("/ids?")) return Response.json(["NA1_old"]);
    if (url.includes("active-games")) return new Response(null, { status: 404 });
    if (url.includes("league/v4")) return Response.json([ranked("III", { losses: 21 })]);
    throw new Error("Unexpected request");
  });
  await assert.rejects(runLeagueMonitor({ MONITOR_ENABLED: "true", MONITOR_DB: db, RIOT_API_KEY: "test", DISCORD_BOT_TOKEN: "test", DISCORD_ALERT_CHANNEL_ID: "123" }, { detectionTimestamp: Date.parse(later) }), /Discord bot POST failed/);
  assert.equal(stored, original);
});
