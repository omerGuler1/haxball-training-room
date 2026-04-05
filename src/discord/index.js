import { loadConfig } from "../config/index.js";
import { startDiscordBot } from "./bot.js";

const config = loadConfig();

if (!config.discord.token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (!config.discord.guildId) {
  console.error("Missing DISCORD_GUILD_ID in .env");
  process.exit(1);
}

const bot = startDiscordBot(config);

process.on("SIGINT", () => {
  bot.shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.shutdown();
  process.exit(0);
});
