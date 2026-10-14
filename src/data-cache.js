import { readRecord, writeRecord } from "./store.js";
import { riotKeyFingerprint } from "./riot-key.js";
import { RiotRateLimitError } from "./errors.js";

export async function cacheKey(prefix, value) {
  return `${prefix}:${await riotKeyFingerprint(JSON.stringify(value))}`;
}
export async function cacheRead(env, key) {
  if (!env.MONITOR_DB) return null;
  try { return await readRecord(env.MONITOR_DB, key); } catch { return null; }
}
export async function cacheWrite(env, key, value, ttl) {
  if (!env.MONITOR_DB) return;
  try { await writeRecord(env.MONITOR_DB, key, value, Date.now() + ttl); }
  catch { /* Optional cache failure must not fail a lookup. */ }
}
export function retryAt(header, now = Date.now()) {
  const seconds = Number(header);
  const parsed = header && Number.isFinite(seconds) ? now + Math.max(1, seconds) * 1000 : Date.parse(header);
  return Number.isFinite(parsed) && parsed > now ? parsed : now + 120000;
}
export async function checkRiotCooldown(env, url) {
  const key = await cacheKey("riot-cooldown", [env.RIOT_API_KEY, new URL(url).hostname]);
  const value = await cacheRead(env, key);
  if (value?.until > Date.now()) throw new RiotRateLimitError(value.until);
  return key;
}
export async function recordRiotCooldown(env, url, header) {
  const key = await cacheKey("riot-cooldown", [env.RIOT_API_KEY, new URL(url).hostname]);
  const until = retryAt(header);
  if (env.MONITOR_DB) {
    try {
      // Concurrent 429s may extend a cooldown, never shorten it.
      await env.MONITOR_DB.prepare("INSERT INTO bot_records(record_key,payload,expires_at) VALUES(?1,?2,?3) ON CONFLICT(record_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at WHERE excluded.expires_at > bot_records.expires_at")
        .bind(key, JSON.stringify({ until }), until).run();
    } catch { /* Still propagate the rate limit when persistence is unavailable. */ }
  }
  return new RiotRateLimitError(until);
}
