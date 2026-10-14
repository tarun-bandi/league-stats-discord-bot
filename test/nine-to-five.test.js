import test from "node:test";
import assert from "node:assert/strict";
import { easternParts, workdayWindow, rememberWorkdayGame, workdayCount } from "../src/workday.js";
import { runNineToFive, nineToFiveCommand, nineToFiveStatus, workdayRows, workdayPayload } from "../src/nine-to-five.js";
import { readRecord, writeRecord } from "../src/store.js";
import { readState } from "../src/monitor.js";
import worker, { autocompleteResponse } from "../src/index.js";
import { COMMANDS } from "../src/commands.js";
import { testDb, stateFixture, tracker, envFixture, interaction } from "./helpers/db.js";

const date = "2026-10-13";
const close = Date.parse(`${date}T21:00:00Z`);
const record = (id, start, status = "completed") => ({ match_id: `NA1_${id}`, riot_game_id: String(id), status, start_time: `${date}T${start}Z` });
const fixture = () => {
  const state = stateFixture();
  state.last_check_at = new Date(close).toISOString();
  state.reported_games = { one: record(1, "13:00:00"), two: record(2, "20:59:59", "live") };
  return state;
};
const persistState = (db, state) => db.sqlite.prepare("UPDATE monitor_state SET state_json=?").run(JSON.stringify(state));
const deliver = (calls) => async (url, init) => {
  calls.push({ url, ...init, body: JSON.parse(init.body) });
  return Response.json({ id: init.method === "PATCH" ? url.split("/").at(-1) : String(900 + calls.length) });
};

test("workday boundaries follow Eastern DST, including transition days and local midnight", () => {
  for (const [day, start, end] of [
    ["2026-07-04", "13:00", "21:00"], // weekends included
    ["2026-01-13", "14:00", "22:00"],
    ["2026-03-08", "13:00", "21:00"],
    ["2026-11-01", "14:00", "22:00"],
  ]) assert.deepEqual(workdayWindow(day), { start: Date.parse(`${day}T${start}:00Z`), end: Date.parse(`${day}T${end}:00Z`) });
  assert.equal(easternParts(Date.parse("2026-10-14T03:59:59Z")).date, date);
  assert.equal(easternParts(Date.parse("2026-10-14T04:00:00Z")).date, "2026-10-14");
  assert.throws(() => workdayWindow("2026-02-30"), /Invalid/);
});

test("counts starts inclusively at 9, exclusively at 5, not overlaps or detection times", () => {
  const player = tracker();
  player.reported_games = {
    before: { ...record(0, "12:59:59"), duration: "90m", detected_at: new Date(close).toISOString() },
    first: record(1, "13:00:00"), last: record(2, "20:59:59", "live"),
    after: record(3, "21:00:00"), invalid: { status: "completed", start_time: "broken" },
    rank: { ...record(4, "15:00:00"), kind: "demotion" },
    yesterday: { ...record(5, "15:00:00"), start_time: "2026-10-12T15:00:00Z" },
  };
  assert.equal(workdayCount(player, date, close), 2);
  assert.equal(workdayCount(player, date, Date.parse(`${date}T15:00:00Z`)), 1);
});

test("live and completed aliases count once; completion can correct the start boundary", () => {
  const player = tracker();
  rememberWorkdayGame(player, { ...record(1, "20:59:59", "live"), match_id: null, live_game_id: "1" }, close);
  player.reported_games["live:1"] = { ...record(1, "20:59:59"), live_game_id: "1" };
  player.reported_games.NA1_1 = record(1, "20:59:59");
  assert.equal(workdayCount(player, date, close), 1);
  player.reported_games.NA1_1 = record(1, "21:00:00");
  assert.equal(workdayCount(player, date, close), 0);
  assert.deepEqual(Object.keys(player.nine_to_five_games), ["1"]);
});

test("live observations persist without creating alert records and prune only their small count cache", () => {
  const player = tracker();
  player.reported_games.historical = record(99, "13:00:00");
  player.nine_to_five_games = { old: { start_time: "2020-01-01T14:00:00Z" } };
  rememberWorkdayGame(player, record(2, "20:30:00", "live"), close);
  assert.equal(workdayCount(player, date, close), 2);
  assert.ok(player.reported_games.historical);
  assert.equal(player.reported_games.NA1_2, undefined);
  assert.equal(player.nine_to_five_games.old, undefined);
});

