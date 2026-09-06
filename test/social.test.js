import test from "node:test";
import assert from "node:assert/strict";
import worker, { autocompleteResponse } from "../src/index.js";
import { createSocial, updateSocial, resolveSocial, rankPlayers, renderLeaderboard, playerStats, loadRoster } from "../src/social.js";
import { readRecord, leaseRecord, releaseRecord, writeRecord } from "../src/store.js";
import { profileCommand } from "../src/features.js";
import { COMMANDS } from "../src/commands.js";
import { testDb, stateFixture, envFixture, interaction, subcommand, game, tracker } from "./helpers/db.js";

function mockPlayers(t, { count = 30, fail = () => false, onRequest = () => {} } = {}) {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    onRequest(url, init);
    if (url.hostname === "discord.com") return Response.json({ id: "999" });
    if (fail(url)) return new Response(null, { status: 429 });
    if (url.pathname.includes("accounts/by-riot-id")) {
      const name = decodeURIComponent(url.pathname.split("/").at(-2));
      return Response.json({ puuid: name, gameName: name, tagLine: "NA1" });
    }
    if (url.pathname.endsWith("/ids")) {
      const name = decodeURIComponent(url.pathname.split("/").at(-2));
      return Response.json(Array.from({ length: Math.min(count, Number(url.searchParams.get("count"))) }, (_, i) => `NA1_${name}_${i}`));
    }
    const [, name, index] = url.pathname.split("/").at(-1).split("_");
    return Response.json(game(`${name}_${index}`, "Zed", name, Number(index) % 2 === 0));
  });
}
const service = (env) => ({ load: async (query, window) => {
  try { return { player: await playerStats(query, env, window, 30) }; }
  catch (error) { return { error: error.message }; }
} });
const cardId = (payload) => payload.components[0].components[0].custom_id;
const click = (payload, extra = {}) => interaction("", {}, { type: 3, data: { custom_id: cardId(payload) }, ...extra });
const viewFor = (db, payload) => readRecord(db, cardId(payload).split(":").slice(0, 2).join(":"));

async function signedRun(command, env) {
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const body = JSON.stringify(command), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(timestamp + body))).toString("hex");
  const pending = [];
  const response = await worker.fetch(new Request("https://worker.test/", { method: "POST", body, headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp } }),
    { ...env, DISCORD_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey("raw", key.publicKey)).toString("hex") }, { waitUntil: (p) => pending.push(p), exports: { LeaderboardPlayer: service(env) } });
  await Promise.all(pending);
  return response.json();
}

test("leaderboard qualification, missing metrics, deterministic ties and competition ranks", () => {
  const rows = [{ name: "B", games: 5, winRate: 60 }, { name: "A", games: 10, winRate: 60 }, { name: "C", games: 5, winRate: 40 }, { name: "D", games: 1, winRate: 100 }, { name: "E", games: 5, winRate: null }];
  assert.deepEqual(rankPlayers(rows, "winRate", 5).map((p) => [p.name, p.position]), [["A", 1], ["B", 1], ["C", 3]]);
});

