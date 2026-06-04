import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import puppeteer from "puppeteer";

import { loadConfig } from "../config/index.js";
import { createLogger } from "../logging/logger.js";
import { createControlServer } from "./controlServer.js";
import { loadStadiumJsonString } from "./stadiumLoader.js";
import { openDatabase } from "../db/database.js";
import * as auth from "../db/auth.js";

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

  // ── Database ───────────────────────────────────────────
  const dbPath = path.resolve(process.cwd(), config.db?.path || "./data/haxball.db");
  const db = openDatabase(dbPath);
  log.info(`Database opened: ${dbPath}`);

  const controlPort = await pickFreePort();
  const control = createControlServer({ port: controlPort, logger: log });

  const stadiumPath = config.stadium.path
    ? path.resolve(process.cwd(), config.stadium.path)
    : null;
  let stadiumJsonString = null;
  if (stadiumPath) {
    try {
      stadiumJsonString = await loadStadiumJsonString(stadiumPath);
      log.info(`Loaded stadium: ${stadiumPath}`);
    } catch (e) {
      log.error(`Failed to load stadium: ${stadiumPath}`);
      log.error(String(e?.message || e));
    }
  } else {
    log.info("No STADIUM_PATH set — using Haxball default stadium.");
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
    } else if (msg.type === "room.startGameError") {
      log.error(`startGame failed: ${msg.payload?.message || msg.payload}`);
    } else if (msg.type === "bot.control") {
      const { botName, tick, moveX, moveY, kick, kickPower } = msg.payload || {};
      if (!botName) return;
      control.sendToBot(botName, { t: "control", tick, moveX, moveY, kick, kickPower });
    } else if (msg.type === "debug.tick") {
      if (config.debug.botDebug) log.debug(JSON.stringify(msg.payload));
    } else if (msg.type === "stadium.reload") {
      // Async: read stadium and ask the room script to load it next tick by refreshing config.
      // For simplicity: reload by evaluating a small snippet that calls setCustomStadium again.
      if (!stadiumPath) {
        log.warn("Stadium reload requested but no STADIUM_PATH configured.");
        return;
      }
      (async () => {
        try {
          const s = await loadStadiumJsonString(stadiumPath);
          await page.evaluate((json) => {
            try {
              window.__HB_ROOM__?.setCustomStadium(json);
              try { window.__HB_ROOM__?.setTeamColors(1, 60, 0xFC0303, [0x000000, 0x000000, 0x000000]); } catch {}
              try { window.__HB_ROOM__?.startGame(); } catch {}
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
    } else if (msg.type === "auth.register") {
      const { playerId, playerName, password } = msg.payload || {};
      (async () => {
        try {
          const result = auth.register(db, playerName, password);
          await page.evaluate((id, text, color) => {
            window.__HB_ROOM__?.sendAnnouncement(text, id, color, "small", 1);
          }, playerId, result.message, result.success ? 0x66ff66 : 0xff4444);
        } catch (e) {
          log.error(`Auth register error: ${e?.message || e}`);
        }
      })();
    } else if (msg.type === "auth.login") {
      const { playerId, playerName, password } = msg.payload || {};
      (async () => {
        try {
          const result = auth.login(db, playerName, password);
          await page.evaluate((id, text, color, success) => {
            window.__HB_ROOM__?.sendAnnouncement(text, id, color, "small", 1);
            if (success) window.__HB_STATE__?.loggedInIds?.add(id);
          }, playerId, result.message, result.success ? 0x66ff66 : 0xff4444, !!result.success);
        } catch (e) {
          log.error(`Auth login error: ${e?.message || e}`);
        }
      })();
    } else if (msg.type === "auth.createLinkCode") {
      const { playerId, playerName } = msg.payload || {};
      (async () => {
        try {
          const player = db.getPlayerByName(playerName);
          if (!player) {
            await page.evaluate((id) => {
              window.__HB_ROOM__?.sendAnnouncement("Once kayit ol: !kayit <sifre>", id, 0xff4444, "small", 1);
            }, playerId);
            return;
          }
          const code = Math.random().toString(36).substring(2, 8).toUpperCase();
          db.createLinkCode(playerName, code);
          const msg = `Discord'da su komutu yaz:  /bagla nick:${playerName} kod:${code}  (5 dk gecerli)`;
          await page.evaluate((id, t) => {
            window.__HB_ROOM__?.sendAnnouncement(t, id, 0x66ff66, "small", 1);
          }, playerId, msg);
        } catch (e) {
          log.error(`Auth createLinkCode error: ${e?.message || e}`);
        }
      })();
    } else if (msg.type === "auth.profile") {
      const { playerId, playerName } = msg.payload || {};
      (async () => {
        try {
          const player = db.getPlayerByName(playerName);
          let text;
          if (player) {
            const discord = player.discord_id ? "bagli" : "baglanmamis";
            text = "Kayitli: " + player.haxball_name + " | Discord: " + discord + " | Kayit: " + player.created_at;
          } else {
            text = "Kayitli degilsin. !kayit <sifre> ile kayit ol.";
          }
          await page.evaluate((id, t) => {
            window.__HB_ROOM__?.sendAnnouncement(t, id, 0xdddddd, "small", 1);
          }, playerId, text);
        } catch (e) {
          log.error(`Auth profile error: ${e?.message || e}`);
        }
      })();
    } else if (msg.type === "record.update") {
      const { playerName, seconds } = msg.payload || {};
      try {
        db.setRecord(config.room.name, playerName, seconds);
      } catch (e) {
        log.error(`Record update failed: ${e?.message || e}`);
      }
    } else if (msg.type === "record.updatePersonal") {
      const { playerName, seconds } = msg.payload || {};
      try {
        db.setPersonalRecord(config.room.name, playerName, seconds);
      } catch (e) {
        log.error(`Personal record update failed: ${e?.message || e}`);
      }
    } else if (msg.type === "record.getTop") {
      const { playerId, limit } = msg.payload || {};
      (async () => {
        try {
          const rows = db.getTopRecords(config.room.name, Math.max(1, Math.min(20, Number(limit) || 5)));
          await page.evaluate((id, list) => {
            const fmt = (s) => {
              s = Math.max(0, Math.floor(s || 0));
              const m = Math.floor(s / 60);
              const r = s % 60;
              return m > 0 ? `${m}dk ${r}sn` : `${r}sn`;
            };
            const room = window.__HB_ROOM__;
            if (!room) return;
            if (!list || list.length === 0) {
              room.sendAnnouncement("Henuz kayitli rekor yok. Topu bottan uzak tut!", id, 0xdddddd, "small", 1);
              return;
            }
            room.sendAnnouncement(`Top ${list.length} rekor:`, id, 0x66ff66, "bold", 1);
            list.forEach((r, i) => {
              room.sendAnnouncement(`${i + 1}. ${r.player_name} — ${fmt(r.best_seconds)}`, id, 0xdddddd, "small", 1);
            });
          }, playerId, rows);
        } catch (e) {
          log.error(`Top records get failed: ${e?.message || e}`);
        }
      })();
    } else if (msg.type === "record.getPersonal") {
      const { playerId, playerName } = msg.payload || {};
      (async () => {
        try {
          const row = db.getPersonalRecord(config.room.name, playerName);
          const formatDur = (s) => {
            s = Math.max(0, Math.floor(s || 0));
            const m = Math.floor(s / 60);
            const r = s % 60;
            return m > 0 ? `${m}dk ${r}sn` : `${r}sn`;
          };
          const text = row && row.best_seconds > 0
            ? "Senin rekorun: " + formatDur(row.best_seconds) + "  (" + row.achieved_at + ")"
            : "Henuz kayitli rekorun yok. Topu bottan uzak tut!";
          await page.evaluate((id, t) => {
            window.__HB_ROOM__?.sendAnnouncement(t, id, 0xdddddd, "small", 1);
          }, playerId, text);
        } catch (e) {
          log.error(`Personal record get failed: ${e?.message || e}`);
        }
      })();
    } else if (msg.type === "room.statusUpdate") {
      const p = msg.payload || {};
      try {
        db.upsertRoomStatus({
          roomName: config.room.name,
          matchState: p.matchState,
          matchMode: p.matchMode,
          playerCount: p.playerCount ?? 0,
          scoreRed: p.scoreRed ?? 0,
          scoreBlue: p.scoreBlue ?? 0,
          activePlayer: p.activePlayer || null,
          queueSize: p.queueSize ?? 0,
        });
      } catch (e) {
        log.error(`Room status update failed: ${e?.message || e}`);
      }
    }
  });

  const injectedParts = [
    "injected/bridge.js",
    "injected/math.js",
    "injected/util.js",
    "injected/state.js",
    "injected/perception.js",
    "injected/decision.js",
    "injected/proDecision.js",
    "injected/nnDecision.js",
    "injected/treeBotDecision.js",
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

  // Load existing record from DB
  let existingRecord = null;
  try {
    const row = db.getRecord(config.room.name);
    if (row) existingRecord = { name: row.player_name, seconds: row.seconds };
  } catch (e) {
    log.warn(`Could not load record: ${e?.message || e}`);
  }

  // Optional: load NN weights JSON for DECISION_PROFILE=nn
  let nnWeights = null;
  if (config.nn?.weightsPath) {
    const weightsAbs = path.resolve(process.cwd(), config.nn.weightsPath);
    try {
      const raw = await fs.readFile(weightsAbs, "utf8");
      nnWeights = JSON.parse(raw);
      log.info(`Loaded NN weights: ${weightsAbs}`);
    } catch (e) {
      log.error(`Failed to load NN weights: ${weightsAbs} — ${e?.message || e}`);
    }
  }

  await page.evaluate(
    (cfg, stadiumJson, record, weights) => {
      window.__HB_CONFIG__ = cfg;
      if (stadiumJson) {
        window.__HB_CONFIG__.stadium = window.__HB_CONFIG__.stadium || {};
        window.__HB_CONFIG__.stadium.jsonString = stadiumJson;
      }
      window.__HB_CONFIG__.initialRecord = record;
      if (weights) window.__HB_NN_WEIGHTS__ = weights;
    },
    config,
    stadiumJsonString,
    existingRecord,
    nnWeights
  );

  await page.evaluate(injected);

  log.info(`Host started. Control WS at ${control.url}`);

  process.on("unhandledRejection", (e) => {
    log.error(`Unhandled rejection: ${e?.message || e}`);
  });

  // Respond to orchestrator health checks
  process.on("message", (msg) => {
    if (msg?.type === "ping") {
      process.send?.({ type: "pong", ts: Date.now() });
    }
  });

  return {
    shutdown: async () => {
      try { db.deleteRoomStatus(config.room.name); } catch {}
      try { db.close(); } catch {}
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

