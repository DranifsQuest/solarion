'use strict';

/**
 * Solarion — authentication.
 *
 * register / login over HTTP. Sessions are rows in the `sessions` table with
 * a 30-day TTL; the token is presented as `?token=` on the WebSocket.
 *
 * Phase 5 hardening:
 *  - Login lockout is PER IP *and* PER ACCOUNT: N failures inside the
 *    window locks both for a timed lockout (env-tunable, default 5 min).
 *    A successful login clears the failing streaks.
 *  - Registration is throttled per IP (env-tunable, default 20/hr).
 *    Test harnesses that legitimately create many accounts from one IP
 *    set BOTH SOLARION_TEST=1 and SOLARION_TEST_NO_ABUSE_LIMITS=1; the
 *    dedicated security suite does NOT set the escape var and exercises
 *    the real limits.
 *  - Reserved usernames (admin, system, ...) can't be registered, so
 *    nobody can impersonate a system account.
 *  - All inbound values are type-guarded BEFORE they reach bcrypt or
 *    SQLite, so malformed JSON bodies return 4xx instead of throwing
 *    a 500 (info-leaking stack trace) or crashing.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q } = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 10;
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PASS_MIN = 6;
const PASS_MAX = 128; // bcrypt truncates at 72 bytes; cap well above it

// Names nobody may register — impersonating a system account.
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'system', 'solarion', 'moderator', 'mod',
  'support', 'staff', 'root', 'official', 'server', 'announcer',
  'relaun', 'relaunch', 'relaunchstudios',
]);

const DEFAULT_SPAWN = { map_id: 'the-gateway', x: 512, y: 560 };

// ---- Phase 5: login lockout + registration throttle (in-memory) -----
const envInt = (name, dflt) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};
const LOGIN_FAIL_LIMIT = 10;                    // failures per IP / per account
const LOGIN_FAIL_WINDOW_MS = 10 * 60 * 1000;    // counting window
const LOGIN_LOCKOUT_MS = envInt('SOLARION_LOGIN_LOCKOUT_MS', 5 * 60 * 1000);
const REGISTER_IP_LIMIT = envInt('SOLARION_REGISTER_LIMIT', 20);
const REGISTER_WINDOW_MS = envInt('SOLARION_REGISTER_WINDOW_MS', 60 * 60 * 1000);
const RATE_MAP_CAP = 20000;                     // prune before maps grow unbounded

const loginFails = new Map();    // ip -> { count, firstAt, lockedUntil }
const accountFails = new Map();  // lower(username) -> { count, firstAt, lockedUntil }
const registrations = new Map(); // ip -> { count, firstAt }

// True only inside bulk-account test harnesses: SOLARION_TEST harnesses
// that legitimately create many accounts from one IP set BOTH vars.
// Production never sets SOLARION_TEST, so abuse limits always apply
// there. The dedicated security suite does NOT set the escape var and
// tests the real limits.
function abuseLimitsRelaxed() {
  return process.env.SOLARION_TEST === '1' && process.env.SOLARION_TEST_NO_ABUSE_LIMITS === '1';
}

function pruneRateMap(map, windowMs, now) {
  for (const [k, v] of map) {
    if (now - v.firstAt >= windowMs) map.delete(k);
  }
}

function failRecord(map, key, windowMs) {
  const now = Date.now();
  if (map.size > RATE_MAP_CAP) pruneRateMap(map, windowMs, now);
  let rec = map.get(key);
  if (!rec || now - rec.firstAt >= windowMs) { rec = { count: 0, firstAt: now, lockedUntil: 0 }; map.set(key, rec); }
  rec.count++;
  if (rec.count >= LOGIN_FAIL_LIMIT && !rec.lockedUntil) rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  return rec;
}

function lockoutSecs(map, key, windowMs) {
  const rec = map.get(key);
  if (!rec) return null;
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return Math.max(1, Math.ceil((rec.lockedUntil - now) / 1000));
  }
  if (now - rec.firstAt >= windowMs) { map.delete(key); return null; }
  return null;
}

function noteRegistration(ip) {
  const now = Date.now();
  if (registrations.size > RATE_MAP_CAP) pruneRateMap(registrations, REGISTER_WINDOW_MS, now);
  const rec = registrations.get(ip);
  if (!rec || now - rec.firstAt >= REGISTER_WINDOW_MS) registrations.set(ip, { count: 1, firstAt: now });
  else rec.count++;
}

function registrationBlocked(ip) {
  if (abuseLimitsRelaxed()) return false;
  const rec = registrations.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAt >= REGISTER_WINDOW_MS) { registrations.delete(ip); return false; }
  return rec.count >= REGISTER_IP_LIMIT;
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
  SESSION_TTL_MS,
  LOGIN_FAIL_LIMIT, LOGIN_FAIL_WINDOW_MS, LOGIN_LOCKOUT_MS,
  REGISTER_IP_LIMIT, REGISTER_WINDOW_MS,

  register(username, password, opts, ip) {
    opts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    const ipKey = (typeof ip === 'string' && ip) ? ip : 'unknown';
    if (registrationBlocked(ipKey)) {
      return { ok: false, error: 'Too many accounts created from this address recently — try again later.', code: 429 };
    }
    if (typeof username !== 'string' || !USER_RE.test(username)) {
      return { ok: false, error: 'Username must be 3–20 letters, numbers or _.' };
    }
    if (RESERVED_USERNAMES.has(username.toLowerCase())) {
      return { ok: false, error: 'That username is reserved — pick another.' };
    }
    if (typeof password !== 'string' || password.length < PASS_MIN) {
      return { ok: false, error: 'Password must be at least 6 characters.' };
    }
    if (password.length > PASS_MAX) {
      return { ok: false, error: `Password must be at most ${PASS_MAX} characters.` };
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
    noteRegistration(ipKey);
    const token = newToken();
    q.insertSession.run(token, r.lastInsertRowid, now, now + SESSION_TTL_MS, ipKey);
    return { ok: true, token, avatar: publicAvatar(q.avatarByUser.get(r.lastInsertRowid)) };
  },

  login(username, password, ip) {
    const ipKey = (typeof ip === 'string' && ip) ? ip : 'unknown';
    // Phase 5: every inbound value is type-guarded before it touches
    // bcrypt or SQLite — malformed bodies get a plain 401, never a 500.
    if (typeof username !== 'string' || username.length === 0 || username.length > 64 ||
        typeof password !== 'string' || password.length === 0 || password.length > PASS_MAX) {
      failRecord(loginFails, ipKey, LOGIN_FAIL_WINDOW_MS);
      return { ok: false, error: 'Invalid username or password.', code: 401 };
    }
    const ipLocked = lockoutSecs(loginFails, ipKey, LOGIN_FAIL_WINDOW_MS);
    const acctKey = username.toLowerCase();
    const acctLocked = lockoutSecs(accountFails, acctKey, LOGIN_FAIL_WINDOW_MS);
    const locked = ipLocked != null ? ipLocked : acctLocked;
    if (locked != null) {
      return { ok: false, error: `Too many failed logins — try again in ${locked}s.`, code: 429 };
    }
    const u = q.userByName.get(username);
    // Constant-time-ish: always run a compare so a missing account isn't
    // faster than a wrong password (thwarts user-enumeration timing).
    const hash = u ? u.pass_hash : '$2a$10$invalidinvalidinvalidinvalidinvalid12';
    const compared = bcrypt.compareSync(password, hash);
    const good = Boolean(u && compared);
    if (!good) {
      failRecord(loginFails, ipKey, LOGIN_FAIL_WINDOW_MS);
      failRecord(accountFails, acctKey, LOGIN_FAIL_WINDOW_MS);
      const relock = lockoutSecs(loginFails, ipKey, LOGIN_FAIL_WINDOW_MS) != null ||
                     lockoutSecs(accountFails, acctKey, LOGIN_FAIL_WINDOW_MS) != null;
      if (relock) {
        const secs = lockoutSecs(loginFails, ipKey, LOGIN_FAIL_WINDOW_MS) ||
                     lockoutSecs(accountFails, acctKey, LOGIN_FAIL_WINDOW_MS);
        return { ok: false, error: `Too many failed logins — try again in ${secs}s.`, code: 429 };
      }
      return { ok: false, error: 'Invalid username or password.', code: 401 };
    }
    loginFails.delete(ipKey);
    accountFails.delete(acctKey);
    const now = Date.now();
    const token = newToken();
    q.insertSession.run(token, u.id, now, now + SESSION_TTL_MS, ipKey);
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

  /**
   * Phase 4 — avatar editing. Validates against the SAME sets used at
   * registration (SKIN_TONES / HAIR_STYLES / COLOR_RE above) so there is
   * exactly one source of truth for what a legal look is. Accepts the
   * canonical column names (body_color / accent_color) plus the
   * registration aliases (shirt / pants). Partial updates merge with the
   * current look; every provided field must be valid or nothing changes.
   *
   * Phase 5: the field set is a WHITELIST — any other key in the client
   * message (zcoins, name, user_id, map_id, ...) is silently ignored, so
   * there is no way to escalate via avatar-update.
   */
  updateAvatar(userId, opts) {
    if (!Number.isInteger(userId)) return { ok: false, error: 'No such avatar.' };
    opts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    const cur = q.avatarByUser.get(userId);
    if (!cur) return { ok: false, error: 'No such avatar.' };
    const next = {
      hair_style: cur.hair_style,
      hair_color: cur.hair_color,
      body_color: cur.body_color,
      accent_color: cur.accent_color,
      skin_tone: cur.skin_tone,
    };
    let touched = false;
    if (opts.hair_style !== undefined) {
      if (!HAIR_STYLES.includes(opts.hair_style)) return { ok: false, error: `Invalid hair style. Choose: ${HAIR_STYLES.join(', ')}.` };
      next.hair_style = opts.hair_style; touched = true;
    }
    if (opts.hair_color !== undefined) {
      if (typeof opts.hair_color !== 'string' || !COLOR_RE.test(opts.hair_color)) return { ok: false, error: 'Invalid hair color (use #rrggbb).' };
      next.hair_color = opts.hair_color; touched = true;
    }
    const shirt = opts.body_color !== undefined ? opts.body_color : opts.shirt;
    if (shirt !== undefined) {
      if (typeof shirt !== 'string' || !COLOR_RE.test(shirt)) return { ok: false, error: 'Invalid shirt color (use #rrggbb).' };
      next.body_color = shirt; touched = true;
    }
    const pants = opts.accent_color !== undefined ? opts.accent_color : opts.pants;
    if (pants !== undefined) {
      if (typeof pants !== 'string' || !COLOR_RE.test(pants)) return { ok: false, error: 'Invalid pants color (use #rrggbb).' };
      next.accent_color = pants; touched = true;
    }
    if (opts.skin_tone !== undefined) {
      if (!SKIN_TONES.includes(opts.skin_tone)) return { ok: false, error: 'Invalid skin tone.' };
      next.skin_tone = opts.skin_tone; touched = true;
    }
    if (!touched) return { ok: false, error: 'Nothing to update.' };
    q.updateAvatarLook.run(next.hair_style, next.hair_color, next.body_color, next.accent_color, next.skin_tone, userId);
    return { ok: true, avatar: publicAvatar(q.avatarByUser.get(userId)) };
  },

  publicAvatar,
};

// The single source of truth for legal looks (registration + editing).
auth.SKIN_TONES = SKIN_TONES;
auth.HAIR_STYLES = HAIR_STYLES;
auth.COLOR_RE = COLOR_RE;

module.exports = auth;
