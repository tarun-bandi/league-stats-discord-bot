import test from "node:test";
import assert from "node:assert/strict";
import { runLeagueMonitor, readState, trackerEntries, monitorStatus } from "../src/monitor.js";
import { workdayRows } from "../src/nine-to-five.js";
import { workdayCount } from "../src/workday.js";
import { riotKeyFingerprint } from "../src/riot-key.js";
import { testDb, stateFixture, envFixture, game } from "./helpers/db.js";

const initialTime = Date.parse("2026-10-14T20:00:00Z");
async function fixture(t, customize = () => {}) {
  let now = initialTime;
  t.mock.method(Date, "now", () => now);
  const state = stateFixture();
  state.riot_key_fingerprint = await riotKeyFingerprint("fixture");
  state.last_check_at = new Date(now - 60_000).toISOString();
  for (const { tracker } of trackerEntries(state)) {
    tracker.riot_key_fingerprint = state.riot_key_fingerprint;
    tracker.newest_live_game_id = "old-live-id";
  }
  customize(state);
  const db = testDb(state);
  return { state, db, env: envFixture(db), advance: (ms) => { now += ms; } };
}

function mock(t, { live = () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }), detail, discordFailure = false, ids = ["NA1_200", "NA1_100"] } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, ...init, payload: init.body ? JSON.parse(init.body) : null });
    if (url.hostname === "discord.com") {
      if (discordFailure && /\/messages/.test(url.pathname)) return new Response(null, { status: 503 });
      return Response.json({ id: init.method === "PATCH" ? url.pathname.split("/").at(-1) : "999" });
    }
    if (url.pathname.includes("/realms/")) return Response.json({ v: "unavailable" });
    if (url.pathname.includes("/accounts/")) {
      const name = url.pathname.split("/").at(-1);
      return Response.json({ puuid: name, gameName: name, tagLine: "NA1" });
    }
    if (url.pathname.endsWith("/ids")) return Response.json(ids);
    if (url.pathname.includes("active-games")) return live(url);
    if (url.pathname.includes("league/v4")) return Response.json([]);
    if (url.pathname.includes("/matches/")) {
      if (detail) { const response = detail(url); if (response) return response; }
      const id = Number(url.pathname.split("_").at(-1));
      const match = game(id, "Zed", "Test", true, initialTime - 3600_000);
      match.info.participants.push(...["Other", "Third"].map((puuid) => ({ ...match.info.participants[0], puuid })));
      return Response.json(match);
    }
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  });
  return calls;
}

test("Spectator 429 saves completed games for all players, backs off, and recovers without duplicate alerts", async (t) => {
  const { db, env, advance } = await fixture(t);
  let throttled = true;
  const calls = mock(t, { live: () => throttled ? new Response(null, { status: 429, headers: { "Retry-After": "60" } }) : new Response(null, { status: 404 }) });
  assert.equal((await runLeagueMonitor(env)).status, "partial");
  let saved = await readState(db);
  for (const { tracker } of trackerEntries(saved)) {
    assert.equal(tracker.riot_newest_completed_match_id, "NA1_200");
    assert.equal(tracker.reported_games.NA1_200.discord_message_id, "999");
    assert.equal(tracker.newest_live_game_id, "old-live-id", "a 429 must not clear the live cursor");
    assert.equal(tracker.completed_checked_at, new Date(initialTime).toISOString());
    assert.equal(tracker.live_checked_at, undefined);
    assert.ok(tracker.observation_deferred.some((item) => item.stage === "live" && item.retryAt >= initialTime + 120000));
    assert.equal(workdayCount(tracker, "2026-10-14", Date.now()), 1);
  }
  assert.ok(workdayRows(saved, "2026-10-14", Date.now()).every((row) => row.delayed));
  const status = await monitorStatus(env);
  assert.equal(status.lastRun.status, "partial");
  assert.equal(status.checks[0].liveAt, null);
  const posts = () => calls.filter((call) => call.method === "POST" && call.url.pathname.endsWith("/messages"));
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].payload.embeds.length, 3);
  assert.deepEqual(posts()[0].payload.allowed_mentions, { parse: [] });
  const liveCalls = () => calls.filter((call) => call.url.pathname.includes("active-games")).length;
  assert.equal(liveCalls(), 1, "shared host cooldown blocks later players in the same tick");
  advance(60_000);
  assert.equal((await runLeagueMonitor(env)).status, "partial");
  assert.equal(liveCalls(), 1, "no network probe during saved backoff");
  advance(60_001);
  throttled = false;
  assert.equal((await runLeagueMonitor(env)).status, "ok");
  saved = await readState(db);
  assert.equal(saved.monitor_last_run.checked, 3);
  for (const { tracker } of trackerEntries(saved)) {
    assert.deepEqual(tracker.observation_deferred, []);
    assert.equal(tracker.newest_live_game_id, null);
    assert.ok(tracker.live_checked_at);
  }
  assert.equal(posts().length, 1);
});

