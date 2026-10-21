'use strict';

/**
 * Solarion — sound effects (Phase 9, item 15).
 *
 * Tiny synthesized SFX on the SAME Web Audio context + master gain
 * as the music engine (AE in mixer.js), so one volume/mute controls
 * everything. Sounds: UI click, door chime, coin, applause (crowd
 * noise swell), pop. No audio assets — all oscillators/noise.
 *
 * Volume + mute persist in localStorage ('solarion_volume',
 * 'solarion_muted') and apply to AE.master.gain (engine default
 * 0.55 × user volume).
 */

const Sfx = {
  volume: 0.9,
  muted: false,

  init() {
    try {
      const v = parseFloat(localStorage.getItem('solarion_volume'));
      if (Number.isFinite(v)) this.volume = Math.min(1, Math.max(0, v));
      this.muted = localStorage.getItem('solarion_muted') === '1';
    } catch (e) { /* private mode */ }
    this.apply();
  },

  apply() {
    /* global AE */
    if (typeof AE !== 'undefined' && AE.master) {
      AE.master.gain.value = this.muted ? 0 : 0.55 * this.volume;
    }
    const btn = document.getElementById('soundBtn');
    if (btn) btn.textContent = this.muted ? '🔇' : '🔊';
  },

  unlock() {
    // A gesture happened: make sure the engine exists so later
    // scheduled playback (performances, radio) is audible.
    if (typeof AE !== 'undefined' && AE.ensure()) AE.ctx.resume();
    this.apply();
    this._applyAmbience();
  },

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    this.muted = false;
    try {
      localStorage.setItem('solarion_volume', String(this.volume));
      localStorage.removeItem('solarion_muted');
    } catch (e) { /* ignore */ }
    this.apply();
  },

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('solarion_muted', this.muted ? '1' : '0'); } catch (e) { /* ignore */ }
    this.apply();
    return this.muted;
  },

  /** Play a named synth sound if the engine is live. */
  play(name) {
    if (this.muted || typeof AE === 'undefined' || !AE.ctx || !AE.master) return;
    const ctx = AE.ctx;
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const out = AE.master;
    const tone = (freq, t0, dur, type = 'sine', gain = 0.2, slideTo = null) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + dur + 0.05);
    };
    const noise = (t0, dur, gain = 0.15, freq = 1200, q = 0.8) => {
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(out);
      src.start(t0); src.stop(t0 + dur + 0.02);
    };
    switch (name) {
      case 'click': tone(660, t, 0.07, 'triangle', 0.12); break;
      case 'pop': tone(320, t, 0.1, 'sine', 0.18, 660); break;
      case 'chime': tone(880, t, 0.35, 'sine', 0.14); tone(1318, t + 0.09, 0.4, 'sine', 0.12); break;
      case 'coin': tone(988, t, 0.09, 'square', 0.08); tone(1319, t + 0.08, 0.22, 'square', 0.08); break;
      case 'boo': tone(196, t, 0.4, 'sawtooth', 0.06, 147); break;
      case 'applause': {
        // Crowd swell: layered filtered noise bursts (hands) + wash.
        for (let i = 0; i < 14; i++) {
          noise(t + Math.random() * 1.1, 0.07 + Math.random() * 0.08, 0.05 + Math.random() * 0.05, 1800 + Math.random() * 1200, 1.4);
        }
        noise(t, 1.3, 0.05, 900, 0.5);
        break;
      }
      default: break;
    }
  },

  // ---------------------------------------------------------- ambience
  // Per-zone ambient beds (items 13/15): one looping filtered-noise
  // node per zone type, run through the shared master so volume and
  // mute apply. Started lazily — only once the engine is unlocked.
  _amb: null,
  _wantAmbience: null,

  ambience(mapId, isCasino) {
    let kind = null;
    if (isCasino) kind = 'casino';
    else if (mapId === 'solstice-bay') kind = 'waves';
    else if (mapId === 'gateway-cafe' || mapId === 'hookah-lounge') kind = 'warm';
    else if (mapId && mapId.startsWith('studio:')) kind = 'room';
    else if (mapId && mapId !== 'the-gateway') kind = 'air';
    this._wantAmbience = kind;
    this._applyAmbience();
  },

  _applyAmbience() {
    const kind = this._wantAmbience;
    if (this._amb && this._amb.kind === kind) return;
    this._stopAmbience();
    if (!kind || this.muted || typeof AE === 'undefined' || !AE.ctx || AE.ctx.state !== 'running') return;
    const ctx = AE.ctx;
    const prof = {
      casino: { freq: 760, q: 0.6, gain: 0.016 },
      waves: { freq: 420, q: 0.4, gain: 0.026 },
      warm: { freq: 450, q: 0.5, gain: 0.014 },
      room: { freq: 420, q: 0.5, gain: 0.008 },
      air: { freq: 700, q: 0.4, gain: 0.010 },
    }[kind];
    if (!prof) return;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // pinkish noise
      const white = Math.random() * 2 - 1;
      last = last * 0.94 + white * 0.06;
      d[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = prof.freq; f.Q.value = prof.q;
    const g = ctx.createGain();
    g.gain.value = prof.gain;
    src.connect(f); f.connect(g); g.connect(AE.master);
    src.start();
    let lfo = null;
    if (kind === 'waves') { // slow swell, like surf
      lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 0.09; lg.gain.value = prof.gain * 0.55;
      lfo.connect(lg); lg.connect(g.gain);
      lfo.start();
    }
    this._amb = { kind, src, g, lfo };
  },

  _stopAmbience() {
    if (!this._amb) return;
    try { this._amb.src.stop(); } catch (e) { /* already stopped */ }
    if (this._amb.lfo) { try { this._amb.lfo.stop(); } catch (e) { /* ignore */ } }
    this._amb = null;
  },
};

window.SolarionSfx = Sfx;
Sfx.init();
