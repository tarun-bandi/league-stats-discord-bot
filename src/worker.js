import { runWeeklyRecap } from "./recap.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { UserFacingError } from "./index.js";
import { playerStats } from "./social.js";
import { runNineToFive } from "./nine-to-five.js";

// Private loopback RPC; no unauthenticated HTTP lookup endpoint is exposed.
export class LeaderboardPlayer extends WorkerEntrypoint {
  async load(query, window) {
    try {
      return { player: await playerStats(query, this.env, window, 30) };
    } catch (error) {
      return { error: error instanceof UserFacingError ? error.message : "Player data is unavailable. Please retry." };
    }
  }
}

export class WeeklyRecap extends WorkerEntrypoint {
  async run(now) { return runWeeklyRecap(this.env, now); }
}

// Separate request budget for report delivery; no public scheduler endpoint.
export class NineToFive extends WorkerEntrypoint {
  async run() { return runNineToFive(this.env); }
}

export default worker;
