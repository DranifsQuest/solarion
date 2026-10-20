'use strict';

/**
 * Solarion — database layer (Phase 1).
 *
 * SQLite via built-in node:sqlite (zero native deps), same proven approach
 * as Kingdom of Goleon. Sessions live in the DB, never in memory: a server
 * restart / crash / redeploy can never log anyone out.
 *
 * Schema v1:
 *   meta      — schema version + bookkeeping
 *   users     — accounts (bcrypt password hashes)
 *   avatars   — one avatar per account (customization, position, z coins)
 *   sessions  — 30-day login sessions keyed by random token
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.SOLARION_DB_PATH || path.join(__dirname, '..', 'data', 'solarion.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA_VERSION = 1;

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS avatars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  body_color TEXT NOT NULL DEFAULT '#3aa7e0',
  accent_color TEXT NOT NULL DEFAULT '#2b3a55',
  skin_tone TEXT NOT NULL DEFAULT '#f1c27d',
  hair_style TEXT NOT NULL DEFAULT 'short',
  hair_color TEXT NOT NULL DEFAULT '#3a2a1c',
  map_id TEXT NOT NULL DEFAULT 'the-gateway',
  x REAL NOT NULL DEFAULT 512,
  y REAL NOT NULL DEFAULT 560,
  zcoins INTEGER NOT NULL DEFAULT 0,
  last_bonus_day TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));

// ---------------------------------------------------------------- queries

const q = {
  insertUser: db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),

  insertAvatar: db.prepare(
    'INSERT INTO avatars (user_id, name, body_color, accent_color, skin_tone, hair_style, hair_color, map_id, x, y, zcoins, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
  ),
  avatarByUser: db.prepare('SELECT * FROM avatars WHERE user_id = ?'),
  saveAvatarPos: db.prepare('UPDATE avatars SET map_id = ?, x = ?, y = ? WHERE user_id = ?'),
  updateAvatarLook: db.prepare('UPDATE avatars SET hair_style = ?, hair_color = ?, body_color = ?, accent_color = ?, skin_tone = ? WHERE user_id = ?'),
  setZCoins: db.prepare('UPDATE avatars SET zcoins = ? WHERE user_id = ?'),

  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, last_ip) VALUES (?, ?, ?, ?, ?)'),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

  // Atomic daily-bonus claim: succeeds only when last_bonus_day differs
  // from today. Returns the number of changed rows (1 = bonus granted).
  claimDailyBonus: db.prepare(
    'UPDATE avatars SET zcoins = zcoins + 100, last_bonus_day = ? WHERE user_id = ? AND (last_bonus_day IS NULL OR last_bonus_day <> ?)'
  ),
};

module.exports = { db, q, DB_PATH, SCHEMA_VERSION };
