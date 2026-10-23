'use strict';

/**
 * Mixer static fix (v1.3) — RENDERED regression proof.
 *
 * X (2026-10-21): "Make sure the sounds from the mixer at any
 * BPM don't cause staticy glitchy sounds... u can hear it at high
 * bpm with most drum lines."
 *
 * Measured BEFORE (test/render-audio.js, real engine, offline
 * sample-accurate render of the worst saveable case — five drum
 * lines with bubbles at EVERY bar):
 *   160 BPM: destination peak 1.110, 105 samples over ±1.0
 *   112 BPM: destination peak 1.824, 342 samples over ±1.0
 * Root causes: (1) coincident drum voices sum COHERENTLY (the
 * kick is one identical oscillator, every noise hit reads the
 * shared buffer from offset 0 through the same filter) to
 * +8..+14 dBFS raw; (2) the v1.2 limiter (-8dB, 16:1, 4ms
 * attack) could not catch transient fronts and pumped up to
 * 11.4dB; (3) unchoked tails (240ms kicks, open hats) fattened
 * the sum between hits.
 *
 * The fix (public/mixer.js): staging bus master -> trim 0.8 ->
 * highpass 32Hz -> fast ceiling limiter (-4dB, 20:1, 0.8ms);
 * per-loop drum trims normalizing every kit's solo peak to
 * ~0.56; drum-machine CHOKE (a retrigger fades the previous
 * voice of that instrument in ~4ms instead of stacking tails).
 *
 * These tests render the REAL engine offline and pin the AFTER
 * numbers, so the static cannot come back silently. They also
 * pin that a normal mix is NOT processed or dulled (the ceiling
 * never engages; band balance unchanged), that the trim table
 * cannot go stale, and that the zone-music path through the same
 * bus stays clean.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadEngine, renderGraph, analyze, worstMix, typicalMix } = require('./render-audio');
const { LOOPS } = require('../src/music');

const DRUM_LOOPS = LOOPS.filter(l => l.drums);

// ------------------------------------------------------------ worst case

for (const bpm of [160, 112]) {
  test(`glitch: worst drum stack @${bpm}bpm stays under the ceiling, zero clipping`, () => {
    const { ctx, AE } = loadEngine();
    AE.playMix(worstMix(bpm), 0.05);
    const { dest, taps } = renderGraph(ctx, 7);
    const a = analyze(dest);
    assert.equal(a.overSamples, 0, `no sample may pass ±1.0 (the DAC clip that reads as static); got ${a.overSamples}`);
    assert.ok(a.peak <= 0.95, `destination peak ${a.peak.toFixed(3)} stays under the ceiling (BEFORE: ${bpm === 160 ? '1.110' : '1.824'})`);
    assert.ok(taps.get('grPeak') <= 6, `limiter gain reduction ${taps.get('grPeak').toFixed(1)}dB peak — catching peaks, not pumping (BEFORE: up to 11.4dB)`);
    assert.ok(a.maxDelta <= 0.45, `max sample step ${a.maxDelta.toFixed(3)} — no new discontinuities introduced`);
  });
}

// ------------------------------------------------------------ normal playback untouched

test('glitch: a typical mix is never touched by the ceiling and keeps its balance', () => {
  const { ctx, AE } = loadEngine();
  AE.playMix(typicalMix(112), 0.05);
  const { dest, taps } = renderGraph(ctx, 7);
  const a = analyze(dest);
  assert.equal(a.overSamples, 0);
  assert.ok(taps.get('grPeak') <= 0.05, `limiter must not engage on a normal mix (GR ${taps.get('grPeak').toFixed(2)}dB)`);
  assert.ok(a.peak >= 0.25 && a.peak <= 0.40, `typical peak ${a.peak.toFixed(3)} in the expected band (measured 0.309)`);
  // Band BALANCE (ratios, level-independent): the fix must not
  // dull the top or thin the bottom. BEFORE ratios: LF/rms 0.76,
  // HF-diff/rms 0.23.
  const lfRatio = a.lfRms / a.rms;
  const hfRatio = a.hfDiffRms / a.rms;
  assert.ok(lfRatio >= 0.6 && lfRatio <= 0.9, `LF balance ratio ${lfRatio.toFixed(2)} (BEFORE 0.76)`);
  assert.ok(hfRatio >= 0.15 && hfRatio <= 0.32, `HF balance ratio ${hfRatio.toFixed(2)} (BEFORE 0.23) — top end not dulled`);
});

// ------------------------------------------------------------ trim table cannot go stale

test('glitch: every drum loop is trim-covered and solos land in the normalized band', () => {
  const { AE } = loadEngine();
  for (const loop of DRUM_LOOPS) {
    assert.ok(AE.DRUM_TRIM[loop.id] !== undefined, `DRUM_TRIM covers ${loop.id}`);
    assert.ok(AE.DRUM_TRIM[loop.id] <= 1, `${loop.id} trim only attenuates`);
  }
  for (const loop of DRUM_LOOPS) {
    const { ctx, AE: ae2 } = loadEngine();
    const solo = { bpm: 140, bars: 2, tracks: [{ cells: [{ loopId: loop.id, bar: 0 }] }] };
    ae2.playMix(solo, 0.05);
    const { taps } = renderGraph(ctx, 4);
    const peak = analyze(taps.get(ae2.master)).peak;
    assert.ok(peak >= 0.48 && peak <= 0.66,
      `${loop.id} solo peak ${peak.toFixed(3)} in the normalized band [0.48, 0.66] — if a kit's samples changed, re-measure (node test/render-audio.js) and update DRUM_TRIM`);
  }
});

// ------------------------------------------------------------ zone music through the same bus

test('glitch: densest zone composition renders clean through the new bus', () => {
  const { ctx, AE, ZoneMusic: ZM, forMap } = loadEngine();
  const spec = forMap('neon-casino');
  ZM.mapId = 'neon-casino';
  ZM.spec = spec;
  ZM._tracks = null;
  ZM._pump();
  const { dest } = renderGraph(ctx, 10);
  const a = analyze(dest);
  assert.ok(a.rms > 0.005, `zone comp actually rendered (rms ${a.rms.toFixed(3)})`);
  assert.equal(a.overSamples, 0, 'zone music never clips at the destination');
  assert.ok(a.peak <= 0.95, `zone comp peak ${a.peak.toFixed(3)}`);
});

// ------------------------------------------------------------ choke behavior (mock ctx)
//
// The choke is what stops tails stacking. Pin its exact behavior
// with an event-recording mock: a retrigger fades the PREVIOUS
// voice (~4ms setTarget + stop at +30ms); a voice born at the
// same instant (the other half of a snare, a coincident hit from
// another line) is NEVER choked — it is part of the same hit.

class MP {
  constructor(v = 0) { this._v = v; this.events = []; }
  get value() { return this._v; } set value(v) { this._v = v; }
  setValueAtTime(v, t) { this.events.push({ k: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { this.events.push({ k: 'lin', v, t }); }
  exponentialRampToValueAtTime(v, t) { this.events.push({ k: 'exp', v, t }); }
  setTargetAtTime(v, t, tc) { this.events.push({ k: 'target', v, t, tc }); }
  cancelScheduledValues(t) { this.events.push({ k: 'cancel', t }); }
}
class MN {
  constructor(kind) { this.kind = kind; this.connectedTo = []; this._inputs = []; }
  connect(to) { this.connectedTo.push(to); if (to) to._inputs.push(this); return to; }
  disconnect() { this.connectedTo = []; }
}
class MSrc extends MN {
  constructor(kind) { super(kind); this.startedAt = null; this.stoppedAt = null; }
  start(t) { this.startedAt = t; }
  stop(t) { this.stoppedAt = t; }
}
class MCtx {
  constructor() {
    this.currentTime = 0; this.state = 'running'; this.sampleRate = 44100;
    this.destination = new MN('destination'); this.sources = [];
  }
  createGain() { const g = new MN('gain'); g.gain = new MP(1); return g; }
  createOscillator() { const o = new MSrc('osc'); o.type = 'sine'; o.frequency = new MP(440); this.sources.push(o); return o; }
  createBufferSource() { const s = new MSrc('buffer'); s.buffer = null; s.loop = false; this.sources.push(s); return s; }
  createBiquadFilter() { const f = new MN('filter'); f.type = 'lowpass'; f.frequency = new MP(350); f.Q = new MP(1); return f; }
  createDynamicsCompressor() {
    const c = new MN('compressor');
    c.threshold = new MP(-24); c.knee = new MP(30); c.ratio = new MP(12); c.attack = new MP(0.003); c.release = new MP(0.25);
    return c;
  }
  createBuffer(ch, len) { const d = new Float32Array(len); return { getChannelData: () => d }; }
  resume() { return Promise.resolve(); }
}

function loadMockEngine() {
  const ctx = new MCtx();
  const sandbox = {
    console, Math, JSON, setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { now: () => 0 },
    AudioContext: class extends MCtx {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // Point the engine at OUR ctx: AE.ensure constructs `new AC()`
  // (a fresh MCtx) — instead pre-seed AE's fields by running the
  // script and then swapping the constructed context's plumbing:
  // simplest is to make the AC constructor return our ctx.
  sandbox.AudioContext = function () { return ctx; };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'mixer.js'), 'utf8'), sandbox, { filename: 'mixer.js' });
  const AE = vm.runInContext('AE', sandbox);
  AE.ensure();
  return { AE, ctx };
}

function gainEventsOf(ctx, src) {
  // src -> (filter?) -> gain : collect event lists of gains the
  // source feeds within one hop.
  const out = [];
  const walk = (n, depth) => {
    if (!n || depth > 2) return;
    if (n.kind === 'gain') out.push(n.gain.events);
    for (const t of n.connectedTo || []) walk(t, depth + 1);
  };
  walk(src, 0);
  return out;
}

test('glitch: a retriggered kick fades the previous kick instead of stacking its tail', () => {
  const { AE, ctx } = loadMockEngine();
  AE.kick(1.0);
  const first = ctx.sources[ctx.sources.length - 1];
  const firstStopBefore = first.stoppedAt;
  AE.kick(1.12); // 120ms later — the first kick's 240ms tail is still ringing
  const evs = gainEventsOf(ctx, first).flat();
  assert.ok(evs.some(e => e.k === 'cancel'), 'previous voice gain is cancelled for the fade');
  const fade = evs.find(e => e.k === 'target');
  assert.ok(fade && Math.abs(fade.t - 1.12) < 1e-9 && fade.tc <= 0.002, 'fade is a fast setTarget at the retrigger instant');
  assert.ok(Math.abs(first.stoppedAt - 1.15) < 1e-9, `previous voice stopped at retrigger+30ms (was ${firstStopBefore})`);
});

test('glitch: a snare never chokes ITSELF (noise + body are one hit)', () => {
  const { AE, ctx } = loadMockEngine();
  AE.snare(2.0);
  for (const s of ctx.sources) {
    const evs = gainEventsOf(ctx, s).flat();
    assert.ok(!evs.some(e => e.k === 'cancel'), 'no voice of the same hit is faded');
  }
});

test('glitch: coincident hits at the same instant do not choke each other', () => {
  const { AE, ctx } = loadMockEngine();
  AE.kick(3.0);
  const first = ctx.sources[ctx.sources.length - 1];
  AE.kick(3.0); // another line's kick on the very same step
  const evs = gainEventsOf(ctx, first).flat();
  assert.ok(!evs.some(e => e.k === 'cancel'), 'same-instant voices are one musical hit, not a retrigger');
});
