import { COMMANDS } from "./commands.js";

// Reconcile deployment metadata using the encrypted runtime token. Never export it
// to CI, a response, or a log. Command PUT is safe to retry.
export async function syncDiscordApplication(env, state, fetchImpl = fetch) {
  if (!env.DISCORD_APPLICATION_ID) return;
  if (!/^\d+$/.test(env.DISCORD_APPLICATION_ID)) throw new Error("Invalid Discord application ID");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(COMMANDS))))].map((v) => v.toString(16).padStart(2, "0")).join("");
  const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" };
  state.discord ??= {};
  if (state.discord.command_schema_hash !== hash) {
    const response = await fetchImpl(`https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
      method: "PUT", headers, body: JSON.stringify(COMMANDS),
    });
    if (!response.ok) throw new Error(`Discord command registration failed with HTTP ${response.status}`);
    state.discord.command_schema_hash = hash;
  }
}
