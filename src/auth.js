'use strict';

/**
 * Solarion — authentication.
 *
 * register / login over HTTP. Sessions are rows in the `sessions` table with
 * a 30-day TTL; the token is presented as `?token=` on the WebSocket.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q } = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 10;
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_SPAWN = { map_id: 'the-gateway', x: 512, y: 560 };

// ---- login failure rate limiting (process-local, in-memory) ------------
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;
const loginFails = new Map(); // ip -> { count, firstAt }

function lockoutSecs(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return null;
  const now = Date.now();
  if (now - rec.firstAt >= LOGIN_FAIL_WINDOW_MS) { loginFails.delete(ip); return null; }
  if (rec.count >= LOGIN_FAIL_LIMIT) {
    return Math.max(1, Math.ceil((rec.firstAt + LOGIN_FAIL_WINDOW_MS - now) / 1000));
  }
  return null;
}

function noteFailedLogin(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (!rec || now - rec.firstAt >= LOGIN_FAIL_WINDOW_MS) loginFails.set(ip, { count: 1, firstAt: now });
  else rec.count++;
  if (loginFails.size > 20000) loginFails.clear();
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicAvatar(a) {
  return {
    id: a.id,
    user_id: a.user_id,
    name: a.name,
    body_color: a.body_color,
    accent_color: a.accent_color,
    skin_tone: a.skin_tone,
    hair_style: a.hair_style,
    hair_color: a.hair_color,
    map_id: a.map_id,
    x: a.x,
    y: a.y,
    zcoins: a.zcoins,
  };
}

const SKIN_TONES = ['#ffe0bd', '#f1c27d', '#e0ac69', '#8d5524'];
const HAIR_STYLES = ['short', 'spiky', 'long'];

const auth = {
  register(username, password, opts) {
    opts = opts || {};
    if (typeof username !== 'string' || !USER_RE.test(username)) {
      return { ok: false, error: 'Username must be 3–20 letters, numbers or _.' };
    }
    if (typeof password !== 'string' || password.length < 6) {
      return { ok: false, error: 'Password must be at least 6 characters.' };
    }
    if (q.userByName.get(username)) {
      return { ok: false, error: 'That username is already taken.' };
    }
    const shirt = typeof opts.shirt === 'string' && COLOR_RE.test(opts.shirt) ? opts.shirt : '#3aa7e0';
    const pants = typeof opts.pants === 'string' && COLOR_RE.test(opts.pants) ? opts.pants : '#2b3a55';
    const skin = SKIN_TONES.includes(opts.skin_tone) ? opts.skin_tone : '#f1c27d';
    const hair = HAIR_STYLES.includes(opts.hair_style) ? opts.hair_style : 'short';
    const hairColor = typeof opts.hair_color === 'string' && COLOR_RE.test(opts.hair_color) ? opts.hair_color : '#3a2a1c';
    const now = Date.now();
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const r = q.insertUser.run(username, hash, now);
    q.insertAvatar.run(r.lastInsertRowid, username, shirt, pants, skin, hair, hairColor,
      DEFAULT_SPAWN.map_id, DEFAULT_SPAWN.x, DEFAULT_SPAWN.y, now);
    const token = newToken();
    q.insertSession.run(token, r.lastInsertRowid, now, now + SESSION_TTL_MS, null);
    return { ok: true, token, avatar: publicAvatar(q.avatarByUser.get(r.lastInsertRowid)) };
  },

  login(username, password, ip) {
    const locked = lockoutSecs(ip);
    if (locked) return { ok: false, error: `Too many failed logins — try again in ${locked}s.`, code: 429 };
    const u = q.userByName.get(username);
    if (!u || !bcrypt.compareSync(password, u.pass_hash)) {
      noteFailedLogin(ip);
      return { ok: false, error: 'Invalid username or password.', code: 401 };
    }
    const now = Date.now();
    const token = newToken();
    q.insertSession.run(token, u.id, now, now + SESSION_TTL_MS, ip || null);
    return { ok: true, token, avatar: publicAvatar(q.avatarByUser.get(u.id)) };
  },

  // Resolve a session token -> { user, avatar } or null. Expired sessions are deleted.
  resolveSession(token) {
    if (typeof token !== 'string' || token.length < 16) return null;
    const s = q.sessionByToken.get(token);
    if (!s) return null;
    if (s.expires_at <= Date.now()) {
      q.deleteSession.run(token);
      return null;
    }
    const u = q.userById.get(s.user_id);
    const a = q.avatarByUser.get(s.user_id);
    if (!u || !a) return null;
    return { user: u, avatar: a };
  },

  logout(token) {
    q.deleteSession.run(token);
  },

  publicAvatar,
};

module.exports = auth;
