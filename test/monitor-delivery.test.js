import test from "node:test";
import assert from "node:assert/strict";
import { acquireLease, commitMonitorChanges, readState, recoverMonitorDelivery, releaseLease, runLeagueMonitor, monitorStatus } from "../src/monitor.js";
import { readFileSync } from "node:fs";
import { monitorDeliveryNonce, readMonitorDelivery } from "../src/monitor-delivery.js";
import { observeRanks } from "../src/ranks.js";
import { testDb, stateFixture, envFixture, game } from "./helpers/db.js";

const now = Date.parse("2026-11-01T16:00:00Z");
const at = new Date(now).toISOString();
const completed = (id) => ({ status: "completed", match_id: `NA1_${id}`, riot_game_id: String(id), champion: "Zed", queue: "Ranked Solo/Duo", start_time: at, detected_at: at, result: "WIN", duration: "30m 00s" });

async function fixture(t) {
  t.mock.method(Date, "now", () => now);
  const initial = stateFixture();
  initial.reported_games["live:90"] = { ...completed(90), status: "live", discord_message_id: "90", discord_channel_id: "789" };
  const db = testDb(initial);
  await acquireLease(db, now, "owner");
  const state = structuredClone(initial);
  state.reported_games["live:90"].status = "completed";
  const record = completed(200);
  state.additional_summoners.b.reported_games.NA1_200 = record;
  const plan = { state, owner: "owner", detectionIso: at,
    newAlerts: [{ stateKey: "b", riotId: "Other#NA1", record }],
    patchTargets: new Map([["90", { messageId: "90", channelId: "789" }]]) };
  return { db, initial, plan, env: envFixture(db) };
}

test("a failed completion edit cannot send the same new alerts on every retry", async (t) => {
  const { db, initial, plan, env } = await fixture(t);
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init.method);
    return init.method === "POST" ? Response.json({ id: "999" }) : new Response(null, { status: 503 });
  };
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(commitMonitorChanges(env, structuredClone(plan), { fetchImpl }), /Discord bot PATCH failed/);
    assert.deepEqual(await readState(db), initial);
  }
  assert.equal(calls.filter((method) => method === "POST").length, 0);
});

test("Unknown Message closes a deleted grouped alert, retaining every game and sending only the new game", async (t) => {
  const { db, plan, env } = await fixture(t);
  plan.state.additional_summoners.c.reported_games["live:90"] = { ...plan.state.reported_games["live:90"], champion: "Lux", status: "live" };
  const calls = [];
  await commitMonitorChanges(env, plan, { fetchImpl: async (_url, init) => {
    calls.push(init);
    return init.method === "PATCH" ? Response.json({ code: 10008 }, { status: 404 }) : Response.json({ id: "999" });
  } });
  assert.deepEqual(calls.map((call) => call.method), ["PATCH", "POST"]);
  assert.equal(JSON.parse(calls[0].body).embeds.length, 2);
  const posted = JSON.parse(calls[1].body);
  assert.equal(posted.embeds.length, 1);
  assert.equal(posted.enforce_nonce, true);
  assert.ok(posted.nonce.length <= 25);
  for (const call of calls) assert.deepEqual(JSON.parse(call.body).allowed_mentions, { parse: [] });
  const saved = await readState(db);
  for (const tracker of [saved, saved.additional_summoners.c]) {
    assert.equal(tracker.reported_games["live:90"].discord_message_id, "90");
    assert.equal(tracker.reported_games["live:90"].discord_message_deleted_at, at);
  }
  assert.equal(saved.additional_summoners.b.reported_games.NA1_200.discord_message_id, "999");
});

for (const [status, code] of [[404, 10003], [403, 50013], [429, 0]]) {
  test(`PATCH ${status}/${code} is not mistaken for a deleted message`, async (t) => {
    const { db, initial, plan, env } = await fixture(t);
    const methods = [];
    await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl: async (_url, init) => {
      methods.push(init.method); return Response.json({ code }, { status });
    } }), /Discord bot PATCH failed/);
    assert.deepEqual(methods, ["PATCH"]);
    assert.deepEqual(await readState(db), initial);
    assert.equal(await readMonitorDelivery(db), null);
  });
}

test("all grouped payloads are validated before any external delivery", async (t) => {
  const { plan, env } = await fixture(t);
  plan.patchTargets.set("missing", { messageId: "missing" });
  let requests = 0;
  await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl: async () => { requests++; } }), /payload is empty/);
  assert.equal(requests, 0);
});

