import assert from "node:assert/strict";
import test from "node:test";

import {
  findCorrelatedLiveRecord,
  monitorPayload,
  validateMonitorState,
} from "../src/monitor.js";

function tracker(riotId) {
  return {
    summoner: { riot_id: riotId },
    baseline: { completed_match_id: "baseline" },
    newest_completed_match: null,
    newest_live_game_id: null,
    reported_games: {},
  };
}

function validState() {
  return {
    summoner: { riot_id: "HelloThere#9494" },
    baseline: { completed_match_id: "baseline" },
    newest_completed_match: null,
    newest_live_game_id: null,
    reported_games: {},
    additional_summoners: {
      "na:tixbs chaos#na1": tracker("TIXBS Chaos#NA1"),
      "na:knaye east#yeezy": tracker("Knaye East#YEEZY"),
    },
  };
}

test("validateMonitorState accepts three independent tracker maps", () => {
  const state = validState();
  assert.equal(validateMonitorState(state), state);
});

test("validateMonitorState rejects a missing tracker", () => {
  const state = validState();
  delete state.additional_summoners["na:knaye east#yeezy"];
  assert.throws(() => validateMonitorState(state), /Expected 3 monitor trackers/);
});

test("findCorrelatedLiveRecord prefers Riot game IDs", () => {
  const stateTracker = tracker("HelloThere#9494");
  stateTracker.reported_games["live:12345"] = {
    status: "live",
    champion: "Kassadin",
    queue: "Ranked Solo/Duo",
    start_time: "2026-08-23T12:00:00.000Z",
    live_game_id: "12345",
  };

  const result = findCorrelatedLiveRecord(stateTracker, {
    match_id: "NA1_12345",
    riot_game_id: "12345",
    champion: "Kassadin",
    queue: "Ranked Solo/Duo",
    start_time: "2026-08-23T12:01:00.000Z",
  });

  assert.equal(result[0], "live:12345");
});

test("findCorrelatedLiveRecord falls back to champion, queue, and start time", () => {
  const stateTracker = tracker("HelloThere#9494");
  stateTracker.reported_games.legacy = {
    status: "live",
    champion: "Kai'Sa",
    queue: "Ranked Solo/Duo",
    start_time: "2026-08-23T12:00:00.000Z",
  };

  const result = findCorrelatedLiveRecord(stateTracker, {
    match_id: "NA1_99999",
    riot_game_id: "99999",
    champion: "kai'sa",
    queue: "Ranked Solo/Duo",
    start_time: "2026-08-23T12:08:00.000Z",
  });

  assert.equal(result[0], "legacy");
});

test("monitorPayload disables mentions and renders completed details", () => {
  const payload = monitorPayload([
    {
      riotId: "HelloThere#9494",
      record: {
        status: "completed",
        champion: "Kassadin",
        queue: "Ranked Solo/Duo",
        start_time: "2026-08-23T12:00:00.000Z",
        detected_at: "2026-08-23T12:30:00.000Z",
        result: "WIN",
        duration: "30m 00s",
      },
    },
  ]);

  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.embeds[0].description, /HelloThere#9494/);
  assert.match(payload.embeds[0].description, /Result: \*\*WIN\*\*/);
  assert.match(payload.embeds[0].description, /Duration: 30m 00s/);
});

