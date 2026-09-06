import test from "node:test";
import assert from "node:assert/strict";
import { riotKeyFingerprint } from "../src/riot-key.js";
import { resolveTrackedAccount, runLeagueMonitor } from "../src/monitor.js";
import { buildRecentResponse } from "../src/index.js";

const at = "2026-09-06T05:45:00.000Z";
const tracker = (name = "A", id = 1) => ({
  summoner: { riot_id: `${name}#NA1`, puuid: `old-${name}`, riot_account_checked_at: at },
  baseline: { completed_match_id: "legacy-baseline" },
  newest_completed_match: { id: `NA1_${id}`, started_at: "2026-09-06T04:00:00Z" },
  riot_newest_completed_match_id: `NA1_${id}`,
  newest_live_game_id: null,
  rank_snapshot: {}, rank_checked_at: at,
  reported_games: { historic: { status: "completed", match_id: `NA1_${id}`, discord_message_id: `message-${id}` } },
});

test("credential fingerprint is stable and contains no credential", async () => {
  const hash = await riotKeyFingerprint("synthetic-key-A");
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, await riotKeyFingerprint("synthetic-key-A"));
  assert.notEqual(hash, await riotKeyFingerprint("synthetic-key-B"));
});

test("forced account refresh verifies a new encrypted PUUID against saved match history", async (t) => {
  const saved = tracker();
  const history = structuredClone(saved.reported_games);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    if (url.includes("by-puuid")) return new Response(null, { status: 400 });
    if (url.includes("by-riot-id")) return Response.json({ puuid: "new-A", gameName: "A", tagLine: "NA1" });
    return Response.json({ info: { participants: [{ puuid: "new-A" }] } });
  });
  await resolveTrackedAccount({ RIOT_API_KEY: "synthetic" }, saved, Date.parse(at));
  assert.equal(calls.length, 0); // Daily cache is valid until a credential change.
  await resolveTrackedAccount({ RIOT_API_KEY: "synthetic" }, saved, Date.parse(at), { force: true });
  assert.equal(saved.summoner.puuid, "new-A");
  assert.ok(calls.at(-1).endsWith("/matches/NA1_1"));
  assert.deepEqual(saved.reported_games, history);
  assert.equal(saved.riot_newest_completed_match_id, "NA1_1");
});

test("reused Riot ID cannot silently replace the tracked account", async (t) => {
  const saved = tracker();
  const before = JSON.stringify(saved);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("by-puuid")) return new Response(null, { status: 400 });
    if (url.includes("by-riot-id")) return Response.json({ puuid: "different-account", gameName: "A", tagLine: "NA1" });
    return Response.json({ info: { participants: [{ puuid: "true-account" }] } });
  });
  await assert.rejects(resolveTrackedAccount({ RIOT_API_KEY: "synthetic" }, saved, Date.parse(at), { force: true }), /different account/);
  assert.equal(JSON.stringify(saved), before);
});

test("expired credentials do not trigger identity rebinding", async (t) => {
  const saved = tracker();
  const before = JSON.stringify(saved);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 403 }); });
  await assert.rejects(resolveTrackedAccount({ RIOT_API_KEY: "synthetic" }, saved, Date.parse(at), { force: true }), /HTTP 403/);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(saved), before);
});

for (const fail of [false, true]) test(`monitor key migration ${fail ? "failure preserves all durable state" : "refreshes all three identities without new alerts"}`, async (t) => {
  let stored = JSON.stringify({ ...tracker(), riot_key_fingerprint: "previous", additional_summoners: { b: tracker("B", 2), c: tracker("C", 3) } });
  const before = stored;
  const original = JSON.parse(before);
  const db = { prepare(sql) { return { bind(...args) { return {
    first: async () => ({ state_json: stored }),
    run: async () => { if (sql.includes("SET state_json")) stored = args[0]; return { meta: { changes: 1 } }; },
  }; } }; } };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    assert.ok(!url.includes("discord.com"), "Migration must not POST historical alerts");
    if (url.includes("/realms/")) return Response.json({ v: "invalid" });
    if (url.includes("/accounts/by-puuid/")) return new Response(null, { status: 400 });
    if (url.includes("/accounts/by-riot-id/")) {
      const name = url.split("/").at(-2);
      return Response.json({ puuid: `new-${name}`, gameName: name, tagLine: "NA1" });
    }
    if (url.includes("/ids?")) {
      if (fail && url.includes("new-B")) return new Response(null, { status: 503 });
      const name = url.split("/").at(-2).slice(-1);
      return Response.json([`NA1_${name.charCodeAt(0) - 64}`]);
    }
    if (url.includes("active-games")) return new Response(null, { status: 404 });
    const id = Number(url.split("_").at(-1));
    return Response.json({ info: { participants: [{ puuid: `new-${String.fromCharCode(64 + id)}` }] } });
  });
  const run = runLeagueMonitor({ MONITOR_ENABLED: "true", MONITOR_DB: db, RIOT_API_KEY: "synthetic-key", DISCORD_BOT_TOKEN: "synthetic-bot", DISCORD_ALERT_CHANNEL_ID: "123" }, { detectionTimestamp: Date.parse(at) });
  if (fail) {
    await assert.rejects(run, /HTTP 503/);
    assert.equal(stored, before);
  } else {
    assert.equal((await run).newAlerts, 0);
    const state = JSON.parse(stored);
    assert.equal(state.riot_key_fingerprint, await riotKeyFingerprint("synthetic-key"));
    for (const [current, old] of [[state, original], [state.additional_summoners.b, original.additional_summoners.b], [state.additional_summoners.c, original.additional_summoners.c]]) {
      assert.ok(current.summoner.puuid.startsWith("new-"));
      assert.deepEqual(current.reported_games, old.reported_games);
      assert.deepEqual(current.newest_completed_match, old.newest_completed_match);
      assert.deepEqual(current.baseline, old.baseline);
    }
    assert.ok(!stored.includes("synthetic-key"));
  }
});

test("slash-command caches never reuse a previous credential's encrypted identifiers", async (t) => {
  const entries = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
    match: async (request) => entries.get(request.url)?.clone(),
    put: async (request, response) => { entries.set(request.url, response.clone()); },
  } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "caches", descriptor) : delete globalThis.caches);
  const accounts = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(!url.includes("__leaguestats_credential")); // Fingerprint stays in the local cache only.
    const key = init.headers["X-Riot-Token"];
    const puuid = key.endsWith("A") ? "account-A" : "account-B";
    if (url.includes("/accounts/")) {
      accounts.push(puuid);
      return Response.json({ puuid, gameName: "Example", tagLine: "NA1" });
    }
    assert.ok(url.includes(puuid), "Match-list request must use the current key's PUUID");
    return Response.json([]);
  });
  const interaction = { data: { options: [{ name: "summoner", value: "Example#NA1" }] } };
  for (const key of ["synthetic-key-A", "synthetic-key-B", "synthetic-key-A"]) {
    await buildRecentResponse(interaction, { RIOT_API_KEY: key });
  }
  assert.deepEqual(accounts, ["account-A", "account-B"]);
  assert.ok([...entries.keys()].every((url) => !url.includes("synthetic-key")));
});
