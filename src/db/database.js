import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  haxball_name TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  discord_id TEXT UNIQUE,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS link_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  haxball_name TEXT NOT NULL COLLATE NOCASE,
  code TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_records (
  room_name TEXT PRIMARY KEY,
  player_name TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  achieved_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_status (
  room_name TEXT PRIMARY KEY,
  match_state TEXT,
  match_mode TEXT,
  player_count INTEGER DEFAULT 0,
  score_red INTEGER DEFAULT 0,
  score_blue INTEGER DEFAULT 0,
  active_player TEXT,
  queue_size INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);

  return {
    // ── Players ─────────────────────────────────────

    getPlayerByName(name) {
      return db.prepare("SELECT * FROM players WHERE haxball_name = ?").get(name);
    },

    getPlayerByDiscordId(discordId) {
      return db.prepare("SELECT * FROM players WHERE discord_id = ?").get(discordId);
    },

    createPlayer(name, passwordHash) {
      return db.prepare("INSERT INTO players (haxball_name, password_hash) VALUES (?, ?)").run(name, passwordHash);
    },

    updateLastLogin(name) {
      return db.prepare("UPDATE players SET last_login = datetime('now') WHERE haxball_name = ?").run(name);
    },

    linkDiscord(name, discordId) {
      return db.prepare("UPDATE players SET discord_id = ? WHERE haxball_name = ?").run(discordId, name);
    },

    unlinkDiscord(discordId) {
      return db.prepare("UPDATE players SET discord_id = NULL WHERE discord_id = ?").run(discordId);
    },

    // ── Link Codes ───────────────────────────────────

    createLinkCode(haxballName, code) {
      // Remove old codes for this player first
      db.prepare("DELETE FROM link_codes WHERE haxball_name = ?").run(haxballName);
      return db.prepare("INSERT INTO link_codes (haxball_name, code) VALUES (?, ?)").run(haxballName, code);
    },

    verifyLinkCode(haxballName, code) {
      const row = db.prepare(
        "SELECT * FROM link_codes WHERE haxball_name = ? AND code = ? AND created_at > datetime('now', '-5 minutes')"
      ).get(haxballName, code);
      if (row) {
        db.prepare("DELETE FROM link_codes WHERE id = ?").run(row.id);
      }
      return row || null;
    },

    // ── Room Records ─────────────────────────────────

    getRecord(roomName) {
      return db.prepare("SELECT * FROM room_records WHERE room_name = ?").get(roomName);
    },

    setRecord(roomName, playerName, seconds) {
      return db.prepare(`
        INSERT INTO room_records (room_name, player_name, seconds, achieved_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(room_name) DO UPDATE SET
          player_name = excluded.player_name,
          seconds = excluded.seconds,
          achieved_at = datetime('now')
      `).run(roomName, playerName, seconds);
    },

    // ── Room Status ─────────────────────────────────

    upsertRoomStatus({ roomName, matchState, matchMode, playerCount, scoreRed, scoreBlue, activePlayer, queueSize }) {
      return db.prepare(`
        INSERT INTO room_status (room_name, match_state, match_mode, player_count, score_red, score_blue, active_player, queue_size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(room_name) DO UPDATE SET
          match_state = excluded.match_state,
          match_mode = excluded.match_mode,
          player_count = excluded.player_count,
          score_red = excluded.score_red,
          score_blue = excluded.score_blue,
          active_player = excluded.active_player,
          queue_size = excluded.queue_size,
          updated_at = datetime('now')
      `).run(roomName, matchState, matchMode, playerCount, scoreRed, scoreBlue, activePlayer, queueSize);
    },

    getAllRoomStatuses() {
      return db.prepare("SELECT * FROM room_status ORDER BY room_name").all();
    },

    deleteRoomStatus(roomName) {
      return db.prepare("DELETE FROM room_status WHERE room_name = ?").run(roomName);
    },

    close() {
      db.close();
    },
  };
}
