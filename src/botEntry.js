import { startBot } from "./bots/botProcess.js";

const roomLink = process.env.HB_ROOM_LINK;
const botName = process.env.HB_BOT_NAME;
const controlWsUrl = process.env.HB_CONTROL_WS_URL;
const password = process.env.HB_ROOM_PASSWORD || "";

if (!roomLink || !botName || !controlWsUrl) {
  console.error("Bot missing env: HB_ROOM_LINK, HB_BOT_NAME, HB_CONTROL_WS_URL");
  process.exit(1);
}

const bot = await startBot({ roomLink, botName, controlWsUrl, password });

if (process.send) process.send({ type: "bot.ready", name: botName });

process.on("SIGINT", async () => {
  await bot?.shutdown?.();
  process.exit(0);
});