test("repeated throttle increases stage backoff and honors a longer Riot deadline", async (t) => {
  const { db, env, advance } = await fixture(t);
  let retry = "1";
  mock(t, { live: () => new Response(null, { status: 429, headers: { "Retry-After": retry } }) });
  await runLeagueMonitor(env);
  advance(120_001);
  await runLeagueMonitor(env);
  let item = (await readState(db)).observation_deferred.find((item) => item.stage === "live");
  assert.equal(item.attempts, 2);
  assert.equal(item.retryAt, Date.now() + 240_000);
  advance(240_001);
  retry = "3600";
  await runLeagueMonitor(env);
  item = (await readState(db)).observation_deferred.find((item) => item.stage === "live");
  assert.equal(item.retryAt, Date.now() + 3600_000);
});

test("completed-history throttling rolls back that scan but allows live checks on the other host", async (t) => {
  const { db, env, state } = await fixture(t);
  const calls = mock(t, {
    ids: ["NA1_200", "NA1_199", "NA1_100"],
    detail: (url) => url.pathname.endsWith("NA1_199") ? new Response(null, { status: 429, headers: { "Retry-After": "60" } }) : null,
    live: () => new Response(null, { status: 404 }),
  });
  const result = await runLeagueMonitor(env);
  assert.equal(result.status, "partial");
  for (const { tracker } of trackerEntries(await readState(db))) {
    assert.equal(tracker.riot_newest_completed_match_id, "NA1_100");
    assert.deepEqual(tracker.reported_games, state.reported_games);
    assert.ok(tracker.live_checked_at);
    assert.ok(tracker.observation_deferred.some((item) => item.stage === "completed"));
  }
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
});

test("completed grouped live alerts retain their message IDs during Spectator throttling", async (t) => {
  const { db, env } = await fixture(t, (state) => {
    state.additional_summoners.c.monitor_paused = true;
    for (const tracker of [state, state.additional_summoners.b]) {
      tracker.reported_games["live:200"] = { status: "live", live_game_id: "200", riot_game_id: "200", start_time: new Date(initialTime - 3600_000).toISOString(), discord_message_id: "77", discord_channel_id: "789" };
    }
  });
  const calls = mock(t);
  await runLeagueMonitor(env);
  const saved = await readState(db);
  for (const tracker of [saved, saved.additional_summoners.b]) {
    assert.equal(tracker.reported_games["live:200"].status, "completed");
    assert.equal(tracker.reported_games["live:200"].discord_message_id, "77");
  }
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  const patches = calls.filter((call) => call.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.equal(patches[0].payload.embeds.length, 2);
  assert.deepEqual(patches[0].payload.allowed_mentions, { parse: [] });
});

test("Discord failure during a partial tick leaves all authoritative cursors and history unchanged", async (t) => {
  const { db, env, state } = await fixture(t);
  mock(t, { discordFailure: true });
  await assert.rejects(runLeagueMonitor(env), /Discord bot POST failed/);
  assert.deepEqual(await readState(db), state);
});

test("unexpected live source failure is not silently downgraded to a successful partial check", async (t) => {
  const { db, env, state } = await fixture(t);
  mock(t, { live: () => new Response(null, { status: 503 }) });
  await assert.rejects(runLeagueMonitor(env), /HTTP 503/);
  assert.deepEqual(await readState(db), state);
});
