import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { recapBoundary, weeklyLp, recapPayload, summaryCommand, weeklyCommand, runWeeklyRecap } from "../src/recap.js";
import { readRecord, writeRecord } from "../src/store.js";
import { testDb, stateFixture, tracker, envFixture, interaction, subcommand } from "./helpers/db.js";

const HOUR = 3600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
const end = Date.parse("2026-09-14T16:00:00Z"), start = end - WEEK;
const solo = "RANKED_SOLO_5x5", flex = "RANKED_FLEX_SR";
const rank = (lp, extra = {}) => ({ tier: "GOLD", rank: "II", leaguePoints: lp, wins: 10, losses: 5, ...extra });
const point = (at, lp = 20, other = 30) => ({ at: new Date(at).toISOString(), entries: { [solo]: rank(lp), [flex]: rank(other) } });
const history = () => Array.from({ length: 8 }, (_, i) => point(i === 7 ? end - 1000 : start + i * DAY, 20 + i * 10, 30 - i));
const key = "weekly:456";
const enabled = (extra = {}) => ({ enabled: true, nextDue: end, channel: "789", ...extra });

async function signedRun(command, env) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  const body = JSON.stringify(command), timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body))).toString("hex");
  const pending = [];
  const response = await worker.fetch(new Request("https://worker.test/", { method: "POST", body, headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp } }), { ...env, DISCORD_PUBLIC_KEY: publicKey }, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending); return response.json();
}

test("weekly boundaries are Monday 16 UTC across midnight, DST and years", () => {
  assert.equal(recapBoundary(end), end);
  assert.equal(recapBoundary(end - 1), start);
  assert.equal(recapBoundary(end + WEEK - 1), end);
  assert.equal(new Date(recapBoundary(Date.parse("2027-01-01T00:00Z"))).toISOString(), "2026-12-28T16:00:00.000Z");
  assert.equal(new Date(recapBoundary(Date.parse("2026-11-02T16:00Z"))).toISOString(), "2026-11-02T16:00:00.000Z");
});

test("LP stays queue-specific and handles promotions, demotions and apex tiers", () => {
  const h = history();
  assert.equal(weeklyLp(h, solo, start, end).delta, 70);
  assert.equal(weeklyLp(h, flex, start, end).delta, -7);
  h[0].entries[solo] = rank(90, { rank: "II" });
  h.at(-1).entries[solo] = rank(15, { rank: "I" });
  assert.equal(weeklyLp(h, solo, start, end).delta, 25);
  h[0].entries[solo] = rank(15, { rank: "I" }); h.at(-1).entries[solo] = rank(90);
  assert.equal(weeklyLp(h, solo, start, end).delta, -25);
  h[0].entries[solo] = rank(500, { tier: "MASTER" }); h.at(-1).entries[solo] = rank(550, { tier: "GRANDMASTER" });
  assert.equal(weeklyLp(h, solo, start, end).delta, 50);
});

test("LP rejects resets, missing queues and long gaps; labels partial history", () => {
  assert.equal(weeklyLp([], solo, start, end).delta, null);
  const h = history(); h[3].entries[solo].wins = 1;
  assert.equal(weeklyLp(h, solo, start, end).delta, null);
  assert.equal(weeklyLp([point(start), point(end - 1)], solo, start, end).delta, null);
  const missing = history(); delete missing[2].entries[solo];
  assert.equal(weeklyLp(missing, solo, start, end).delta, null);
  const partial = weeklyLp(history().slice(2), solo, start, end);
  assert.equal(partial.partial, true); assert.equal(partial.delta, 50);
  assert.equal(weeklyLp([point(start - 1), point(end)], solo, start, end).delta, null);
});

test("summary deduplicates completed games, uses exact range and labels observed LP", () => {
  const state = stateFixture(); state.rank_history = history();
  const game = (id, result, at) => ({ match_id: id, status: "completed", result, start_time: new Date(at).toISOString() });
  state.reported_games = { a: game("a", "WIN", start), duplicate: game("a", "WIN", start), b: game("b", "LOSS", start + HOUR), c: game("c", "LOSS", start + 2 * HOUR), outside: game("d", "WIN", end), old: game("e", "WIN", start - 1), live: { ...game("f", "WIN", start), status: "live" } };
  const before = JSON.stringify(state);
  const payload = recapPayload(state, start, end), field = payload.embeds[0].fields[0];
  assert.match(field.value, /1W–2L/); assert.match(field.value, /\+70 LP/); assert.match(field.value, /-7 LP/);
  assert.match(payload.embeds[0].description, /Biggest observed Solo\/Duo climber/);
  assert.match(payload.embeds[0].description, /loss streak/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(JSON.stringify(state), before);
  state.rank_history = history().slice(2);
  assert.doesNotMatch(recapPayload(state, start, end).embeds[0].description, /climber/);
});

test("ten-player recap fits Discord limits and archived players are excluded", () => {
  const state = { ...tracker("@everyone"), roster_version: 2, additional_summoners: {} };
  state.rank_history = history();
  for (let i = 0; i < 9; i++) state.additional_summoners[i] = tracker("Long".repeat(15) + i, { rank_history: history() });
  state.additional_summoners.archived = tracker("Archived", { removed_at: "2026-01-01", monitor_paused: true });
  const embed = recapPayload(state, start, end).embeds[0];
  assert.equal(embed.fields.length, 10);
  assert.ok(embed.fields.every((f) => f.value.length <= 1024 && f.name.length <= 256));
  const length = embed.title.length + embed.description.length + embed.footer.text.length + embed.author.name.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  assert.ok(length <= 6000, `Embed length ${length}`);
  assert.doesNotMatch(JSON.stringify(embed), /@everyone|Archived/);
});

test("configuration is admin-only, scoped to guild, off by default and channel explicit", async () => {
  const db = testDb(stateFixture()), env = envFixture(db);
  assert.match((await weeklyCommand(subcommand("weekly", "status"), env, start)).content, /disabled/);
  await assert.rejects(weeklyCommand(subcommand("weekly", "enable", {}, { member: { permissions: "0" } }), env), /permission/);
  await assert.rejects(summaryCommand(interaction("summary", {}, { guild_id: "other" }), env), /configured tracking server/);
  await weeklyCommand(subcommand("weekly", "enable"), env, start);
  assert.equal((await readRecord(db, key)).nextDue, end);
  assert.equal((await readRecord(db, key)).channel, "789");
  await weeklyCommand(subcommand("weekly", "disable"), env, start);
  assert.equal((await readRecord(db, key)).enabled, false);
});

test("signed summary needs no summoner; weekly controls defer privately", async (t) => {
  const env = envFixture(testDb(stateFixture())), replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { assert.match(String(url), /discord.com\/api\/v10\/webhooks/); replies.push(JSON.parse(init.body)); return Response.json({ id: "999" }); });
  const result = await signedRun(interaction("summary", { private: true }, { member: { user: { id: "111" }, permissions: "0" } }), env);
  assert.equal(result.type, 5); assert.equal(result.data.flags, 64);
  assert.match(replies.at(-1).embeds[0].title, /Weekly server summary/);
  assert.equal((await signedRun(subcommand("weekly", "status"), env)).data.flags, 64);
  assert.equal((await signedRun(subcommand("weekly", "enable", {}, { member: { permissions: "0" } }), env)).type, 4);
});

