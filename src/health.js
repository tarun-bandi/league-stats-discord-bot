import { readRecord, writeRecord, leaseRecord, releaseRecord } from "./store.js";

// Operational health is deliberately separate from game cursors: an auth failure
// must never advance match history merely to remember a notification.
export async function reportCredentialHealth(env, status, monitorState, now = Date.now()) {
  const key = "health:riot";
  await env.MONITOR_DB.prepare("INSERT INTO bot_records(record_key,payload) VALUES(?1,?2) ON CONFLICT(record_key) DO NOTHING").bind(key, JSON.stringify({ status: "unknown", pending: [] })).run();
  const owner = crypto.randomUUID();
  if (!await leaseRecord(env.MONITOR_DB, key, owner)) return null;
  try {
  const health = await readRecord(env.MONITOR_DB, key);
  if (health.status !== status) {
    if (status === "invalid" || health.status === "invalid") {
      health.pending.push({ id: crypto.randomUUID(), status, at: now });
    }
    health.status = status;
    health.changedAt = now;
    await writeRecord(env.MONITOR_DB, key, health);
  }
  if (!health.pending.length) return health;
  const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" };
  const discord = async (path, method = "GET", body) => {
    const response = await fetch(`https://discord.com/api/v10${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Credential notification delivery failed (${response.status})`);
    return response.json();
  };
  try {
    const owner = monitorState.health_notification_owner ?? (env.DISCORD_GUILD_ID ? (await discord(`/guilds/${env.DISCORD_GUILD_ID}`)).owner_id : null);
    if (!/^\d+$/.test(String(owner ?? ""))) throw new Error("Credential notification owner is not configured");
    const channel = await discord("/users/@me/channels", "POST", { recipient_id: owner });
    if (!/^\d+$/.test(String(channel.id ?? ""))) throw new Error("Credential notification DM channel is invalid");
    // A failed Discord request leaves the event queued. Nonces suppress retries
    // after an ambiguous response within Discord's nonce-deduplication window.
    for (const event of health.pending.slice(0, 2)) {
      const message = await discord(`/channels/${channel.id}/messages`, "POST", {
        content: event.status === "invalid"
          ? "LeagueStats: the Riot API credential is invalid or expired. Refresh RIOT_API_KEY in Cloudflare. Match history has been preserved; no repeated failure notices will be sent for this outage."
          : "LeagueStats: Riot API authentication is working again. This is the recovery notice for the previous credential failure.",
        allowed_mentions: { parse: [] }, nonce: event.id.slice(0, 24), enforce_nonce: true,
      });
      if (!message.id) throw new Error("Credential notification did not return a message ID");
      health.pending.shift();
      health.lastNotificationAt = now;
      delete health.deliveryError;
      await writeRecord(env.MONITOR_DB, key, health);
    }
  } catch {
    health.deliveryError = true;
    await writeRecord(env.MONITOR_DB, key, health);
    console.error("LeagueStats credential notification is queued; check bot DM access and notification-owner configuration.");
  }
  return health;
  } finally { await releaseRecord(env.MONITOR_DB, key, owner); }
}

export async function confirmCredentialFailure(env, monitorState) {
  const riotId = monitorState.summoner.riot_id;
  const split = riotId.lastIndexOf("#");
  const response = await fetch(`https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(riotId.slice(0, split))}/${encodeURIComponent(riotId.slice(split + 1))}`, { headers: { "X-Riot-Token": env.RIOT_API_KEY } });
  return [401, 403].includes(response.status);
}
