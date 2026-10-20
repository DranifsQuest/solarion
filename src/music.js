'use strict';

/**
 * Solarion — music system (Phase 2).
 *
 * The loop library: original, procedurally-synthesized loops. There are
 * NO audio samples anywhere — every loop is a *pattern* (drum step
 * strings, note events, chord lists, fx events) that the client renders
 * live with Web Audio oscillators/noise. This module owns the manifest
 * of valid loopIds; the server validates every saved mix against it.
 *
 * All loops live in A minor and share the Am–F–C–G family of chords, so
 * any combination a newcomer throws together stays listenable (the
 * mixer is a toy, not a DAW — soul doc §3).
 *
 * Pattern formats:
 *   drums: { kick, snare, hat, perc } — strings, 'x' = hit, 16 steps/bar
 *   bass/melody: notes: [[step, semitoneOffsetFromRoot, lenSteps], ...]
 *   pad: chords: [[semitone, ...], ...] — one chord per bar
 *   fx: fx: [{ step, kind, note? }] — kinds: crash/riser/sweep/blip/
 *       scratch/shaker/rain
 *
 * Mix format (JSON, persisted):
 *   { name, bpm, bars, tracks: [{ loopId, startBar }] }
 *   Each track's loop tiles (repeats) from startBar to the end of the
 *   mix. ≤5 tracks, ≤16 bars, bpm 70–160 → longest possible mix is
 *   16 bars at 70bpm ≈ 54.9s (under the 60s performance cap).
 *
 * Tables (additive, created here — db.js schema is untouched):
 *   mixes          (user_id, slot 1–5, name, data JSON, updated_at)
 *   perf_earnings  (user_id, day, earned) — daily performance-pay ledger
 */

const { db } = require('./db');

const BPM_MIN = 70;
const BPM_MAX = 160;
const MAX_TRACKS = 5;
const MAX_BARS = 16;
const MAX_SLOTS = 5;
const MAX_MIX_BYTES = 8192;
const MAX_NAME_LEN = 40;

// ---------------------------------------------------------------- loops