test("weekly delivery is once per period under concurrent cron and keeps monitor state unchanged", async () => {
  const state = stateFixture(), db = testDb(state), env = envFixture(db); let calls = 0;
  await writeRecord(db, key, enabled());
  const mock = async (url, init) => { calls++; assert.match(url, /channels\/789\/messages/); assert.deepEqual(JSON.parse(init.body).allowed_mentions, { parse: [] }); return Response.json({ id: "999" }); };
  await runWeeklyRecap(env, end - 1, mock); assert.equal(calls, 0);
  await Promise.all([runWeeklyRecap(env, end, mock), runWeeklyRecap(env, end, mock)]);
  await runWeeklyRecap(env, end + 60000, mock); assert.equal(calls, 1);
  assert.equal((await readRecord(db, key)).lastStatus, "sent");
  assert.equal(db.sqlite.prepare("SELECT state_json FROM monitor_state").get().state_json, JSON.stringify(state));
});

test("Discord rate limit respects retry time and permission failures back off", async () => {
  const db = testDb(stateFixture()), env = envFixture(db); let calls = 0;
  await writeRecord(db, key, enabled());
  await runWeeklyRecap(env, end, async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "180" } }); });
  const mock = async () => { calls++; return Response.json({ id: "999" }); };
  await runWeeklyRecap(env, end + 60000, mock); assert.equal(calls, 1);
  await runWeeklyRecap(env, end + 180000, mock); assert.equal(calls, 2);
  await writeRecord(db, key, enabled());
  await runWeeklyRecap(env, end, async () => new Response("", { status: 403 }));
  assert.equal((await readRecord(db, key)).retryAt, end + HOUR);
});

test("ambiguous delivery and crash markers are never automatically resent", async () => {
  for (const crash of [false, true]) {
    const db = testDb(stateFixture()), env = envFixture(db); let calls = 0;
    await writeRecord(db, key, enabled(crash ? { attempt: end } : {}));
    const mock = async () => { calls++; throw new Error("timeout after acceptance"); };
    await runWeeklyRecap(env, end, mock); await runWeeklyRecap(env, end + 60000, mock);
    assert.equal(calls, crash ? 0 : 1); assert.match((await readRecord(db, key)).lastStatus, /uncertain/);
  }
});

test("disabled, missing configuration and unavailable state never send; outage catches up only latest week", async () => {
  const db = testDb(stateFixture()), env = envFixture(db); let calls = 0;
  const mock = async () => { calls++; return Response.json({ id: "999" }); };
  await runWeeklyRecap(env, end, mock); assert.equal(calls, 0);
  await writeRecord(db, key, enabled());
  await runWeeklyRecap({ ...env, MONITOR_ENABLED: "false" }, end, mock); assert.equal(calls, 0);
  await runWeeklyRecap(env, end + 2 * WEEK, mock); assert.equal(calls, 1);
  assert.equal((await readRecord(db, key)).nextDue, end + 3 * WEEK);
  await writeRecord(db, key, enabled()); db.sqlite.exec("DELETE FROM monitor_state");
  await assert.rejects(runWeeklyRecap(env, end, mock), /missing/); assert.equal(calls, 1);
  assert.equal((await readRecord(db, key)).attempt, undefined);
});

test("resumed trackers cannot compare LP across their paused baseline", () => {
  const state = stateFixture(); state.rank_history = history(); state.monitor_started_at = new Date(end - DAY).toISOString();
  const payload = recapPayload(state, start, end);
  assert.match(payload.embeds[0].fields[0].value, /\+10 LP/);
  assert.match(payload.embeds[0].fields[0].value, /partial period/);
  assert.doesNotMatch(payload.embeds[0].description, /climber/);
});
