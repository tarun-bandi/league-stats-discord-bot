import { runWeeklyRecap } from "./recap.js";
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { UserFacingError } from "./index.js";
import { playerStats } from "./social.js";

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

export default worker;
