'use strict';

/**
 * Solarion — MIXER SPAN suite (X, 2026-10-27: a sound that takes more
 * than one bar renders as one solid block covering those bars, and
 * blocks can never overlap on the same line — reverses the 2026-10-21
 * one-cell-bubble rule).
 *
 * The current model:
 *   - a placement is ONE solid block covering its loop's bars on the
 *     line (a 1-bar loop still renders as a single bubble);
 *   - placing over bars a block already covers is refused;
 *   - clicking any cell of a block removes the whole block;
 *   - the bar-number header shares the rows' column template, so the
 *     numbers align with the columns exactly;
 *   - playback: a placement triggers its loop at its bar; if the
 *     line's next placement arrives first, the new placement takes
 *     the line over (the old pass is clipped at that bar);
 *   - v1 mixes/CDs ({loopId, startBar} tiling lines) keep playing
 *     EXACTLY as before — the engine expands the tiling into
 *     placements and lands on the identical event schedule.
 * Stored data is unchanged: one {loopId, bar} per placement.
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

test('validateMix: 160-bar mixes (X, 2026-10-23 — longer beats)', () => {
  // the new ceiling validates, one past it does not
  const atCap = musicMod.validateMix({ name: 'Long', bpm: 70, bars: 160, tracks: [{ cells: [{ loopId: 'pop-drums-1', bar: 159 }] }] });
  assert.equal(atCap.ok, true, atCap.error || '160 bars should validate');
  assert.equal(musicMod.mixDurationMs(atCap.data), 548571, '160 bars @70bpm = 548571ms (~9.1 min)');
  const over = musicMod.validateMix({ name: 'Long', bpm: 70, bars: 161, tracks: [{ cells: [{ loopId: 'pop-drums-1', bar: 0 }] }] });
  assert.equal(over.ok, false); assert.match(over.error, /1–160 bars/);
  const cellOut = musicMod.validateMix({ name: 'Long', bpm: 70, bars: 160, tracks: [{ cells: [{ loopId: 'pop-drums-1', bar: 160 }] }] });
  assert.equal(cellOut.ok, false); assert.match(cellOut.error, /Cell bar is out of range/);
  // a FULLY DENSE 160-bar mix (5 lines × 160 cells) still fits the byte cap
  const dense = {
    name: 'Dense', bpm: 120, bars: 160,
    tracks: Array.from({ length: 5 }, () => ({
      cells: Array.from({ length: 160 }, (_, bar) => ({ loopId: 'pop-drums-1', bar })),
    })),
  };
  const dv = musicMod.validateMix(dense);
  assert.equal(dv.ok, true, dv.error || 'dense 160-bar mix should validate');
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

test('playMix plan: the performance cap clips the whole room at one instant', () => {
  const { AE, Mixer } = loadMixer();
  AE.ensure();
  const calls = [];
  AE.playLoop = (l, t, bpm, clipEnd) => calls.push({ id: l.id, t, clipEnd });
  // Same plan as the uncapped test (bpm 120 -> bar = 2s), but the
  // set is capped at 5s: the bar-0 pass is clipped at the cap (not
  // by the next bubble at T0+6), the pad at bar 2 (T0+4) is clipped
  // at the cap, and the bubbles at bars 3/4 (T0+6/T0+8) never sound.
  const mix = {
    name: 'Plan', bpm: 120, bars: 8,
    tracks: [
      { cells: [{ loopId: 'pop-drums-1', bar: 0 }, { loopId: 'pop-drums-1', bar: 3 }, { loopId: 'pop-drums-1', bar: 4 }] },
      { cells: [{ loopId: 'pop-pad-1', bar: 2 }] },
    ],
  };
  const end = AE.playMix(mix, T0, 5);
  assert.equal(end, T0 + 5, 'a capped playMix returns the cap end');
  assert.deepEqual(calls, [
    { id: 'pop-drums-1', t: T0, clipEnd: T0 + 5 },
    { id: 'pop-pad-1', t: T0 + 4, clipEnd: T0 + 5 },
  ], 'bubbles at/past the cap are never scheduled; the last passes clip at the cap');
  // No cap (audition/radio): the full mix is scheduled, as before.
  const full = [];
  AE.playLoop = (l, t, bpm, clipEnd) => full.push({ id: l.id, t, clipEnd });
  assert.equal(AE.playMix(mix, T0), T0 + 16, 'uncapped playMix still returns the full mix end');
  assert.equal(full.length, 4, 'uncapped playMix schedules every bubble');
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

test('grid: bar numbers align with columns; placements are solid spans that never overlap on a line', () => {
  const { Mixer, toasts } = loadMixer();
  Mixer.myMixes = [];
  Mixer.selectSlot(1); // fresh draft: 8 bars, 5 empty rows
  const html = () => Mixer.el.grid.innerHTML;
  const blockCount = () => (html().match(/filled block/g) || []).length;
  const bubbleCount = () => (html().match(/filled bubble/g) || []).length;

  // Header and rows share one column template, so numbers align.
  const cols = 'grid-template-columns:repeat(8,minmax(26px,1fr)) 110px';
  assert.ok(html().includes(`<div class="gridHead" style="${cols}">`), 'header uses the row column template');
  assert.ok(html().includes(`<div class="gridRow" data-row="0" style="${cols}">`), 'rows use the same template');
  assert.equal((html().match(/class="gcell head"/g) || []).length, 8, 'eight bar numbers');
  assert.ok(html().includes('<div class="gcell head">8</div><div></div>'), 'header carries the label-column spacer');

  // A 4-bar loop lands as ONE solid block covering its bars.
  Mixer.selLoopId = 'pop-pad-1'; // a FOUR-bar loop
  Mixer.gridClick(0, 2);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells), [{ loopId: 'pop-pad-1', bar: 2 }]);
  assert.equal(blockCount(), 1, 'one solid block on the grid');
  assert.equal(bubbleCount(), 0, 'no single-cell bubble for a 4-bar loop');
  assert.ok(html().includes('grid-column:span 4'), 'the block spans four columns');
  assert.equal((html().match(/>Warm Chords<\/div>/g) || []).length, 1, 'the loop name appears once for the whole block (the row label is a button, not a cell)');

  // Overlap on the same line is refused; adjacency is fine. (A click
  // on a covered cell removes the block instead — that path is
  // tested below — so a refusal clicks an EMPTY cell whose span
  // would overlap a block.)
  Mixer.selLoopId = 'pop-drums-1'; // a TWO-bar loop
  const before = toasts.length;
  Mixer.gridClick(0, 1);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [2], 'drums spanning into the pad block refused');
  assert.ok(toasts.length > before, 'a refusal explains itself');
  Mixer.gridClick(0, 0);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 2], 'drums exactly before the block allowed');
  Mixer.gridClick(0, 6);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 2, 6], 'drums exactly after the block allowed');

  // Clicking any cell of a block removes the WHOLE block.
  Mixer.gridClick(0, 4);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 6], 'clicking inside the pad block removed all of it');
  Mixer.gridClick(0, 3);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 3, 6], 'a 2-bar block lands in the freed space');
  Mixer.gridClick(0, 4);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 6], 'clicking inside the 2-bar block removed all of it');

  // A 2-bar loop at the grid end clips its visual span to the bars left.
  // (Tested on the empty middle row so the main line stays intact.)
  Mixer.selLoopId = 'pop-drums-1';
  Mixer.gridClick(1, 7);
  assert.deepEqual(J(Mixer.draft.tracks[1].cells), [{ loopId: 'pop-drums-1', bar: 7 }], 'clipped placement still lands');
  assert.deepEqual(J(Mixer.cellSpan({ loopId: 'pop-drums-1', bar: 7 }, 8)), [7, 8], 'span clips at the grid end');
  Mixer.gridClick(1, 7);
  assert.equal(Mixer.draft.tracks[1], null, 'clicking the clipped block removes it');

  // Nothing selected + empty cell: a hint, no change.
  Mixer.selLoopId = null;
  Mixer.gridClick(0, 3);
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0, 6]);

  // Another row fills independently; rows never compact mid-edit.
  Mixer.selLoopId = 'pop-bass-1';
  Mixer.gridClick(2, 5);
  assert.deepEqual(J(Mixer.draft.tracks[2].cells), [{ loopId: 'pop-bass-1', bar: 5 }]);
  assert.equal(Mixer.draft.tracks[1], null, 'the middle row stays empty (no compaction)');
  assert.equal(Mixer.draftCellCount(), 3);
  assert.deepEqual(J(Mixer.draftWireTracks()), [
    { cells: [{ loopId: 'pop-drums-1', bar: 0 }, { loopId: 'pop-drums-1', bar: 6 }] },
    { cells: [{ loopId: 'pop-bass-1', bar: 5 }] },
  ], 'wire format drops empty lines and keeps the placements');

  // Shrinking the length drops out-of-range placements per line.
  Mixer.el.bars.value = '4';
  Mixer.el.bars.onchange();
  assert.deepEqual(J(Mixer.draft.tracks[0].cells.map(c => c.bar)), [0], 'bar-6 placement dropped at 4 bars');
  assert.equal(Mixer.draft.tracks[2], null, 'a line emptied by the shrink returns to an empty row');

  // The hint says what the grid actually does now.
  assert.match(Mixer.el.editTitle.textContent, /click a cell to place the loop there/);
  assert.match(Mixer.el.editTitle.textContent, /click a block to take it back/);
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
