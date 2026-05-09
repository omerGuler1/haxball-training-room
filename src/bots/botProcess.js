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

  let botInGame = false;

  const isInGame = async () => {
    try {
      // Check main page and all iframes for canvas
      const main = await page.evaluate(() => {
        const c = document.querySelector("canvas");
        return c && c.width > 100;
      });
      if (main) return true;
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        try {
          const has = await f.evaluate(() => {
            const c = document.querySelector("canvas");
            return c && c.width > 100;
          });
          if (has) return true;
        } catch {}
      }
      return false;
    } catch { return false; }
  };

  // Retry loop: if bot isn't in game after joinRoom, keep retrying
  const retryUntilInGame = async () => {
    await new Promise((r) => setTimeout(r, 5000));
    for (let attempt = 0; attempt < 10; attempt++) {
      if (botInGame || await isInGame()) { botInGame = true; return; }
      log.warn(`Bot not in game (${botName}). Retrying in 10s... (attempt ${attempt + 1}/10)`);
      await new Promise((r) => setTimeout(r, 10000));
      try {
        await page.goto(roomLink, { waitUntil: "domcontentloaded" });
        await new Promise((r) => setTimeout(r, 3000));
        // Re-run the join flow
        await (await import("./joinRoom.js")).joinRoomClient({ page, roomLink, password, nickname: botName });
      } catch (e) {
        log.warn(`Retry join failed (${botName}): ${e?.message || e}`);
      }
      await new Promise((r) => setTimeout(r, 3000));
      if (await isInGame()) { botInGame = true; log.info(`Bot joined after retry (${botName}).`); return; }
    }
    log.error(`Bot failed to join after 10 retries (${botName}). Exiting for orchestrator restart.`);
    process.exit(1);
  };
  void retryUntilInGame();

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
        botInGame = true;
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

  // Watchdog: bot may silently fall out of the Haxball room (WebRTC drop,
  // Cloudflare interstitial, renderer crash) while the Node process keeps
  // running. Re-check periodically; exit non-zero so the orchestrator restarts.
  let missedChecks = 0;
  const watchdog = setInterval(async () => {
    if (!botInGame) return;
    if (await isInGame()) {
      missedChecks = 0;
      return;
    }
    missedChecks++;
    log.warn(`Watchdog: bot not in game (${botName}) [${missedChecks}/2].`);
    if (missedChecks >= 2) {
      log.error(`Watchdog: bot lost room (${botName}). Exiting for orchestrator restart.`);
      process.exit(1);
    }
  }, 60_000);

  // Surface browser disconnect immediately — no point waiting for the watchdog tick.
  browser.on("disconnected", () => {
    log.error(`Chromium disconnected (${botName}). Exiting for orchestrator restart.`);
    process.exit(1);
  });
  page.on("close", () => {
    log.error(`Chromium page closed (${botName}). Exiting for orchestrator restart.`);
    process.exit(1);
  });

  return {
    shutdown: async () => {
      clearInterval(failsafe);
      clearInterval(watchdog);
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
