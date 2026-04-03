import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import puppeteer from "puppeteer";

import { loadConfig } from "../config/index.js";
import { createLogger } from "../logging/logger.js";
import { createControlServer } from "./controlServer.js";
import { loadStadiumJsonString } from "./stadiumLoader.js";

async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startHost({ onReady }) {
  const config = loadConfig();
  const log = createLogger(config);

  if (!config.room.token) {
    log.error("Missing HAXBALL_TOKEN. Put it in .env (see .env.example).");
    process.exit(1);
  }

  const controlPort = await pickFreePort();
  const control = createControlServer({ port: controlPort, logger: log });

  const stadiumPath = path.resolve(process.cwd(), config.stadium.path);
  let stadiumJsonString = null;
  try {
    stadiumJsonString = await loadStadiumJsonString(stadiumPath);
    log.info(`Loaded stadium: ${stadiumPath}`);
  } catch (e) {
    log.error(`Failed to load stadium: ${stadiumPath}`);
    log.error(String(e?.message || e));
  }

  const browser = await puppeteer.launch({
    headless: config.puppeteer.headless,
    executablePath: config.puppeteer.executablePath || undefined,
    args: config.puppeteer.launchArgs,
  });
  const page = await browser.newPage();

  page.on("pageerror", (err) => {
    log.error(`Page error: ${err?.message || err}`);
  });
  page.on("error", (err) => {
    log.error(`Puppeteer page crashed: ${err?.message || err}`);
  });

  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("[HB]")) log.info(text);
  });

  await page.exposeFunction("__hbNodeBridgePost", (msg) => {
    if (!msg?.type) return;
    if (msg.type === "room.link") {
      const roomLink = msg.payload?.link;
      if (roomLink && onReady) onReady({ roomLink, controlWsUrl: control.url });
      log.info(`Room link: ${roomLink}`);
    } else if (msg.type === "room.playerJoin") {
      const { id, name, team } = msg.payload || {};
      log.info(`Player joined: id=${id} name=${name} team=${team}`);
    } else if (msg.type === "room.playerLeave") {
      const { id, name, team } = msg.payload || {};
      log.info(`Player left: id=${id} name=${name} team=${team}`);
    } else if (msg.type === "bot.control") {
      const { botName, tick, moveX, moveY, kick } = msg.payload || {};
      if (!botName) return;
      control.sendToBot(botName, { t: "control", tick, moveX, moveY, kick });
    } else if (msg.type === "debug.tick") {
      if (config.debug.botDebug) log.debug(JSON.stringify(msg.payload));
    } else if (msg.type === "stadium.reload") {
      // Async: read stadium and ask the room script to load it next tick by refreshing config.
      // For simplicity: reload by evaluating a small snippet that calls setCustomStadium again.
      (async () => {
        try {
          const s = await loadStadiumJsonString(stadiumPath);
          await page.evaluate((json) => {
            try {
              window.__HB_ROOM__?.setCustomStadium(json);
              window.__HB_ROOM__?.sendAnnouncement("Stadium reloaded.", null, 0xdddddd, "small", 1);
            } catch (e) {
              window.__HB_ROOM__?.sendAnnouncement(`Stadium reload failed: ${e?.message || e}`, null, 0xff4444, "small", 1);
            }
          }, s);
          log.info("Stadium reloaded via command.");
        } catch (e) {
          log.error(`Stadium reload failed: ${e?.message || e}`);
        }
      })();
    }
  });

  const injectedParts = [
    "injected/bridge.js",
    "injected/math.js",
    "injected/util.js",
    "injected/state.js",
    "injected/perception.js",
    "injected/decision.js",
    "injected/botMemory.js",
    "injected/receivePass.js",
    "injected/commands.js",
    "injected/main.js",
  ];
  const injected = (
    await Promise.all(
      injectedParts.map((p) => fs.readFile(new URL(`./${p}`, import.meta.url), "utf8"))
    )
  ).join("\n\n");

  await page.goto("https://www.haxball.com/headless", { waitUntil: "networkidle2" });

  // Ensure the official headless API bootstrap is present before we inject.
  // `domcontentloaded` is sometimes too early and HBInit isn't defined yet.
  await page.waitForFunction(() => typeof window.HBInit === "function", { timeout: 30_000 });

  await page.evaluate(
    (cfg, stadiumJson) => {
      window.__HB_CONFIG__ = cfg;
      if (stadiumJson) {
        window.__HB_CONFIG__.stadium = window.__HB_CONFIG__.stadium || {};
        window.__HB_CONFIG__.stadium.jsonString = stadiumJson;
      }
    },
    config,
    stadiumJsonString
  );

  await page.evaluate(injected);

  log.info(`Host started. Control WS at ${control.url}`);

  process.on("unhandledRejection", (e) => {
    log.error(`Unhandled rejection: ${e?.message || e}`);
  });

  return {
    shutdown: async () => {
      try {
        control.broadcast({ t: "release", reason: "host.shutdown" });
      } catch {}
      try {
        await control.close();
      } catch {}
      try {
        await page.close();
      } catch {}
      try {
        await browser.close();
      } catch {}
    },
  };
}

