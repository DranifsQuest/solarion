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
 * a block grid where loop blocks snap onto tracks on a bar grid → PLAY
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
      // v1.2 (Item D): a limiter between master and the speakers.
      // The old graph ran master straight to the destination, so a
      // dense zone composition + SFX on top could sum past 0dBFS
      // and clip into harsh distortion bursts. The compressor
      // only engages on peaks (high threshold, hard ratio) — the
      // music itself is untouched at normal levels.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 4;
      this.limiter.ratio.value = 16;
      this.limiter.attack.value = 0.004;
      this.limiter.release.value = 0.24;
      this.master.connect(this.limiter);
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
  },

  noise(t, dur, { type = 'highpass', freq = 7000, q = 0.8, gain = 0.2, sweepTo = null } = {}) {
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
    return this.track(src);
  },

  tone(t, freq, dur, { wave = 'sine', gain = 0.18, attack = 0.005, slideTo = null } = {}) {
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
    return this.track(o);
  },

  kick(t) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g); g.connect(this.out || this.master);
    o.start(t); o.stop(t + 0.26);
    this.track(o);
  },

  snare(t) {
    this.noise(t, 0.12, { type: 'bandpass', freq: 1800, q: 0.7, gain: 0.28 });
    this.tone(t, 190, 0.08, { wave: 'triangle', gain: 0.15 });
  },

  hat(t, open) {
    this.noise(t, open ? 0.22 : 0.05, { type: 'highpass', freq: 7500, gain: 0.12 });
  },

  perc(t) {
    this.noise(t, 0.07, { type: 'bandpass', freq: 5200, q: 2.5, gain: 0.13 });
  },

  freq(root, semi) { return root * Math.pow(2, semi / 12); },

  /** Schedule ONE pass of a loop starting at ctx-time t. stepDur in seconds. */
  playLoop(loop, t, bpm) {
    const stepDur = (60 / bpm) / 4;
    const totalSteps = loop.bars * 16;
    if (loop.drums) {
      for (const [inst, pat] of Object.entries(loop.drums)) {
        for (let s = 0; s < pat.length; s++) {
          if (pat[s] !== 'x') continue;
          const tt = t + s * stepDur;
          if (inst === 'kick') this.kick(tt);
          else if (inst === 'snare') this.snare(tt);
          else if (inst === 'hat') this.hat(tt, s % 16 === 14);
          else this.perc(tt);
        }
      }
    }
    if (loop.notes) {
      const isBass = loop.role === 'bass';
      for (const [step, semi, len] of loop.notes) {
        this.tone(t + step * stepDur, this.freq(loop.root, semi), len * stepDur * 0.92, {
          wave: loop.wave || 'triangle', gain: isBass ? 0.26 : 0.15,
        });
      }
    }
    if (loop.chords) {
      const barDur = stepDur * 16;
      loop.chords.forEach((chord, bar) => {
        const bt = t + bar * barDur;
        for (const semi of chord) {
          const o = this.ctx.createOscillator();
          o.type = loop.wave || 'triangle';
          o.frequency.value = this.freq(loop.root, semi);
          o.detune.value = (Math.random() * 8 - 4);
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, bt);
          g.gain.linearRampToValueAtTime(0.045, bt + Math.min(0.35, barDur * 0.3));
          g.gain.setValueAtTime(0.045, bt + barDur * 0.7);
          g.gain.linearRampToValueAtTime(0.0001, bt + barDur);
          o.connect(g); g.connect(this.out || this.master);
          o.start(bt); o.stop(bt + barDur + 0.05);
          this.track(o);
        }
      });
    }
    if (loop.fx) {
      for (const e of loop.fx) {
        const tt = t + e.step * stepDur;
        switch (e.kind) {
          case 'crash': this.noise(tt, 0.6, { type: 'highpass', freq: 5500, gain: 0.22 }); break;
          case 'riser': this.noise(tt, stepDur * 16, { type: 'bandpass', freq: 400, sweepTo: 4200, q: 2, gain: 0.16 }); break;
          case 'sweep': this.noise(tt, stepDur * 8, { type: 'bandpass', freq: 900, sweepTo: 2600, q: 3, gain: 0.14 }); break;
          case 'scratch': this.noise(tt, 0.14, { type: 'bandpass', freq: 1100, sweepTo: 300, q: 4, gain: 0.25 }); break;
          case 'shaker': this.noise(tt, 0.09, { type: 'highpass', freq: 6000, gain: 0.13 }); break;
          case 'rain': this.noise(tt, stepDur * totalSteps, { type: 'lowpass', freq: 900, gain: 0.05 }); break;
          case 'blip': this.tone(tt, this.freq(220, e.note || 12), 0.16, { wave: 'square', gain: 0.09 }); break;
          default: break;
        }
      }
    }
  },

  /** Schedule a whole mix starting at ctx-time t0. Returns end ctx-time. */
  playMix(mix, t0) {
    const loopsById = Mixer.loopsById;
    const stepDur = (60 / mix.bpm) / 4;
    const barDur = stepDur * 16;
    for (const tr of mix.tracks) {
      const loop = loopsById.get(tr.loopId);
      if (!loop) continue;
      const loopDur = loop.bars * barDur;
      let start = t0 + tr.startBar * barDur;
      const end = t0 + mix.bars * barDur;
      while (start < end - 0.01) {
        this.playLoop(loop, start, mix.bpm);
        start += loopDur;
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
  draft: null,               // { name, bpm, bars, tracks: [{loopId, startBar}] }
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
    $('musicBtn').onclick = () => { AE.ensure(); this.openPanel(); };
    $('mixerClose').onclick = () => this.closePanel();
    $('mixPlay').onclick = () => this.auditionDraft();
    $('mixStop').onclick = () => AE.stop();
    $('mixSave').onclick = () => this.saveDraft();
    $('mixDelete').onclick = () => this.deleteSlot();
    $('mixAddTrackHint').onclick = () => this.hooks.toast('Pick a loop below, then click a track row to place it.');
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
    this.el.bars.onchange = () => { if (this.draft) { this.draft.bars = Number(this.el.bars.value); this.draft.tracks = this.draft.tracks.filter(t => t.startBar < this.draft.bars); this.renderGrid(); } };
    this.el.name.oninput = () => { if (this.draft) this.draft.name = this.el.name.value; };
  },

  openPanel() {
    this.el.panel.classList.remove('hidden');
    this.hooks.send({ type: 'mix-list' });
    this.renderSlots();
    if (this.editSlot == null) this.selectSlot(1);
  },

  closePanel() {
    AE.stop();
    this.el.panel.classList.add('hidden');
  },

  mixAtSlot(slot) { return this.myMixes.find(m => m.slot === slot) || null; },

  selectSlot(slot) {
    this.editSlot = slot;
    const existing = this.mixAtSlot(slot);
    this.draft = existing
      ? JSON.parse(JSON.stringify(existing.data))
      : { name: '', bpm: 112, bars: 8, tracks: [] };
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
    this.el.editTitle.textContent = `Editing slot ${this.editSlot} — one click places ONE bubble; click the bubble again to take it back`;
    let html = '<div class="gridHead">';
    for (let b = 0; b < bars; b++) html += `<div class="gcell head">${b + 1}</div>`;
    html += '</div>';
    for (let r = 0; r < this.limits.maxTracks; r++) {
      const tr = this.draft.tracks[r];
      html += `<div class="gridRow" data-row="${r}">`;
      for (let b = 0; b < bars; b++) {
        let cls = 'gcell', label = '';
        if (tr) {
          const loop = this.loopsById.get(tr.loopId);
          // v1.1 (Zan): exactly ONE filled bubble per track — the
          // placement cell. The loop's span is a faint underline so
          // it can never be mistaken for more filled bubbles, and
          // the repeat tail draws nothing at all.
          if (loop && b === tr.startBar) { cls += ' filled bubble'; label = esc(loop.name); }
          else if (loop && b > tr.startBar && b < tr.startBar + loop.bars) { cls += ' span'; }
        }
        html += `<div class="${cls}" data-bar="${b}">${label}</div>`;
      }
      html += `<button class="rowLabel" data-row="${r}">${tr ? esc((this.loopsById.get(tr.loopId) || {}).name || tr.loopId) : '+ track'}</button></div>`;
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
    // v1.1 toggle contract (Zan: "fill one bubble at a time per
    // selection; click a second time to remove the bubble"):
    //  - one click places exactly ONE bubble (the track's startBar);
    //  - clicking that bubble with the SAME loop selected removes it;
    //  - clicking it with a DIFFERENT loop selected swaps the loop
    //    in place (still one bubble);
    //  - clicking anywhere else in the row moves the one bubble;
    //  - with nothing selected, clicking the bubble removes it too.
    if (!this.draft) return;
    const at = Math.max(0, Math.min(bar, this.draft.bars - 1));
    const existing = this.draft.tracks[row];
    if (!this.selLoopId) {
      if (existing && bar === existing.startBar) { this.draft.tracks.splice(row, 1); this.renderGrid(); }
      else if (existing) { this.hooks.toast('Click the filled bubble to remove it, or pick a loop to move it.'); }
      else this.hooks.toast('Pick a loop from the browser first (click = hear it).');
      return;
    }
    if (existing && bar === existing.startBar) {
      if (existing.loopId === this.selLoopId) this.draft.tracks.splice(row, 1); // toggle OFF
      else existing.loopId = this.selLoopId;                                     // swap in place
    } else {
      this.draft.tracks[row] = { loopId: this.selLoopId, startBar: at };         // place / move the one bubble
    }
    this.draft.tracks = this.draft.tracks.filter(Boolean);
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
    if (!this.draft.tracks.length) { this.hooks.toast('Add at least one loop first.'); return; }
    AE.stop();
    AE.playMix({ ...this.draft, name: this.draft.name || 'preview' }, AE.ctx.currentTime + 0.08);
  },

  saveDraft() {
    if (!this.draft || this.editSlot == null) return;
    const data = { name: this.el.name.value.trim(), bpm: Number(this.el.bpm.value), bars: Number(this.el.bars.value), tracks: this.draft.tracks };
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
