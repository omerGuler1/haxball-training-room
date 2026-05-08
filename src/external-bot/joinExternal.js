// Standalone NN bot that joins an EXISTING Haxball room as a player.
// Uses node-haxball (reverse-engineered Haxball client) — no Puppeteer/browser.
//
// Usage:
//   node src/external-bot/joinExternal.js <ROOM_ID>
//   ROOM_ID is the c=... part of the room URL (e.g. for
//   https://www.haxball.com/play?c=qikgD6zASPY → "qikgD6zASPY")
//
// Optional env:
//   BOT_NAME           — display name (default: BatNN)
//   HB_ROOM_PASSWORD   — room password if any
//   NN_WEIGHTS_PATH    — path to weights.json (default: ./HaxAI-main/weights.json)
//
// Existing modes (squares, 1v1pro, 1v1nn, classic) are NOT touched by this script.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const API = require("node-haxball")();
const EnglishLanguage = require("node-haxball/examples/languages/englishLanguage");
const { Plugin, Utils, Room, AllowFlags, Language } = API;
Language.current = new EnglishLanguage(API);

// ── Args / env ─────────────────────────────────────────
const ROOM_ID = process.argv[2];
if (!ROOM_ID) {
  console.error("Usage: node src/external-bot/joinExternal.js <ROOM_ID>");
  console.error("ROOM_ID = the c=... portion of the haxball room URL");
  process.exit(1);
}
const BOT_NAME       = process.env.BOT_NAME || "BatNN";
const ROOM_PASSWORD  = process.env.HB_ROOM_PASSWORD || "";
// const WEIGHTS_PATH   = process.env.NN_WEIGHTS_PATH || "./HaxAI-main/weights.json";
const WEIGHTS_PATH   = process.env.NN_WEIGHTS_PATH || "./models/v12_league.json";

// ── Load weights ───────────────────────────────────────
const W = JSON.parse(readFileSync(resolve(process.cwd(), WEIGHTS_PATH), "utf8"));
console.log(`[BatNN] Loaded weights: W0=[${W.w0.length}×${W.w0[0].length}] W1=[${W.w1.length}×${W.w1[0].length}] W2=[${W.w2.length}×${W.w2[0].length}]`);

// ── HaxAI training-sim constants (mirror of config.py) ─
const FIELD_W = 368;
const FIELD_H = 171;
const MAX_VEL = 15.0;
const FW2 = FIELD_W * 2;
const FH2 = FIELD_H * 2;
const KICK_RANGE_APPROX = 35;
const INFER_EVERY = 4;

// ── Inference (pure JS) ────────────────────────────────
function matVec(M, v) {
  const out = new Array(M.length);
  for (let i = 0; i < M.length; i++) {
    let s = 0;
    const row = M[i];
    for (let j = 0; j < row.length; j++) s += row[j] * v[j];
    out[i] = s;
  }
  return out;
}
function addB(v, b) { for (let i = 0; i < v.length; i++) v[i] += b[i]; return v; }
function tanhV(v)   { for (let i = 0; i < v.length; i++) v[i] = Math.tanh(v[i]); return v; }
function argmaxR(a, s, e) {
  let bi = s;
  for (let i = s + 1; i < e; i++) if (a[i] > a[bi]) bi = i;
  return bi - s;
}
function policyInfer(obs) {
  const h1 = tanhV(addB(matVec(W.w0, obs), W.b0));
  const h2 = tanhV(addB(matVec(W.w1, h1), W.b1));
  const lg = addB(matVec(W.w2, h2), W.b2);
  return [argmaxR(lg, 0, 3), argmaxR(lg, 3, 6), argmaxR(lg, 6, 8)];
}

// ── Observation builder (mirror of selfplay_env._get_obs) ──
function nc(v, m) { return Math.max(-1, Math.min(1, v / m)); }
function buildObs({ ball, bot, opp, teamId }) {
  const dm = teamId === 1 ? 1 : -1;
  const goalX = FIELD_W * dm;
  const dx = ball.x - bot.x, dy = ball.y - bot.y;
  const distToBall = Math.hypot(dx, dy);
  const canKick = distToBall < KICK_RANGE_APPROX ? 1 : -1;
  return [
    nc(bot.vx * dm,         MAX_VEL),
    nc(bot.vy,              MAX_VEL),
    nc(dx * dm,             FW2),
    nc(dy,                  FH2),
    nc(ball.vx * dm,        MAX_VEL),
    nc(ball.vy,             MAX_VEL),
    nc((goalX - bot.x) * dm, FW2),
    nc(0 - bot.y,           FH2),
    canKick,
    nc((opp.x - bot.x) * dm, FW2),
    nc(opp.y - bot.y,        FH2),
    nc(opp.vx * dm,          MAX_VEL),
    nc(opp.vy,               MAX_VEL),
  ];
}

