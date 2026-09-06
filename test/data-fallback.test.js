import test from "node:test";
import assert from "node:assert/strict";
import { parseOpgg, opggStats, buildOpggResponse } from "../src/opgg.js";
import { playerStats, renderLeaderboard } from "../src/social.js";
import { buildStatsResponse, resolveAccount } from "../src/index.js";
import { RiotRateLimitError } from "../src/errors.js";
import { cacheKey, cacheRead, cacheWrite, checkRiotCooldown, recordRiotCooldown, retryAt } from "../src/data-cache.js";
import { testDb, envFixture, game, mockLookup, interaction } from "./helpers/db.js";

const now = Date.now(), endTime = Math.floor(now / 1000), window = { startTime: endTime - 86400, endTime };
const query = { summoner: "Test#NA1", region: "na", mode: 420, days: 1 };
function html({ name = "Test#NA1", region = "na", items, updatedAt = now - 3600_000 } = {}) {
  const url = "https://op.gg/lol/summoners/na/Test-NA1";
  const row = (id, queue, result, at, props = {}) => ({ item: {
    "@type": "PlayGameAction", agent: { "@id": url + "#summoner" }, actionStatus: "https://schema.org/CompletedActionStatus", startTime: new Date(at).toISOString(),
    additionalProperty: Object.entries({ matchId: id, queueType: queue, result, champion: "Zed", kills: 5, deaths: 2, assists: 3, ...props }).map(([name, value]) => ({ name, value })),
  } });
  const rows = items ?? [row("a", "SOLORANKED", "WIN", now - 10000), row("b", "SOLORANKED", "LOSE", now - 20000), row("c", "ARAM", "WIN", now - 30000), row("old", "SOLORANKED", "WIN", now - 3 * 86400000), row("future", "SOLORANKED", "WIN", now + 86400000), row("remake", "SOLORANKED", "REMAKE", now - 40000)];
  return `<script type="application/ld+json">${JSON.stringify({ "@graph": [
    { "@type": "ProfilePage", mainEntity: { "@id": url + "#summoner" }, dateModified: new Date(updatedAt).toISOString() },
    { "@type": "Person", "@id": url + "#summoner", name, identifier: [{ name: "region", value: region }] },
    { "@type": "ItemList", "@id": url + "#recent-games", itemListElement: rows },
  ] })}</script>`;
}
const page = (body = html()) => new Response(body, { headers: { "content-type": "text/html" } });

test("OP.GG parser verifies identity/region, rejects changed markup and ignores remakes", () => {
  assert.equal(parseOpgg(html(), "Test#NA1", "na").rows.length, 5);
  assert.throws(() => parseOpgg(html({ name: "Other#NA1" }), "Test#NA1", "na"), /unavailable/);
  assert.throws(() => parseOpgg(html({ region: "euw" }), "Test#NA1", "na"), /unavailable/);
  assert.throws(() => parseOpgg("<html>Verify you are human</html>", "Test#NA1", "na"), /unavailable/);
});

test("OP.GG filters exact time/mode, marks unsupported metrics absent, caches profile across queries", async (t) => {
  const env = envFixture(testDb()); let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++; assert.equal(new URL(url).hostname, "op.gg");
    assert.equal(init.headers["X-Riot-Token"], undefined); assert.equal(init.redirect, "manual");
    return page();
  });
  const first = await opggStats(query, env, window);
  assert.equal(first.games, 2); assert.equal(first.wins, 1); assert.equal(first.kda, 4);
  for (const metric of ["hours", "csPerMinute", "averageDamagePerMinute", "averageVision"]) assert.equal(first[metric], null);
  const second = await opggStats({ ...query, mode: 450 }, env, window);
  assert.equal(second.games, 1); assert.equal(second.sourceCached, true); assert.equal(calls, 1);
  await assert.rejects(opggStats({ ...query, mode: 2400 }, env, window), /currently supports/);
  assert.equal(calls, 1);
  const records = env.MONITOR_DB.sqlite.prepare("SELECT payload FROM bot_records").all();
  assert.ok(records.every((r) => !r.payload.includes("fixture") && !r.payload.includes("<script")));
});

test("a real Riot 429 triggers OP.GG and shares cooldown across subsequent players", async (t) => {
  const env = envFixture(testDb()); let riotCalls = 0, opggCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (new URL(url).hostname === "op.gg") { opggCalls++; assert.equal(init.headers["X-Riot-Token"], undefined); return page(); }
    riotCalls++; return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  });
  const p = await playerStats(query, env, window, 30);
  assert.equal(p.source, "opgg"); assert.equal(p.games, 2);
  await playerStats(query, env, window, 30);
  assert.equal(riotCalls, 1); assert.equal(opggCalls, 1);
  await assert.rejects(resolveAccount(env, { gameName: "Other", tagLine: "NA1" }, { regional: "americas" }), RiotRateLimitError);
  assert.equal(riotCalls, 1);
});

