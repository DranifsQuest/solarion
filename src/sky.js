'use strict';

/**
 * Solarion — day/night + weather (X's spec, 2026-10-26).
 *
 * DAY/NIGHT — the real clock, not the 12-minute world clock: Day is
 * 08:00–20:00 America/Chicago, Night is everything else. The server
 * owns the clock (same America/Chicago calendar as the visitor
 * windows and the seasonal themes); the client never computes
 * day/night from its own clock.
 *
 * WEATHER — server-authoritative and identical for every player:
 * time is divided into 2-hour cycles anchored to even CT hours
 * (00, 02, 04, …, 22). The first 20 minutes of each cycle carry
 * one weather event; the other 100 minutes are clear. The event
 * type is picked deterministically per cycle (hash of the cycle
 * key) and is never the previous cycle's type, so the sequence
 * feels random but is the same for every server, every restart,
 * and every test. Clients render ground effects from the event
 * timestamps alone — no per-client randomness for event state.
 *
 * SCOPE — weather and night apply to OUTDOOR public maps only
 * (the Gateway + the five cities). The two hidden maps (the
 * Threshold, Elsewhere) keep their scene atmosphere, and interiors
 * (café, casinos, Hookah Lounge, Club Mirage, player homes) keep
 * their interior lighting with no weather. Weather is not NPCs.
 *
 * GROUND EFFECTS — snow coverage grows 0→1 across the 20-minute
 * event, then melts linearly over the next 60 minutes, so the
 * world is back to normal long before the next event. Rain
 * puddles follow the same curve. Thunderstorm lightning strikes
 * are server-picked ground points (biased near players outdoors);
 * each leaves a scorch mark that fades after a few minutes, and a
 * strike landing on a character's tile triggers a COSMETIC-ONLY
 * reaction (startle hop + bubble) — no damage, no stats, no
 * death. This is a cozy game.
 *
 * DST EDGES (documented, not bugs): on spring-forward day the
 * 02:00 cycle never exists, so that cycle's event is skipped.
 * On fall-back day the 00:00 hour repeats, so that cycle's event
 * window appears twice in wall-clock terms. Both follow from
 * anchoring to wall-clock hours, which is what the spec asks for.
 */

const { TILE, MAPS, isSolidTile } = require('./maps');

const TIME_ZONE = 'America/Chicago';
const DAY_START_MIN = 8 * 60;    // 08:00 CT — day begins
const DAY_END_MIN = 20 * 60;     // 20:00 CT — night begins
const EVENT_MS = 20 * 60 * 1000; // weather events last 20 minutes
const DECAY_MS = 60 * 60 * 1000; // snow melt / puddle evaporation after an event
const MARK_MS = 3 * 60 * 1000;   // scorch-mark lifetime ("a few minutes")
const STRIKE_MIN_MS = 20 * 1000; // lightning cadence during a storm
const STRIKE_MAX_MS = 45 * 1000;
const MARK_FADE_MS = 30 * 1000;  // a mark fades across its final 30s
const WEATHER_TYPES = ['snow', 'rain', 'thunderstorm'];

/** Outdoor public maps — the only maps that get weather or night. */
const OUTDOOR_MAPS = new Set([
  'the-gateway', 'solstice-bay', 'neon-district',
  'cinder-mesa', 'frosthaven', 'verdant-hollow',
]);

/** True when this map id gets weather + night (hidden + interiors do not). */
function isOutdoorMapId(mapId) {
  return OUTDOOR_MAPS.has(mapId);
}

// ------------------------------------------------------------ CT clock

const ctFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
});

