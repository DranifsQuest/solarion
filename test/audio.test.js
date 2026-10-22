'use strict';

/**
 * Item D + S audio harness (v1.2).
 *
 * Item D ("music is a little staticy") — measured diagnosis:
 *   1. AE.noise() (every hat/snare/perc hit) started at FULL gain
 *      instantly — a click transient per hit, several per second
 *      in dense loops. FIXED: 3ms attack ramps (here + SFX noise).
 *   2. AE.master ran straight to the destination with NO limiter,
 *      and the densest zone comp (Neon Casino) measures a
 *      worst-instant peak sum of 6.01 at the sources = ~0.99 of
 *      full scale at the output — any SFX on top clips. FIXED:
 *      DynamicsCompressor limiter in the master chain.
 *   3. The ambience beds overshot full scale INSIDE their buffers
 *      (1.17-1.33 measured) and started near-silent (IIR from
 *      rest). FIXED: warm-up passes + peak normalization.
 *   Ruled OUT by measurement: bed loop seams — through the beds'
 *   own filters, the old wrap step sat below the texture's own
 *   step distribution, so no seam fix is claimed for them. (The
 *   engine's white-noise buffer does get a wrap blend: sustained
 *   filtered sources like 'rain' loop it ~1x/sec.)
 * This suite loads the REAL public/mixer.js + sfx.js +
 * zonemusic.js into a vm with a mock AudioContext and pins the
 * fixes + the measured composition peak.
 *
 * Item S ("zone + table music overlap at poker tables"): the
 * outgoing composition's scheduled pass kept playing under the
 * new one on the shared bus (swap-stop), and the zone layer never
 * ducked for the poker context (foreground priority). Both pinned
 * here with deterministic gain/source assertions.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { LOOPS } = require('../src/music');

// ------------------------------------------------------------ mock Web Audio
class MockParam {
  constructor(v = 0) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.events.push({ k: 'set', v, t }); this.value = v; }
  linearRampToValueAtTime(v, t) { this.events.push({ k: 'lin', v, t }); this.value = v; }
  exponentialRampToValueAtTime(v, t) { this.events.push({ k: 'exp', v, t }); this.value = v; }
  setTargetAtTime(v, t, tc) { this.events.push({ k: 'tgt', v, t, tc }); this.value = v; }
  cancelScheduledValues() { this.events.push({ k: 'cancel' }); }
  /** Peak value this param ever reaches (its automation ceiling). */
  peak() { return Math.max(this.value, ...this.events.map(e => e.v || 0)); }
}
class MockNode {
  constructor(kind) { this.kind = kind; this.connectedTo = []; }
  connect(n) { this.connectedTo.push(n); return n; }
  disconnect() {}
}
class MockGain extends MockNode {
  constructor() { super('gain'); this.gain = new MockParam(1); }
}
class MockSource extends MockNode {
  constructor(kind) {
    super(kind);
    this.buffer = null; this.loop = false; this.type = 'sine';
    this.frequency = new MockParam(440); this.detune = new MockParam(0); this.Q = new MockParam(1);
    this.startedAt = null; this.stoppedAt = null; this.stopCalls = 0;
  }
  start(t = 0) { this.startedAt = t; }
  stop(t = 0) { this.stoppedAt = t; this.stopCalls++; }
}
class MockCtx {
  constructor() {
    this.sampleRate = 44100; this.currentTime = 100; this.state = 'running';
    this.destination = new MockNode('destination');
    this.nodes = []; this.sources = []; this.gains = [];
  }
  createGain() { const g = new MockGain(); this.gains.push(g); this.nodes.push(g); return g; }
  createDynamicsCompressor() {
    const n = new MockNode('compressor');
    n.threshold = new MockParam(-24); n.knee = new MockParam(30); n.ratio = new MockParam(12);
    n.attack = new MockParam(0.003); n.release = new MockParam(0.25);
    this.nodes.push(n); return n;
  }
  createBuffer(ch, len, rate) {
    const data = new Float32Array(len);
    return { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData: () => data, _data: data };
  }
  createBufferSource() { const s = new MockSource('buffer'); this.sources.push(s); this.nodes.push(s); return s; }
  createOscillator() { const s = new MockSource('osc'); this.sources.push(s); this.nodes.push(s); return s; }
  createBiquadFilter() { const n = new MockNode('filter'); n.frequency = new MockParam(350); n.Q = new MockParam(1); n.type = 'lowpass'; this.nodes.push(n); return n; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

// ------------------------------------------------------------ vm sandbox
function el() {
  return {
    textContent: '', innerHTML: '', value: '', disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => true },
    style: {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    appendChild() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}
function loadClientAudio() {
  const ctx = new MockCtx();
  const store = new Map();
  // Deterministic noise: the client fills its buffers from
  // Math.random, so seed it — bed/seam measurements must be the
  // same draw on every run, never a coin flip.
  let seed = 1234567;
  const seededMath = Object.create(Math);
  seededMath.random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const sandbox = {
    console, setInterval, clearInterval, setTimeout, clearTimeout, Math: seededMath, JSON,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: { getElementById: () => el(), createElement: () => el(), addEventListener() {}, body: el() },
    fetch: () => Promise.reject(new Error('no net in harness')),
    AudioContext: function () { return ctx; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  vm.runInContext(pub('mixer.js'), sandbox, { filename: 'mixer.js' });
  vm.runInContext(pub('sfx.js'), sandbox, { filename: 'sfx.js' });
  vm.runInContext(pub('zonemusic.js'), sandbox, { filename: 'zonemusic.js' });
  const api = vm.runInContext('({ AE, Sfx, ZoneMusic, Mixer, forMap, pickTracks, MUSIC_LEVEL })', sandbox);
  return { sandbox, ctx, ...api };
}

// ------------------------------------------------------------ Item D

test('audio D: master runs through a limiter before the destination', () => {
  const { AE, ctx } = loadClientAudio();
  assert.equal(AE.ensure(), true);
  assert.ok(AE.limiter, 'a limiter node exists');
  assert.equal(AE.limiter.kind, 'compressor');
  assert.ok(AE.master.connectedTo.includes(AE.limiter), 'master -> limiter');
  assert.ok(AE.limiter.connectedTo.includes(ctx.destination), 'limiter -> destination');
  assert.ok(!AE.master.connectedTo.includes(ctx.destination), 'master no longer feeds the destination directly');
  assert.ok(AE.limiter.ratio.value >= 12, `limiter ratio ${AE.limiter.ratio.value} is hard`);
  assert.ok(AE.limiter.threshold.value <= -6, `limiter threshold ${AE.limiter.threshold.value}dB leaves headroom`);
});

test('audio D: looped noise wraps seamlessly through the filters that use it', () => {
  const { AE } = loadClientAudio();
  AE.ensure();
  const d = AE.noiseBuf.getChannelData(0);
  let sum = 0; for (let i = 0; i < d.length; i += 97) sum += d[i] * d[i];
  const rms = Math.sqrt(sum / Math.ceil(d.length / 97));
  assert.ok(rms > 0.2, `noise buffer is real noise (rms ${rms.toFixed(2)})`);
  // Construction: the blend anchors the head to the tail it wraps
  // from (head sample 0 IS tail sample len-n before blending).
  const n = Math.floor(d.length * 0.06);
  assert.ok(Math.abs(d[0] - d[d.length - n]) < 1e-6, 'the head starts exactly where the tail left off');
  // What a listener actually gets: the buffer is always heard
  // through filters (rain = lowpass 900, hats = highpass). Run the
  // looped buffer through a 900Hz one-pole and compare the wrap
  // step against the signal's own step distribution — the seam
  // must be ordinary texture, not a periodic tick standing out.
  const alpha = 1 - Math.exp(-2 * Math.PI * 900 / 44100);
  let y = 0;
  const steps = [];
  for (let rep = 0; rep < 2; rep++) {
    for (let i = 0; i < d.length; i++) {
      const prev = y;
      y += alpha * (d[i] - y);
      if (rep === 1) steps.push(Math.abs(y - prev));
    }
  }
  const wrapStep = steps[0];
  const sorted = [...steps].sort((a, b) => a - b);
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  assert.ok(wrapStep <= p99 * 1.5, `filtered wrap step ${wrapStep.toFixed(4)} within the texture (p99 ${p99.toFixed(4)})`);
});

test('audio D: ambience beds are level-steady, in range, and seam-ordinary', () => {
  const { AE, Sfx } = loadClientAudio();
  AE.ensure();
  for (const kind of ['pink', 'brown']) {
    const buf = Sfx._bedBuffer(kind);
    const d = buf.getChannelData(0);
    let sum = 0, peak = 0;
    for (let i = 0; i < d.length; i++) { sum += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); }
    const rms = Math.sqrt(sum / d.length);
    assert.ok(rms > 0.05, `${kind} bed has body (rms ${rms.toFixed(3)})`);
    assert.ok(peak <= 0.95, `${kind} bed is normalized in range (peak ${peak.toFixed(2)}; raw IIR beds measured 1.17-1.33)`);
    // Steady from sample 0 (the warm-up passes): the first 100ms
    // carries the same energy as the last 100ms.
    const seg = (from) => {
      let s = 0; const n = Math.floor(d.length * 0.05);
      for (let i = from; i < from + n; i++) s += d[i] * d[i];
      return Math.sqrt(s / n);
    };
    const head = seg(0), tail = seg(d.length - Math.floor(d.length * 0.05));
    assert.ok(head > tail * 0.5, `${kind} bed starts at level (head rms ${head.toFixed(3)} vs tail ${tail.toFixed(3)})`);
    // The loop seam, heard through a 700Hz one-pole like its real
    // bandpass: the wrap step must be ordinary texture, not a
    // periodic tick standing out of it.
    const alpha = 1 - Math.exp(-2 * Math.PI * 700 / 44100);
    let y = 0; const steps = [];
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < d.length; i++) {
        const prev = y; y += alpha * (d[i] - y);
        if (rep === 1) steps.push(Math.abs(y - prev));
      }
    }
    const sorted = [...steps].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    assert.ok(steps[0] <= p99 * 1.5, `${kind} bed wrap is ordinary texture (${steps[0].toFixed(4)} vs p99 ${p99.toFixed(4)})`);
  }
});

test('audio D: noise hits attack over >=2ms, never an instant full-gain step', () => {
  const { AE, ctx } = loadClientAudio();
  AE.ensure();
  const gainsBefore = ctx.gains.length;
  AE.noise(100, 0.1, { gain: 0.2 });
  const g = ctx.gains[gainsBefore]; // the noise hit's gain node
  const evs = g.gain.events;
  assert.ok(evs.length >= 2, 'the hit has an envelope');
  assert.ok(!(evs[0].k === 'set' && evs[0].v === 0.2), 'first event is NOT an instant set to full gain');
  const ramp = evs.find(e => e.k === 'lin' && e.v === 0.2);
  assert.ok(ramp && ramp.t >= 100.002, 'gain reaches full over a >=2ms attack ramp');
});

test('audio D: measured peak of the densest zone composition (documented, limiter-guarded)', () => {
  const { AE, ctx, ZoneMusic, Mixer, forMap, pickTracks } = loadClientAudio();
  AE.ensure();
  Mixer.loops = LOOPS; Mixer.loopsById = new Map(LOOPS.map(l => [l.id, l]));
  // Neon Casino = the densest comp (Dance, drums+bass+pad, 112bpm).
  const spec = forMap('neon-casino');
  const tracks = pickTracks(spec, LOOPS, 'neon-casino');
  assert.ok(tracks.length >= 3, `comp layers ${tracks.length} loops`);
  AE.out = AE.ctx.createGain(); // stand-in for the zone bus
  for (const l of tracks) AE.playLoop(l, 100, spec.bpm);
  AE.out = null;
  // Worst-instant bound: sum the peak gains of everything sounding
  // in the first 250ms window (bar 0 opens with every layer live).
  let peakSum = 0;
  for (const s of ctx.sources) {
    if (s.startedAt === null || s.startedAt > 100.25) continue;
    // each source's chain: source -> (filter?) -> gain -> out; find
    // the gain node it feeds (directly or via one filter hop).
    const gains = new Set();
    const walk = (n, depth) => {
      if (!n || depth > 2) return;
      if (n.kind === 'gain') gains.add(n);
      for (const t of n.connectedTo || []) walk(t, depth + 1);
    };
    walk(s, 0);
    for (const g of gains) peakSum += g.gain.peak();
  }
  const atSpeakers = peakSum * 0.3 /* zone bus MUSIC_LEVEL */ * 0.55 /* master */;
  console.log(`    [audio] neon-casino comp: ${tracks.length} loops, worst-instant source-peak sum ${peakSum.toFixed(2)} -> ${(atSpeakers).toFixed(2)} at the master output pre-limiter`);
  assert.ok(peakSum > 0.5, 'the measurement is real (sources actually scheduled)');
  // The point of the limiter: whatever the sum, peaks above -8dB
  // are compressed 16:1, so the destination cannot hard-clip.
  assert.ok(AE.limiter && AE.limiter.threshold.value === -8 && AE.limiter.ratio.value === 16);
});

// ------------------------------------------------------------ Item S

test('audio S: one music source at a time — poker seats duck the zone track', () => {
  const { sandbox, ZoneMusic, MUSIC_LEVEL } = loadClientAudio();
  assert.equal(ZoneMusic.targetLevel(), MUSIC_LEVEL, 'plain zone: music plays');
  sandbox.SolarionCasino = { context: 'poker' };
  assert.equal(ZoneMusic.targetLevel(), 0, 'seated at poker: zone music ducks to silent');
  sandbox.SolarionCasino = { context: 'slots' };
  assert.equal(ZoneMusic.targetLevel(), MUSIC_LEVEL, 'slot stool has no layer of its own: zone stays');
  sandbox.SolarionCasino = { context: 'bar' };
  assert.equal(ZoneMusic.targetLevel(), MUSIC_LEVEL, 'bar has no layer of its own: zone stays');
  sandbox.SolarionCasino = { context: null };
  sandbox.SolarionStudio = { radioKey: 'radio|1' };
  assert.equal(ZoneMusic.targetLevel(), 0, 'a sounding home radio still ducks the zone');
  sandbox.SolarionStudio = { radioKey: null };
  sandbox.SolarionMixer.perf.active = true;
  sandbox.SolarionCasino = { context: 'poker' };
  assert.equal(ZoneMusic.targetLevel(), 0, 'a live performance outranks everything');
  sandbox.SolarionMixer.perf.active = false;
  sandbox.SolarionCasino = { context: null };
  assert.equal(ZoneMusic.targetLevel(), MUSIC_LEVEL, 'standing up restores the zone track');
});

test('audio S: a composition swap STOPS the outgoing comp’s scheduled sources', () => {
  const { AE, ctx, ZoneMusic, Mixer, forMap } = loadClientAudio();
  AE.ensure();
  Mixer.loops = LOOPS; Mixer.loopsById = new Map(LOOPS.map(l => [l.id, l]));
  ZoneMusic.mapId = 'the-gateway';
  ZoneMusic.spec = forMap('the-gateway');
  ZoneMusic._tracks = null;
  ZoneMusic._pump();
  const zoneSources = [...ZoneMusic._zoneSources];
  assert.ok(zoneSources.length > 0, `zone scheduler owns ${zoneSources.length} live sources`);
  ZoneMusic.setMap('neon-casino', true);
  assert.equal(ZoneMusic._zoneSources.length, 0, 'tracking resets on swap');
  assert.ok(zoneSources.every(s => s.stopCalls > 0), 'every outgoing source was stopped — no tail plays under the new comp');
});
