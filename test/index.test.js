import assert from "node:assert/strict";
import test from "node:test";

import { COMMANDS, MONITORED_SUMMONER_DEFAULTS } from "../src/commands.js";
import {
  aggregateMatches,
  autocompleteResponse,
  parseRiotId,
  summonerAutocompleteChoices,
  UserFacingError,
} from "../src/index.js";

test("summoner options autocomplete the monitored accounts", () => {
  for (const command of COMMANDS.filter(({ name }) =>
    ["stats", "recent", "live"].includes(name),
  )) {
    const option = command.options.find(({ name }) => name === "summoner");
    assert.equal(option.required, false);
    assert.equal(option.autocomplete, true);
    assert.equal(option.choices, undefined);
  }
});

test("summoner autocomplete lists and filters monitored accounts", () => {
  assert.deepEqual(
    summonerAutocompleteChoices(""),
    MONITORED_SUMMONER_DEFAULTS.map((riotId) => ({
      name: riotId,
      value: riotId,
    })),
  );
  assert.deepEqual(summonerAutocompleteChoices("chaos"), [
    { name: "TIXBS Chaos#NA1", value: "TIXBS Chaos#NA1" },
  ]);
});

test("summoner autocomplete follows monitor-state Riot ID renames", () => {
  assert.deepEqual(
    summonerAutocompleteChoices("renamed", [
      "HelloThere#9494",
      "Renamed Account#NA1",
    ]),
    [{ name: "Renamed Account#NA1", value: "Renamed Account#NA1" }],
  );
});

test("autocomplete response reads current Riot IDs from monitor state", async () => {
  const tracker = (riotId) => ({
    summoner: { riot_id: riotId },
    baseline: {},
    newest_completed_match: null,
    reported_games: {},
  });
  const state = {
    ...tracker("HelloThere#9494"),
    additional_summoners: {
      "na:tixbs chaos#na1": tracker("TIXBS Chaos#NA1"),
      "na:renamed#na1": tracker("Renamed Account#NA1"),
    },
  };
  const env = {
    MONITOR_DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { state_json: JSON.stringify(state) };
              },
            };
          },
        };
      },
    },
  };

  const response = await autocompleteResponse(
    {
      data: {
        name: "stats",
        options: [
          { name: "summoner", value: "renamed", focused: true },
        ],
      },
    },
    env,
  );

  assert.deepEqual(await response.json(), {
    type: 8,
    data: {
      choices: [
        { name: "Renamed Account#NA1", value: "Renamed Account#NA1" },
      ],
    },
  });
});

test("parseRiotId preserves spaces and splits on the final hash", () => {
  assert.deepEqual(parseRiotId(" Knaye East#YEEZY "), {
    gameName: "Knaye East",
    tagLine: "YEEZY",
    display: "Knaye East#YEEZY",
  });
});

test("parseRiotId rejects missing tags", () => {
  assert.throws(() => parseRiotId("HelloThere"), UserFacingError);
});

test("aggregateMatches computes win rate, games per day, KDA, and CS", () => {
  const puuid = "test-puuid";
  const makeMatch = ({ id, win, champion, kills, deaths, assists, cs }) => ({
    metadata: { matchId: id },
    info: {
      gameStartTimestamp: Date.parse("2026-08-23T12:00:00Z"),
      gameDuration: 1800,
      queueId: 420,
      participants: [
        {
          puuid,
          win,
          championName: champion,
          kills,
          deaths,
          assists,
          totalMinionsKilled: cs,
          neutralMinionsKilled: 0,
        },
      ],
    },
  });

  const stats = aggregateMatches(
    [
      makeMatch({
        id: "NA1_1",
        win: true,
        champion: "Garen",
        kills: 10,
        deaths: 2,
        assists: 5,
        cs: 180,
      }),
      makeMatch({
        id: "NA1_2",
        win: false,
        champion: "Garen",
        kills: 2,
        deaths: 8,
        assists: 4,
        cs: 120,
      }),
    ],
    puuid,
    7,
  );

  assert.equal(stats.games, 2);
  assert.equal(stats.wins, 1);
  assert.equal(stats.winRate, 50);
  assert.equal(stats.calendarGamesPerDay, 2 / 7);
  assert.equal(stats.kda, 2.1);
  assert.equal(stats.csPerMinute, 5);
  assert.equal(stats.topChampions[0].name, "Garen");
});
