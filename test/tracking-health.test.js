import test from "node:test";
import assert from "node:assert/strict";
import { trackingCommand, assertMonitorAdmin } from "../src/tracking.js";
import { readState, trackerEntries, runLeagueMonitor, validateMonitorState, monitorStatus } from "../src/monitor.js";
import { reportCredentialHealth } from "../src/health.js";
import { readRecord } from "../src/store.js";
import { testDb, stateFixture, tracker, envFixture, subcommand, game } from "./helpers/db.js";

function mockMonitor(t, { current = "NA1_100", newAccount = "New", live = false, onRequest = () => {}, failDiscord = false, authFails = false } = {}) {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input); onRequest(url, init);
    if (url.hostname === "discord.com") {
      if (failDiscord) return new Response(null, { status: 503 });
      if (url.pathname.includes("/guilds/")) return Response.json({ owner_id: "111" });
      return Response.json({ id: "999" });
    }
    if (url.pathname.includes("/realms/")) return Response.json({ v: "16.17.1" });
    if (url.pathname.endsWith("champion.json")) return Response.json({ data: { Zed: { id: "Zed", key: "238", name: "Zed" } } });
    if (authFails) return new Response(null, { status: 403 });
    if (url.pathname.includes("accounts/by-puuid")) { const name = decodeURIComponent(url.pathname.split("/").at(-1)); return Response.json({ puuid: name, gameName: name, tagLine: "NA1" }); }
    if (url.pathname.includes("accounts/by-riot-id")) return Response.json({ puuid: newAccount, gameName: newAccount, tagLine: "NA1" });
    if (url.pathname.endsWith("/ids")) return Response.json(url.searchParams.get("count") === "1" ? [current] : current === "NA1_100" ? [current] : [current, "NA1_100"]);
    if (url.pathname.includes("active-games")) {
      const puuid = decodeURIComponent(url.pathname.split("/").at(-1));
      return live ? Response.json({ gameId: 300, gameStartTime: Date.now(), gameQueueConfigId: 420, participants: [{ puuid, championId: 238 }] }) : new Response(null, { status: 404 });
    }
    if (url.pathname.includes("league/v4")) return Response.json([{ queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "II", wins: 10, losses: 10, leaguePoints: 30 }]);
    if (url.pathname.includes("/matches/")) {
      const match = game(Number(url.pathname.split("_").at(-1)), "Zed", newAccount);
      match.info.participants.push(...["Test", "Other", "Third"].filter((p) => p !== newAccount).map((puuid) => ({ ...match.info.participants[0], puuid })));
      return Response.json(match);
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
}

test("tracking requires real Manage Server/Admin permissions and the configured guild", () => {
  const env = envFixture(testDb());
  assert.doesNotThrow(() => assertMonitorAdmin(subcommand("track", "list"), env));
  assert.doesNotThrow(() => assertMonitorAdmin(subcommand("track", "list", {}, { member: { permissions: "8" } }), env));
  for (const overrides of [{ guild_id: "elsewhere" }, { member: { permissions: "0" } }, { member: { permissions: "broken" } }]) assert.throws(() => assertMonitorAdmin(subcommand("track", "list", {}, overrides), env));
});

test("adding a tracker establishes a fresh cursor and preserves every existing reported game", async (t) => {
  const state = stateFixture(); state.reported_games.old = { status: "completed", discord_message_id: "old" };
  const db = testDb(state); const env = envFixture(db); mockMonitor(t, { current: "NA1_200" });
  assert.match(await trackingCommand(subcommand("track", "add", { summoner: "New#NA1" }), env), /Existing completed games will not be announced/);
  const after = await readState(db);
  assert.equal(after.roster_version, 2); assert.equal(trackerEntries(after).length, 4);
  assert.deepEqual(after.reported_games, state.reported_games);
  const added = trackerEntries(after).find(({ tracker }) => tracker.summoner.riot_id === "New#NA1").tracker;
  assert.equal(added.riot_newest_completed_match_id, "NA1_200"); assert.deepEqual(added.reported_games, {});
  await assert.rejects(trackingCommand(subcommand("track", "add", { summoner: "New#NA1" }), env), /already tracked/);
});