test("report covers all active players, all modes, zeroes, renamed accounts and partial enrollment", () => {
  const state = fixture(); state.roster_version = 2;
  state.additional_summoners.b.summoner.riot_id = "Renamed#NA1";
  state.additional_summoners.b.monitor_started_at = `${date}T14:00:00Z`;
  state.additional_summoners.c.monitor_paused = true;
  state.additional_summoners.c.reported_games = { shared: { ...record(1, "13:00:00"), queue_id: 450 } };
  state.additional_summoners.archived = tracker("Archived", { removed_at: `${date}T12:00:00Z`, monitor_paused: true });
  const rows = workdayRows(state, date, close);
  assert.deepEqual(rows.map((row) => [row.riotId, row.count]), [["Test#NA1", 2], ["Third#NA1", 1], ["Renamed#NA1", 0]]);
  assert.ok(rows.find((row) => row.riotId === "Renamed#NA1").partial);
  const payload = workdayPayload(rows, date, close);
  assert.match(payload.embeds[0].description, /3 player-games/);
  assert.match(payload.embeds[0].description, /partial tracking/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("daily report posts at 5, stays quiet unchanged, patches late games and retains match history", async () => {
  const state = fixture(); const db = testDb(state); const env = envFixture(db); const calls = [];
  const options = { now: close - 1, fetchImpl: deliver(calls) };
  await runNineToFive(env, options); assert.equal(calls.length, 0);
  await runNineToFive(env, { ...options, now: close }); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.com/api/v10/channels/789/messages");
  assert.equal(calls[0].headers.Authorization, "Bot test-bot-token");
  assert.equal(calls[0].body.enforce_nonce, true);
  assert.ok(calls[0].body.nonce.length <= 25);
  assert.equal((await readRecord(db, `nine-to-five:day:${date}`)).messageId, "901");
  for (let minute = 1; minute <= 7; minute++) await runNineToFive(env, { ...options, now: close + minute * 60_000 });
  assert.equal(calls.length, 1);
  state.reported_games.late = record(3, "19:00:00"); persistState(db, state);
  for (let minute = 8; minute <= 15; minute++) await runNineToFive(env, { ...options, now: close + minute * 60_000 });
  assert.equal(calls.length, 2); assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].url, "https://discord.com/api/v10/channels/789/messages/901");
  assert.match(calls[1].body.embeds[0].description, /3 player-games/);
  assert.deepEqual(calls[1].body.allowed_mentions, { parse: [] });
  assert.deepEqual(await readState(db), state);
  assert.equal((await nineToFiveStatus(env)).lastReportDate, date);
});

test("zero-game days still surface, first rollout does not replay previous days, overdue days catch up", async () => {
  const state = stateFixture(); const db = testDb(state); const env = envFixture(db); const calls = [];
  await runNineToFive(env, { now: close - 3600_000, fetchImpl: deliver(calls) });
  assert.equal(calls.length, 0);
  assert.equal((await nineToFiveStatus(env)).firstDate, date);
  await runNineToFive(env, { now: close + 86400_000, fetchImpl: deliver(calls) });
  assert.equal(calls.length, 1); assert.match(calls[0].body.embeds[0].title, /2026-10-13/);
  assert.match(calls[0].body.embeds[0].description, /0 player-games/);
  assert.match(calls[0].body.embeds[0].description, /data is delayed/);
  await runNineToFive(env, { now: close + 86400_000 + 60_000, fetchImpl: deliver(calls) });
  assert.equal(calls.length, 2); assert.match(calls[1].body.embeds[0].title, /2026-10-14/);
});

test("delivery failure retries with the same nonce; no cursor or reported-game mutations", async () => {
  const state = fixture(); const db = testDb(state); const env = envFixture(db); const calls = [];
  await assert.rejects(runNineToFive(env, { now: close, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(null, { status: 429 }); } }), /429/);
  assert.deepEqual(await readState(db), state);
  assert.equal((await nineToFiveStatus(env)).nextDate, date);
  assert.equal((await nineToFiveStatus(env)).deliveryError, true);
  const successful = [];
  await runNineToFive(env, { now: close + 60_000, fetchImpl: deliver(successful) });
  assert.equal(successful[0].body.nonce, calls[0].nonce);
  assert.equal((await nineToFiveStatus(env)).deliveryError, false);
});

