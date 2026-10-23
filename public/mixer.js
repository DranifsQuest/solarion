'use strict';

/**
 * Solarion — music client (Phase 2): loop mixer + stage UI + Web Audio
 * synthesis engine.
 *
 * There are NO audio files. Every loop in the server manifest is a
 * pattern (drum step strings / note events / chords / fx events) and
 * this engine renders it live with oscillators + filtered noise.
 *
 * The mixer is a TOY, not a DAW (soul doc §3): 5 song slots → EDIT opens
 * a bar grid of 5 lines → click a cell to drop a one-cell bubble of the
 * selected loop there (a line fills up one bubble at a time, one sound
 * per bar per line; click a bubble to take just it back) → PLAY
 * auditions → SAVE persists server-side. All loops live in A minor over
 * the Am–F–C–G family, so random combinations stay listenable.
 *
 * Stage: queue panel (join with a saved mix, see who's up), a Now
 * Playing bar with 👍/👎 vote buttons, and synchronized playback —
 * performance-start carries a server timestamp (startAt ≈ +1.2s) and
 * every client schedules the same mix data locally from it.
 */

// ------------------------------------------------------------ audio engine

const AE = {
  ctx: null,
  // v1.1: alternate output tap — the zone-music scheduler points
  // this at its own bus for the duration of a scheduling call so
  // background music gets its own fader under the master. Null =
  // straight to master (performances, radios, auditions unaffected).
  out: null,
  master: null,
  noiseBuf: null,
  scheduled: [],     // sources to stop on AE.stop()
  stopTimers: [],

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      // v1.3 (mixer static fix, measured — test/render-audio.js):
      // the v1.2 limiter (threshold -8dB, 4ms attack) could NOT
      // catch the mixer path's worst case. Five drum lines hitting
      // step 0 together sum COHERENTLY (identical kick phase,
      // identical noise-buffer offset) to +8..+14 dBFS raw; the
      // old chain still let the destination reach 1.11-1.82 —
      // hundreds of samples hard-clipped at the DAC per pass,
      // heard as static bursts, worst at high BPM where the hits
      // land thickest. The chain is now a real staging bus:
      //   master (0.55, the volume) -> TRIM 0.8 (-1.9dB of staging
      //   headroom) -> HIGHPASS 32Hz (dumps subsonic kick-tail
      //   mush that eats headroom; the kick's floor is ~42Hz, so
      //   nothing audible is touched) -> LIMITER as a fast CEILING
      //   (-4dB threshold, 20:1, 0.8ms attack). Measured on the
      //   worst saveable drum stack: destination peak 1.11-1.82
      //   with 105-342 DAC-clipped samples BEFORE, 0.906 with
      //   ZERO clipped samples after (test/audio-glitch.test.js
      //   pins it). A normal mix peaks around -10dB at the
      //   limiter input, so the ceiling never engages on ordinary
      //   playback (measured: 0.0dB of gain reduction, band
      //   balance unchanged).
      this.mixTrim = this.ctx.createGain();
      this.mixTrim.gain.value = 0.8;
      this.mixHp = this.ctx.createBiquadFilter();
      this.mixHp.type = 'highpass';
      this.mixHp.frequency.value = 32;
      this.mixHp.Q.value = 0.7;
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -4;
      this.limiter.knee.value = 1;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.0008;
      this.limiter.release.value = 0.16;
      this.master.connect(this.mixTrim);
      this.mixTrim.connect(this.mixHp);
      this.mixHp.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // v1.2 (Item D): blend the buffer's tail into its head so
      // LOOPED playback wraps seamlessly — an unblended wrap is a
      // sample step, heard as a click every buffer length (and
      // through the filters, as a periodic static tick).
      this._wrapBlend(d, Math.floor(len * 0.06));
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  },

  /**
   * Crossfade a sample array's tail into its head (in place) so
   * looping it has no seam step. Shared with the sfx ambience beds
   * (public/sfx.js), whose smooth pink/brown noise made the seam
   * the worst offender: a hard tick every 2 seconds.
   */
  _wrapBlend(d, fade) {
    const len = d.length;
    const n = Math.min(fade, Math.floor(len / 2));
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const w = i / n; // 0 at the head -> 1 at (head + fade)
      d[i] = d[i] * w + d[len - n + i] * (1 - w);
    }
  },

  track(node) { this.scheduled.push(node); return node; },

  stop() {
    for (const t of this.stopTimers) clearTimeout(t);
    this.stopTimers = [];
    for (const n of this.scheduled) { try { n.stop(); } catch (e) { /* done */ } }
    this.scheduled = [];
    this._voices = {};
  },

  // v1.3: DRUM CHOKE (drum-machine style). Until now a retriggered
  // drum voice's tail rang UNDER the next hit — kick tails (240ms)
  // and open hats piling up step after step, fattening the sum
  // between the coincident hits that slam the ceiling. Now, when
  // a voice of an instrument starts, the previous still-ringing
  // voice of the SAME instrument is faded to silence in ~4ms
  // (setTarget tau 1.2ms) and stopped 30ms later — a fade, never a
  // hard cut, so the choke itself cannot click. The registry is a
  // pure function of the schedule (same hits, same chokes), so the
  // audibility contract is untouched: every client hearing the
  // same mix makes the identical chokes.
  _voices: {}, // instrument -> [{ src, g, born, until }]

  _choke(key, t) {
    const list = this._voices[key];
    if (!list || !list.length) return;
    for (const v of list) {
      // Only voices born STRICTLY before this hit are "the
      // previous instance": a voice born at the same instant is
      // part of the same hit (a snare's noise + body, or another
      // line's coincident hit) and must not eat itself.
      if (v.born < t && v.until > t) {
        try {
          v.g.gain.cancelScheduledValues(t);
          v.g.gain.setTargetAtTime(0.0001, t, 0.0012);
          v.src.stop(t + 0.03);
        } catch (e) { /* already stopped */ }
      }
    }
    this._voices[key] = list.filter(v => v.until > t);
  },

  _registerVoice(key, src, g, born, until) {
    if (!key) return;
    (this._voices[key] || (this._voices[key] = [])).push({ src, g, born, until });
  },

  noise(t, dur, { type = 'highpass', freq = 7000, q = 0.8, gain = 0.2, sweepTo = null, choke = null } = {}) {
    if (choke) this._choke(choke, t);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = this.ctx.createGain();
    // v1.2 (Item D): a 3ms attack ramp instead of an instant
    // full-gain onset — the old setValueAtTime(gain) step was a
    // click transient on EVERY hat/snare/perc hit, stacking into
    // the fizzy "static" over dense loops.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.out || this.master);
    src.start(t); src.stop(t + dur + 0.05);
    this._registerVoice(choke, src, g, t, t + dur + 0.05);
    return this.track(src);
  },

  tone(t, freq, dur, { wave = 'sine', gain = 0.18, attack = 0.005, slideTo = null, choke = null } = {}) {
    if (choke) this._choke(choke, t);
    const o = this.ctx.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + Math.max(dur, attack + 0.02));
    o.connect(g); g.connect(this.out || this.master);
    o.start(t); o.stop(t + dur + 0.05);
    this._registerVoice(choke, o, g, t, t + dur + 0.05);
    return this.track(o);
  },

  kick(t) {
    this._choke('kick', t);
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g); g.connect(this.out || this.master);
    o.start(t); o.stop(t + 0.26);
    this._registerVoice('kick', o, g, t, t + 0.26);
    this.track(o);
  },

  snare(t) {
    this.noise(t, 0.12, { type: 'bandpass', freq: 1800, q: 0.7, gain: 0.28, choke: 'snare' });
    this.tone(t, 190, 0.08, { wave: 'triangle', gain: 0.15, choke: 'snare' });
  },

  hat(t, open) {
    this.noise(t, open ? 0.22 : 0.05, { type: 'highpass', freq: 7500, gain: 0.12, choke: 'hat' });
  },

  perc(t) {
    this.noise(t, 0.07, { type: 'bandpass', freq: 5200, q: 2.5, gain: 0.13, choke: 'perc' });
  },

  freq(root, semi) { return root * Math.pow(2, semi / 12); },

  // v1.3: measured per-loop drum trims — solo peak per kit
  // (test/render-audio.js, 140bpm, raw at the master input)
  // normalized to 0.56, attenuate-only. Guarded against staleness
  // by test/audio-glitch.test.js (re-renders every solo).
  DRUM_TRIM: {
    'pop-drums-1': 0.90, 'pop-drums-2': 0.91, 'pop-drums-3': 0.90,
    'dance-drums-1': 0.91, 'dance-drums-2': 0.90, 'dance-drums-3': 0.91,
    'hh-drums-1': 1.00, 'hh-drums-2': 1.00, 'hh-drums-3': 0.90,
    'rock-drums-1': 0.90, 'rock-drums-2': 0.90, 'rock-drums-3': 1.00,
    'latin-drums-1': 1.00, 'latin-drums-2': 0.91, 'latin-drums-3': 0.90,
    'chill-drums-1': 1.00, 'chill-drums-2': 1.00, 'chill-drums-3': 0.94,
  },

  /**
   * Schedule ONE pass of a loop starting at ctx-time t. stepDur in
   * seconds. `clipEnd` (mixer rework): the ctx-time at which this
   * pass must fall silent because the NEXT bubble on the same line
   * takes the line over (restart semantics — see playMix). Events
   * that would START at/after clipEnd are never scheduled, and
   * sustained events (notes, pad chords, long fx washes) are
   * shortened to end at clipEnd. Short drum/perc transients are only
   * start-gated: a hit already ringing when the boundary lands is a
   * fraction of a step and reads as part of the takeover. Default
   * Infinity = the historical unclipped pass (radio loops, zone
   * music, loop auditions all schedule without a boundary).
   */
  playLoop(loop, t, bpm, clipEnd = Infinity) {
    const stepDur = (60 / bpm) / 4;
    const totalSteps = loop.bars * 16;
    // Effective duration for a sustained event starting at tt: 0
    // means "at/past the boundary — do not schedule it at all".
    const seg = (tt, dur) => (tt >= clipEnd ? 0 : Math.min(dur, clipEnd - tt));
    if (loop.drums) {
      // v1.3: per-loop drum normalization. Solo renders of the 18
      // drum loops (test/render-audio.js) peak between 0.54 and
      // 0.63 raw — the loudest kits ran ~15% hotter than the
      // quietest for no musical reason, and in a stack every bit
      // of that spread lands on the ceiling. DRUM_TRIM pulls each
      // kit to the common 0.56 target (attenuate only, never
      // boost); test/audio-glitch.test.js re-renders the solos and
      // fails if this table goes stale.
      const trim = AE.DRUM_TRIM[loop.id];
      const prevOut = this.out;
      if (trim && trim < 1) {
        const tg = this.ctx.createGain();
        tg.gain.value = trim;
        tg.connect(prevOut || this.master);
        this.out = tg;
      }
      for (const [inst, pat] of Object.entries(loop.drums)) {
        for (let s = 0; s < pat.length; s++) {
          if (pat[s] !== 'x') continue;
          const tt = t + s * stepDur;
          if (tt >= clipEnd) continue;
          if (inst === 'kick') this.kick(tt);
          else if (inst === 'snare') this.snare(tt);
          else if (inst === 'hat') this.hat(tt, s % 16 === 14);
          else this.perc(tt);
        }
      }
      this.out = prevOut;
    }
    if (loop.notes) {
      const isBass = loop.role === 'bass';
      for (const [step, semi, len] of loop.notes) {
        const tt = t + step * stepDur;
        const d = seg(tt, len * stepDur * 0.92);
        if (d <= 0.005) continue;
        this.tone(tt, this.freq(loop.root, semi), d, {
          wave: loop.wave || 'triangle', gain: isBass ? 0.26 : 0.15,
        });
      }
    }
    if (loop.chords) {
      const barDur = stepDur * 16;
      loop.chords.forEach((chord, bar) => {
        const bt = t + bar * barDur;
        const segDur = seg(bt, barDur);
        if (segDur <= 0.005) return;
        for (const semi of chord) {
          const o = this.ctx.createOscillator();
          o.type = loop.wave || 'triangle';
          o.frequency.value = this.freq(loop.root, semi);
          o.detune.value = (Math.random() * 8 - 4);
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, bt);
          g.gain.linearRampToValueAtTime(0.045, bt + Math.min(0.35, barDur * 0.3, segDur * 0.6));
          g.gain.setValueAtTime(0.045, bt + segDur * 0.7);
          g.gain.linearRampToValueAtTime(0.0001, bt + segDur);
          o.connect(g); g.connect(this.out || this.master);
          o.start(bt); o.stop(bt + segDur + 0.05);
          this.track(o);
        }
      });
    }
    if (loop.fx) {
      for (const e of loop.fx) {
        const tt = t + e.step * stepDur;
        if (tt >= clipEnd) continue;
        switch (e.kind) {
          case 'crash': this.noise(tt, 0.6, { type: 'highpass', freq: 5500, gain: 0.22 }); break;
          case 'riser': this.noise(tt, seg(tt, stepDur * 16), { type: 'bandpass', freq: 400, sweepTo: 4200, q: 2, gain: 0.16 }); break;
          case 'sweep': this.noise(tt, seg(tt, stepDur * 8), { type: 'bandpass', freq: 900, sweepTo: 2600, q: 3, gain: 0.14 }); break;
          case 'scratch': this.noise(tt, 0.14, { type: 'bandpass', freq: 1100, sweepTo: 300, q: 4, gain: 0.25 }); break;
          case 'shaker': this.noise(tt, 0.09, { type: 'highpass', freq: 6000, gain: 0.13 }); break;
          case 'rain': this.noise(tt, seg(tt, stepDur * totalSteps), { type: 'lowpass', freq: 900, gain: 0.05 }); break;
          case 'blip': this.tone(tt, this.freq(220, e.note || 12), 0.16, { wave: 'square', gain: 0.09 }); break;
          default: break;
        }
      }
    }
  },

  /**
   * Schedule a whole mix starting at ctx-time t0. Returns end
   * ctx-time. THE one playback path — mixer audition, stage
   * performances and home radios all schedule through here, which is
   * what keeps the audibility contract (performer and audience hear
   * the identical thing): the schedule is a pure function of the mix
   * data and t0.
   *
   * Mixer rework model: every track is normalized to CELLS by
   * Mixer.trackCells (v2 lines already hold cells; v1 legacy lines
   * expand their tiling into bubbles, which lands on exactly the
   * passes the old tiling loop scheduled — old mixes and CDs sound
   * unchanged). Each bubble triggers ONE pass of its loop at its
   * bar. If the line's next bubble arrives before this pass would
   * end, the pass is clipped at that bar — the new bubble takes the
   * line over (restart semantics; see playLoop's clipEnd). A pass is
   * NOT clipped at the mix's end: the last bubble rings out its full
   * length, exactly as a v1 track's final tile always did.
   */
  playMix(mix, t0) {
    const loopsById = Mixer.loopsById;
    const stepDur = (60 / mix.bpm) / 4;
    const barDur = stepDur * 16;
    for (const tr of mix.tracks || []) {
      const cells = Mixer.trackCells(tr, mix.bars);
      for (let i = 0; i < cells.length; i++) {
        const loop = loopsById.get(cells[i].loopId);
        if (!loop) continue;
        const start = t0 + cells[i].bar * barDur;
        const clipEnd = i + 1 < cells.length ? t0 + cells[i + 1].bar * barDur : Infinity;
        this.playLoop(loop, start, mix.bpm, clipEnd);
      }
    }
    return t0 + mix.bars * barDur;
  },

  // ---------------------------------------------------------------
  // v1.1 audibility (Item 5): stage performances are scheduled ONLY
  // once the AudioContext is actually RUNNING. The old code scheduled
  // onto ctx.currentTime unconditionally — on a suspended context
  // (the performer who queued, waited, and whose browser idled or
  // interrupted the context) currentTime is FROZEN, so the whole set
  // sat on a clock that never advanced: total silence, no error.
  // Now: if the context isn't running, we ask it to resume and keep
  // retrying (statechange + poll + the client's gesture hook). When
  // it runs in time, the set starts exactly at startAt, in sync with
  // the room. If it wakes LATE, the performer joins from the top of
  // their mix right away — a performance is one pass, so there is no
  // later grid point to join on; hearing the set a beat behind the
  // room beats not hearing it at all.
  _perfWait: null,

  playPerformance(mix, startAt, durationMs) {
    this.cancelPerformanceWait();
    if (!mix) return;
    const attempt = () => {
      if (!this.ctx || this.ctx.state !== 'running') return false;
      const now = Date.now();
      const elapsed = now - startAt;
      if (elapsed >= durationMs) return true; // the set is over — nothing to join
      this.stop();
      if (elapsed <= 50) {
        // On time: start on the shared grid point, exactly synced.
        this.playMix(mix, this.ctx.currentTime + Math.max(0.03, (startAt - now) / 1000));
      } else {
        // Late wake: play the set from the top, now.
        this.playMix(mix, this.ctx.currentTime + 0.05);
      }
      return true;
    };
    if (this.ensure() && attempt()) return;
    const wait = this._perfWait = { done: false, timer: null, onState: null, tryNow: null };
    wait.tryNow = () => {
      if (wait.done) return;
      if (this.ensure()) { try { this.ctx.resume(); } catch (e) { /* stays cold */ } }
      if (attempt() || Date.now() > startAt + durationMs) {
        wait.done = true;
        this._clearPerfWait();
      }
    };
    if (this.ctx && this.ctx.addEventListener) {
      wait.onState = () => wait.tryNow();
      this.ctx.addEventListener('statechange', wait.onState);
    }
    wait.timer = setInterval(wait.tryNow, 400);
    wait.tryNow();
  },

  _clearPerfWait() {
    const w = this._perfWait;
    if (!w) return;
    if (w.timer) clearInterval(w.timer);
    if (w.onState && this.ctx && this.ctx.removeEventListener) {
      try { this.ctx.removeEventListener('statechange', w.onState); } catch (e) { /* gone */ }
    }
    if (this._perfWait === w) this._perfWait = null;
  },

  cancelPerformanceWait() {
    const w = this._perfWait;
    if (w) { w.done = true; this._clearPerfWait(); }
  },

  /** The client's global gesture listener pokes this: a real user
   *  gesture is the one thing that reliably un-suspends a context. */
  notifyGesture() {
    if (this._perfWait) this._perfWait.tryNow();
  },
};

