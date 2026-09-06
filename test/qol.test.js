import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { profileCommand, createLookup, updateLookup, resolveView, startOfDay, observedLp, buildSessionResponse, championModal } from "../src/features.js";
import { withDefaults, readProfile } from "../src/preferences.js";
import { readRecord, writeRecord, leaseRecord, releaseRecord, purgeExpiredRecords } from "../src/store.js";
import { testDb, interaction, subcommand, envFixture, stateFixture, game, mockLookup } from "./helpers/db.js";

async function signedRun(command, env) {
  const key = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", key.publicKey)).toString("hex");
  const body = JSON.stringify(command); const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(timestamp + body))).toString("hex");
  const pending = [];
  const response = await worker.fetch(new Request("https://worker.test/", { method: "POST", body, headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp } }), { ...env, DISCORD_PUBLIC_KEY: publicKey }, { waitUntil: (promise) => pending.push(promise) });
  const result = await response.json();
  await Promise.all(pending);
  return result;
}

const click = (view, action, extra = {}) => interaction("", {}, { type: 3, data: { custom_id: `ls:${view.id}:${action}` }, ...extra });
async function savedView(db, payload) {
  const id = payload.components[0].components[0].custom_id.split(":")[1];
  return readRecord(db, `view:${id}`);
}

test("profiles are isolated by guild/user, explicit options override, clear restores defaults", async () => {
  const db = testDb(); const env = envFixture(db);
  await profileCommand(subcommand("profile", "set", { summoner: "Test#NA1", region: "euw", mode: 450, private: true, timezone: "Europe/London" }), env);
  const profile = await readProfile(interaction("stats"), env);
  assert.equal(profile.region, "euw"); assert.equal(profile.private, true);
  const effective = withDefaults(interaction("stats", { mode: 420, private: false }), profile);
  assert.equal(effective.data.options.find((option) => option.name === "mode").value, 420);
  assert.equal(effective.data.options.find((option) => option.name === "private").value, false);
  assert.deepEqual(await readProfile(interaction("stats", {}, { guild_id: "another" }), env), {});
  assert.deepEqual(await readProfile(interaction("stats", {}, { member: { user: { id: "222" } } }), env), {});
  await assert.rejects(profileCommand(subcommand("profile", "set", { timezone: "Not/AZone" }), env), /IANA/);
  await profileCommand(subcommand("profile", "clear"), env);
  assert.deepEqual(await readProfile(interaction("stats"), env), {});
});

test("signed lookups honor private defaults before defer and permit explicit public override", async (t) => {
  const db = testDb(); const env = envFixture(db); const replies = [];
  mockLookup(t, [game(1)], { onRequest: (url, init) => { if (url.hostname === "discord.com") replies.push(JSON.parse(init.body)); } });
  await profileCommand(subcommand("profile", "set", { summoner: "Test#NA1", private: true }), env);
  const response = await signedRun(interaction("stats"), env);
  assert.equal(response.type, 5); assert.equal(response.data.flags, 64);
  assert.match(replies.at(-1).embeds[0].title, /Test#NA1/);
  assert.deepEqual(replies.at(-1).allowed_mentions, { parse: [] });
  const publicResponse = await signedRun(interaction("stats", { private: false }), env);
  assert.equal(publicResponse.data.flags, undefined);
  assert.equal((await signedRun(subcommand("profile", "show"), env)).data.flags, 64);
});

test("missing defaults and storage failures fail privately without Riot requests", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No external calls expected"); });
  const missing = await signedRun(interaction("stats"), envFixture(testDb()));
  assert.equal(missing.type, 4); assert.equal(missing.data.flags, 64); assert.match(missing.data.content, /profile set/);
  const failed = await signedRun(interaction("stats", { summoner: "Test#NA1" }), { MONITOR_DB: { prepare: () => { throw new Error("Storage down"); } } });
  assert.equal(failed.data.flags, 64); assert.match(failed.data.content, /Nothing was posted publicly/);
});

test("unverified Discord requests cannot mutate profiles or tracking", async () => {
  const db = testDb(stateFixture());
  const response = await worker.fetch(new Request("https://worker.test/", { method: "POST", body: JSON.stringify(subcommand("track", "remove", { summoner: "Test#NA1" })) }), envFixture(db), {});
  assert.equal(response.status, 401); assert.equal(db.queries, 0);
});

