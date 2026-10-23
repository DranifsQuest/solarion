'use strict';

/**
 * Solarion — MIXER REWORK suite (X, 2026-10-21: "click in each
 * bubble where I want the sounds... fill them in 1 at a time").
 *
 * The old mixer held ONE placement per line, drawn stretched across
 * the loop's bars; clicking elsewhere MOVED it. The rework model:
 *   - a line holds MANY one-cell bubbles, placed cell by cell;
 *   - a bubble always renders/sounds as exactly ONE cell/pass, even
 *     for a 2- or 4-bar loop;
 *   - clicking a bubble removes just it;
 *   - playback: a bubble triggers its loop at its bar; if the line's
 *     next bubble arrives first, the new bubble takes the line over
 *     (the old pass is clipped at that bar);
 *   - v1 mixes/CDs ({loopId, startBar} tiling lines) keep playing
 *     EXACTLY as before — the engine expands the tiling into bubbles
 *     and lands on the identical event schedule.
 *
 * Server-free: the real public/mixer.js runs in a vm against a
 * recording fake AudioContext, and src/music.js validateMix is
 * exercised directly. The save -> burn -> perform round-trip over
 * the wire lives in test/music.test.js.
 *
 * Run:  TEST_RUN=<n> node --test test/mixer-cells.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const musicMod = require('../src/music.js');
const LOOPS = musicMod.LOOPS;
const BY_ID = new Map(LOOPS.map(l => [l.id, l]));
const loop = (id) => BY_ID.get(id);

// ------------------------------------------------------------ fake audio

const events = []; // { kind, start, stop } for every scheduled source
class FakeParam {
  constructor(v = 0) { this.value = v; }
  setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} setTargetAtTime() {} cancelScheduledValues() {}
}
class FakeNode {
  constructor(kind) {
    this._kind = kind;
    this.gain = new FakeParam(1); this.frequency = new FakeParam(440);
    this.detune = new FakeParam(0); this.Q = new FakeParam(1);
    this.type = ''; this.buffer = null; this._rec = null;
  }
  connect() {} disconnect() {}
  start(when) { this._rec = { kind: this._kind, start: when, stop: null }; events.push(this._rec); }
  stop(when) { if (this._rec) this._rec.stop = when; }
}
class FakeCtx {
  constructor() {
    this.state = 'running'; this.currentTime = 0; this.sampleRate = 44100;
    this.destination = {}; this._ls = {};
  }
  createGain() { return new FakeNode('gain'); }
  createDynamicsCompressor() {
    const n = new FakeNode('compressor');
    n.threshold = new FakeParam(-24); n.knee = new FakeParam(30); n.ratio = new FakeParam(12);
    n.attack = new FakeParam(0.003); n.release = new FakeParam(0.25);
    return n;
  }
  createOscillator() { return new FakeNode('osc'); }
  createBiquadFilter() { return new FakeNode('filter'); }
  createBufferSource() { return new FakeNode('src'); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  addEventListener(ev, fn) { (this._ls[ev] ||= []).push(fn); }
  removeEventListener(ev, fn) { this._ls[ev] = (this._ls[ev] || []).filter(f => f !== fn); }
  resume() { return Promise.resolve(); }
}

// ------------------------------------------------------------ vm load

function loadMixer() {
  const elCache = new Map();
  const fakeEl = (id) => {
    if (!elCache.has(id)) {
      elCache.set(id, {
        id, style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        querySelectorAll: () => [], querySelector: () => null,
        addEventListener() {}, appendChild() {},
      });
    }
    return elCache.get(id);
  };
  const sandbox = {
    console, Date, Math, JSON, Map, Set, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: { getElementById: (id) => fakeEl(id), createElement: () => fakeEl('anon'), addEventListener() {} },
    fetch: () => Promise.reject(new Error('no network in the vm')),
    AudioContext: FakeCtx,
    module: { exports: {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'mixer.js'), 'utf8'), sandbox);
  const { AE, Mixer } = sandbox.module.exports;
  assert.ok(AE && Mixer, 'mixer module exports AE + Mixer');
  const sent = [];
  const toasts = [];
  Mixer.hooks = {
    send: (m) => sent.push(m),
    toast: (t) => toasts.push(t),
    esc: (s) => String(s),
    getMe: () => ({ id: 42 }),
    getMapDef: () => null,
  };
  Mixer.buildDom();
  Mixer.loops = LOOPS;
  Mixer.loopsById = BY_ID;
  return { AE, Mixer, sent, toasts, fakeEl };
}

// Values built inside the vm carry that realm's prototypes, which
// deepStrictEqual rejects even when the data is identical — round
// them through JSON before comparing against main-realm literals.
const J = (x) => JSON.parse(JSON.stringify(x));

const T0 = 100; // fixed ctx-time origin for every schedule below
const sortedEvents = () => events
  .map(e => ({ kind: e.kind, start: Math.round(e.start * 1000) / 1000, stop: e.stop == null ? null : Math.round(e.stop * 1000) / 1000 }))
  .sort((a, b) => a.start - b.start || (a.stop || 0) - (b.stop || 0) || (a.kind < b.kind ? -1 : 1));

// ------------------------------------------------------------ validateMix

test('validateMix: v2 per-cell lines accepted and normalized', () => {
  const raw = {
    name: 'Cells', bpm: 120, bars: 8,
    tracks: [
      { cells: [{ loopId: 'pop-drums-1', bar: 4 }, { loopId: 'pop-drums-1', bar: 0 }, { loopId: 'pop-mel-1', bar: 2 }] },
      { cells: [{ loopId: 'pop-pad-1', bar: 1 }] },
    ],
  };
  const v = musicMod.validateMix(raw);
  assert.equal(v.ok, true, v.error || 'should validate');
  assert.deepEqual(v.data.tracks[0].cells.map(c => c.bar), [0, 2, 4], 'cells sorted by bar');
  assert.deepEqual(v.data.tracks[0].cells[1], { loopId: 'pop-mel-1', bar: 2 }, 'mixed loops on one line are fine');
  assert.deepEqual(v.data.tracks[1], { cells: [{ loopId: 'pop-pad-1', bar: 1 }] });
});

test('validateMix: v2 rejections — duplicate bar, range, unknown loop, line count, empty mix', () => {
  const base = { name: 'X', bpm: 120, bars: 4 };
  const dup = musicMod.validateMix({ ...base, tracks: [{ cells: [{ loopId: 'pop-drums-1', bar: 1 }, { loopId: 'pop-bass-1', bar: 1 }] }] });
  assert.equal(dup.ok, false); assert.match(dup.error, /share a bar/);
  const range = musicMod.validateMix({ ...base, tracks: [{ cells: [{ loopId: 'pop-drums-1', bar: 4 }] }] });
  assert.equal(range.ok, false); assert.match(range.error, /Cell bar is out of range/);
  const unknown = musicMod.validateMix({ ...base, tracks: [{ cells: [{ loopId: 'nope', bar: 0 }] }] });
  assert.equal(unknown.ok, false); assert.match(unknown.error, /Unknown loop/);
  const six = musicMod.validateMix({ ...base, tracks: Array.from({ length: 6 }, () => ({ cells: [{ loopId: 'pop-drums-1', bar: 0 }] })) });
  assert.equal(six.ok, false); assert.match(six.error, /1–5 tracks/);
  const empty = musicMod.validateMix({ ...base, tracks: [{ cells: [] }] });
  assert.equal(empty.ok, false); assert.match(empty.error, /at least one loop/);
  // an empty line alongside a real one is dropped, not stored
  const dropped = musicMod.validateMix({ ...base, tracks: [{ cells: [] }, { cells: [{ loopId: 'pop-drums-1', bar: 0 }] }] });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.data.tracks.length, 1);
});

test('validateMix: v1 legacy lines still accepted verbatim; formats may mix', () => {
  const v1 = { name: 'Old', bpm: 112, bars: 8, tracks: [{ loopId: 'pop-drums-1', startBar: 0 }, { loopId: 'pop-bass-1', startBar: 2 }] };
  const a = musicMod.validateMix(JSON.parse(JSON.stringify(v1)));
  assert.equal(a.ok, true);
  assert.deepEqual(a.data, v1);
  const mixed = musicMod.validateMix({ name: 'Mix', bpm: 112, bars: 8, tracks: [{ loopId: 'pop-drums-1', startBar: 0 }, { cells: [{ loopId: 'pop-bass-1', bar: 3 }] }] });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.data.tracks[1], { cells: [{ loopId: 'pop-bass-1', bar: 3 }] });
});

// ------------------------------------------------------------ trackCells

test('trackCells: v1 tiling expands to exactly the legacy pass positions', () => {
  const { Mixer } = loadMixer();
  assert.deepEqual(
    J(Mixer.trackCells({ loopId: 'pop-pad-1', startBar: 1 }, 8).map(c => c.bar)), [1, 5],
    '4-bar loop from bar 1 in an 8-bar mix tiles at 1 and 5');
  assert.deepEqual(
    J(Mixer.trackCells({ loopId: 'pop-drums-1', startBar: 0 }, 8).map(c => c.bar)), [0, 2, 4, 6],
    '2-bar loop tiles every 2 bars');
  assert.deepEqual(
    J(Mixer.trackCells({ loopId: 'pop-drums-1', startBar: 3 }, 4).map(c => c.bar)), [3],
    'a start near the end yields just its one pass');
  const v2 = { cells: [{ loopId: 'pop-mel-1', bar: 5 }, { loopId: 'pop-drums-1', bar: 1 }, { loopId: 'pop-mel-1', bar: 5 }] };
  assert.deepEqual(J(Mixer.trackCells(v2, 8)), [{ loopId: 'pop-drums-1', bar: 1 }, { loopId: 'pop-mel-1', bar: 5 }],
    'v2 cells pass through sorted, one per bar');
});

// ------------------------------------------------------------ playMix plan

test('playMix plan: many bubbles per line, one pass each, takeover clips chained', () => {
  const { AE, Mixer } = loadMixer();
  AE.ensure();
  const calls = [];
  AE.playLoop = (l, t, bpm, clipEnd) => calls.push({ id: l.id, t, clipEnd });
  // bpm 120 -> bar = 2s. Line 1: the same 2-bar loop at bars 0, 3, 4.
  // Line 2: a single bubble of the 4-bar pad at bar 2.
  const mix = {
    name: 'Plan', bpm: 120, bars: 8,
    tracks: [
      { cells: [{ loopId: 'pop-drums-1', bar: 0 }, { loopId: 'pop-drums-1', bar: 3 }, { loopId: 'pop-drums-1', bar: 4 }] },
      { cells: [{ loopId: 'pop-pad-1', bar: 2 }] },
    ],
  };
  const end = AE.playMix(mix, T0);
  assert.equal(end, T0 + 16, 'playMix returns t0 + bars*barDur');
  assert.deepEqual(calls, [
    { id: 'pop-drums-1', t: T0, clipEnd: T0 + 6 },
    { id: 'pop-drums-1', t: T0 + 6, clipEnd: T0 + 8 },
    { id: 'pop-drums-1', t: T0 + 8, clipEnd: Infinity },
    { id: 'pop-pad-1', t: T0 + 4, clipEnd: Infinity },
  ], 'each bubble = ONE pass at its bar; a pass is clipped only by the NEXT bubble on its own line');
  // The lone pad bubble is the sharpest contrast with the old model:
  // as a v1 line it would tile (bars 2 and 6); as a bubble it is one pass.
  const legacy = [];
  AE.playLoop = (l, t, bpm, clipEnd) => legacy.push({ id: l.id, t, clipEnd });
  AE.playMix({ name: 'L', bpm: 120, bars: 8, tracks: [{ loopId: 'pop-pad-1', startBar: 2 }] }, T0);
  assert.deepEqual(legacy.map(c => c.t), [T0 + 4, T0 + 12], 'the same content as a v1 line still tiles at bars 2 and 6');
});

// ------------------------------------------------------------ engine events

test('playMix events: overlap takeover — the old pass makes no new attacks and sustained washes end at the boundary', () => {
  const { AE } = loadMixer();
  AE.ensure();
  // Pad takeover: 4-bar pad at bar 0 AND bar 2 (bpm 120, bar = 2s,
  // boundary at T0+4). Unclipped, pass 1 would start chords at bars
  // 0,1,2,3. Clipped, its bar-2/3 chords never start, and nothing
  // from pass 1 starts after the boundary.
  events.length = 0;
  AE.playMix({ name: 'Pads', bpm: 120, bars: 8, tracks: [{ cells: [{ loopId: 'pop-pad-1', bar: 0 }, { loopId: 'pop-pad-1', bar: 2 }] }] }, T0);
  const padStarts = [...new Set(events.map(e => Math.round(e.start * 1000) / 1000))].sort((a, b) => a - b);
  assert.deepEqual(padStarts, [T0, T0 + 2, T0 + 4, T0 + 6, T0 + 8, T0 + 10],
    'chord starts: pass 1 bars 0-1 only, then pass 2 runs its full 4 bars from bar 2');
  assert.equal(events.length, 6 * 3, 'six chords x three notes each');
  for (const e of events) {
    if (e.start < T0 + 4) assert.ok(e.stop <= T0 + 4 + 0.06, `pass-1 source stops at the takeover (stop=${e.stop})`);
  }
  assert.ok(events.some(e => e.stop >= T0 + 11.9), 'the last bubble rings out its full length (no mix-end clip)');

  // Wash clipping: Vinyl Rain is one 2-bar noise wash per pass. At
  // bars 0 and 1 the first wash must END at the bar-1 boundary
  // instead of washing under the second bubble.
  events.length = 0;
  AE.playMix({ name: 'Rain', bpm: 120, bars: 4, tracks: [{ cells: [{ loopId: 'chill-fx-1', bar: 0 }, { loopId: 'chill-fx-1', bar: 1 }] }] }, T0);
  const rains = events.filter(e => e.kind === 'src').sort((a, b) => a.start - b.start);
  assert.equal(rains.length, 2, 'two rain passes');
  assert.equal(rains[0].start, T0);
  assert.ok(rains[0].stop <= T0 + 2 + 0.06, `first wash clipped at the next bubble (stop=${rains[0].stop}, unclipped would be ${T0 + 4.05})`);
  assert.equal(rains[1].start, T0 + 2);
  assert.ok(rains[1].stop >= T0 + 6, 'second wash runs its full 2 bars');
});

test('playMix events: a v1 mix and its migrated v2 form schedule IDENTICALLY', () => {
  const { AE } = loadMixer();
  AE.ensure();
  const v1 = {
    name: 'Same Song', bpm: 120, bars: 8,
    tracks: [{ loopId: 'pop-pad-1', startBar: 1 }, { loopId: 'pop-drums-1', startBar: 0 }, { loopId: 'pop-mel-1', startBar: 3 }],
  };
  events.length = 0;
  AE.playMix(v1, T0);
  const before = sortedEvents();
  assert.ok(before.length > 100, `a dense schedule to compare (${before.length} sources)`);
  // What the editor migration produces for the same mix (tiling
  // expanded by hand): pad at 1,5; drums at 0,2,4,6; melody at 3,5,7.
  const v2 = {
    name: 'Same Song', bpm: 120, bars: 8,
    tracks: [
      { cells: [{ loopId: 'pop-pad-1', bar: 1 }, { loopId: 'pop-pad-1', bar: 5 }] },
      { cells: [0, 2, 4, 6].map(bar => ({ loopId: 'pop-drums-1', bar })) },
      { cells: [3, 5, 7].map(bar => ({ loopId: 'pop-mel-1', bar })) },
    ],
  };
  events.length = 0;
  AE.playMix(v2, T0);
  assert.deepEqual(sortedEvents(), before, 'old format and migrated format are the same performance');
});

// ------------------------------------------------------------ the grid

test('grid: fill cells one at a time, bubbles are one cell, removal is surgical', () => {
  const { Mixer } = loadMixer();
  Mixer.myMixes = [];
  Mixer.selectSlot(1); // fresh draft: 8 bars, 5 empty rows
  const html = () => Mixer.el.grid.innerHTML;
  const bubbleCount = () => (html().match(/filled bubble/g) || []).length;

  Mixer.selLoopId = 'pop-pad-1'; // a FOUR-bar loop
  Mixer.gridClick(0, 2);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells), [{ loopId: 'pop-pad-1', bar: 2 }]);
  assert.equal(bubbleCount(), 1, 'one bubble on the grid');
  assert.ok(!html().includes('gcell span'), 'no span/stretch rendering — a bubble is one cell even for a 4-bar loop');

  Mixer.selLoopId = 'pop-drums-1';
  Mixer.gridClick(0, 0);
  Mixer.gridClick(0, 3);
  Mixer.gridClick(0, 4);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 2, 3, 4],
    'the line fills up one cell at a time, in click order, sorted for playback');
  assert.equal(bubbleCount(), 4);

  // Clicking a bubble removes JUST it — selection is irrelevant.
  Mixer.gridClick(0, 3);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 2, 4], 'only the bar-3 bubble went away');
  assert.equal(bubbleCount(), 3);

  // Nothing selected + empty cell: a hint, no change.
  Mixer.selLoopId = null;
  Mixer.gridClick(0, 6);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 2, 4]);

  // Another row fills independently; rows never compact mid-edit.
  Mixer.selLoopId = 'pop-bass-1';
  Mixer.gridClick(2, 5);
  assert.deepEqual(J(Mixer.draft.tracks[2].cells), [{ loopId: 'pop-bass-1', bar: 5 }]);
  assert.equal(Mixer.draft.tracks[1], null, 'the middle row stays empty (no compaction)');
  assert.equal(Mixer.draftCellCount(), 4);
  assert.deepEqual(J(Mixer.draftWireTracks()), [
    { cells: [{ loopId: 'pop-drums-1', bar: 0 }, { loopId: 'pop-pad-1', bar: 2 }, { loopId: 'pop-drums-1', bar: 4 }] },
    { cells: [{ loopId: 'pop-bass-1', bar: 5 }] },
  ], 'wire format drops empty lines and keeps the bubbles');

  // Shrinking the length drops out-of-range bubbles per line.
  Mixer.el.bars.value = '4';
  Mixer.el.bars.onchange();
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 2], 'bar-4 bubble dropped at 4 bars');
  assert.equal(Mixer.draft.tracks[2], null, 'a line emptied by the shrink returns to an empty row');

  // The hint says what the grid actually does now.
  assert.match(Mixer.el.editTitle.textContent, /click a cell to drop the loop there/);
  assert.match(Mixer.el.editTitle.textContent, /click a bubble to take it back/);
});

test('grid: opening a v1 mix migrates it to bubbles; saving round-trips through validateMix', () => {
  const { Mixer, sent } = loadMixer();
  const old = {
    name: 'Oldie', bpm: 112, bars: 8,
    tracks: [{ loopId: 'pop-pad-1', startBar: 0 }, { loopId: 'pop-drums-1', startBar: 2 }],
  };
  Mixer.myMixes = [{ id: 9, slot: 3, name: 'Oldie', data: JSON.parse(JSON.stringify(old)), updatedAt: 1 }];
  Mixer.selectSlot(3);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 4], 'pad tiling became bubbles at 0 and 4');
  assert.deepEqual(J(Mixer.draft.tracks[1].cells.map(c => c.bar)), [2, 4, 6], 'drums tiling became bubbles at 2, 4, 6');
  Mixer.el.name.value = 'Oldie';
  Mixer.saveDraft();
  const save = sent.find(m => m.type === 'mix-save');
  assert.ok(save, 'save sent');
  assert.equal(save.slot, 3);
  const v = musicMod.validateMix(save.data);
  assert.equal(v.ok, true, `migrated save validates (${v.error || ''})`);
  assert.deepEqual(v.data.tracks, [
    { cells: [{ loopId: 'pop-pad-1', bar: 0 }, { loopId: 'pop-pad-1', bar: 4 }] },
    { cells: [{ loopId: 'pop-drums-1', bar: 2 }, { loopId: 'pop-drums-1', bar: 4 }, { loopId: 'pop-drums-1', bar: 6 }] },
  ]);

  // And a v2 mix opens with its bubbles exactly where they were.
  const modern = {
    name: 'Modern', bpm: 120, bars: 8,
    tracks: [{ cells: [{ loopId: 'pop-mel-1', bar: 1 }, { loopId: 'pop-mel-1', bar: 3 }, { loopId: 'pop-drums-1', bar: 6 }] }],
  };
  Mixer.myMixes = [{ id: 10, slot: 4, name: 'Modern', data: JSON.parse(JSON.stringify(modern)), updatedAt: 2 }];
  Mixer.selectSlot(4);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells), modern.tracks[0].cells, 'v2 bubbles survive the open untouched');
});
