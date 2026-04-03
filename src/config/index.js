import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

const DEFAULTS = {
  room: {
    name: "Private Training (Pass & Move)",
    password: "changeme",
    public: false,
    maxPlayers: 6,
    geo: { code: "TR", lat: 39.0, lon: 35.0 },
    noPlayer: true,
    token: "",
  },
  stadium: {
    path: "./bats_map.hbs",
  },
  trainee: {
    nickname: "",
  },
  bots: {
    count: 2,
    names: ["CoopBot1", "CoopBot2"],
    avatarPrefix: "🤖",
    launchDelayMs: 2500,
    userAgent: null,
  },
  training: {
    defaultMode: "triangle", // solo|triangle|wall|free
    autoStart: true,
  },
  permissions: {
    adminNicknames: [],
  },
  debug: {
    botDebug: false,
    logLevel: "info",
  },
  puppeteer: {
    headless: true,
    executablePath: null,
    launchArgs: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  },
};

function parseBool(s, fallback) {
  if (s == null) return fallback;
  if (typeof s === "boolean") return s;
  const v = String(s).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

function parseIntSafe(s, fallback) {
  const n = Number.parseInt(String(s), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatSafe(s, fallback) {
  const n = Number.parseFloat(String(s));
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
  else dotenv.config();

  const cfg = structuredClone(DEFAULTS);

  cfg.room.token = process.env.HAXBALL_TOKEN ?? cfg.room.token;
  cfg.room.name = process.env.ROOM_NAME ?? cfg.room.name;
  cfg.room.password = process.env.ROOM_PASSWORD ?? cfg.room.password;
  cfg.room.public = parseBool(process.env.ROOM_PUBLIC, cfg.room.public);
  cfg.room.maxPlayers = parseIntSafe(process.env.ROOM_MAX_PLAYERS, cfg.room.maxPlayers);
  cfg.room.noPlayer = parseBool(process.env.ROOM_NO_PLAYER, cfg.room.noPlayer);

  cfg.room.geo.code = process.env.ROOM_GEO_CODE ?? cfg.room.geo.code;
  cfg.room.geo.lat = parseFloatSafe(process.env.ROOM_GEO_LAT, cfg.room.geo.lat);
  cfg.room.geo.lon = parseFloatSafe(process.env.ROOM_GEO_LON, cfg.room.geo.lon);

  cfg.stadium.path = process.env.STADIUM_PATH ?? cfg.stadium.path;
  cfg.trainee.nickname = process.env.TRAINEE_NICKNAME ?? cfg.trainee.nickname;

  cfg.bots.count = Math.max(0, Math.min(2, parseIntSafe(process.env.BOT_COUNT, cfg.bots.count)));
  if (process.env.BOT_NAMES) {
    cfg.bots.names = process.env.BOT_NAMES.split(",").map((s) => s.trim()).filter(Boolean);
  }
  cfg.bots.avatarPrefix = process.env.BOT_AVATAR_PREFIX ?? cfg.bots.avatarPrefix;
  cfg.bots.launchDelayMs = parseIntSafe(process.env.BOT_LAUNCH_DELAY_MS, cfg.bots.launchDelayMs);
  cfg.bots.userAgent = process.env.BOT_USER_AGENT || cfg.bots.userAgent;
  cfg.training.defaultMode = process.env.DEFAULT_MODE ?? cfg.training.defaultMode;

  if (process.env.ADMIN_NICKNAMES) {
    cfg.permissions.adminNicknames = process.env.ADMIN_NICKNAMES.split(",").map((s) => s.trim()).filter(Boolean);
  }

  cfg.debug.botDebug = parseBool(process.env.BOT_DEBUG, cfg.debug.botDebug);
  cfg.debug.logLevel = process.env.LOG_LEVEL ?? cfg.debug.logLevel;

  cfg.puppeteer.headless = parseBool(process.env.PUPPETEER_HEADLESS, cfg.puppeteer.headless);
  cfg.puppeteer.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || cfg.puppeteer.executablePath;

  if (!cfg.room.token) {
    // Don’t throw here; host will emit a clear error and exit.
  }

  return cfg;
}

