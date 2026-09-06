import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/commands.js";
import { catalogFromData, championAutocompleteChoices } from "../src/champions.js";
import { autocompleteResponse, buildStatsResponse, UserFacingError } from "../src/index.js";

const data = {
  Chogath: { key: "31", id: "Chogath", name: "Cho'Gath" },
  MonkeyKing: { key: "62", id: "MonkeyKing", name: "Wukong" },
  Zed: { key: "238", id: "Zed", name: "Zed" },
};
const catalog = catalogFromData("16.17.1", data);
const interaction = (options = {}) => ({ data: { name: "stats", options: Object.entries({ summoner: "Test#NA1", ...options }).map(([name, value]) => ({ name, value })) } });
const match = (id, participant) => ({
  metadata: { matchId: id },
  info: {
    gameStartTimestamp: Date.parse("2026-09-05T22:00:00Z"), gameDuration: 1800, queueId: 420,
    participants: [
      { puuid: "test", championId: 31, win: true, kills: 6, deaths: 2, assists: 8, totalMinionsKilled: 180, totalDamageDealtToChampions: 30000, visionScore: 10, goldEarned: 12000, ...participant },
      { puuid: "someone-else", championId: 31, kills: 99 },
    ],
  },
});

function mockRiot(t, matches, { catalogFails = false, onRequest = () => {} } = {}) {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    onRequest(url);
    if (url.pathname.includes("/realms/")) return catalogFails ? new Response(null, { status: 503 }) : Response.json({ v: "16.17.1" });
    if (url.pathname.endsWith("champion.json")) return Response.json({ data });
    if (url.pathname.includes("/accounts/")) return Response.json({ puuid: "test", gameName: "Test", tagLine: "NA1" });
    if (url.pathname.includes("league/v4")) return Response.json([]);
    if (url.pathname.endsWith("/ids")) return Response.json(matches.map((game) => game.metadata.matchId));
    const game = matches.find((game) => url.pathname.endsWith(`/${game.metadata.matchId}`));
    assert.ok(game, `Unexpected request to ${url.pathname}`);
    return Response.json(game);
  });
}

test("only stats has an optional champion string with autocomplete", () => {
  const option = COMMANDS.find((command) => command.name === "stats").options.find((option) => option.name === "champion");
  assert.equal(option.type, 3);
  assert.equal(option.required, false);
  assert.equal(option.autocomplete, true);
  assert.ok(COMMANDS.filter((command) => command.name !== "stats").every((command) => !command.options?.some((option) => option.name === "champion")));
});

test("champion suggestions deduplicate aliases, ignore punctuation/case and cap at 25", () => {
  assert.equal(championAutocompleteChoices(catalog, "").length, 3);
  for (const query of [" cho’ga ", "CHO'GATH", "chogath"]) {
    assert.deepEqual(championAutocompleteChoices(catalog, query), [{ name: "Cho'Gath", value: "Cho'Gath" }]);
  }
  for (const query of ["wuk", "monkey"]) {
    assert.deepEqual(championAutocompleteChoices(catalog, query), [{ name: "Wukong", value: "Wukong" }]);
  }
  assert.deepEqual(championAutocompleteChoices(catalog, "not-a-champion"), []);
  const many = catalogFromData("16.17.1", Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i, { id: `Champ${i}`, key: String(i), name: `Champion ${i}` }])));
  assert.equal(championAutocompleteChoices(many, "").length, 25);
});

test("champion autocomplete works without Riot credentials or D1 access", async (t) => {
  mockRiot(t, [], { onRequest: (url) => assert.equal(url.hostname, "ddragon.leagueoflegends.com") });
  const response = await autocompleteResponse({ data: { name: "stats", options: [{ name: "champion", value: "wu", focused: true }] } }, {});
  assert.deepEqual(await response.json(), { type: 8, data: { choices: [{ name: "Wukong", value: "Wukong" }] } });
});

