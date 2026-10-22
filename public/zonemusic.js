'use strict';
/**
 * Zone background MUSIC (v1.1, Item 14).
 *
 * What already existed (Phase D): per-zone AMBIENCE — generated
 * noise beds (casino chatter-ish air, waves, warm room tone…) in
 * public/sfx.js, plus a persisted volume + mute. Ambience is
 * texture, not music. This module adds the MUSIC layer on top of
 * the same foundations: every zone gets a generative composition
 * from the mixer's existing loop library (no audio files), played
 * through the shared AudioEngine (AE in mixer.js) on a private bus
 * under AE.master, so the existing volume/mute still govern it.
 *
 * Rules of the room: one composition at a time; crossfade on zone
 * change; DUCKED to silence while a stage performance is live or a
 * home radio is sounding. The 🎵 toggle is persisted separately
 * (solarion_music) and controls music only.
 */

const ZONE_MUSIC = {
  // map id -> composition: a genre + tempo + the loop roles to layer
  'the-gateway':    { bpm: 100, genre: 'Pop',   roles: ['pad', 'melody', 'bass', 'drums'] },  // warm welcome
  'gateway-cafe':   { bpm: 92,  genre: 'Chill', roles: ['pad', 'melody', 'bass'] },           // cozy lounge
  'solstice-bay':   { bpm: 104, genre: 'Latin', roles: ['drums', 'bass', 'melody', 'pad'] },  // light + beachy
  'casino-lounge':  { bpm: 96,  genre: 'Chill', roles: ['pad', 'bass', 'melody'] },           // casino lounge groove
  'neon-district':  { bpm: 118, genre: 'Dance', roles: ['drums', 'bass', 'melody', 'fx'] },    // synthy pulse
  'neon-casino':    { bpm: 112, genre: 'Dance', roles: ['drums', 'bass', 'pad'] },            // casino groove, neon side
  'cinder-mesa':    { bpm: 88,  genre: 'Rock',  roles: ['pad', 'bass', 'melody'] },            // sparse desert
  'hookah-lounge':  { bpm: 90,  genre: 'Latin', roles: ['pad', 'melody', 'fx'] },              // mellow / exotic
  'frosthaven':     { bpm: 84,  genre: 'Chill', roles: ['pad', 'melody'] },                    // calm, sparse, icy
  'verdant-hollow': { bpm: 94,  genre: 'Pop',   roles: ['pad', 'melody', 'bass'] },            // mellow nature
  'studio':         { bpm: 90,  genre: 'Chill', roles: ['pad', 'melody'] },                    // your own four walls
};
const FALLBACK_COMP = ZONE_MUSIC['the-gateway'];
const MUSIC_LEVEL = 0.3;

/** Composition for a map id — every map resolves to something. */
function forMap(mapId, isCasino) {
  if (mapId && ZONE_MUSIC[mapId]) return ZONE_MUSIC[mapId];
  if (isCasino) return ZONE_MUSIC['casino-lounge'];
  if (mapId && mapId.startsWith('studio')) return ZONE_MUSIC.studio;
  return FALLBACK_COMP;
}

/**
 * Pick the concrete loops for a composition from the loop catalog:
 * one loop per role, chosen deterministically per zone (seed) so a
 * zone always sounds like itself. Falls back across genres when a
 * genre lacks a role, and returns [] only for an empty catalog.
 */
function pickTracks(spec, loops, seedKey) {
  if (!spec || !Array.isArray(loops) || !loops.length) return [];
  let seed = 0;
  for (const ch of String(seedKey || '')) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const out = [];
  for (const role of spec.roles) {
    const inGenre = loops.filter(l => l.genre === spec.genre && l.role === role);
    const pool = inGenre.length ? inGenre : loops.filter(l => l.role === role);
    if (pool.length) out.push(pool[seed % pool.length]);
  }
  return out;
}

function loadEnabled() {
  try {
    const v = localStorage.getItem('solarion_music');
    return v === null ? true : v === '1';
  } catch (e) { return true; }
}
function saveEnabled(on) {
  try { localStorage.setItem('solarion_music', on ? '1' : '0'); } catch (e) { /* private mode */ }
}

function win() { return typeof window !== 'undefined' ? window : globalThis; }