/** Wall-clock parts in America/Chicago for an instant. */
function ctParts(date) {
  const out = {};
  for (const p of ctFmt.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Minutes since CT midnight for an instant. */
function ctMinutes(date) {
  const p = ctParts(date);
  return p.hour * 60 + p.minute;
}

/**
 * True at night: before 08:00 or from 20:00 CT. The boundaries
 * are sharp — 07:59 is day, 08:00 is day, 19:59 is day, 20:00
 * is night (08:00 belongs to day, 20:00 belongs to night).
 */
function isNightAt(date = new Date()) {
  const m = ctMinutes(date);
  return m < DAY_START_MIN || m >= DAY_END_MIN;
}

// ------------------------------------------------------------ cycle schedule

function hashKey(str) { // FNV-1a, 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** "YYYY-M-D#H" for a wall date + even hour. */
function cycleKeyFor(y, mo, d, h) {
  return `${y}-${mo}-${d}#${h}`;
}

/** The previous even-hour cycle key, wrapping midnight. */
function prevCycleKey(key) {
  const [d, h] = key.split('#');
  const hour = Number(h);
  if (hour > 0) return `${d}#${hour - 2}`;
  const [y, mo, da] = d.split('-').map(Number);
  const prev = new Date(Date.UTC(y, mo - 1, da) - 86400000);
  return `${prev.getUTCFullYear()}-${prev.getUTCMonth() + 1}-${prev.getUTCDate()}#22`;
}

/** True for cycle keys before the schedule epoch (no previous type). */
function isEpochKey(key) {
  const [d] = key.split('#');
  const [y, mo, da] = d.split('-').map(Number);
  return Date.UTC(y, mo - 1, da) < Date.UTC(2026, 0, 1);
}

const typeCache = new Map();

/**
 * Deterministic event type for a cycle key, never equal to the
 * previous cycle's type. Iterative + memoized: walking back to
 * the epoch once, then forward, so per-tick cost is flat.
 */
function typeForCycle(key) {
  if (typeCache.has(key)) return typeCache.get(key);
  const chain = [];
  let k = key;
  while (!typeCache.has(k) && !isEpochKey(k)) {
    chain.push(k);
    k = prevCycleKey(k);
  }
  let prev = typeCache.has(k) ? typeCache.get(k) : null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const kk = chain[i];
    let idx = hashKey(kk) % WEATHER_TYPES.length;
    if (prev && WEATHER_TYPES[idx] === prev) idx = (idx + 1) % WEATHER_TYPES.length;
    prev = WEATHER_TYPES[idx];
    typeCache.set(kk, prev);
  }
  return typeCache.get(key);
}

/**
 * Epoch ms for a CT wall time, or null when that wall time does
 * not exist (spring-forward skips 02:00–02:59). Round-trip
 * conversion: iterate UTC guesses until the CT parts match; a
 * nonexistent time oscillates and fails the final check.
 */
function ctWallToUtc(y, mo, d, h, mi) {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = ctParts(new Date(guess));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = target - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  const check = ctParts(new Date(guess));
  if (check.year !== y || check.month !== mo || check.day !== d || check.hour !== h) return null;
  return guess;
}

/**
 * The sky state for an instant: { isNight, active, last }.
 * active = this cycle's event while inside its 20 minutes, else
 * null. last = the most recent event that has ended (this
 * cycle's, when in its clear gap, else an earlier cycle's) —
 * the anchor for snow melt / puddle evaporation.
 */
function skyState(date = new Date()) {
  const nowMs = date.getTime();
  const isNight = isNightAt(date);
  const p = ctParts(date);
  const startHour = p.hour - (p.hour % 2);
  const key = cycleKeyFor(p.year, p.month, p.day, startHour);
  const startUtc = ctWallToUtc(p.year, p.month, p.day, startHour, 0);
  const wallSinceStart = (p.hour - startHour) * 60 + p.minute;

  let active = null;
  if (startUtc !== null && wallSinceStart < 20) {
    active = { type: typeForCycle(key), startedAt: startUtc, endsAt: startUtc + EVENT_MS, cycleKey: key };
  }

  // Most recent ended event: this cycle's when in its clear gap,
  // else walk back (skipping nonexistent cycles, e.g. the
  // spring-forward 02:00) — decay finishes within 60 minutes,
  // so a handful of steps always suffices.
  let last = null;
  const candidates = [];
  if (startUtc !== null && wallSinceStart >= 20) candidates.push(key);
  let k = key;
  for (let i = 0; i < 4; i++) {
    k = prevCycleKey(k);
    candidates.push(k);
  }
  for (const ck of candidates) {
    const [d, h] = ck.split('#');
    const [y, mo, da] = d.split('-').map(Number);
    const st = ctWallToUtc(y, mo, da, Number(h), 0);
    if (st === null) continue;
    if (st + EVENT_MS <= nowMs) {
      last = { type: typeForCycle(ck), endedAt: st + EVENT_MS };
      break;
    }
  }
  return { isNight, active, last };
}

/**
 * Ground-effect level (0..1) for 'snow' or 'rain' at nowMs:
 * grows 0→1 across the event, then decays linearly over
 * DECAY_MS after it ends. Zero when neither the active nor the
 * last event is of this type.
 */
function groundLevel(sky, wantType, nowMs = Date.now()) {
  if (sky.active && sky.active.type === wantType) {
    return Math.max(0, Math.min(1, (nowMs - sky.active.startedAt) / EVENT_MS));
  }
  if (sky.last && sky.last.type === wantType) {
    return Math.max(0, Math.min(1, 1 - (nowMs - sky.last.endedAt) / DECAY_MS));
  }
  return 0;
}

/** Scorch-mark opacity: full until its final 30s, then fades out. */
function markAlpha(mark, nowMs = Date.now()) {
  return Math.max(0, Math.min(1, (mark.until - nowMs) / MARK_FADE_MS));
}

/** Drop expired marks (pure — returns a new list). */
function pruneMarks(marks, nowMs = Date.now()) {
  return marks.filter(m => m.until > nowMs);
}

// ------------------------------------------------------------ lightning

/**
 * Resolve a strike: every player on the struck map whose tile
 * equals the strike tile reacts. Pure — never mutates players,
 * never touches coins or stats; reactions are cosmetic only.
 * Returns reacted userIds.
 */
function resolveStrikes(playersOnMap, strike) {
  const out = [];
  for (const p of playersOnMap) {
    if (p.mapId !== strike.mapId) continue;
    const tx = Math.floor(p.x / TILE);
    const ty = Math.floor(p.y / TILE);
    if (tx === strike.tx && ty === strike.ty) out.push(p.userId);
  }
  return out;
}

/**
 * Pick a strike point on an outdoor map: half the time near a
 * random player on that map (within one tile, retries for
 * walkable ground), otherwise a random walkable ground point.
 * `rand` is injectable so tests can drive it deterministically.
 * Returns { tx, ty, x, y } (tile + pixel centre) or null.
 */
function pickStrikePoint(map, playersOnMap, rand = Math.random) {
  const centre = (tx, ty) => ({ tx, ty, x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });
  if (playersOnMap.length > 0 && rand() < 0.5) {
    const p = playersOnMap[Math.floor(rand() * playersOnMap.length)];
    const ptx = Math.floor(p.x / TILE);
    const pty = Math.floor(p.y / TILE);
    for (let i = 0; i < 8; i++) {
      const tx = ptx + Math.floor(rand() * 3) - 1;
      const ty = pty + Math.floor(rand() * 3) - 1;
      if (!isSolidTile(map, tx, ty)) return centre(tx, ty);
    }
  }
  for (let i = 0; i < 40; i++) {
    const tx = Math.floor(rand() * map.tiles.w);
    const ty = Math.floor(rand() * map.tiles.h);
    if (!isSolidTile(map, tx, ty)) return centre(tx, ty);
  }
  return null;
}

// ------------------------------------------------------------ live system

/**
 * The live sky system: a 1-second tick that broadcasts sky
 * transitions (day/night flips, event starts/ends) to every
 * connected player, fires lightning during storms, and prunes
 * expired scorch marks. Mirrors the Visitors' shape: its own
 * timer, map-targeted broadcasts, and a syncPlayer hook for
 * arrivals (game.onMapEntered).
 */
class SkySystem {
  constructor(game) {
    this.game = game;
    this.marks = new Map(); // mapId -> [{ x, y, tx, ty, until }]
    this.nextStrikeAt = 0;
    this.lastSent = null;
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Full public state for one map (hello + arrival sync). */
  publicState(mapId, now = new Date()) {
    const s = skyState(now);
    return {
      isNight: s.isNight, active: s.active, last: s.last,
      marks: this.marksFor(mapId, now.getTime()),
    };
  }

  /** Compact summary for /health + live-verify. */
  publicSummary(now = new Date()) {
    const s = skyState(now);
    return { isNight: s.isNight, event: s.active ? s.active.type : null };
  }

  marksFor(mapId, nowMs) {
    return pruneMarks(this.marks.get(mapId) || [], nowMs);
  }

  /** A fresh arrival gets the current sky + its map's live marks. */
  syncPlayer(p) {
    const st = this.publicState(p.mapId);
    this.game.send(p, { type: 'sky', ...st, mapId: p.mapId });
  }

  tick(now = new Date()) {
    const nowMs = now.getTime();
    const s = skyState(now);
    const key = JSON.stringify([
      s.isNight,
      s.active && s.active.cycleKey,
      s.last && s.last.type,
      s.last && s.last.endedAt,
    ]);
    if (key !== this.lastSent) {
      this.lastSent = key;
      const msg = { type: 'sky', isNight: s.isNight, active: s.active, last: s.last };
      for (const p of this.game.players.values()) this.game.send(p, msg);
    }
    if (s.active && s.active.type === 'thunderstorm') {
      if (nowMs >= this.nextStrikeAt) {
        this.nextStrikeAt = nowMs + STRIKE_MIN_MS + Math.random() * (STRIKE_MAX_MS - STRIKE_MIN_MS);
        this.fireStrike(nowMs);
      }
    } else {
      this.nextStrikeAt = 0;
    }
    for (const [mapId, list] of this.marks) {
      const kept = pruneMarks(list, nowMs);
      if (kept.length) this.marks.set(mapId, kept);
      else this.marks.delete(mapId);
    }
  }

  /** One strike on a populated outdoor map; broadcast to that map. */
  fireStrike(nowMs) {
    const populated = [...OUTDOOR_MAPS].filter(id => {
      for (const p of this.game.players.values()) if (p.mapId === id) return true;
      return false;
    });
    if (!populated.length) return;
    const mapId = populated[Math.floor(Math.random() * populated.length)];
    const map = MAPS[mapId];
    if (!map) return;
    const playersOnMap = [...this.game.players.values()].filter(p => p.mapId === mapId);
    const pt = pickStrikePoint(map, playersOnMap);
    if (!pt) return;
    const reacted = resolveStrikes(playersOnMap, { mapId, tx: pt.tx, ty: pt.ty });
    const mark = { x: pt.x, y: pt.y, tx: pt.tx, ty: pt.ty, until: nowMs + MARK_MS };
    const list = this.marks.get(mapId) || [];
    list.push(mark);
    this.marks.set(mapId, list);
    this.game.broadcastToMap(mapId, {
      type: 'lightning', mapId, x: pt.x, y: pt.y, until: mark.until, reacted,
    });
  }
}

module.exports = {
  SkySystem, skyState, isNightAt, ctParts, ctMinutes, typeForCycle,
  groundLevel, markAlpha, pruneMarks, resolveStrikes, pickStrikePoint,
  isOutdoorMapId, OUTDOOR_MAPS, WEATHER_TYPES,
  EVENT_MS, DECAY_MS, MARK_MS, DAY_START_MIN, DAY_END_MIN,
};
