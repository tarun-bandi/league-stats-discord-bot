import { readFile } from "node:fs/promises";
import { COMMANDS } from "../src/commands.js";

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN_FILE
  ? (await readFile(process.env.DISCORD_BOT_TOKEN_FILE, "utf8")).trim()
  : process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !botToken) {
  console.error(
    "Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN before registering commands.",
  );
  process.exitCode = 1;
} else {
  const response = await fetch(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(COMMANDS),
    },
  );

  if (!response.ok) {
    console.error(`Discord command registration failed with HTTP ${response.status}.`);
    process.exitCode = 1;
  } else {
    const commands = await response.json();
    console.log(`Registered ${commands.length} global commands.`);
  }
}