const ZoneMusic = {
  enabled: loadEnabled(),
  mapId: null,
  spec: null,
  bus: null,
  timer: null,
  nextAt: 0,
  _tracks: null,
  _swapTimer: null,

  /** Called by client.js on every map load (incl. zone changes). */
  setMap(mapId, isCasino) {
    const spec = forMap(mapId, isCasino);
    const changed = this.mapId !== mapId || this.spec !== spec;
    this.mapId = mapId;
    if (!changed) return;
    this.spec = spec;
    this._tracks = null;
    // v1.2 (Item S): STOP the old composition's scheduled sources
    // outright. The old code only faded the shared bus and reset
    // the scheduler — but the outgoing comp had up to a full pass
    // (~8-17s) of notes already scheduled ON that same bus, so
    // after the fade came back up you heard the tail of the old
    // zone's theme playing OVER the new zone's theme. (Walking
    // into a casino and sitting at a poker table was exactly this:
    // "zone music and the table music overlap.")
    this._stopZoneSources();
    // Crossfade: duck out, swap the composition under the fade.
    this._fadeTo(0, 0.35);
    if (this._swapTimer) clearTimeout(this._swapTimer);
    this._swapTimer = setTimeout(() => { this.nextAt = 0; this._pump(); }, 380);
  },

  _zoneSources: [],

  /** Stop every source this scheduler has live-scheduled. */
  _stopZoneSources() {
    for (const s of this._zoneSources) { try { s.stop(); } catch (e) { /* already ended */ } }
    this._zoneSources = [];
  },

  /** Called from the client's global gesture hook (audio unlock). */
  kick() {
    const eng = this._ae();
    if (!eng || !eng.ensure()) return;
    this._ensureBus(eng);
    if (!this.timer) this.timer = setInterval(() => this._pump(), 350);
    this._pump();
  },

  setEnabled(on) {
    this.enabled = Boolean(on);
    saveEnabled(this.enabled);
    if (!this.enabled) this._fadeTo(0, 0.2);
    else this._pump();
    return this.enabled;
  },

  _ae() {
    const w = win();
    if (w.AE) return w.AE;
    return typeof AE !== 'undefined' ? AE : null;
  },

  _ensureBus(AE) {
    if (this.bus || !AE || !AE.ctx) return;
    this.bus = AE.ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(AE.master);
  },

  /** Foreground audio owns the room. Priority (v1.2, Item S):
   *  live performance > poker table > home radio > zone music.
   *  Slot stools and the bar start no music layer of their own,
   *  so they deliberately do NOT duck the zone track. */
  _foreground() {
    const w = win();
    const perf = w.SolarionMixer && w.SolarionMixer.perf;
    if (perf && perf.active) return true;
    const cas = w.SolarionCasino;
    if (cas && cas.context === 'poker') return true;
    const st = w.SolarionStudio;
    if (st && st.radioKey) return true;
    return false;
  },

  /** The level the bus wants right now (toggle + mute + ducking). */
  targetLevel() {
    if (!this.enabled) return 0;
    const sfx = win().SolarionSfx;
    if (sfx && sfx.muted) return 0;
    if (this._foreground()) return 0;
    return MUSIC_LEVEL;
  },

  _fadeTo(v, secs) {
    const AE = this._ae();
    if (!this.bus || !AE || !AE.ctx) return;
    const g = this.bus.gain, t = AE.ctx.currentTime;
    try {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(v, t, Math.max(0.05, secs / 3));
    } catch (e) { /* context gone */ }
  },

  _duck() { this._fadeTo(this.targetLevel(), 0.8); },

  _pump() {
    const AE = this._ae();
    if (!this.spec || !AE || !AE.ctx || AE.ctx.state !== 'running') return;
    this._ensureBus(AE);
    this._duck();
    const mixer = win().SolarionMixer;
    if (!mixer || !mixer.loops || !mixer.loops.length) return;
    if (!this._tracks) this._tracks = pickTracks(this.spec, mixer.loops, this.mapId);
    if (!this._tracks.length) return;
    const barDur = (60 / this.spec.bpm) * 4;
    const passBars = Math.max(...this._tracks.map(l => l.bars || 1));
    const passDur = passBars * barDur;
    const now = AE.ctx.currentTime;
    if (!this.nextAt || this.nextAt < now - 0.25) this.nextAt = now + 0.06;
    while (this.nextAt < now + passDur) {
      AE.out = this.bus;
      // v1.2 (Item S): remember exactly which sources belong to
      // the zone layer so a composition swap can stop them (and
      // only them — performances/radios keep their own lives).
      const before = AE.scheduled ? AE.scheduled.length : 0;
      try {
        for (const l of this._tracks) AE.playLoop(l, this.nextAt, this.spec.bpm);
      } finally {
        AE.out = null;
      }
      if (AE.scheduled) {
        for (let i = before; i < AE.scheduled.length; i++) this._zoneSources.push(AE.scheduled[i]);
        if (this._zoneSources.length > 600) this._zoneSources.splice(0, this._zoneSources.length - 600);
      }
      this.nextAt += passDur;
    }
  },
};

if (typeof window !== 'undefined') window.SolarionZoneMusic = ZoneMusic;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ZONE_MUSIC, forMap, pickTracks, ZoneMusic, MUSIC_LEVEL };
}