test("pause, archive and resume preserve history and resume skips paused games", async (t) => {
  const state = stateFixture(); state.reported_games.old = { status: "completed", discord_message_id: "old" };
  const db = testDb(state); const env = envFixture(db); mockMonitor(t, { current: "NA1_200" });
  await trackingCommand(subcommand("track", "pause", { summoner: "Test#NA1" }), env);
  assert.equal((await readState(db)).monitor_paused, true);
  await trackingCommand(subcommand("track", "remove", { summoner: "Test#NA1" }), env);
  assert.ok((await readState(db)).removed_at);
  await trackingCommand(subcommand("track", "resume", { summoner: "Test#NA1" }), env);
  const after = await readState(db);
  assert.equal(after.removed_at, undefined); assert.equal(after.monitor_paused, false);
  assert.equal(after.riot_newest_completed_match_id, "NA1_200"); assert.deepEqual(after.reported_games, state.reported_games);
  assert.equal(after.baseline_history.length, 1);
});

test("tracking lease conflicts and Riot failures leave authoritative state unchanged", async (t) => {
  const state = stateFixture(); const db = testDb(state); const env = envFixture(db); mockMonitor(t, { authFails: true });
  await assert.rejects(trackingCommand(subcommand("track", "add", { summoner: "New#NA1" }), env), /invalid or expired/);
  assert.deepEqual(await readState(db), state);
  db.sqlite.prepare("UPDATE monitor_state SET lease_until=?").run(Date.now() + 60000);
  await assert.rejects(trackingCommand(subcommand("track", "pause", { summoner: "Test#NA1" }), env), /checking games/);
  assert.deepEqual(await readState(db), state);
});

test("dynamic roster retains legacy validation and enforces 10 active accounts", () => {
  assert.throws(() => validateMonitorState({ ...tracker(), additional_summoners: {} }), /Expected 3/);
  const state = { ...tracker(), roster_version: 2, additional_summoners: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, tracker(`Player${i}`)])) };
  assert.doesNotThrow(() => validateMonitorState(state));
  state.additional_summoners.extra = tracker("Extra"); assert.throws(() => validateMonitorState(state), /At most 10/);
  state.additional_summoners.extra.monitor_paused = true; assert.doesNotThrow(() => validateMonitorState(state));
});

test("completed-only suppresses new live posts while still advancing live cursors", async (t) => {
  const state = stateFixture(); state.alert_mode = "completed";
  const db = testDb(state); const env = envFixture(db); const posts = [];
  mockMonitor(t, { live: true, onRequest: (url, init) => { if (url.pathname.endsWith("/messages") && init.method === "POST") posts.push(init); } });
  const result = await runLeagueMonitor(env);
  assert.equal(result.newAlerts, 0); assert.equal(posts.length, 0);
  for (const { tracker } of trackerEntries(await readState(db))) { assert.equal(tracker.newest_live_game_id, "300"); assert.deepEqual(tracker.reported_games, {}); }
});

test("a newly enrolled account without old matches reports its first completed game once", async (t) => {
  const state = stateFixture(); state.roster_version = 2;
  state.newest_completed_match = null; state.riot_newest_completed_match_id = null;
  state.monitor_started_at = new Date(Date.now() - 2 * 3600_000).toISOString();
  state.additional_summoners.b.monitor_paused = true;
  state.additional_summoners.c.monitor_paused = true;
  const db = testDb(state); const env = envFixture(db); const posts = [];
  mockMonitor(t, { onRequest: (url, init) => { if (url.pathname.endsWith("/messages")) posts.push(JSON.parse(init.body)); } });
  assert.equal((await runLeagueMonitor(env)).newAlerts, 1);
  assert.equal((await readState(db)).riot_newest_completed_match_id, "NA1_100");
  assert.equal((await runLeagueMonitor(env)).newAlerts, 0);
  assert.equal(posts.length, 1);
});