test("leaderboard automatically loads the active roster with a fixed window and no per-player controls", async (t) => {
  const state = stateFixture(); state.roster_version = 2; state.additional_summoners.c.monitor_paused = true;
  state.additional_summoners.d = tracker("Archived", { removed_at: "2026-09-01" });
  const db = testDb(state), env = envFixture(db), requests = [];
  mockPlayers(t, { onRequest: (url) => requests.push(url) });
  const payload = await createSocial(interaction("leaderboard", { region: "euw", mode: 420, days: 10 }), env, service(env));
  const view = JSON.parse(db.sqlite.prepare("SELECT payload FROM bot_records WHERE record_key LIKE 'social:%'").get().payload);
  assert.deepEqual(view.roster, ["Test#NA1", "Other#NA1"]);
  assert.equal(view.query.region, "na"); assert.doesNotMatch(payload.embeds[0].title, /incomplete/);
  assert.equal(view.players.length, 2); assert.ok(view.players.every((p) => p.games === 30 && p.hours === 15));
  assert.deepEqual(payload.components, []);
  assert.ok(requests.filter((url) => url.pathname.endsWith("/ids")).every((url) => url.searchParams.get("endTime") === String(view.endTime) && url.searchParams.get("queue") === "420"));
  assert.deepEqual(JSON.parse(db.sqlite.prepare("SELECT state_json FROM monitor_state").get().state_json), state);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("partial failures retain successes; retries only load failures and preserve card ownership and expiry", async (t) => {
  const db = testDb(stateFixture()), env = envFixture(db); let fail = true; const requests = [];
  mockPlayers(t, { count: 5, fail: (url) => fail && url.pathname.includes("Other"), onRequest: (url) => requests.push(url) });
  const payload = await createSocial(interaction("leaderboard"), env, service(env));
  const view = await viewFor(db, payload), key = `social:${view.id}`;
  assert.equal(view.players.length, 2); assert.deepEqual(view.failures.map((f) => f.summoner), ["Other#NA1"]);
  assert.match(payload.embeds[0].title, /incomplete/);
  assert.equal(payload.components[0].components[0].label, "Retry missing players");
  await assert.rejects(resolveSocial(click(payload, { member: { user: { id: "someone" } } }), env), /Only the requester/);
  await assert.rejects(resolveSocial(click(payload, { channel_id: "elsewhere" }), env), /Only the requester/);
  await leaseRecord(db, key, "other");
  await assert.rejects(updateSocial(click(payload), env, service(env)), /already updating/);
  await releaseRecord(db, key, "other");
  const retry = await updateSocial(click(payload), env, service(env));
  assert.equal((await viewFor(db, retry)).players.length, 2);
  const before = requests.length; fail = false;
  const completed = await updateSocial(click(payload), env, service(env));
  assert.equal((await readRecord(db, key)).players.length, 3);
  assert.deepEqual(completed.components, []);
  assert.ok(requests.slice(before).every((url) => url.pathname.includes("Other")));
  const total = requests.length; await updateSocial(click(payload), env, service(env)); assert.equal(requests.length, total);
  await writeRecord(db, key, view, Date.now() - 1);
  await assert.rejects(resolveSocial(click(payload), env), /expired/);
});

test("compare uses identical period/mode and independent participants; caps samples", async (t) => {
  const requests = [];
  mockPlayers(t, { onRequest: (url) => requests.push(url) });
  const payload = await createSocial(interaction("compare", { summoner: "Test#NA1", opponent: "Other#NA1", region: "euw", days: 30, mode: 450 }), envFixture(testDb()));
  assert.deepEqual(payload.embeds[0].fields.map((f) => f.name), ["Test#NA1", "Other#NA1"]);
  assert.ok(payload.embeds[0].fields.every((f) => /15 sampled games \(capped\)/.test(f.value)));
  const ids = requests.filter((url) => url.pathname.endsWith("/ids"));
  assert.equal(ids[0].search, ids[1].search);
  assert.equal(ids[0].searchParams.get("queue"), "450");
  assert.ok(requests.every((url) => url.hostname === "europe.api.riotgames.com"));
  await assert.rejects(createSocial(interaction("compare", { summoner: "Test#NA1", opponent: "Test#NA1" }), envFixture(testDb())), /different accounts/);
});

test("empty periods, no active roster and wrong server are explicit", async (t) => {
  mockPlayers(t, { count: 0 });
  const state = stateFixture(); state.monitor_paused = true;
  Object.values(state.additional_summoners).forEach((p) => p.monitor_paused = true);
  const env = envFixture(testDb(state));
  await assert.rejects(createSocial(interaction("leaderboard"), env), /No active/);
  await assert.rejects(createSocial(interaction("leaderboard", {}, { guild_id: "elsewhere" }), env), /tracking server/);
  const payload = await createSocial(interaction("compare", { summoner: "Test#NA1", opponent: "Other#NA1" }), env);
  assert.ok(payload.embeds[0].fields.every((f) => /No completed games/.test(f.value)));
});

test("ten long player names stay within Discord field and embed limits", () => {
  const players = Array.from({ length: 10 }, (_, i) => ({ name: "x".repeat(64) + "#" + "y".repeat(15) + i, games: 30, wins: 15, losses: 15, winRate: 50, capped: true }));
  for (const min_games of [5, 31]) {
    const embed = renderLeaderboard({ id: "test", query: { days: 7, mode: 0, metric: "winRate", min_games }, players, roster: players, endTime: 123 }).embeds[0];
    assert.ok(embed.fields.every((field) => field.value.length <= 1024));
    assert.ok(JSON.stringify(embed).length < 6000);
  }
});

test("signed commands route, honor privacy/default account, and signed buttons retry missing players", async (t) => {
  const db = testDb(stateFixture()), env = envFixture(db), replies = [];
  let fail = true;
  mockPlayers(t, { count: 5, fail: (url) => fail && url.pathname.includes("Other"), onRequest: (url, init) => { if (url.hostname === "discord.com") replies.push(JSON.parse(init.body)); } });
  await profileCommand(subcommand("profile", "set", { summoner: "Test#NA1", private: true }), env);
  assert.equal((await signedRun(interaction("leaderboard"), env)).data.flags, 64);
  const payload = replies.at(-1);
  fail = false;
  assert.equal((await signedRun(click(payload), env)).type, 6);
  assert.match(replies.at(-1).embeds[0].description, /3\/3 players loaded/);
  const result = await signedRun(interaction("compare", { opponent: "Other#NA1", private: false }), env);
  assert.equal(result.type, 5); assert.equal(result.data.flags, undefined);
  assert.match(replies.at(-1).embeds[0].title, /comparison/);
  assert.deepEqual(replies.at(-1).allowed_mentions, { parse: [] });
  const suggestions = await autocompleteResponse({ data: { name: "compare", options: [{ name: "opponent", focused: true, value: "oth" }] } }, env);
  assert.deepEqual((await suggestions.json()).data.choices, [{ name: "Other#NA1", value: "Other#NA1" }]);
  assert.equal(COMMANDS.find((c) => c.name === "compare").options[0].required, true);
});

test("worst-case cache misses, D1 and reply stay within 50 subrequests per interaction", async (t) => {
  let requests = 0;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: { match: async () => { requests++; }, put: async () => { requests++; } } } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "caches", descriptor) : delete globalThis.caches);
  const db = testDb(stateFixture()), env = envFixture(db);
  mockPlayers(t, { onRequest: () => requests++ });
  await signedRun(interaction("compare", { summoner: "Test#NA1", opponent: "Other#NA1" }), env);
  assert.ok(requests + db.queries <= 50, `${requests} network/cache + ${db.queries} D1`);
  // Count each private RPC separately, as Cloudflare does for each invocation.
  const costs = [];
  const rpc = { load: async (query, window) => {
    const before = requests;
    const result = await playerStats(query, env, window, 30);
    costs.push(requests - before);
    return { player: result };
  } };
  // Individual player budget is independent of roster length.
  requests = 0;
  await rpc.load({ summoner: "Test#NA1", days: 7, region: "na", mode: 0 }, { startTime: 1, endTime: Math.floor(Date.now() / 1000) });
  assert.ok(costs[0] <= 50, `${costs[0]} per-player external/cache requests`);
});

