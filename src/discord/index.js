console.log("[discord] starting…");
import { loadConfig } from "../config/index.js";
import { startDiscordBot } from "./bot.js";

console.log("[discord] modules loaded, calling loadConfig()");
const config = loadConfig();
console.log("[discord] config loaded; cwd=", process.cwd(), "db.path=", config.db.path);

if (!config.discord.token) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

if (!config.discord.guildId) {
  console.error("Missing DISCORD_GUILD_ID in .env");
  process.exit(1);
}

console.log("[discord] calling startDiscordBot()");
const bot = startDiscordBot(config);
console.log("[discord] startDiscordBot() returned");

process.on("SIGINT", () => {
  bot.shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.shutdown();
  process.exit(0);
});
