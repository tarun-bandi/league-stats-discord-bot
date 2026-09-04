import { readFile } from "node:fs/promises";

import { smokeDiscordBot } from "../src/monitor.js";

const botToken = process.env.DISCORD_BOT_TOKEN_FILE
  ? (await readFile(process.env.DISCORD_BOT_TOKEN_FILE, "utf8")).trim()
  : process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.DISCORD_ALERT_CHANNEL_ID;

if (!botToken || !channelId) {
  console.error(
    "Set DISCORD_ALERT_CHANNEL_ID and DISCORD_BOT_TOKEN or DISCORD_BOT_TOKEN_FILE.",
  );
  process.exitCode = 1;
} else {
  try {
    await smokeDiscordBot({
      DISCORD_BOT_TOKEN: botToken,
      DISCORD_ALERT_CHANNEL_ID: channelId,
    });
    console.log("Discord alert smoke passed: create, edit, and delete succeeded.");
  } catch (error) {
    console.error(
      "Discord alert smoke failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  }
}
