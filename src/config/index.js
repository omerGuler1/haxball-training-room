import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

const DEFAULTS = {
  room: {
    name: "1v1 Training Arena",
    password: "",
    public: false,
    maxPlayers: 6,
    geo: { code: "TR", lat: 39.0, lon: 35.0 },
    noPlayer: true,
    token: "",
  },
  stadium: {
    path: "./v1.hbs",
  },
  bots: {
    count: 1,
    names: ["BatBot"],
    avatarPrefix: "🤖",
    launchDelayMs: 2500,
    userAgent: null,
  },
  training: {
    autoStart: true,
    /** Haxball: 1 = Red, 2 = Blue */
    botTeamId: 1,
    traineeTeamId: 2,
  },
  match: {
    mode: "1v1", // "1v1" = queue system, "all" = everyone plays on blue
    scoreLimit: 3,
    timeLimit: 180,
    matchOverPauseMs: 5000,
    autoRestart: true,
  },
  permissions: {
    adminNicknames: [],
  },
  db: {
    path: "./data/haxball.db",
  },
  discord: {
    token: "",
    guildId: "",
    channelId: "",
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
  // Support: node src/index.js --env .env.bats-v1
  const envArg = process.env.HB_ENV_FILE || process.argv.find((a) => a.startsWith("--env="))?.slice(6)
    || (process.argv.indexOf("--env") !== -1 ? process.argv[process.argv.indexOf("--env") + 1] : null);
  const envPath = envArg ? path.resolve(process.cwd(), envArg) : path.join(process.cwd(), ".env");
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

  cfg.bots.count = Math.max(0, Math.min(6, parseIntSafe(process.env.BOT_COUNT, cfg.bots.count)));
  if (process.env.BOT_NAMES) {
    cfg.bots.names = process.env.BOT_NAMES.split(",").map((s) => s.trim()).filter(Boolean);
  }
  cfg.bots.avatarPrefix = process.env.BOT_AVATAR_PREFIX ?? cfg.bots.avatarPrefix;
  cfg.bots.launchDelayMs = parseIntSafe(process.env.BOT_LAUNCH_DELAY_MS, cfg.bots.launchDelayMs);
  cfg.bots.userAgent = process.env.BOT_USER_AGENT || cfg.bots.userAgent;

  cfg.db.path = process.env.DB_PATH ?? cfg.db.path;
  cfg.discord.token = process.env.DISCORD_TOKEN ?? cfg.discord.token;
  cfg.discord.guildId = process.env.DISCORD_GUILD_ID ?? cfg.discord.guildId;
  cfg.discord.channelId = process.env.DISCORD_CHANNEL_ID ?? cfg.discord.channelId;

  cfg.match.mode = process.env.MATCH_MODE ?? cfg.match.mode;
  cfg.match.scoreLimit = parseIntSafe(process.env.MATCH_SCORE_LIMIT, cfg.match.scoreLimit);
  cfg.match.timeLimit = parseIntSafe(process.env.MATCH_TIME_LIMIT, cfg.match.timeLimit);
  cfg.match.matchOverPauseMs = parseIntSafe(process.env.MATCH_OVER_PAUSE_MS, cfg.match.matchOverPauseMs);

  const parseTeamId = (val, fallback) => {
    const v = String(val ?? "").trim().toLowerCase();
    if (v === "red" || v === "1") return 1;
    if (v === "blue" || v === "2") return 2;
    const n = parseIntSafe(val, fallback);
    return n === 1 || n === 2 ? n : fallback;
  };
  cfg.training.botTeamId = parseTeamId(process.env.BOT_TEAM, cfg.training.botTeamId);
  cfg.training.traineeTeamId = parseTeamId(process.env.TRAINEE_TEAM, cfg.training.traineeTeamId);
  if (process.env.TRAINING_TEAM && !process.env.TRAINEE_TEAM) {
    cfg.training.traineeTeamId = parseTeamId(process.env.TRAINING_TEAM, cfg.training.traineeTeamId);
    cfg.training.botTeamId = cfg.training.traineeTeamId === 1 ? 2 : 1;
  }
  if (cfg.training.botTeamId === cfg.training.traineeTeamId) {
    cfg.training.botTeamId = 1;
    cfg.training.traineeTeamId = 2;
  }

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

