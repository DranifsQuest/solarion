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
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
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
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
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
    o.connect(g); g.connect(this.master);
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
    o.connect(g); g.connect(this.master);
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
          o.connect(g); g.connect(this.master);
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
    };
    $('musicBtn').onclick = () => { AE.ensure(); this.openPanel(); };
    $('mixerClose').onclick = () => this.closePanel();
    $('mixPlay').onclick = () => this.auditionDraft();
    $('mixStop').onclick = () => AE.stop();
    $('mixSave').onclick = () => this.saveDraft();
    $('mixDelete').onclick = () => this.deleteSlot();
    $('mixAddTrackHint').onclick = () => this.hooks.toast('Pick a loop below, then click a track row to place it.');
    $('stageJoinBtn').onclick = () => {
      const id = Number(this.el.joinSel.value);
      if (!id) { this.hooks.toast('Save a mix first — open the 🎵 Mixer.'); return; }
      AE.ensure();
      this.hooks.send({ type: 'stage-join', mixId: id });
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
    // stage join select mirrors saved mixes
    const opts = this.myMixes.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
    this.el.joinSel.innerHTML = opts || '<option value="">— no mixes yet —</option>';
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
      b.ondblclick = () => this.placeSelected(0);
    }
  },

  renderGrid() {
    if (!this.draft) return;
    const esc = this.hooks.esc;
    const bars = this.draft.bars;
    this.el.editTitle.textContent = `Editing slot ${this.editSlot} — click a row to place the selected loop; click a block to remove it`;
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
          if (loop && b >= tr.startBar && b < tr.startBar + loop.bars) { cls += ' filled start' + (b === tr.startBar ? ' first' : ''); label = b === tr.startBar ? esc(loop.name) : '·'; }
          else if (loop && b > tr.startBar) { cls += ' repeat'; label = '↻'; }
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
    if (!this.draft) return;
    const existing = this.draft.tracks[row];
    if (existing && !this.selLoopId) { this.draft.tracks.splice(row, 1); this.renderGrid(); return; }
    if (!this.selLoopId) { this.hooks.toast('Pick a loop from the browser first (click = hear it).'); return; }
    if (existing && existing.loopId === this.selLoopId) {
      existing.startBar = Math.max(0, Math.min(bar, this.draft.bars - 1));
    } else if (existing && bar >= existing.startBar && bar < existing.startBar + (this.loopsById.get(existing.loopId) || { bars: 1 }).bars) {
      this.draft.tracks.splice(row, 1); // clicked the block itself → remove
    } else {
      this.draft.tracks[row] = { loopId: this.selLoopId, startBar: Math.max(0, Math.min(bar, this.draft.bars - 1)) };
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
    if (!this.perf.active || this.myVote) return;
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
        (mine ? ' — that\'s you!' : this.myVote ? ` — you voted ${this.myVote > 0 ? '👍' : '👎'}` : ' — vote!');
      document.getElementById('voteUp').disabled = mine || !!this.myVote;
      document.getElementById('voteDown').disabled = mine || !!this.myVote;
    } else {
      this.el.nowPlaying.classList.add('hidden');
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
    if (!hasStage) { AE.stop(); this.perf.active = false; this.renderNowPlaying(); }
  },

  // ---------------------------------------------------------- Phase 9: CDs + chart + vote juice

  renderCds() {
    if (!this.el.cdBox) return;
    const esc = this.hooks.esc;
    const cdFor = new Set(this.cds.cds.map(c => c.mixId));
    const rows = this.myMixes.map(m => cdFor.has(m.id)
      ? `<div class="qItem">💿 <b>${esc(m.name)}</b> — CD ready to perform</div>`
      : `<div class="qItem">🎵 <b>${esc(m.name)}</b> <button data-burn="${m.id}">🔥 Burn CD</button></div>`).join('');
    this.el.cdBox.innerHTML = `
      <div class="qDim" style="margin-top:8px">💿 Blank CDs: <b>${this.cds.blanks}</b>
        <button data-buyblanks="1">Buy pack of 10 — 20z</button></div>
      ${rows || '<div class="qDim">Save a mix, burn it to a CD, then perform it.</div>'}`;
    for (const b of this.el.cdBox.querySelectorAll('[data-burn]')) {
      b.onclick = () => { AE.ensure(); this.hooks.send({ type: 'burn-cd', mixId: Number(b.dataset.burn) }); };
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
        if (!this.perf.active || m.performerId === this.perf.performerId) this.voteFloat(m.value);
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
        this.perf = { active: true, performerId: m.performerId, performerName: m.performerName, mixName: m.mixName, endsAt: m.startAt + m.durationMs };
        this.myVote = 0;
        this.el.result.classList.add('hidden');
        this.renderNowPlaying();
        this.renderQueue();
        if (AE.ensure()) {
          AE.stop();
          const delay = Math.max(0.05, (m.startAt - Date.now()) / 1000);
          AE.playMix(m.mix, AE.ctx.currentTime + delay);
          const totalMs = (m.startAt - Date.now()) + m.durationMs + 10000;
          AE.stopTimers.push(setTimeout(() => { this.perf.active = false; this.renderNowPlaying(); }, Math.max(0, totalMs)));
        }
        break;
      }
      case 'performance-end': {
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

window.SolarionMixer = Mixer;