// ------------------------------------------------------------ mixer + stage

const Mixer = {
  loops: [],
  loopsById: new Map(),
  limits: { bpmMin: 70, bpmMax: 160, maxBars: 16, maxTracks: 5 },
  myMixes: [],               // [{id, slot, name, data, updatedAt}]
  editSlot: null,
  // draft tracks are ALWAYS v2 lines while editing: a fixed row per
  // grid line, null = empty line, else { cells: [{loopId, bar}] }.
  // Saved mixes in the v1 shape ({loopId, startBar} tiling lines)
  // are migrated by trackCells() the moment a slot is opened.
  draft: null,               // { name, bpm, bars, tracks: [null | {cells}] }
  selGenre: 'Pop',
  selLoopId: null,
  perf: { active: false, performerId: null, performerName: null, endsAt: 0 },
  queueState: { queue: [], current: null },
  myVote: 0,
  cds: { blanks: 0, cds: [] },   // Phase 9: CD wallet (server-owned)
  chart: null,                   // Phase 9: last Top-40 payload

  attach(hooks) {
    this.hooks = hooks; // { send, toast, esc, getMe, getMapDef }
    this.buildDom();
    fetch('/api/music/loops')
      .then(r => r.json())
      .then(j => {
        if (!j.ok) return;
        this.loops = j.loops;
        this.loopsById = new Map(j.loops.map(l => [l.id, l]));
        this.limits = { bpmMin: j.bpmMin, bpmMax: j.bpmMax, maxBars: j.maxBars, maxTracks: j.maxTracks };
        const genres = [...new Set(j.loops.map(l => l.genre))];
        if (genres.length) this.selGenre = genres[0];
        this.renderBrowser();
        // Mixer rework: a slot opened BEFORE the catalog arrived was
        // migrated cold (v1 tiling expansion needs each loop's bar
        // count) — redo the migration now that every loopId resolves.
        // gridClick clears the flag: once the user edits, their work
        // is never reset under them.
        if (this._migratedCold && this.editSlot != null) {
          this._migratedCold = false;
          this.selectSlot(this.editSlot);
        }
        // Phase 9 (audibility): a radio that tried to start before
        // the catalog arrived bailed silently — re-sync it now that
        // every loopId resolves.
        if (window.SolarionStudio) window.SolarionStudio.syncRadio();
      })
      .catch(() => {});
  },

  // ---------------------------------------------------------- DOM build

  buildDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      panel: $('mixerPanel'), slots: $('mixSlots'), grid: $('mixGrid'),
      browser: $('loopBrowser'), genreRow: $('genreRow'), name: $('mixName'),
      bpm: $('mixBpm'), bars: $('mixBars'), editTitle: $('editTitle'),
      stagePanel: $('stagePanel'), queueList: $('queueList'),
      joinSel: $('joinMixSel'), nowPlaying: $('nowPlaying'),
      npText: $('npText'), result: $('perfResult'),
      cdBox: $('cdBox'), chartBox: $('chartBox'),
      tipBox: $('tipBox'), tipAmt: $('tipAmt'), tipBtn: $('tipBtn'),
    };
    // UX overhaul: the nav button TOGGLES the mixer (it only opened
    // before), the panel settles in via PanelFx, and it is draggable
    // by its header (position kept for the session).
    $('musicBtn').onclick = () => {
      AE.ensure();
      if (this.el.panel.classList.contains('hidden')) this.openPanel();
      else this.closePanel();
    };
    $('mixerClose').onclick = () => this.closePanel();
    if (window.SolarionDrag) {
      window.SolarionDrag.attach(this.el.panel, this.el.panel.querySelector('.mxHead'), 'mixer');
    }
    $('mixPlay').onclick = () => this.auditionDraft();
    $('mixStop').onclick = () => AE.stop();
    $('mixSave').onclick = () => this.saveDraft();
    $('mixDelete').onclick = () => this.deleteSlot();
    $('mixAddTrackHint').onclick = () => this.hooks.toast('Pick a loop below, then click any cell to drop a bubble there — fill a line one cell at a time; click a bubble to take it back.');
    $('stageJoinBtn').onclick = () => {
      // v1.1: the drop-down lists burned CDs; the selected CD is
      // what Perform plays (its mix goes on the wire, as before).
      const cd = this.cds.cds.find(c => c.id === Number(this.el.joinSel.value));
      if (!cd) { this.hooks.toast('Burn a CD first — open the 🎵 Mixer to make one.'); return; }
      AE.ensure();
      this.hooks.send({ type: 'stage-join', mixId: cd.mixId });
    };
    if (this.el.tipBtn) this.el.tipBtn.onclick = () => {
      this.hooks.send({ type: 'tip', amount: Number(this.el.tipAmt.value) });
    };
    $('stageLeaveBtn').onclick = () => this.hooks.send({ type: 'stage-leave' });
    $('voteUp').onclick = () => this.vote(1);
    $('voteDown').onclick = () => this.vote(-1);
    $('chartBtn').onclick = () => this.hooks.send({ type: 'chart' });
    this.el.bpm.oninput = () => { if (this.draft) { this.draft.bpm = Number(this.el.bpm.value); $('bpmVal').textContent = this.el.bpm.value; } };
    this.el.bars.onchange = () => {
      if (!this.draft) return;
      this.draft.bars = Number(this.el.bars.value);
      // Shrinking the mix drops bubbles past the new end (per line);
      // a line left with no bubbles goes back to an empty row.
      this.draft.tracks = this.draft.tracks.map(t => {
        if (!t) return null;
        const cells = t.cells.filter(c => c.bar < this.draft.bars);
        return cells.length ? { cells } : null;
      });
      this.renderGrid();
    };
    this.el.name.oninput = () => { if (this.draft) this.draft.name = this.el.name.value; };
  },

  openPanel() {
    if (window.SolarionDrag) window.SolarionDrag.restore(this.el.panel, 'mixer');
    if (window.PanelFx) window.PanelFx.show(this.el.panel);
    else this.el.panel.classList.remove('hidden');
    this.hooks.send({ type: 'mix-list' });
    this.renderSlots();
    if (this.editSlot == null) this.selectSlot(1);
  },

  closePanel() {
    AE.stop();
    if (window.PanelFx) window.PanelFx.hide(this.el.panel);
    else this.el.panel.classList.add('hidden');
  },

  mixAtSlot(slot) { return this.myMixes.find(m => m.slot === slot) || null; },

  /**
   * Normalize ANY stored track to its bubble list [{loopId, bar}],
   * sorted by bar, at most one bubble per bar:
   *   v2 line {cells}  → its cells, passed through (deduped).
   *   v1 line {loopId, startBar} → the tiling EXPANDED into bubbles
   *     at startBar + k·loop.bars while < mixBars — precisely the
   *     passes the legacy engine scheduled, so playback (and the
   *     editor) sees a v1 mix exactly as it always sounded.
   * Shared by AE.playMix (playback) and selectSlot (edit migration).
   */
  trackCells(track, mixBars) {
    if (!track) return [];
    if (Array.isArray(track.cells)) {
      const seen = new Set();
      const out = [];
      for (const c of track.cells) {
        if (!c || !Number.isInteger(c.bar) || seen.has(c.bar)) continue;
        seen.add(c.bar);
        out.push({ loopId: c.loopId, bar: c.bar });
      }
      return out.sort((a, b) => a.bar - b.bar);
    }
    if (track.loopId) {
      const loop = this.loopsById.get(track.loopId);
      const span = loop ? loop.bars : 1;
      const out = [];
      for (let b = track.startBar || 0; b < mixBars; b += span) {
        out.push({ loopId: track.loopId, bar: b });
      }
      return out;
    }
    return [];
  },

  /** Total bubbles across the draft's lines (the "has music" test). */
  draftCellCount() {
    if (!this.draft) return 0;
    return this.draft.tracks.reduce((n, t) => n + (t ? t.cells.length : 0), 0);
  },

  /** The draft in wire shape: empty lines dropped, cells copied. */
  draftWireTracks() {
    return this.draft.tracks
      .filter(t => t && t.cells.length)
      .map(t => ({ cells: t.cells.map(c => ({ loopId: c.loopId, bar: c.bar })) }));
  },

  selectSlot(slot) {
    this.editSlot = slot;
    const existing = this.mixAtSlot(slot);
    this.draft = existing
      ? JSON.parse(JSON.stringify(existing.data))
      : { name: '', bpm: 112, bars: 8, tracks: [] };
    // Migrate to v2 lines for editing (see trackCells): every stored
    // track becomes bubbles on its own fixed grid row.
    this._migratedCold = this.loopsById.size === 0 && (this.draft.tracks || []).length > 0;
    const rows = [];
    for (let r = 0; r < this.limits.maxTracks; r++) {
      const cells = this.trackCells((this.draft.tracks || [])[r], this.draft.bars);
      rows.push(cells.length ? { cells } : null);
    }
    this.draft.tracks = rows;
    this.el.name.value = this.draft.name;
    this.el.bpm.value = this.draft.bpm;
    document.getElementById('bpmVal').textContent = this.draft.bpm;
    this.el.bars.value = String(this.draft.bars);
    this.renderSlots();
    this.renderGrid();
  },

  renderSlots() {
    const esc = this.hooks.esc;
    let html = '';
    for (let s = 1; s <= 5; s++) {
      const m = this.mixAtSlot(s);
      html += `<button class="slotBtn ${s === this.editSlot ? 'active' : ''}" data-slot="${s}">
        <b>Slot ${s}</b><span>${m ? esc(m.name) : '&lt; empty &gt;'}</span></button>`;
    }
    this.el.slots.innerHTML = html;
    for (const b of this.el.slots.querySelectorAll('.slotBtn')) {
      b.onclick = () => this.selectSlot(Number(b.dataset.slot));
    }
    // (The stage join drop-down is the CD collection — renderCds
    // owns it since v1.1.)
  },

  renderBrowser() {
    const esc = this.hooks.esc;
    const genres = [...new Set(this.loops.map(l => l.genre))];
    this.el.genreRow.innerHTML = genres.map(g =>
      `<button class="genreBtn ${g === this.selGenre ? 'active' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('');
    for (const b of this.el.genreRow.querySelectorAll('.genreBtn')) {
      b.onclick = () => { this.selGenre = b.dataset.g; this.renderBrowser(); };
    }
    const roleIcon = { drums: '🥁', bass: '🎸', melody: '🎹', pad: '🌫️', fx: '✨' };
    this.el.browser.innerHTML = this.loops.filter(l => l.genre === this.selGenre).map(l =>
      `<button class="loopBtn ${l.id === this.selLoopId ? 'active' : ''}" data-id="${l.id}">
        ${roleIcon[l.role] || '🎵'} ${esc(l.name)} <small>${l.role} · ${l.bars}🔁</small></button>`).join('');
    for (const b of this.el.browser.querySelectorAll('.loopBtn')) {
      b.onclick = () => {
        this.selLoopId = b.dataset.id;
        this.renderBrowser();
        this.auditionLoop(b.dataset.id);
      };
      // (v1.1: the old dblclick called a placeSelected() that never
      // existed — removed; placing lives in the grid, one click.)
    }
  },

  renderGrid() {
    if (!this.draft) return;
    const esc = this.hooks.esc;
    const bars = this.draft.bars;
    this.el.editTitle.textContent = `Editing slot ${this.editSlot} — click a cell to drop the loop there; click a bubble to take it back`;
    let html = '<div class="gridHead">';
    for (let b = 0; b < bars; b++) html += `<div class="gcell head">${b + 1}</div>`;
    html += '</div>';
    for (let r = 0; r < this.limits.maxTracks; r++) {
      const line = this.draft.tracks[r];
      const byBar = new Map(line ? line.cells.map(c => [c.bar, c]) : []);
      html += `<div class="gridRow" data-row="${r}">`;
      for (let b = 0; b < bars; b++) {
        let cls = 'gcell', label = '';
        const cell = byBar.get(b);
        if (cell) {
          // Mixer rework (X): a bubble is EXACTLY one cell, always
          // — even for a 2- or 4-bar loop. No span underline, no
          // stretched block: one cell, one bubble, one trigger.
          const loop = this.loopsById.get(cell.loopId);
          cls += ' filled bubble';
          label = esc(loop ? loop.name : cell.loopId);
        }
        html += `<div class="${cls}" data-bar="${b}">${label}</div>`;
      }
      let rowText = '+ track';
      if (line && line.cells.length) {
        const kinds = new Set(line.cells.map(c => c.loopId));
        rowText = kinds.size === 1
          ? ((this.loopsById.get(line.cells[0].loopId) || {}).name || line.cells[0].loopId)
          : `${line.cells.length} bubbles`;
      }
      html += `<button class="rowLabel" data-row="${r}">${esc(rowText)}</button></div>`;
    }
    this.el.grid.innerHTML = html;
    for (const cell of this.el.grid.querySelectorAll('.gridRow')) {
      cell.onclick = (e) => {
        const row = Number(cell.dataset.row);
        const barEl = e.target.closest('[data-bar]');
        const bar = barEl ? Number(barEl.dataset.bar) : 0;
        this.gridClick(row, bar);
      };
    }
  },

  gridClick(row, bar) {
    // Mixer rework contract (X, 2026-10-21): the grid is CELLS,
    // filled one at a time.
    //  - click an EMPTY cell with a loop selected → a bubble of that
    //    loop lands in exactly that cell (one cell wide, whatever
    //    the loop's length); the line keeps every other bubble.
    //  - click a PLACED bubble → just that bubble is removed.
    //    Nothing moves, nothing else is touched.
    //  - click an empty cell with nothing selected → a hint toast.
    // A line holds at most one bubble per bar (structurally: a cell
    // is either filled or empty), and rows never compact mid-edit —
    // the line you filled is the line you keep filling.
    if (!this.draft) return;
    this._migratedCold = false; // the user owns this draft now
    const at = Math.max(0, Math.min(bar, this.draft.bars - 1));
    let line = this.draft.tracks[row];
    const idx = line ? line.cells.findIndex(c => c.bar === at) : -1;
    if (idx >= 0) {
      line.cells.splice(idx, 1);
      if (!line.cells.length) this.draft.tracks[row] = null;
      this.renderGrid();
      return;
    }
    if (!this.selLoopId) {
      this.hooks.toast('Pick a loop from the browser first (click = hear it), then click a cell to drop it there.');
      return;
    }
    if (!line) { line = { cells: [] }; this.draft.tracks[row] = line; }
    line.cells.push({ loopId: this.selLoopId, bar: at });
    line.cells.sort((a, b) => a.bar - b.bar);
    this.renderGrid();
  },

  auditionLoop(loopId) {
    if (!AE.ensure()) return;
    AE.stop();
    const loop = this.loopsById.get(loopId);
    if (loop) AE.playLoop(loop, AE.ctx.currentTime + 0.06, this.draft ? this.draft.bpm : 112);
  },

  auditionDraft() {
    if (!AE.ensure() || !this.draft) return;
    if (!this.draftCellCount()) { this.hooks.toast('Add at least one loop first.'); return; }
    AE.stop();
    AE.playMix({ ...this.draft, name: this.draft.name || 'preview', tracks: this.draftWireTracks() }, AE.ctx.currentTime + 0.08);
  },

  saveDraft() {
    if (!this.draft || this.editSlot == null) return;
    const data = { name: this.el.name.value.trim(), bpm: Number(this.el.bpm.value), bars: Number(this.el.bars.value), tracks: this.draftWireTracks() };
    if (!data.tracks.length) { this.hooks.toast('Add at least one loop first.'); return; }
    this.hooks.send({ type: 'mix-save', slot: this.editSlot, data });
  },

  deleteSlot() {
    if (this.editSlot == null) return;
    this.hooks.send({ type: 'mix-delete', slot: this.editSlot });
  },

  // ---------------------------------------------------------- stage UI

  vote(v) {
    // v1.1: one ACTIVE vote — clicking the opposite thumb switches
    // it (the old client locked both buttons after any vote).
    if (!this.perf.active || this.myVote === v) return;
    const me = this.hooks.getMe();
    if (me && me.id === this.perf.performerId) return;
    this.myVote = v;
    this.hooks.send({ type: 'vote', value: v });
    this.renderNowPlaying();
  },

  renderNowPlaying() {
    const esc = this.hooks.esc;
    if (this.perf.active) {
      this.el.nowPlaying.classList.remove('hidden');
      const mine = this.hooks.getMe() && this.hooks.getMe().id === this.perf.performerId;
      this.el.npText.innerHTML = `🎤 <b>${esc(this.perf.performerName)}</b> is performing <b>${esc(this.perf.mixName)}</b>` +
        ` · <span class="npCounts">👍 ${this.perf.up || 0} 👎 ${this.perf.down || 0}</span>` +
        (mine ? ' — that\'s you!' : this.myVote ? ` — you voted ${this.myVote > 0 ? '👍' : '👎'} (other thumb switches)` : ' — vote!');
      const up = document.getElementById('voteUp'), dn = document.getElementById('voteDown');
      up.disabled = Boolean(mine);
      dn.disabled = Boolean(mine);
      up.classList.toggle('mine', !mine && this.myVote === 1);
      dn.classList.toggle('mine', !mine && this.myVote === -1);
      if (this.el.tipBox) this.el.tipBox.classList.toggle('hidden', Boolean(mine));
    } else {
      this.el.nowPlaying.classList.add('hidden');
      if (this.el.tipBox) this.el.tipBox.classList.add('hidden');
    }
  },

  renderQueue() {
    const esc = this.hooks.esc;
    const q = this.queueState;
    const me = this.hooks.getMe();
    const inQueue = me && q.queue.some(e => e.userId === me.id);
    const performing = me && q.current && q.current.userId === me.id;
    let html = '';
    if (q.current) html += `<div class="qNow">🎤 Now: <b>${esc(q.current.name)}</b> — ${esc(q.current.mixName)}</div>`;
    if (!q.queue.length && !q.current) html += '<div class="qEmpty">Stage is free — be the first to perform!</div>';
    q.queue.forEach((e, i) => { html += `<div class="qItem">${i + 1}. ${esc(e.name)} — <i>${esc(e.mixName)}</i></div>`; });
    this.el.queueList.innerHTML = html;
    document.getElementById('stageJoinBtn').classList.toggle('hidden', Boolean(inQueue || performing));
    document.getElementById('stageLeaveBtn').classList.toggle('hidden', !inQueue);
    this.el.joinSel.classList.toggle('hidden', Boolean(inQueue || performing));
  },

  onMapChanged(mapDef) {
    const hasStage = Boolean(mapDef && mapDef.stage);
    this.el.stagePanel.classList.toggle('hidden', !hasStage);
    if (!hasStage) { AE.stop(); AE.cancelPerformanceWait(); this.perf.active = false; this.renderNowPlaying(); }
  },

  // ---------------------------------------------------------- Phase 9: CDs + chart + vote juice

  renderCds() {
    if (!this.el.cdBox) return;
    const esc = this.hooks.esc;
    // v1.1: CDs are a permanent collection (performing no longer
    // spends them). The stage join drop-down lists CDs — duplicates
    // of one mix told apart by CD number — and each CD row carries
    // its own Delete (the mix itself is never touched).
    if (this.el.joinSel) {
      const prev = this.el.joinSel.value;
      this.el.joinSel.innerHTML = this.cds.cds.map(c =>
        `<option value="${c.id}">💿 ${esc(c.name || 'mix')} · CD #${c.id}</option>`).join('') ||
        '<option value="">— burn a CD to perform —</option>';
      if (this.cds.cds.some(c => String(c.id) === prev)) this.el.joinSel.value = prev;
    }
    const cdRows = this.cds.cds.map(c =>
      `<div class="qItem">💿 <b>${esc(c.name || 'mix')}</b> · CD #${c.id} <button data-delcd="${c.id}">🗑 Delete</button></div>`).join('');
    const burnRows = this.myMixes.map(m =>
      `<div class="qItem">🎵 <b>${esc(m.name)}</b> <button data-burn="${m.id}">🔥 Burn CD</button></div>`).join('');
    this.el.cdBox.innerHTML = `
      <div class="qDim" style="margin-top:8px">💿 Blank CDs: <b>${this.cds.blanks}</b>
        <button data-buyblanks="1">Buy pack of 10 — 20z</button></div>
      ${cdRows}${burnRows || '<div class="qDim">Save a mix, burn it to a CD, then perform it.</div>'}`;
    for (const b of this.el.cdBox.querySelectorAll('[data-burn]')) {
      b.onclick = () => { AE.ensure(); this.hooks.send({ type: 'burn-cd', mixId: Number(b.dataset.burn) }); };
    }
    for (const b of this.el.cdBox.querySelectorAll('[data-delcd]')) {
      b.onclick = () => this.hooks.send({ type: 'delete-cd', cdId: Number(b.dataset.delcd) });
    }
    const buy = this.el.cdBox.querySelector('[data-buyblanks]');
    if (buy) buy.onclick = () => this.hooks.send({ type: 'buy-blanks' });
  },

  renderChart() {
    if (!this.chart || !this.el.chartBox) return;
    const esc = this.hooks.esc;
    const rows = this.chart.entries.map(e =>
      `<div class="qItem">#${e.rank} <b>${esc(e.title)}</b> — ${esc(e.performer)} · 👍 ${e.ups}</div>`).join('');
    this.el.chartBox.innerHTML = `<div class="qDim" style="margin-top:6px">🏆 TOP 40 — last ${this.chart.windowDays} days</div>` +
      (rows || '<div class="qDim">No performances charted yet this week.</div>');
  },

  /** Floating 👍/👎 over the stage area (item 9). */
  voteFloat(value) {
    const host = document.getElementById('stageFloats');
    if (!host) return;
    const s = document.createElement('span');
    s.className = 'voteFloat';
    s.textContent = value > 0 ? '👍' : '👎';
    s.style.left = `${42 + Math.random() * 16}%`;
    s.style.bottom = '120px';
    host.appendChild(s);
    setTimeout(() => s.remove(), 1700);
  },

  // ---------------------------------------------------------- messages

  handle(m) {
    switch (m.type) {
      case 'mixes':
        this.myMixes = m.mixes || [];
        this.renderSlots();
        this.renderCds();
        if (this.editSlot != null && !this.el.panel.classList.contains('hidden')) this.renderGrid();
        break;
      case 'cds':
        this.cds = { blanks: m.blanks || 0, cds: m.cds || [] };
        this.renderCds();
        break;
      case 'chart':
        this.chart = m;
        this.renderChart();
        break;
      case 'vote-fx':
        // Someone in the room voted — float it for everyone (item 9).
        // v1.1: the broadcast carries live tallies — the performer
        // watches the 👍/👎 counts move while they play.
        if (this.perf.active && m.performerId === this.perf.performerId) {
          if (Number.isFinite(m.up)) this.perf.up = m.up;
          if (Number.isFinite(m.down)) this.perf.down = m.down;
          this.renderNowPlaying();
        }
        if (!this.perf.active || m.performerId === this.perf.performerId) this.voteFloat(m.value);
        break;
      case 'vote-ack':
        if (this.perf.active) { this.myVote = m.value; this.renderNowPlaying(); }
        break;
      case 'mix-saved':
        this.hooks.toast(`💾 Saved "${m.mix.name}" to slot ${m.mix.slot}`);
        break;
      case 'mix-error':
        this.hooks.toast(`⚠️ ${m.error}`, 4000);
        break;
      case 'stage-queue':
        this.queueState = { queue: m.queue || [], current: m.current || null };
        this.renderQueue();
        break;
      case 'performance-start': {
        this.perf = {
          active: true, performerId: m.performerId, performerName: m.performerName,
          mixName: m.mixName, endsAt: m.startAt + m.durationMs, startAt: m.startAt,
          bpm: m.mix ? m.mix.bpm : 112, bars: m.mix ? m.mix.bars : 8, up: 0, down: 0,
        };
        this.myVote = 0;
        this.el.result.classList.add('hidden');
        this.renderNowPlaying();
        this.renderQueue();
        // v1.1 (Item 5): AE.playPerformance schedules ONLY on a
        // running context (deferring if it starts cold) — the old
        // code scheduled unconditionally onto
        // ctx.currentTime, which is frozen on a suspended context,
        // so a performer whose browser had idled heard silence.
        // The UI end timer is Mixer-owned now (AE.stop() would have
        // cleared an AE.stopTimers entry when a deferred join lands).
        AE.playPerformance(m.mix, m.startAt, m.durationMs);
        clearTimeout(this._perfUiTimer);
        const totalMs = (m.startAt - Date.now()) + m.durationMs + 10000;
        this._perfUiTimer = setTimeout(() => { this.perf.active = false; this.renderNowPlaying(); }, Math.max(0, totalMs));
        break;
      }
      case 'performance-end': {
        AE.cancelPerformanceWait();
        clearTimeout(this._perfUiTimer);
        this.perf.active = false;
        this.renderNowPlaying();
        const mine = this.hooks.getMe() && this.hooks.getMe().id === m.performerId;
        this.el.result.innerHTML = `🎤 <b>${this.hooks.esc(m.performerName)}</b> — "${this.hooks.esc(m.mixName)}"<br>` +
          `👍 ${m.up} &nbsp; 👎 ${m.down}` + (mine ? `<br>You receive <b>${m.earned} z coins</b> 🪙` : '');
        this.el.result.classList.remove('hidden');
        clearTimeout(this._resultTimer);
        this._resultTimer = setTimeout(() => this.el.result.classList.add('hidden'), 12000);
        // Item 9: a strong set gets the crowd — applause + a burst
        // of thumbs. A rough set gets a sympathetic groan.
        if (window.SolarionSfx) {
          if (m.up >= 3 && m.up > m.down * 2) {
            window.SolarionSfx.play('applause');
            for (let i = 0; i < 6; i++) setTimeout(() => this.voteFloat(1), i * 130);
          } else if (m.down >= 3 && m.down > m.up) {
            window.SolarionSfx.play('boo');
          }
        }
        break;
      }
      default:
        break;
    }
  },
};

if (typeof window !== 'undefined') window.SolarionMixer = Mixer;
if (typeof module !== 'undefined' && module.exports) module.exports = { AE, Mixer };