test("champion stats filter the requested participant before every aggregate and combine with days/mode", async (t) => {
  const matches = [
    match("NA1_1", {}),
    match("NA1_2", { championId: 238, kills: 99, deaths: 1, assists: 99, pentaKills: 5 }),
    match("NA1_3", { championId: undefined, championName: "Chogath", win: false, kills: 2, deaths: 6, assists: 4, totalDamageDealtToChampions: 18000, visionScore: 20, goldEarned: 10000 }),
  ];
  mockRiot(t, matches, { onRequest: (url) => {
    if (url.pathname.endsWith("/ids")) {
      assert.equal(url.searchParams.get("queue"), "420");
      assert.equal(url.searchParams.get("count"), "30");
      assert.ok(Math.abs(Number(url.searchParams.get("startTime")) - (Date.now() / 1000 - 10 * 86400)) < 5);
    }
  } });
  const payload = await buildStatsResponse(interaction({ champion: "CHO’GATH", days: 10, mode: 420 }), { RIOT_API_KEY: "fixture" });
  const embed = payload.embeds[0];
  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.match(embed.title, /Cho'Gath • last 10 days/);
  assert.match(embed.thumbnail.url, /\/Chogath.png$/);
  assert.match(embed.description, /1W–1L • 50.0% win rate/);
  assert.match(embed.description, /2 Cho'Gath games in the 3 newest games returned for this period and mode/);
  assert.match(fields["Games per day"], /^0.20 calendar avg/);
  assert.match(fields.Performance, /4.0\/4.0\/6.0 avg • 2.50 KDA • 6.0 CS\/min/);
  assert.match(fields.Impact, /800 champion damage\/min • 15.0 avg vision • 11.0k avg gold/);
  assert.doesNotMatch(fields.Impact, /pentakill/);
  assert.match(fields.Pace, /champion streak/);
  assert.equal(fields["Account rank (all champions)"], "Unranked");
  assert.equal(fields["Top champions"], undefined);
  assert.match(embed.footer.text, /Ranked Solo\/Duo/);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("Wukong canonical alias filters by numeric champion ID", async (t) => {
  mockRiot(t, [match("NA1_1", { championId: 62, championName: "MonkeyKing" })]);
  const payload = await buildStatsResponse(interaction({ champion: "MonkeyKing" }), { RIOT_API_KEY: "fixture" });
  assert.match(payload.embeds[0].title, /Wukong/);
  assert.match(payload.embeds[0].description, /1W–0L/);
  assert.match(payload.embeds[0].thumbnail.url, /\/MonkeyKing.png$/);
});

test("no matching champion games is explicit and does not fall back to overall stats", async (t) => {
  mockRiot(t, [match("NA1_1", { championId: 238 })]);
  const payload = await buildStatsResponse(interaction({ champion: "Wukong" }), { RIOT_API_KEY: "fixture" });
  assert.match(payload.embeds[0].description, /No Wukong games found in this sample/);
  assert.match(payload.embeds[0].description, /0 Wukong games in the 1 newest game returned/);
  assert.match(payload.embeds[0].thumbnail.url, /\/MonkeyKing.png$/);
});

test("invalid champion fails clearly before spending Riot requests", async (t) => {
  mockRiot(t, [], { onRequest: (url) => assert.equal(url.hostname, "ddragon.leagueoflegends.com") });
  for (const champion of ["madeup", "", "  "]) {
    await assert.rejects(buildStatsResponse(interaction({ champion }), {}), (error) => error instanceof UserFacingError && /Unknown champion/.test(error.message));
  }
});

test("catalog outage does not silently ignore a filter; overall stats still work", async (t) => {
  mockRiot(t, [match("NA1_1", {})], { catalogFails: true });
  await assert.rejects(buildStatsResponse(interaction({ champion: "Zed" }), {}), /Champion names are temporarily unavailable/);
  const suggestions = await autocompleteResponse({ data: { name: "stats", options: [{ name: "champion", value: "z", focused: true }] } }, {});
  assert.deepEqual((await suggestions.json()).data.choices, []);
  const payload = await buildStatsResponse(interaction(), { RIOT_API_KEY: "fixture" });
  assert.match(payload.embeds[0].description, /1W–0L/);
  assert.equal(payload.embeds[0].thumbnail, undefined);
});

test("champion filtering preserves the 30-game subrequest budget and labels the sample", async (t) => {
  let subrequests = 0;
  const before = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: { match: async () => { subrequests++; }, put: async () => { subrequests++; } } } });
  t.after(() => before ? Object.defineProperty(globalThis, "caches", before) : delete globalThis.caches);
  mockRiot(t, Array.from({ length: 30 }, (_, i) => match(`NA1_${i}`, { championId: i % 2 ? 31 : 238 })), { onRequest: () => subrequests++ });
  const payload = await buildStatsResponse(interaction({ champion: "Zed" }), { RIOT_API_KEY: "fixture" });
  assert.equal(subrequests + 1, 46); // Includes the deferred Discord reply PATCH.
  assert.match(payload.embeds[0].description, /15 Zed games in the 30 newest games/);
  assert.match(payload.embeds[0].description, /Older champion games may not be included/);
  assert.match(payload.embeds[0].footer.text, /Capped at the 30 newest games/);
});