test("failed PATCH retains the original message ID and retries an edit, never another POST", async () => {
  const state = fixture(); const db = testDb(state); const env = envFixture(db); const calls = [];
  await runNineToFive(env, { now: close, fetchImpl: deliver(calls) });
  state.reported_games.late = record(3, "16:00:00"); persistState(db, state);
  const job = await readRecord(db, "nine-to-five:schedule"); job.reconcileOffset = 0;
  await writeRecord(db, "nine-to-five:schedule", job);
  await assert.rejects(runNineToFive(env, { now: close + 60_000, fetchImpl: async () => new Response(null, { status: 503 }) }), /503/);
  assert.equal((await readRecord(db, `nine-to-five:day:${date}`)).messageId, "901");
  await runNineToFive(env, { now: close + 120_000, fetchImpl: deliver(calls) });
  assert.deepEqual(calls.map((call) => call.method), ["POST", "PATCH"]);
});

test("overlapping scheduled ticks share a lease; disabled/corrupt-state runs never post", async () => {
  const db = testDb(fixture()); const env = envFixture(db); const calls = [];
  await Promise.all([runNineToFive(env, { now: close, fetchImpl: deliver(calls) }), runNineToFive(env, { now: close, fetchImpl: deliver(calls) })]);
  assert.equal(calls.length, 1);
  const bad = { MONITOR_ENABLED: "false", MONITOR_DB: { prepare() { throw new Error("Must not query"); } } };
  assert.equal((await runNineToFive(bad)).status, "disabled");
  await worker.scheduled({ scheduledTime: close }, bad);
  await assert.rejects(runNineToFive(envFixture(testDb()), { now: close, fetchImpl: deliver(calls) }), /missing/);
  assert.equal(calls.length, 1);
});

test("on-demand 9-5 supports the roster or one player without Riot requests or persisted report changes", async () => {
  const db = testDb(fixture()); const env = envFixture(db);
  const result = await nineToFiveCommand(interaction("9-5"), env, close);
  assert.match(result.embeds[0].description, /Test#NA1/); assert.match(result.embeds[0].description, /Other#NA1/);
  const single = await nineToFiveCommand(interaction("9-5", { summoner: "test#na1" }), env, close);
  assert.match(single.embeds[0].description, /Test#NA1/); assert.doesNotMatch(single.embeds[0].description, /Other#NA1/);
  await assert.rejects(nineToFiveCommand(interaction("9-5", { summoner: "Stranger#NA1" }), env, close), /not in today's/);
  await assert.rejects(nineToFiveCommand(interaction("9-5", {}, { guild_id: "elsewhere" }), env, close), /configured alerts server/);
  assert.equal(await readRecord(db, "nine-to-five:schedule"), null);
  assert.equal(COMMANDS.find((command) => command.name === "9-5").options[0].required, false);
  const response = await autocompleteResponse({ data: { name: "9-5", options: [{ name: "summoner", value: "oth", focused: true }] } }, env);
  assert.deepEqual((await response.json()).data.choices, [{ name: "Other#NA1", value: "Other#NA1" }]);
});

test("signed 9-5 interaction honors private default but never narrows roster to profile summoner", async (t) => {
  const db = testDb(fixture()); const env = envFixture(db);
  await writeRecord(db, "profile:456:111", { summoner: "Test#NA1", private: true, timezone: "Europe/London" });
  const replies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { replies.push(JSON.parse(init.body)); return Response.json({ id: "999" }); });
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  const body = JSON.stringify(interaction("9-5")); const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body))).toString("hex");
  const pending = [];
  const response = await worker.fetch(new Request("https://worker.test", { method: "POST", body, headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp } }), { ...env, DISCORD_PUBLIC_KEY: publicKey }, { waitUntil: (promise) => pending.push(promise) });
  assert.equal((await response.json()).data.flags, 64);
  await Promise.all(pending);
  assert.match(replies[0].embeds[0].description, /Other#NA1/);
  assert.match(replies[0].embeds[0].description, /America\/New_York/);
  assert.deepEqual(replies[0].allowed_mentions, { parse: [] });
});