for (const status of ["completed", "live"]) test(`a successful ${status} POST survives a failed D1 save and subsequent crons never repost it`, async (t) => {
  const { db, initial, plan, env } = await fixture(t);
  const recordKey = status === "live" ? "live:200" : "NA1_200";
  if (status === "live") {
    const record = plan.newAlerts[0].record;
    Object.assign(record, { status: "live", live_game_id: "200", match_id: null });
    delete plan.state.additional_summoners.b.reported_games.NA1_200;
    plan.state.additional_summoners.b.reported_games[recordKey] = record;
  }
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, ...init });
    if (url.hostname === "discord.com") return Response.json({ id: "999" });
    if (url.pathname.includes("/realms/")) return Response.json({ v: "unavailable" });
    if (url.pathname.includes("/accounts/")) {
      const name = url.pathname.split("/").at(-1);
      return Response.json({ puuid: name, gameName: name, tagLine: "NA1" });
    }
    if (url.pathname.endsWith("/ids")) return Response.json(url.pathname.includes("/Other/") ? ["NA1_200", "NA1_100"] : ["NA1_100"]);
    if (url.pathname.includes("active-games")) return new Response(null, { status: 404 });
    if (url.pathname.includes("league/v4")) return Response.json([]);
    if (url.pathname.endsWith("NA1_200")) return Response.json(game(200, "Zed", "Other", true, now));
    if (url.pathname.endsWith("NA1_90")) return Response.json(game(90, "Zed", "Test", true, now));
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  };
  await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl, saveStateImpl: async () => { throw new Error("D1 unavailable"); } }), /D1 unavailable/);
  assert.deepEqual(await readState(db), initial);
  assert.equal((await readMonitorDelivery(db)).messageId, "999");
  await releaseLease(db, "owner");
  t.mock.method(globalThis, "fetch", fetchImpl);
  await runLeagueMonitor(env);
  await runLeagueMonitor(env);
  const saved = await readState(db);
  assert.equal(saved.additional_summoners.b.reported_games[recordKey].discord_message_id, "999");
  assert.equal(saved.additional_summoners.b.reported_games[recordKey].status, "completed");
  assert.equal(saved.additional_summoners.b.riot_newest_completed_match_id, "NA1_200");
  assert.equal(saved.reported_games["live:90"].status, "completed");
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
  if (status === "live") assert.ok(requests.some((request) => request.method === "PATCH" && request.url.pathname.endsWith("/999")), "completion edits the original recovered live alert");
  assert.equal((await monitorStatus(env)).delivery.status, "idle");
});

test("receipt checkpoint failure retains recovery data and sends nothing", async (t) => {
  const { db, plan, env } = await fixture(t);
  await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl: async () => Response.json({ id: "999" }), saveStateImpl: async () => { throw new Error("D1 unavailable"); } }), /D1 unavailable/);
  await releaseLease(db, "owner");
  const prepare = db.prepare.bind(db);
  const broken = t.mock.method(db, "prepare", (sql) => {
    if (sql.startsWith("UPDATE monitor_state SET state_json=")) throw new Error("checkpoint unavailable");
    return prepare(sql);
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not send"); });
  await assert.rejects(runLeagueMonitor(env), /checkpoint unavailable/);
  assert.equal((await readMonitorDelivery(db)).messageId, "999");
  broken.mock.restore();
  await acquireLease(db, now, "recovery");
  await recoverMonitorDelivery(db, "recovery", await readState(db));
  assert.equal((await readState(db)).additional_summoners.b.reported_games.NA1_200.discord_message_id, "999");
});

test("receipt recovery preserves roster edits, newer completion data, and unrelated history", async (t) => {
  const { db, plan, env } = await fixture(t);
  await commitMonitorChanges(env, plan, { fetchImpl: async () => Response.json({ id: "999" }) });
  const state = await readState(db);
  const other = state.additional_summoners.b;
  other.monitor_paused = true;
  other.summoner.riot_id = "Renamed#NA1";
  other.reported_games.NA1_200.result = "LOSS";
  state.additional_summoners.c.reported_games.NA1_400 = completed(400);
  state.alert_mode = "completed";
  await acquireLease(db, now, "next");
  await recoverMonitorDelivery(db, "next", state);
  assert.deepEqual(await readState(db), state);
  assert.equal(other.reported_games.NA1_200.result, "LOSS");
  assert.equal(other.monitor_paused, true);
  assert.equal(await readMonitorDelivery(db), null);
});

