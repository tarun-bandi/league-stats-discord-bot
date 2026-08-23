import assert from "node:assert/strict";
import test from "node:test";

import { aggregateMatches, parseRiotId, UserFacingError } from "../src/index.js";

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