test("archived live alerts drain by editing the original grouped message", async (t) => {
  const state = stateFixture(); state.roster_version = 2; state.monitor_paused = true; state.removed_at = new Date().toISOString();
  state.reported_games.live = { status: "live", live_game_id: "200", riot_game_id: "200", start_time: new Date().toISOString(), discord_message_id: "77", discord_channel_id: "789" };
  state.additional_summoners.b.reported_games.done = { status: "completed", champion: "Zed", queue: "Ranked Solo/Duo", result: "WIN", duration: "30m", start_time: new Date().toISOString(), detected_at: new Date().toISOString(), discord_message_id: "77" };
  const db = testDb(state); const patches = []; const calls = [];
  mockMonitor(t, { onRequest: (url, init) => { calls.push(url.pathname); if (init?.method === "PATCH") patches.push(JSON.parse(init.body)); } });
  await runLeagueMonitor(envFixture(db));
  assert.equal(patches.length, 1); assert.equal(patches[0].embeds.length, 2);
  assert.equal((await readState(db)).reported_games.live.status, "completed");
  assert.ok(!calls.some((path) => path.includes("active-games") && path.endsWith("/Test")));
  assert.ok(!(await monitorStatus(envFixture(db))).summoners.includes("Test#NA1"));
});

test("expanded roster is processed fairly within the per-invocation Riot budget", async (t) => {
  const state = { ...tracker(), roster_version: 2, additional_summoners: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, tracker(`Player${i}`)])) };
  const db = testDb(state); const activeChecks = new Set(); let riotCalls = 0;
  mockMonitor(t, { onRequest: (url) => { if (url.hostname.endsWith("api.riotgames.com")) riotCalls++; if (url.pathname.includes("active-games")) activeChecks.add(url.pathname.split("/").at(-1)); } });
  for (let i = 0; i < 3; i++) {
    const before = riotCalls; await runLeagueMonitor(envFixture(db)); assert.ok(riotCalls - before <= 20);
  }
  assert.equal(activeChecks.size, 10);
  for (const { tracker } of trackerEntries(await readState(db))) assert.ok(tracker.rank_history.length);
});

test("credential health emits one failure and one recovery DM, without mentions or secrets", async (t) => {
  const db = testDb(stateFixture()); const env = envFixture(db); const payloads = [];
  mockMonitor(t, { onRequest: (url, init) => { if (url.pathname.endsWith("/messages")) payloads.push(JSON.parse(init.body)); } });
  await reportCredentialHealth(env, "ok", stateFixture()); assert.equal(payloads.length, 0);
  await reportCredentialHealth(env, "invalid", stateFixture());
  await reportCredentialHealth(env, "invalid", stateFixture()); assert.equal(payloads.length, 1);
  await reportCredentialHealth(env, "ok", stateFixture());
  await reportCredentialHealth(env, "ok", stateFixture()); assert.equal(payloads.length, 2);
  for (const payload of payloads) { assert.deepEqual(payload.allowed_mentions, { parse: [] }); assert.equal(payload.enforce_nonce, true); assert.ok(!JSON.stringify(payload).includes(env.RIOT_API_KEY)); }
  assert.equal((await readRecord(db, "health:riot")).pending.length, 0);
});

test("failed credential notifications remain queued, and confirmed auth failure preserves game state", async (t) => {
  const state = stateFixture(); const db = testDb(state); const env = envFixture(db);
  mockMonitor(t, { authFails: true, failDiscord: true });
  // Suppress command registration here so this run reaches the Riot check.
  delete env.DISCORD_APPLICATION_ID;
  await assert.rejects(runLeagueMonitor(env), /HTTP 403/);
  assert.deepEqual(await readState(db), state);
  const health = await readRecord(db, "health:riot");
  assert.equal(health.status, "invalid"); assert.equal(health.pending.length, 1); assert.equal(health.deliveryError, true);
  await reportCredentialHealth(env, "invalid", state); assert.equal((await readRecord(db, "health:riot")).pending.length, 1);
});

test("concurrent credential reporters share a lease and emit only one failure notice", async (t) => {
  const db = testDb(stateFixture()); const env = envFixture(db); const posts = [];
  mockMonitor(t, { onRequest: (url, init) => { if (url.pathname.endsWith("/messages")) posts.push(JSON.parse(init.body)); } });
  await Promise.all([reportCredentialHealth(env, "invalid", stateFixture()), reportCredentialHealth(env, "invalid", stateFixture())]);
  assert.equal(posts.length, 1);
  assert.equal((await readRecord(db, "health:riot")).pending.length, 0);
});