test("cached load-more finds older champion games, deduplicates and retains a fixed range", async (t) => {
  const db = testDb(); const env = envFixture(db); const requests = [];
  const games = Array.from({ length: 61 }, (_, i) => game(1000 - i, i < 30 ? "Chogath" : "Zed"));
  mockLookup(t, games, { onRequest: (url) => requests.push(url) });
  const initial = await createLookup(interaction("stats", { summoner: "Test#NA1", champion: "Zed" }), env);
  assert.match(initial.embeds[0].description, /No Zed games/);
  const view = await savedView(db, initial);
  const updated = await updateLookup(click(view, "more"), env);
  assert.match(updated.embeds[0].description, /30 Zed games in the 60 newest games/);
  const after = await readRecord(db, `view:${view.id}`);
  assert.equal(after.snapshot.endTime, view.snapshot.endTime);
  assert.equal(new Set(after.snapshot.matches.map((match) => match.metadata.matchId)).size, 60);
  assert.ok(after.snapshot.matches.every((match) => match.info.participants.length === 1));
  const last = await updateLookup(click(view, "more"), env);
  assert.match(last.embeds[0].description, /31 Zed games in the 61 newest games/);
  assert.equal((await readRecord(db, `view:${view.id}`)).snapshot.more, false);
  assert.deepEqual(requests.filter((url) => url.pathname.endsWith("/ids")).map((url) => url.searchParams.get("start")), ["0", "30", "60"]);
});

test("recent pages move both directions and only fetch uncached pages", async (t) => {
  const db = testDb(); const env = envFixture(db); let matchRequests = 0;
  mockLookup(t, Array.from({ length: 12 }, (_, i) => game(100 - i)), { onRequest: (url) => { if (url.pathname.includes("/lol/match/")) matchRequests++; } });
  const initial = await createLookup(interaction("recent", { summoner: "Test#NA1" }), env);
  assert.equal(initial.embeds.length, 5);
  const view = await savedView(db, initial);
  const next = await updateLookup(click(view, "next"), env); assert.match(next.embeds[0].title, /page 2/);
  const calls = matchRequests;
  const previous = await updateLookup(click(view, "previous"), env); assert.match(previous.embeds[0].title, /page 1/);
  await updateLookup(click(view, "next"), env); assert.equal(matchRequests, calls);
  const last = await updateLookup(click(view, "next"), env); assert.equal(last.embeds.length, 2);
  assert.equal(last.components[0].components[1].disabled, true);
});

test("card controls change period/champion and deny other users, servers and expired cards", async (t) => {
  const db = testDb(); const env = envFixture(db); mockLookup(t, [game(1)]);
  const initial = await createLookup(interaction("stats", { summoner: "Test#NA1" }), env);
  const view = await savedView(db, initial);
  assert.match((await updateLookup(click(view, "days30"), env)).embeds[0].title, /last 30 days/);
  assert.match((await updateLookup(click(view, "days7"), env)).embeds[0].title, /last 7 days/);
  assert.equal(championModal(view).type, 9);
  const form = click(view, "choose", { type: 5, data: { custom_id: `ls:${view.id}:choose`, components: [{ type: 1, components: [{ custom_id: "champion", value: "Zed" }] }] } });
  assert.match((await updateLookup(form, env)).embeds[0].title, /Zed/);
  assert.doesNotMatch((await updateLookup(click(view, "all"), env)).embeds[0].title, /Zed/);
  for (const overrides of [{ guild_id: "different" }, { channel_id: "different" }, { member: { user: { id: "222" } } }]) await assert.rejects(resolveView(click(view, "more", overrides), env), /Only the person/);
  await writeRecord(db, `view:${view.id}`, view, Date.now() - 1);
  await assert.rejects(resolveView(click(view, "more"), env), /expired/);
  await purgeExpiredRecords(db); assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM bot_records").get().n, 0);
});

