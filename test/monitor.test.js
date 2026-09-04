import assert from "node:assert/strict";
import test from "node:test";

import {
  commitMonitorChanges,
  monitorConfiguration,
  findCorrelatedLiveRecord,
  monitorPayload,
  patchDiscordBot,
  postDiscordBot,
  reconcilePendingLiveGames,
  runLeagueMonitor,
  smokeDiscordBot,
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

function completedAlert() {
  return {
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
  };
}

const botEnv = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_ALERT_CHANNEL_ID: "1539858396545818755",
};

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

test("pending live records reconcile by Riot game ID and retain webhook routing", async () => {
  const stateTracker = tracker("Example#NA1");
  stateTracker.summoner.puuid = "puuid-example";
  stateTracker.reported_games["live:12345"] = {
    status: "live",
    champion: "Lux",
    queue: "Ranked Solo/Duo",
    start_time: "2026-09-04T12:00:00.000Z",
    detected_at: "2026-09-04T12:01:00.000Z",
    live_game_id: "12345",
    riot_game_id: "12345",
    discord_message_id: "message-1",
  };

  const calls = [];
  const updates = await reconcilePendingLiveGames(
    {},
    stateTracker,
    "2026-09-04T12:40:00.000Z",
    async (_env, matchId, options) => {
      calls.push({ matchId, options });
      return {
        metadata: { matchId: "NA1_12345" },
        info: {
          gameId: 12345,
          gameStartTimestamp: Date.parse("2026-09-04T12:00:00.000Z"),
          gameDuration: 1805,
          queueId: 420,
          gameMode: "CLASSIC",
          participants: [
            { puuid: "puuid-example", championName: "Lux", win: true },
          ],
        },
      };
    },
  );

  assert.deepEqual(calls, [
    { matchId: "NA1_12345", options: { allowNotFound: true } },
  ]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch_message_id, "message-1");
  assert.equal(updates[0].patch_transport, "webhook");
  assert.equal(stateTracker.reported_games["live:12345"].status, "completed");
  assert.equal(stateTracker.reported_games["live:12345"].result, "WIN");
  assert.equal(stateTracker.reported_games["live:12345"].duration, "30m 05s");
});

test("pending live records stay live while Riot has no completed match", async () => {
  const stateTracker = tracker("Example#NA1");
  stateTracker.reported_games["live:12345"] = {
    status: "live",
    live_game_id: "12345",
  };

  const updates = await reconcilePendingLiveGames(
    {},
    stateTracker,
    "2026-09-04T12:40:00.000Z",
    async () => null,
  );

  assert.deepEqual(updates, []);
  assert.equal(stateTracker.reported_games["live:12345"].status, "live");
});

test("monitorPayload disables mentions and renders completed details", () => {
  const payload = monitorPayload([completedAlert()]);

  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.embeds[0].description, /HelloThere#9494/);
  assert.match(payload.embeds[0].description, /Result: \*\*WIN\*\*/);
  assert.match(payload.embeds[0].description, /Duration: 30m 00s/);
});

test("postDiscordBot creates a channel message with bot authorization", async () => {
  const calls = [];
  const messageId = await postDiscordBot(botEnv, [completedAlert()], async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ id: "123456" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.equal(messageId, "123456");
  assert.equal(
    calls[0][0],
    "https://discord.com/api/v10/channels/1539858396545818755/messages",
  );
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].headers.Authorization, "Bot test-token");
  assert.deepEqual(JSON.parse(calls[0][1].body).allowed_mentions, { parse: [] });
});

test("patchDiscordBot edits the stored message in its original channel", async () => {
  const calls = [];
  await patchDiscordBot(
    botEnv,
    "123456",
    [completedAlert()],
    "999999",
    async (...args) => {
      calls.push(args);
      return new Response(null, { status: 204 });
    },
  );

  assert.equal(
    calls[0][0],
    "https://discord.com/api/v10/channels/999999/messages/123456",
  );
  assert.equal(calls[0][1].method, "PATCH");
  assert.equal(calls[0][1].headers.Authorization, "Bot test-token");
});

test("smokeDiscordBot creates, edits, and deletes one temporary message", async () => {
  const calls = [];
  await smokeDiscordBot(botEnv, async (...args) => {
    calls.push(args);
    if (args[1].method === "POST") {
      return new Response(JSON.stringify({ id: "123456" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  });

  assert.deepEqual(
    calls.map(([, init]) => init.method),
    ["POST", "PATCH", "DELETE"],
  );
  assert.deepEqual(JSON.parse(calls[0][1].body).allowed_mentions, { parse: [] });
  assert.deepEqual(JSON.parse(calls[1][1].body).allowed_mentions, { parse: [] });
});

test("monitor kill switch exits before accessing state or the network", async () => {
  const env = new Proxy(
    { MONITOR_ENABLED: "false" },
    {
      get(target, property) {
        if (property === "MONITOR_DB" || property === "RIOT_API_KEY") {
          throw new Error(`Unexpected access to ${String(property)}`);
        }
        return target[property];
      },
    },
  );

  assert.deepEqual(await runLeagueMonitor(env), { status: "disabled" });
});

test("monitorConfiguration reports bot readiness without exposing values", () => {
  const configuration = monitorConfiguration({
    ...botEnv,
    MONITOR_DB: {},
    MONITOR_ENABLED: "true",
    RIOT_API_KEY: "riot-test-key",
    DISCORD_ALERT_TRANSPORT: "bot",
  });

  assert.deepEqual(configuration, {
    configured: true,
    enabled: true,
    transport: "bot",
  });
});

test("Discord delivery failure does not save monitor state", async () => {
  let saved = false;
  const state = validState();
  const alert = completedAlert();
  state.reported_games.game = alert.record;

  await assert.rejects(
    commitMonitorChanges(
      { ...botEnv, MONITOR_DB: {} },
      {
        state,
        owner: "test-owner",
        detectionIso: "2026-08-23T12:30:00.000Z",
        transport: "bot",
        newAlerts: [alert],
        patchTargets: new Map(),
      },
      {
        fetchImpl: async () => new Response(null, { status: 500 }),
        saveStateImpl: async () => {
          saved = true;
        },
      },
    ),
    /Discord bot POST failed with HTTP 500/,
  );

  assert.equal(saved, false);
});
