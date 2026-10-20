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
const appearance = require('./appearance');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 10;
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const COLOR_RE = appearance.COLOR_RE;
const PASS_MIN = 6;
const PASS_MAX = 128; // bcrypt truncates at 72 bytes; cap well above it
// Display names (chosen on the creation screen): username charset plus
// spaces, 3–20 chars once trimmed, never blank, never a reserved name.
const NAME_RE = /^[A-Za-z0-9_ ]{3,20}$/;

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
    created: Boolean(a.created),
    gender: a.gender || 'M',
    face: a.face || 'classic',
    eyes: a.eyes || 'round',
    eye_color: a.eye_color || '#20242c',
    nose: a.nose || 'button',
    lips: a.lips || 'natural',
    body_color: a.body_color,
    accent_color: a.accent_color,
    skin_tone: a.skin_tone,
    hair_style: a.hair_style,
    hair_color: a.hair_color,
    top_style: a.top_style || 'tee',
    bottom_style: a.bottom_style || 'pants',
    shoe_color: a.shoe_color || '#23262b',
    accessory: a.accessory || 'none',
    map_id: a.map_id,
    x: a.x,
    y: a.y,
    zcoins: a.zcoins,
  };
}

/** The look axes of an avatar row as a plain look object. */
function lookOf(a) {
  const p = publicAvatar(a);
  const look = {};
  for (const axis of appearance.AXIS_NAMES) look[axis] = p[axis];
  return look;
}

// Back-compat exports (Phase 4/5 shape): SKIN_TONES is now the 8-tone
// list and HAIR_STYLES the per-gender map — both live in appearance.js.
const SKIN_TONES = appearance.SKIN_TONES;
const HAIR_STYLES = appearance.HAIR_STYLES;

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
    // Phase 6: registration creates the ACCOUNT only. The avatar row
    // is a placeholder (username as name, default look, created = 0);
    // the look is chosen on the character creation screen after login
    // (see createCharacter). Any look fields in `opts` are ignored.
    const d = appearance.defaultsFor('M');
    const now = Date.now();
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const r = q.insertUser.run(username, hash, now);
    q.insertAvatar.run(r.lastInsertRowid, username, d.body_color, d.accent_color, d.skin_tone,
      d.hair_style, d.hair_color, DEFAULT_SPAWN.map_id, DEFAULT_SPAWN.x, DEFAULT_SPAWN.y, now);
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
   * Phase 6 — character creation. One-shot: only an account whose
   * avatar is still a placeholder (created = 0) may create. Validates
   * the display name and EVERY look axis against appearance.js (the
   * shared options module), fills unprovided axes with the gender's
   * defaults, writes name + look + created = 1 atomically.
   */
  createCharacter(userId, input) {
    if (!Number.isInteger(userId)) return { ok: false, error: 'No such avatar.' };
    input = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
    const cur = q.avatarByUser.get(userId);
    if (!cur) return { ok: false, error: 'No such avatar.' };
    if (cur.created) return { ok: false, error: 'Character already created — use the look editor to change it.', code: 409 };
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!NAME_RE.test(name)) {
      return { ok: false, error: 'Name must be 3–20 letters, numbers, spaces or _.' };
    }
    if (RESERVED_USERNAMES.has(name.toLowerCase())) {
      return { ok: false, error: 'That name is reserved — pick another.' };
    }
    const gender = input.gender !== undefined ? input.gender : 'M';
    if (typeof gender !== 'string' || !appearance.GENDERS.includes(gender)) {
      return { ok: false, error: 'Invalid gender. Choose: M, F.' };
    }
    const base = appearance.defaultsFor(gender);
    const merged = appearance.mergeLook(base, { ...input, gender });
    if (merged.error) return { ok: false, error: merged.error };
    const L = merged.look;
    q.createCharacter.run(name, L.gender, L.face, L.eyes, L.eye_color, L.nose, L.lips,
      L.skin_tone, L.hair_style, L.hair_color, L.top_style, L.body_color,
      L.bottom_style, L.accent_color, L.shoe_color, L.accessory, userId);
    return { ok: true, avatar: publicAvatar(q.avatarByUser.get(userId)) };
  },

  /**
   * Avatar editing (Phase 4, expanded in Phase 6 to every axis).
   * Validation lives in appearance.js — the SAME module the creation
   * screen uses, so create and edit can never disagree about a legal
   * look. Partial updates merge with the current look; every provided
   * field must be valid or nothing changes. Switching gender resets
   * any per-gender axis that doesn't exist for the new gender to its
   * default (appearance.mergeLook).
   *
   * The field set is a WHITELIST (the appearance axes) — any other key
   * in the client message (zcoins, name, user_id, map_id, created...)
   * is silently ignored, so there is no way to escalate via
   * avatar-update. Legacy aliases shirt/pants map to body/accent color.
   */
  updateAvatar(userId, opts) {
    if (!Number.isInteger(userId)) return { ok: false, error: 'No such avatar.' };
    opts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    const cur = q.avatarByUser.get(userId);
    if (!cur) return { ok: false, error: 'No such avatar.' };
    const input = {};
    for (const axis of appearance.AXIS_NAMES) {
      if (opts[axis] !== undefined) input[axis] = opts[axis];
    }
    if (input.body_color === undefined && opts.shirt !== undefined) input.body_color = opts.shirt;
    if (input.accent_color === undefined && opts.pants !== undefined) input.accent_color = opts.pants;
    if (!Object.keys(input).length) return { ok: false, error: 'Nothing to update.' };
    const merged = appearance.mergeLook(lookOf(cur), input);
    if (merged.error) {
      // Keep the Phase 4 error wording for the classic axes.
      if (/hair style/.test(merged.error)) {
        const g = typeof input.gender === 'string' && appearance.GENDERS.includes(input.gender) ? input.gender : cur.gender;
        return { ok: false, error: `Invalid hair style. Choose: ${appearance.HAIR_STYLES[g].join(', ')}.` };
      }
      if (/hair color|top color|bottom color/.test(merged.error)) {
        return { ok: false, error: merged.error.replace(' color.', ' color (use #rrggbb).') };
      }
      return { ok: false, error: merged.error };
    }
    const L = merged.look;
    q.updateAvatarLook.run(L.gender, L.face, L.eyes, L.eye_color, L.nose, L.lips,
      L.skin_tone, L.hair_style, L.hair_color, L.top_style, L.body_color,
      L.bottom_style, L.accent_color, L.shoe_color, L.accessory, userId);
    return { ok: true, avatar: publicAvatar(q.avatarByUser.get(userId)) };
  },

  publicAvatar,
};

// The single source of truth for legal looks (registration + editing).
auth.SKIN_TONES = SKIN_TONES;
auth.HAIR_STYLES = HAIR_STYLES;
auth.COLOR_RE = COLOR_RE;

module.exports = auth;