for (const failure of ["timeout", "5xx", "missing ID", "receipt write"]) {
  test(`${failure} after starting POST blocks all automatic resends, even days later`, async (t) => {
    const { db, initial, plan, env } = await fixture(t);
    plan.patchTargets.clear();
    if (failure === "receipt write") {
      const prepare = db.prepare.bind(db);
      t.mock.method(db, "prepare", (sql) => {
        if (sql.startsWith("UPDATE bot_records SET payload=")) throw new Error("receipt unavailable");
        return prepare(sql);
      });
    }
    let posts = 0;
    await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl: async () => {
      posts++;
      if (failure === "timeout") throw new Error("network timeout");
      if (failure === "5xx") return new Response(null, { status: 503 });
      return Response.json(failure === "missing ID" ? {} : { id: "999" });
    } }));
    assert.deepEqual(await readState(db), initial);
    assert.equal((await readMonitorDelivery(db)).status, "sending");
    await releaseLease(db, "owner");
    t.mock.method(Date, "now", () => now + 3 * 86400_000);
    t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call Riot or Discord"); });
    for (let retry = 0; retry < 2; retry++) await assert.rejects(runLeagueMonitor(env), /outcome is uncertain/);
    assert.equal(posts, 1);
    assert.deepEqual(await readState(db), initial);
    const status = await monitorStatus(env);
    assert.deepEqual(status.delivery, { status: "needs_review", attemptedAt: at });
    assert.ok(!JSON.stringify(status).includes("test-bot-token"));
  });
}

test("an explicit POST rejection can be retried without advancing cursors", async (t) => {
  const { db, initial, plan, env } = await fixture(t);
  plan.patchTargets.clear();
  await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl: async () => new Response(null, { status: 429 }) }), /HTTP 429/);
  assert.equal(await readMonitorDelivery(db), null);
  assert.deepEqual(await readState(db), initial);
  await commitMonitorChanges(env, plan, { fetchImpl: async () => Response.json({ id: "999" }) });
  assert.equal((await readState(db)).additional_summoners.b.reported_games.NA1_200.discord_message_id, "999");
});

test("a failed intent write or lost lease cannot send a message", async (t) => {
  const { db, plan, env } = await fixture(t);
  let requests = 0;
  const fetchImpl = async () => { requests++; };
  plan.patchTargets.clear();
  const prepare = db.prepare.bind(db);
  const mock = t.mock.method(db, "prepare", (sql) => {
    if (sql.startsWith("INSERT INTO bot_records")) throw new Error("intent unavailable");
    return prepare(sql);
  });
  await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl }), /intent unavailable/);
  mock.mock.restore();
  await releaseLease(db, "owner");
  await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl }), /lease was lost/);
  assert.equal(requests, 0);
});

test("recovering a grouped demotion restores its baseline so it is not alerted again", async (t) => {
  const { db, plan, env } = await fixture(t);
  plan.patchTargets.clear();
  const ranked = (rank) => [{ queueType: "RANKED_SOLO_5x5", tier: "GOLD", rank, leaguePoints: 20, wins: 10, losses: 10 }];
  observeRanks(plan.state, ranked("II"), new Date(now - 60_000).toISOString());
  const record = observeRanks(plan.state, ranked("III"), at)[0];
  plan.newAlerts.push({ riotId: "Test#NA1", record });
  await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl: async () => Response.json({ id: "999" }), saveStateImpl: async () => { throw new Error("D1 unavailable"); } }), /D1 unavailable/);
  const state = await readState(db);
  await recoverMonitorDelivery(db, "owner", state);
  assert.deepEqual(observeRanks(state, ranked("III"), new Date(now + 60_000).toISOString()), []);
  assert.equal(Object.values(state.reported_rank_changes)[0].discord_message_id, "999");
  assert.equal(state.additional_summoners.b.reported_games.NA1_200.discord_message_id, "999");
});