// ── Plugin: NN-driven bot logic ────────────────────────
function NNBotPlugin() {
  Object.setPrototypeOf(this, Plugin.prototype);
  Plugin.call(this, "nn_bot", true, {
    version: "0.1",
    author: "hax_recovered",
    description: "NN bot using HaxAI SP_V16 weights for 1v1 play",
    allowFlags: AllowFlags.JoinRoom,
  });

  let lastAction  = [1, 1, 0]; // [ax_idx, ay_idx, kick_idx] — idle
  let lastInfer   = -INFER_EVERY;
  let tick        = 0;
  const that      = this;

  this.onGameTick = function () {
    that.room.extrapolate();
    const cp = that.room.currentPlayer;
    const playerDisc = cp?.disc?.ext;
    if (!playerDisc || !cp?.team) return;

    const teamId = cp.team.id;
    if (teamId !== 1 && teamId !== 2) return;        // bot is in spectator
    const opponentTeamId = 3 - teamId;

    const { state, gameState, gameStateExt } = that.room;
    const gs = gameStateExt || gameState;
    const ball = gs?.physicsState?.discs?.[0];
    if (!ball?.pos) return;

    // Find first opponent disc
    let oppDisc = null;
    for (const p of state.players) {
      if (p?.team?.id === opponentTeamId && p?.disc?.ext) {
        oppDisc = p.disc.ext;
        break;
      }
    }
    if (!oppDisc) return; // no opponent yet; idle

    // Infer every INFER_EVERY ticks
    if (tick - lastInfer >= INFER_EVERY) {
      try {
        const obs = buildObs({
          ball: { x: ball.pos.x, y: ball.pos.y, vx: ball.speed?.x || 0, vy: ball.speed?.y || 0 },
          bot:  { x: playerDisc.pos.x, y: playerDisc.pos.y, vx: playerDisc.speed?.x || 0, vy: playerDisc.speed?.y || 0 },
          opp:  { x: oppDisc.pos.x, y: oppDisc.pos.y, vx: oppDisc.speed?.x || 0, vy: oppDisc.speed?.y || 0 },
          teamId,
        });
        lastAction = policyInfer(obs);
      } catch {
        lastAction = [1, 1, 0];
      }
      lastInfer = tick;
    }
    tick++;

    const [ax_i, ay_i, k_i] = lastAction;
    let dirX = ax_i === 0 ? -1 : ax_i === 2 ? 1 : 0;
    let dirY = ay_i === 0 ? -1 : ay_i === 2 ? 1 : 0;
    if (teamId === 2) dirX = -dirX; // POV symmetry: blue mirrors x

    that.room.setKeyState(Utils.keyState(dirX, dirY, k_i === 1));
  };

  this.onPlayerJoin = function (player) {
    if (player?.id === that.room.currentPlayer?.id) {
      console.log(`[BatNN] Joined as id=${player.id}, name="${player.name}", team=${player.team?.id ?? 0}`);
    }
  };
  this.onPlayerKicked = function (kickedPlayer, reason) {
    if (kickedPlayer?.id === that.room.currentPlayer?.id) {
      console.log(`[BatNN] Kicked from room: ${reason || "no reason"}`);
    }
  };
}

// ── Join the room ──────────────────────────────────────
console.log(`[BatNN] Joining room "${ROOM_ID}" as "${BOT_NAME}"${ROOM_PASSWORD ? " (with password)" : ""}...`);

Utils.generateAuth().then(([authKey, authObj]) => {
  Room.join({
    id: ROOM_ID,
    password: ROOM_PASSWORD || undefined,
    authObj,
  }, {
    storage: {
      player_name: BOT_NAME,
      avatar: "🤖",
      player_auth_key: authKey,
    },
    config: null,
    renderer: null,
    plugins: [new NNBotPlugin()],
    onOpen: (room) => {
      console.log(`[BatNN] In room: "${room.state?.name || "?"}", players: ${room.state?.players?.length ?? "?"}`);
    },
    onClose: (msg) => {
      console.log(`[BatNN] Disconnected: ${msg?.toString?.() || msg}`);
      process.exit(0);
    },
  });
}).catch((e) => {
  console.error(`[BatNN] Failed to join: ${e?.message || e}`);
  process.exit(1);
});

process.on("SIGINT", () => { console.log("[BatNN] SIGINT — exiting"); process.exit(0); });