test("ten players load automatically with at most two concurrent RPCs and stable roster ordering", async () => {
  const roster = Array.from({ length: 10 }, (_, i) => `Player${i}#NA1`);
  const view = { query: { days: 7 }, roster, players: [], startTime: 10, endTime: 20 };
  let active = 0, peak = 0, calls = 0;
  await loadRoster(view, { load: async (query, window) => {
    active++; peak = Math.max(peak, active); calls++;
    assert.deepEqual(window, { startTime: 10, endTime: 20 });
    await new Promise((r) => setTimeout(r, 2)); active--;
    return { player: { name: query.summoner, games: 30 } };
  } });
  assert.equal(calls, 10); assert.equal(peak, 2);
  assert.deepEqual(view.players.map((p) => p.summoner), roster);
  assert.deepEqual(view.failures, []);
});

test("deadline returns successful players and marks unfinished lookups for retry without late writes", async () => {
  const view = { query: { days: 7 }, roster: ["Fast#NA1", "Slow#NA1", "Later#NA1"], players: [], startTime: 1, endTime: 2 };
  await loadRoster(view, { load: async ({ summoner }) => {
    if (summoner !== "Fast#NA1") await new Promise((r) => setTimeout(r, 30));
    return { player: { name: summoner, games: 5 } };
  } }, 5);
  assert.equal(view.players.length, 1); assert.equal(view.failures.length, 2);
  assert.ok(view.failures.every((f) => /timed out/.test(f.error)));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(view.players.length, 1);
});