test("batch nonce is stable across order and presentation changes but scoped to identities and destination", async () => {
  const items = [
    { stateKey: "a", collection: "reported_games", recordKey: "NA1_200", record: completed(200) },
    { stateKey: "b", collection: "reported_rank_changes", recordKey: `solo:${at}:GOLD:III`, record: { kind: "demotion", status: "completed" } },
  ];
  const nonce = await monitorDeliveryNonce("789", items);
  assert.match(nonce, /^[a-f0-9]{24}$/);
  const reordered = structuredClone(items).reverse();
  reordered[1].record.detected_at = "2026-11-02T00:00:00Z";
  reordered[1].record.champion_icon_url = "https://example.invalid/new-icon";
  assert.equal(await monitorDeliveryNonce("789", reordered), nonce);
  assert.notEqual(await monitorDeliveryNonce("790", items), nonce);
  assert.notEqual(await monitorDeliveryNonce("789", items.slice(0, 1)), nonce);
  for (const [field, value] of [["stateKey", "c"], ["collection", "reported_rank_changes"], ["recordKey", "NA1_201"]]) {
    const changed = structuredClone(items);
    changed[0][field] = value;
    assert.notEqual(await monitorDeliveryNonce("789", changed), nonce);
  }
  const live = structuredClone(items);
  live[0].record.status = "live";
  assert.notEqual(await monitorDeliveryNonce("789", live), nonce);
  // Rank keys include observation time: this is deliberately NOT event-level
  // deduplication for a regenerated rank transition or a regrouped batch.
  const laterRank = structuredClone(items);
  laterRank[1].recordKey = "solo:2026-11-02T00:00:00Z:GOLD:III";
  assert.notEqual(await monitorDeliveryNonce("789", laterRank), nonce);
});

test("a recreated batch reuses its nonce while an outstanding receipt still blocks POST", async (t) => {
  const { db, plan, env } = await fixture(t);
  plan.patchTargets.clear();
  const nonces = [];
  const fetchImpl = async (_url, init) => {
    nonces.push(JSON.parse(init.body).nonce);
    return nonces.length === 1 ? new Response(null, { status: 429 }) : Response.json({ id: "999" });
  };
  await assert.rejects(commitMonitorChanges(env, structuredClone(plan), { fetchImpl }), /HTTP 429/);
  await assert.rejects(commitMonitorChanges(env, structuredClone(plan), {
    fetchImpl, saveStateImpl: async () => { throw new Error("D1 unavailable"); },
  }), /D1 unavailable/);
  assert.equal(nonces[0], nonces[1]);
  assert.equal(nonces[1], (await readMonitorDelivery(db)).nonce);
  await assert.rejects(commitMonitorChanges(env, structuredClone(plan), { fetchImpl }), /must be recovered/);
  assert.equal(nonces.length, 2);
});

test("documented confirmed-send SQL rejects stale/live attempts and recovery never reposts", async (t) => {
  const { db, initial, plan, env } = await fixture(t);
  plan.patchTargets.clear();
  await assert.rejects(commitMonitorChanges(env, plan, { fetchImpl: async () => { throw new Error("timeout"); } }), /timeout/);
  const receipt = await readMonitorDelivery(db);
  const runbook = readFileSync(new URL("../docs/monitor-delivery-recovery.md", import.meta.url), "utf8");
  const template = runbook.match(/```sql\n   (UPDATE bot_records[\s\S]*?)\n   ```/)[1];
  const sql = (nonce = receipt.nonce) => template.replace("VERIFIED_MESSAGE_ID", "999")
    .replace("EXPECTED_NONCE", nonce).replace("EXPECTED_ATTEMPT_AT", at);
  const wallNow = db.sqlite.prepare("SELECT unixepoch('now') * 1000 AS now").get().now;
  db.sqlite.prepare("UPDATE monitor_state SET lease_until=?").run(wallNow + 60_000);
  assert.equal(db.sqlite.prepare(sql()).get(), undefined, "live lease blocks operator update");
  await releaseLease(db, "owner");
  assert.equal(db.sqlite.prepare(sql("stale-nonce")).get(), undefined);
  assert.equal(db.sqlite.prepare(sql().replace(at, "2000-01-01T00:00:00Z")).get(), undefined);
  const updated = JSON.parse(db.sqlite.prepare(sql()).get().payload);
  assert.deepEqual(updated, { ...receipt, status: "sent", messageId: "999" });
  assert.deepEqual(await readState(db), initial, "operator only updates the receipt");
  assert.equal(db.sqlite.prepare(sql()).get(), undefined, "already-sent receipt is not overwritten");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("recovery must not POST"); });
  await acquireLease(db, now, "recovery");
  await recoverMonitorDelivery(db, "recovery", await readState(db));
  assert.equal((await readState(db)).additional_summoners.b.reported_games.NA1_200.discord_message_id, "999");
  assert.equal(await readMonitorDelivery(db), null);
});
