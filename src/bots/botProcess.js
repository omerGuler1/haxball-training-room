import process from "node:process";

import puppeteer from "puppeteer";
import WebSocket from "ws";
import path from "node:path";

import { loadConfig } from "../config/index.js";
import { createLogger } from "../logging/logger.js";
import { ControlMsgType, makeHello } from "../shared/protocol.js";
import { joinRoomClient } from "./joinRoom.js";
import { createInputController } from "./inputController.js";

export async function startBot({ roomLink, botName, controlWsUrl, password }) {
  const config = loadConfig();
  const log = createLogger(config);
  const debug = Boolean(config.debug?.botDebug);

  const browser = await puppeteer.launch({
    headless: config.puppeteer.headless,
    executablePath: config.puppeteer.executablePath || undefined,
    args: config.puppeteer.launchArgs,
  });
  const page = await browser.newPage();

  if (config.bots.userAgent) {
    try {
      await page.setUserAgent(config.bots.userAgent);
    } catch (e) {
      log.warn(`Failed to set UA: ${e?.message || e}`);
    }
  }

  let promptUsed = false;
  page.on("dialog", async (d) => {
    try {
      const msg = (d.message?.() || "").toLowerCase();
      const type = d.type?.() || "unknown";
      log.info(`Bot dialog (${botName}): type=${type} msg=${msg.slice(0, 120)}`);

      if (type === "prompt") {
        if (!promptUsed && password) {
          promptUsed = true;
          await d.accept(password ?? "");
          return;
        }
      }

      await d.accept();
    } catch {}
  });

  await page.setViewport({ width: 1200, height: 800 });

  await joinRoomClient({ page, roomLink, password, nickname: botName });

  const debugProbe = async (tag) => {
    if (!debug) return;
    try {
      const url = page.url();
      const title = await page.title();
      log.info(`Bot probe (${botName}) [${tag}]: url=${url} title=${title}`);
      const outPath = path.join(process.cwd(), `bot-${botName}-${tag}.png`);
      await page.screenshot({ path: outPath, fullPage: false });
      log.info(`Bot screenshot written: ${outPath}`);
    } catch (e) {
      log.warn(`Bot probe failed (${botName}) [${tag}]: ${e?.message || e}`);
    }
  };

  setTimeout(() => void debugProbe("after-join-5s"), 5000);

  const retryIfCloudflare = async () => {
    try {
      const title = await page.title();
      if (!title.toLowerCase().includes("cloudflare") && !title.toLowerCase().includes("access denied")) return;
      log.warn(`Bot blocked by Cloudflare (${botName}). Backing off and retrying...`);
      for (const backoffMs of [15_000, 45_000, 120_000]) {
        await new Promise((r) => setTimeout(r, backoffMs));
        await page.goto(roomLink, { waitUntil: "domcontentloaded" });
        await debugProbe(`retry-${backoffMs}ms`);
        const t2 = (await page.title()).toLowerCase();
        if (!t2.includes("cloudflare") && !t2.includes("access denied")) {
          log.info(`Bot unblocked (${botName}) after retry.`);
          return;
        }
      }
    } catch (e) {
      log.warn(`Cloudflare retry failed (${botName}): ${e?.message || e}`);
    }
  };
  setTimeout(() => void retryIfCloudflare(), 7000);

  const input = createInputController({ page, logger: log });

  let lastPacketAt = Date.now();
  let ws = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;

  function connectWs() {
    ws = new WebSocket(controlWsUrl);

    ws.on("open", () => {
      ws.send(JSON.stringify(makeHello({ name: botName })));
      log.info(`Bot connected to control: ${botName}`);
      reconnectAttempts = 0; // Reset on successful connection
      lastPacketAt = Date.now();
    });

    ws.on("message", async (data) => {
      lastPacketAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }

      if (msg?.t === ControlMsgType.CONTROL || msg?.t === "control") {
        const { moveX, moveY, kick, kickPower } = msg;
        await input.applyAxes(moveX, moveY, kick);
        if (kick) await input.kickPulse(kickPower);
        return;
      }
      if (msg?.t === ControlMsgType.RELEASE) {
        await input.releaseAll();
        return;
      }
    });

    ws.on("close", async () => {
      log.warn(`Control WS closed (${botName}).`);
      await input.releaseAll();
      scheduleReconnect();
    });

    ws.on("error", (e) => {
      log.error(`Control WS error (${botName}): ${e?.message || e}`);
    });
  }

  function scheduleReconnect() {
    reconnectAttempts++;
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      log.error(`Max reconnect attempts reached (${botName}). Exiting for orchestrator restart.`);
      process.exit(1);
    }
    // Exponential backoff: 3s, 6s, 12s, 24s, 48s
    const delay = 3000 * Math.pow(2, reconnectAttempts - 1);
    log.warn(`Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(() => connectWs(), delay);
  }

  connectWs();

  // Failsafe: if packets stop, release keys.
  const failsafe = setInterval(async () => {
    if (Date.now() - lastPacketAt > 1500) {
      await input.releaseAll();
    }
  }, 500);

  return {
    shutdown: async () => {
      clearInterval(failsafe);
      try {
        ws?.close();
      } catch {}
      await input.releaseAll().catch(() => {});
      await debugProbe("shutdown");
      try {
        await page.close();
      } catch {}
      try {
        await browser.close();
      } catch {}
    },
  };
}