test("simultaneous clicks cannot overwrite a leased history view", async (t) => {
  const db = testDb(); const env = envFixture(db); mockLookup(t, [game(1)]);
  const view = await savedView(db, await createLookup(interaction("stats", { summoner: "Test#NA1" }), env));
  assert.equal(await leaseRecord(db, `view:${view.id}`, "other"), true);
  await assert.rejects(updateLookup(click(view, "days30"), env), /already updating/);
  assert.equal((await readRecord(db, `view:${view.id}`)).query.days, undefined);
  await releaseRecord(db, `view:${view.id}`, "other");
});

test("signed button and modal interactions update in place, while errors stay private", async (t) => {
  const db = testDb(); const env = envFixture(db); const calls = [];
  mockLookup(t, [game(1)], { onRequest: (url, init) => { if (url.hostname === "discord.com") calls.push({ path: url.pathname, method: init.method, body: JSON.parse(init.body) }); } });
  const view = await savedView(db, await createLookup(interaction("stats", { summoner: "Test#NA1" }), env));
  const button = await signedRun(click(view, "days30"), env);
  assert.equal(button.type, 6); assert.equal(calls.at(-1).method, "PATCH");
  assert.match(calls.at(-1).body.embeds[0].title, /last 30 days/);
  const modal = await signedRun(click(view, "champion"), env); assert.equal(modal.type, 9);
  const form = click(view, "choose", { type: 5, data: { custom_id: modal.data.custom_id, components: [{ type: 1, components: [{ custom_id: "champion", value: "invalid-champion" }] }] } });
  assert.equal((await signedRun(form, env)).type, 6);
  assert.equal(calls.at(-1).method, "POST"); assert.equal(calls.at(-1).body.flags, 64);
  assert.match(calls.at(-1).body.content, /Unknown champion/);
  assert.equal((await readRecord(db, `view:${view.id}`)).query.champion, undefined);
});

test("local-midnight boundaries handle spring/fall daylight saving", () => {
  assert.equal(new Date(startOfDay(Date.parse("2026-03-08T12:00:00Z"), "America/New_York")).toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(new Date(startOfDay(Date.parse("2026-11-01T12:00:00Z"), "America/New_York")).toISOString(), "2026-11-01T04:00:00.000Z");
});

test("session shows today's record, time, best champion and honest observed LP", async (t) => {
  const now = Date.now(); const midnight = startOfDay(now, "UTC");
  const state = stateFixture(); state.rank_history = [{ at: new Date(midnight + 1000).toISOString(), entries: { RANKED_SOLO_5x5: { tier: "GOLD", rank: "II", leaguePoints: 30, wins: 10, losses: 10 } } }];
  const current = { queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank: "II", leaguePoints: 55, wins: 11, losses: 10 };
  mockLookup(t, [game(1, "Zed", "Test", true, midnight + 2000), game(2, "Chogath", "Test", false, midnight + 1000), game(3, "Zed", "Test", true, midnight - 1000)], { ranked: [current] });
  const payload = await buildSessionResponse(interaction("session", { summoner: "Test#NA1", timezone: "UTC" }), envFixture(testDb(state)));
  assert.match(payload.embeds[0].description, /1W–1L/); assert.match(payload.embeds[0].description, /1h 0m played across 2 games/);
  assert.match(payload.embeds[0].fields[0].value, /Zed: 1W–0L/);
  assert.match(payload.embeds[0].fields[2].value, /\+25 LP since/);
  assert.match(observedLp(state.rank_history, [{ ...current, wins: 0 }], midnight), /No same-day/);
  assert.match(observedLp([], [current], midnight), /not reconstructed/);
});

test("full interactive cold-cache stats stays within 50 subrequests including D1 and reply", async (t) => {
  const db = testDb(); const env = envFixture(db); let external = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: { match: async () => { external++; }, put: async () => { external++; } } } });
  t.after(() => previous ? Object.defineProperty(globalThis, "caches", previous) : delete globalThis.caches);
  mockLookup(t, Array.from({ length: 30 }, (_, i) => game(i)), { onRequest: () => external++ });
  await signedRun(interaction("stats", { summoner: "Test#NA1" }), env);
  assert.ok(external + db.queries <= 50, `${external + db.queries} subrequests`);
});