test("expired credentials and arbitrary Riot outages never trigger scraping", async (t) => {
  let status = 403, calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.notEqual(new URL(url).hostname, "op.gg"); calls++;
    return new Response(null, { status });
  });
  const env = envFixture(testDb());
  await assert.rejects(playerStats(query, env, window, 30), /invalid or expired/);
  status = 503;
  await assert.rejects(playerStats(query, env, window, 30), /temporarily unavailable/);
  assert.equal(calls, 2);
});

test("OP.GG denial backs off instead of retrying or bypassing; no malformed page is cached as valid", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 403 }); });
  const env = envFixture(testDb());
  for (let i = 0; i < 2; i++) await assert.rejects(opggStats(query, env, window), /unavailable/);
  assert.equal(calls, 1);
});

test("cooldown honors seconds and HTTP dates, never shortens, expires, and is isolated by key/host", async () => {
  const env = envFixture(testDb()), url = "https://americas.api.riotgames.com/test";
  assert.equal(retryAt("60", 1000), 61000);
  assert.equal(retryAt("", 1000), 121000);
  assert.equal(retryAt(new Date(180000).toUTCString(), 1000), 180000);
  await recordRiotCooldown(env, url, "120"); await recordRiotCooldown(env, url, "10");
  await assert.rejects(checkRiotCooldown(env, url), (e) => e instanceof RiotRateLimitError && e.retryAt > Date.now() + 110000);
  await checkRiotCooldown({ ...env, RIOT_API_KEY: "rotated" }, url);
  await checkRiotCooldown(env, "https://europe.api.riotgames.com/test");
  env.MONITOR_DB.sqlite.prepare("UPDATE bot_records SET expires_at = 1").run();
  await checkRiotCooldown(env, url);
});

test("completed match cache survives new views and instances, isolates credentials, stores only requested participant", async (t) => {
  const db = testDb(), env = envFixture(db); let matchCalls = 0;
  const g = game(123); g.info.participants.push({ puuid: "unrequested", secretField: "not-needed", kills: 99 });
  mockLookup(t, [g], { onRequest: (url) => { if (/\/matches\/NA1_/.test(url.pathname)) matchCalls++; } });
  const command = interaction("stats", { summoner: "Test#NA1" });
  await buildStatsResponse(command, env);
  await buildStatsResponse(command, { ...env });
  assert.equal(matchCalls, 1);
  const row = db.sqlite.prepare("SELECT payload, expires_at FROM bot_records WHERE record_key LIKE 'match-scope:%'").get();
  assert.ok(row.expires_at > Date.now() + 6 * 86400000);
  assert.equal(JSON.parse(row.payload).info.participants.length, 1);
  assert.ok(!row.payload.includes("unrequested") && !row.payload.includes("not-needed"));
  await buildStatsResponse(command, { ...env, RIOT_API_KEY: "rotated" }); assert.equal(matchCalls, 2);
});

test("cache TTL, optional database failure and error results do not corrupt lookups", async (t) => {
  const env = envFixture(testDb()), key = await cacheKey("test", ["one"]);
  await cacheWrite(env, key, { ok: true }, 1000); assert.deepEqual(await cacheRead(env, key), { ok: true });
  env.MONITOR_DB.sqlite.prepare("UPDATE bot_records SET expires_at = 1").run(); assert.equal(await cacheRead(env, key), null);
  const broken = { MONITOR_DB: { prepare() { throw Error("unavailable"); } } };
  assert.equal(await cacheRead(broken, key), null); await cacheWrite(broken, key, {}, 1000);
  const db = testDb(); let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/accounts/")) return Response.json({ puuid: "Test", gameName: "Test", tagLine: "NA1" });
    if (String(url).endsWith("/ids?start=0&count=30&startTime=1&endTime=2")) return Response.json(["NA1_1"]);
    calls++; return new Response(null, { status: 503 });
  });
  await assert.rejects(playerStats(query, envFixture(db), { startTime: 1, endTime: 2 }, 30));
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM bot_records WHERE record_key LIKE 'match-scope:%'").get().n, 0);
});

test("fallback cards cite OP.GG and do not rank missing vision as zero", async (t) => {
  t.mock.method(globalThis, "fetch", async () => page());
  const env = envFixture(testDb()), p = await opggStats(query, env, window);
  const view = { id: "test", query: { ...query, metric: "averageVision", min_games: 1 }, endTime, roster: [query.summoner], players: [p] };
  const payload = renderLeaderboard(view);
  assert.match(JSON.stringify(payload), /OP.GG fallback/);
  assert.match(JSON.stringify(payload), /metric unavailable/);
  assert.match(JSON.stringify(payload), /No qualifying players/);
  const recent = await buildOpggResponse(interaction("recent", { summoner: query.summoner }), env);
  assert.match(recent.embeds[0].title, /OP.GG fallback/);
  assert.deepEqual(recent.allowed_mentions, { parse: [] });
});