function arp(steps, semis, len = 1) {
  return steps.map((s, i) => [s, semis[i % semis.length], len]);
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const LOOPS = [
  // ---------------------------------------------------------- POP
  { id: 'pop-drums-1', name: 'Sunny Beat', genre: 'Pop', role: 'drums', bars: 2,
    drums: { kick: 'x...x...x...x...x...x...x...x...', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' } },
  { id: 'pop-drums-2', name: 'Clap Pop', genre: 'Pop', role: 'drums', bars: 2,
    drums: { kick: 'x.....x.x...x...x.....x.x...x...', snare: '....x.......x.......x.......x...', hat: '..x...x...x...x...x...x...x...x.', perc: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' } },
  { id: 'pop-bass-1', name: 'Bouncy Bass', genre: 'Pop', role: 'bass', bars: 2, wave: 'triangle', root: 55,
    notes: [[0, 0, 2], [4, 7, 1], [6, 0, 2], [8, 0, 2], [12, 7, 2], [16, -4, 2], [20, 3, 1], [22, -4, 2], [24, -4, 2], [28, 0, 2]] },
  { id: 'pop-bass-2', name: 'Round Pop Bass', genre: 'Pop', role: 'bass', bars: 2, wave: 'sine', root: 55,
    notes: [[0, 0, 4], [8, 0, 4], [16, -4, 4], [24, 3, 4], [30, 7, 2]] },
  { id: 'pop-mel-1', name: 'Sunshine Lead', genre: 'Pop', role: 'melody', bars: 2, wave: 'triangle', root: 220,
    notes: [[0, 12, 2], [2, 15, 2], [4, 19, 2], [6, 15, 2], [8, 12, 2], [10, 10, 2], [12, 12, 4], [16, 8, 2], [18, 10, 2], [20, 12, 2], [22, 15, 2], [24, 19, 2], [28, 15, 4]] },
  { id: 'pop-mel-2', name: 'Whistle Tune', genre: 'Pop', role: 'melody', bars: 2, wave: 'sine', root: 220,
    notes: [[0, 19, 3], [4, 17, 1], [6, 15, 2], [8, 12, 2], [12, 10, 2], [14, 12, 2], [16, 8, 3], [20, 10, 1], [22, 12, 2], [24, 15, 2], [28, 12, 4]] },
  { id: 'pop-pad-1', name: 'Warm Chords', genre: 'Pop', role: 'pad', bars: 4, wave: 'triangle', root: 110,
    chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]] },
  { id: 'pop-fx-1', name: 'Sparkle', genre: 'Pop', role: 'fx', bars: 2,
    fx: [{ step: 0, kind: 'crash' }, { step: 24, kind: 'blip', note: 24 }, { step: 28, kind: 'blip', note: 19 }] },

  // ---------------------------------------------------------- DANCE
  { id: 'dance-drums-1', name: 'Four Floor', genre: 'Dance', role: 'drums', bars: 2,
    drums: { kick: 'x...x...x...x...x...x...x...x...', snare: '....x.......x.......x.......x...', hat: '..x...x...x...x...x...x...x...x.', perc: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' } },
  { id: 'dance-drums-2', name: 'Electro Drive', genre: 'Dance', role: 'drums', bars: 2,
    drums: { kick: 'x...x...x...x...x...x...x...x...', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' } },
  { id: 'dance-bass-1', name: 'Offbeat Bass', genre: 'Dance', role: 'bass', bars: 2, wave: 'sawtooth', root: 55,
    notes: [[2, 0, 1], [6, 12, 1], [10, 0, 1], [14, 12, 1], [18, -4, 1], [22, 8, 1], [26, -4, 1], [30, 8, 1]] },
  { id: 'dance-bass-2', name: 'Rolling Bass', genre: 'Dance', role: 'bass', bars: 2, wave: 'sawtooth', root: 55,
    notes: [[0, 0, 1], [2, 0, 1], [4, 0, 1], [6, 3, 1], [8, 0, 1], [10, 0, 1], [12, 7, 1], [14, 3, 1], [16, -4, 1], [18, -4, 1], [20, -4, 1], [22, 0, 1], [24, -4, 1], [26, -4, 1], [28, 3, 1], [30, 0, 1]] },
  { id: 'dance-mel-1', name: 'Rave Stabs', genre: 'Dance', role: 'melody', bars: 2, wave: 'sawtooth', root: 220,
    notes: [[0, 12, 1], [4, 12, 1], [8, 15, 1], [12, 12, 1], [16, 8, 1], [20, 8, 1], [24, 12, 1], [28, 10, 1]] },
  { id: 'dance-mel-2', name: 'Pluck Arp', genre: 'Dance', role: 'melody', bars: 2, wave: 'square', root: 220,
    notes: [...arp(range(0, 15), [12, 15, 19, 24]), ...arp(range(16, 31), [8, 12, 15, 20])] },
  { id: 'dance-pad-1', name: 'Trance Pad', genre: 'Dance', role: 'pad', bars: 4, wave: 'sawtooth', root: 110,
    chords: [[0, 7, 12], [-4, 3, 8], [3, 10, 15], [-2, 5, 10]] },
  { id: 'dance-fx-1', name: 'Riser Sweep', genre: 'Dance', role: 'fx', bars: 2,
    fx: [{ step: 0, kind: 'riser' }, { step: 16, kind: 'crash' }] },

  // ---------------------------------------------------------- HIP-HOP
  { id: 'hh-drums-1', name: 'Boom Bap', genre: 'Hip-Hop', role: 'drums', bars: 2,
    drums: { kick: 'x.....x...x.....x.....x...x.....', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.xx.x.x.x.x.x.x.x.x' } },
  { id: 'hh-drums-2', name: 'Trap Hats', genre: 'Hip-Hop', role: 'drums', bars: 2,
    drums: { kick: 'x......x....x...x......x....x...', snare: '........x...............x.......', hat: 'x.xxx.x.x.x.xxx.x.xxx.x.x.x.xxx.' } },
  { id: 'hh-bass-1', name: 'Sub Deep', genre: 'Hip-Hop', role: 'bass', bars: 2, wave: 'sine', root: 55,
    notes: [[0, 0, 6], [10, 0, 2], [16, -2, 6], [26, 3, 2]] },
  { id: 'hh-bass-2', name: 'Boom Bass', genre: 'Hip-Hop', role: 'bass', bars: 2, wave: 'triangle', root: 55,
    notes: [[0, 0, 3], [6, 0, 1], [8, 3, 2], [14, 0, 2], [16, -4, 3], [22, -4, 1], [24, 0, 2], [30, -2, 2]] },
  { id: 'hh-mel-1', name: 'Keys Loop', genre: 'Hip-Hop', role: 'melody', bars: 2, wave: 'sine', root: 220,
    notes: [[0, 12, 3], [4, 15, 2], [7, 19, 2], [11, 15, 2], [16, 8, 3], [20, 12, 2], [23, 15, 2], [27, 12, 2]] },
  { id: 'hh-mel-2', name: 'Vinyl Melody', genre: 'Hip-Hop', role: 'melody', bars: 2, wave: 'triangle', root: 220,
    notes: [[0, 17, 2], [4, 15, 2], [8, 12, 4], [16, 15, 2], [20, 12, 2], [24, 10, 4]] },
  { id: 'hh-pad-1', name: 'Dusty Chords', genre: 'Hip-Hop', role: 'pad', bars: 4, wave: 'triangle', root: 110,
    chords: [[0, 3, 7], [-2, 2, 5], [3, 7, 10], [-4, 0, 3]] },
  { id: 'hh-fx-1', name: 'Scratch Cuts', genre: 'Hip-Hop', role: 'fx', bars: 2,
    fx: [{ step: 0, kind: 'scratch' }, { step: 8, kind: 'scratch' }, { step: 16, kind: 'blip', note: 7 }, { step: 24, kind: 'scratch' }] },

  // ---------------------------------------------------------- ROCK
  { id: 'rock-drums-1', name: 'Backbeat', genre: 'Rock', role: 'drums', bars: 2,
    drums: { kick: 'x.......x...x...x.......x...x...', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' } },
  { id: 'rock-drums-2', name: 'Driving Rock', genre: 'Rock', role: 'drums', bars: 2,
    drums: { kick: 'x...x...x...x...x...x...x...x.x.', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' } },
  { id: 'rock-bass-1', name: 'Eighth Rock', genre: 'Rock', role: 'bass', bars: 2, wave: 'sawtooth', root: 55,
    notes: [[0, 0, 1], [2, 0, 1], [4, 0, 1], [6, 0, 1], [8, 0, 1], [10, 0, 1], [12, 3, 1], [14, 3, 1], [16, -4, 1], [18, -4, 1], [20, -4, 1], [22, -4, 1], [24, -4, 1], [26, -4, 1], [28, 0, 1], [30, 3, 1]] },
  { id: 'rock-bass-2', name: 'Punch Bass', genre: 'Rock', role: 'bass', bars: 2, wave: 'triangle', root: 55,
    notes: [[0, 0, 2], [4, 0, 2], [8, 7, 2], [12, 0, 2], [16, 3, 2], [20, 3, 2], [24, 10, 2], [28, 7, 2]] },
  { id: 'rock-mel-1', name: 'Lead Riff', genre: 'Rock', role: 'melody', bars: 2, wave: 'sawtooth', root: 220,
    notes: [[0, 12, 2], [2, 12, 1], [4, 15, 2], [6, 12, 1], [8, 10, 2], [10, 12, 2], [12, 15, 2], [16, 12, 2], [18, 12, 1], [20, 19, 2], [22, 17, 1], [24, 15, 2], [26, 12, 2], [28, 10, 4]] },
  { id: 'rock-mel-2', name: 'Chime Guitar', genre: 'Rock', role: 'melody', bars: 2, wave: 'triangle', root: 220,
    notes: [...arp([0, 2, 4, 6, 8, 10, 12, 14], [12, 19, 15, 19]), ...arp([16, 18, 20, 22, 24, 26, 28, 30], [8, 15, 12, 15])] },
  { id: 'rock-pad-1', name: 'Power Chords', genre: 'Rock', role: 'pad', bars: 4, wave: 'sawtooth', root: 110,
    chords: [[0, 7], [-4, 3], [3, 10], [-2, 5]] },
  { id: 'rock-fx-1', name: 'Crash & Pick', genre: 'Rock', role: 'fx', bars: 2,
    fx: [{ step: 0, kind: 'crash' }, { step: 16, kind: 'crash' }, { step: 24, kind: 'blip', note: 12 }] },

  // ---------------------------------------------------------- LATIN
  { id: 'latin-drums-1', name: 'Conga Groove', genre: 'Latin', role: 'drums', bars: 2,
    drums: { kick: 'x.....x...x.....x.....x...x.....', snare: '....x.......x.......x.......x...', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', perc: '..x.x...x.x.....x.x...x.x.......' } },
  { id: 'latin-drums-2', name: 'Bossa Beat', genre: 'Latin', role: 'drums', bars: 2,
    drums: { kick: 'x.....x..x......x.....x..x......', snare: '..x...x...x...x...x...x...x...x.', hat: 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.' } },
  { id: 'latin-bass-1', name: 'Tumbao', genre: 'Latin', role: 'bass', bars: 2, wave: 'triangle', root: 55,
    notes: [[0, 0, 2], [6, 0, 1], [8, 7, 2], [14, 3, 1], [16, -4, 2], [22, -4, 1], [24, 3, 2], [30, 0, 1]] },
  { id: 'latin-bass-2', name: 'Montuno Bass', genre: 'Latin', role: 'bass', bars: 2, wave: 'triangle', root: 55,
    notes: [[0, 0, 1], [3, 0, 1], [6, 7, 1], [8, 0, 1], [11, 3, 1], [14, 7, 1], [16, -4, 1], [19, -4, 1], [22, 3, 1], [24, -4, 1], [27, 0, 1], [30, 3, 1]] },
  { id: 'latin-mel-1', name: 'Montuno Piano', genre: 'Latin', role: 'melody', bars: 2, wave: 'triangle', root: 220,
    notes: [[0, 12, 1], [3, 15, 1], [6, 19, 1], [8, 12, 1], [11, 15, 1], [14, 19, 1], [16, 8, 1], [19, 12, 1], [22, 15, 1], [24, 8, 1], [27, 12, 1], [30, 15, 1]] },
  { id: 'latin-mel-2', name: 'Flute Line', genre: 'Latin', role: 'melody', bars: 2, wave: 'sine', root: 220,
    notes: [[0, 19, 3], [4, 22, 1], [6, 19, 2], [8, 15, 2], [12, 17, 2], [14, 19, 2], [16, 15, 3], [20, 17, 1], [22, 15, 2], [24, 12, 2], [28, 15, 4]] },
  { id: 'latin-pad-1', name: 'Warm Montuno Pad', genre: 'Latin', role: 'pad', bars: 4, wave: 'triangle', root: 110,
    chords: [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]] },
  { id: 'latin-fx-1', name: 'Bell Accents', genre: 'Latin', role: 'fx', bars: 2,
    fx: [{ step: 0, kind: 'blip', note: 24 }, { step: 8, kind: 'shaker' }, { step: 16, kind: 'blip', note: 19 }, { step: 24, kind: 'shaker' }] },

  // ---------------------------------------------------------- CHILL
  { id: 'chill-drums-1', name: 'Lo-Fi Dust', genre: 'Chill', role: 'drums', bars: 2,
    drums: { kick: 'x......x..x.....x......x..x.....', snare: '....x.......x.......x.......x...', hat: '..x...x...x...x...x...x...x...x.' } },
  { id: 'chill-drums-2', name: 'Slow Waves', genre: 'Chill', role: 'drums', bars: 2,
    drums: { kick: 'x...........x...x...........x...', snare: '........x...............x.......', hat: 'x...x...x...x...x...x...x...x...' } },
  { id: 'chill-bass-1', name: 'Deep Pillow', genre: 'Chill', role: 'bass', bars: 2, wave: 'sine', root: 55,
    notes: [[0, 0, 8], [16, -4, 8]] },
  { id: 'chill-bass-2', name: 'Walking Soft', genre: 'Chill', role: 'bass', bars: 2, wave: 'triangle', root: 55,
    notes: [[0, 0, 3], [8, 3, 2], [12, 7, 2], [16, -2, 3], [24, 2, 2], [28, 5, 2]] },
  { id: 'chill-mel-1', name: 'Rainy Keys', genre: 'Chill', role: 'melody', bars: 2, wave: 'sine', root: 220,
    notes: [[0, 12, 4], [8, 15, 3], [14, 19, 2], [16, 17, 4], [24, 15, 3], [30, 12, 2]] },
  { id: 'chill-mel-2', name: 'Music Box', genre: 'Chill', role: 'melody', bars: 2, wave: 'sine', root: 220,
    notes: [[0, 24, 1], [4, 27, 1], [8, 24, 1], [12, 19, 1], [16, 22, 1], [20, 24, 1], [24, 27, 1], [28, 31, 2]] },
  { id: 'chill-pad-1', name: 'Cloud Pad', genre: 'Chill', role: 'pad', bars: 4, wave: 'triangle', root: 110,
    chords: [[0, 3, 7, 10], [-4, 0, 3, 7], [3, 7, 10, 14], [-2, 2, 5, 10]] },
  { id: 'chill-fx-1', name: 'Vinyl Rain', genre: 'Chill', role: 'fx', bars: 2,
    fx: [{ step: 0, kind: 'rain' }] },
];

const LOOP_BY_ID = new Map(LOOPS.map(l => [l.id, l]));
const GENRES = [...new Set(LOOPS.map(l => l.genre))];

// ---------------------------------------------------------------- tables

let mq = null; // prepared lazily in init(), after the tables exist

function init() {
  if (mq) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS mixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, slot)
  );
  CREATE TABLE IF NOT EXISTS perf_earnings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    earned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day)
  );
  `);
  mq = {
    list: db.prepare('SELECT id, slot, name, data, updated_at FROM mixes WHERE user_id = ? ORDER BY slot'),
    byId: db.prepare('SELECT id, slot, name, data, updated_at FROM mixes WHERE user_id = ? AND id = ?'),
    upsert: db.prepare(`INSERT INTO mixes (user_id, slot, name, data, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, slot) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`),
    bySlot: db.prepare('SELECT id, slot, name, data, updated_at FROM mixes WHERE user_id = ? AND slot = ?'),
    del: db.prepare('DELETE FROM mixes WHERE user_id = ? AND slot = ?'),
    perfGet: db.prepare('SELECT earned FROM perf_earnings WHERE user_id = ? AND day = ?'),
    perfSet: db.prepare(`INSERT INTO perf_earnings (user_id, day, earned) VALUES (?, ?, ?)
      ON CONFLICT(user_id, day) DO UPDATE SET earned = excluded.earned`),
    addZ: db.prepare('UPDATE avatars SET zcoins = zcoins + ? WHERE user_id = ?'),
    zOf: db.prepare('SELECT zcoins FROM avatars WHERE user_id = ?'),
  };
}

// ---------------------------------------------------------------- mixes

function rowToMix(row) {
  if (!row) return null;
  let data = null;
  try { data = JSON.parse(row.data); } catch (e) { data = null; }
  return { id: row.id, slot: row.slot, name: row.name, data, updatedAt: row.updated_at };
}

function listMixes(userId) {
  return mq.list.all(userId).map(rowToMix).filter(m => m.data);
}

function getMix(userId, mixId) {
  return rowToMix(mq.byId.get(userId, mixId));
}

/** Mix length in ms: bars * 4 beats at bpm. Always ≤ ~54.9s by validation. */
function mixDurationMs(data) {
  return Math.round(data.bars * 4 * (60000 / data.bpm));
}

/**
 * Validate + normalize a client-supplied mix. Returns { ok, data } or
 * { ok: false, error }. The server never trusts the client: unknown
 * loopIds, >5 tracks, out-of-range bpm/bars and oversized payloads are
 * all rejected here.
 */
function validateMix(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Mix data must be an object.' };
  }
  let serialized;
  try { serialized = JSON.stringify(raw); } catch (e) { return { ok: false, error: 'Mix data is not serializable.' }; }
  if (serialized.length > MAX_MIX_BYTES) {
    return { ok: false, error: `Mix is too large (max ${MAX_MIX_BYTES} bytes).` };
  }
  const name = String(raw.name == null ? '' : raw.name).trim().slice(0, MAX_NAME_LEN);
  if (!name) return { ok: false, error: 'Give your mix a name.' };
  const bpm = raw.bpm;
  if (!Number.isInteger(bpm) || bpm < BPM_MIN || bpm > BPM_MAX) {
    return { ok: false, error: `Tempo must be a whole number between ${BPM_MIN} and ${BPM_MAX} bpm.` };
  }
  const bars = raw.bars;
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_BARS) {
    return { ok: false, error: `Mix length must be 1–${MAX_BARS} bars.` };
  }
  if (!Array.isArray(raw.tracks) || raw.tracks.length < 1 || raw.tracks.length > MAX_TRACKS) {
    return { ok: false, error: `A mix needs 1–${MAX_TRACKS} tracks.` };
  }
  const tracks = [];
  for (const t of raw.tracks) {
    if (!t || typeof t !== 'object') return { ok: false, error: 'Bad track entry.' };
    if (!LOOP_BY_ID.has(t.loopId)) return { ok: false, error: `Unknown loop: ${String(t.loopId).slice(0, 40)}` };
    if (!Number.isInteger(t.startBar) || t.startBar < 0 || t.startBar >= bars) {
      return { ok: false, error: 'Track start bar is out of range.' };
    }
    tracks.push({ loopId: t.loopId, startBar: t.startBar });
  }
  return { ok: true, data: { name, bpm, bars, tracks } };
}

function saveMix(userId, slot, rawData) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) {
    return { ok: false, error: `Slot must be 1–${MAX_SLOTS}.` };
  }
  const v = validateMix(rawData);
  if (!v.ok) return v;
  mq.upsert.run(userId, slot, v.data.name, JSON.stringify(v.data), Date.now());
  return { ok: true, mix: rowToMix(mq.bySlot.get(userId, slot)) };
}

function deleteMix(userId, slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) {
    return { ok: false, error: `Slot must be 1–${MAX_SLOTS}.` };
  }
  mq.del.run(userId, slot);
  return { ok: true };
}

// ------------------------------------------------------- performance pay

const PERF_PAY_PER_UP = 5;    // z per thumbs-up (soul doc §1/§2)
const PERF_DAILY_CAP = 350;   // z per day from performing (soul doc §1)

function perfEarnedOn(userId, day) {
  const r = mq.perfGet.get(userId, day);
  return r ? r.earned : 0;
}

function setPerfEarned(userId, day, amount) {
  mq.perfSet.run(userId, day, Math.max(0, Math.floor(amount) || 0));
}

/** Credit z coins; returns the new balance. */
function addZCoins(userId, amount) {
  mq.addZ.run(amount, userId);
  const r = mq.zOf.get(userId);
  return r ? r.zcoins : 0;
}

module.exports = {
  init, LOOPS, LOOP_BY_ID, GENRES,
  BPM_MIN, BPM_MAX, MAX_TRACKS, MAX_BARS, MAX_SLOTS, MAX_MIX_BYTES,
  validateMix, listMixes, getMix, saveMix, deleteMix, mixDurationMs,
  PERF_PAY_PER_UP, PERF_DAILY_CAP, perfEarnedOn, setPerfEarned, addZCoins,
};
