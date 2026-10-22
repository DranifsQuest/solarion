'use strict';

/**
 * Offline SAMPLE renderer for the client audio engine (AE in
 * public/mixer.js) — the measurement instrument for the mixer
 * static/glitch fix (Zan, 2026-10-21: "at high bpm with most drum
 * lines" the mixer turns staticy).
 *
 * The other suites use recording fakes: they prove WHAT is
 * scheduled, never what it SOUNDS like summed at the destination.
 * This harness runs the REAL public/mixer.js in a vm against a
 * sample-accurate fake AudioContext (oscillators with phase +
 * frequency automation, the engine's own seeded noise buffer
 * through RBJ biquads, full AudioParam automation, and a
 * spec-shaped DynamicsCompressor model), then sums the graph the
 * way a browser would and hands back the destination samples plus
 * taps at the master input and the limiter input.
 *
 * The compressor is a MODEL (feedforward, soft knee, attack /
 * release smoothing of the gain reduction in the dB domain, per
 * the Web Audio spec's shape) — identical before and after a fix,
 * which is what makes the comparison evidence rather than vibes.
 * What reaches a listener's DAC clips at ±1.0, so post-chain
 * samples beyond ±1.0 ARE the audible clipping, whatever the
 * model's fine detail.
 *
 * Used by test/audio-glitch.test.js (pinned thresholds) and
 * runnable directly for the measurement table:
 *   node test/render-audio.js
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SR = 44100;

// ------------------------------------------------------------ params

class RParam {
  constructor(v = 0) { this._intrinsic = v; this.events = []; }
  // The engine sets most params by direct .value assignment
  // (master.gain.value = 0.55, limiter.threshold.value = -8, ...);
  // that IS the intrinsic value automation starts from.
  get value() { return this._intrinsic; }
  set value(v) { this._intrinsic = v; }
  setValueAtTime(v, t) { this.events.push({ k: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { this.events.push({ k: 'lin', v, t }); }
  exponentialRampToValueAtTime(v, t) { this.events.push({ k: 'exp', v, t }); }
  setTargetAtTime(v, t, tc) { this.events.push({ k: 'tgt', v, t, tc }); }
  cancelScheduledValues(t) {
    const frozen = this.valueAt(t);
    this.events = this.events.filter(e => e.t <= t);
    this.events.push({ k: 'set', v: frozen, t });
  }
  cancelAndHoldAtTime(t) { this.cancelScheduledValues(t); }
  _sorted() {
    return this.events
      .map((e, i) => [e, i])
      .sort((a, b) => (a[0].t - b[0].t) || (a[1] - b[1]))
      .map(([e]) => e);
  }
  valueAt(t) {
    let pT = -Infinity, pV = this._intrinsic, tgt = null;
    const tgtVal = (g, tt) => g.target + (g.v0 - g.target) * Math.exp(-(tt - g.t0) / g.tc);
    for (const e of this._sorted()) {
      if (t < e.t) {
        if (e.k === 'lin') {
          if (!isFinite(pT)) return pV;
          const w = (t - pT) / (e.t - pT);
          return pV + (e.v - pV) * Math.min(1, Math.max(0, w));
        }
        if (e.k === 'exp') {
          if (!isFinite(pT)) return pV;
          const w = (t - pT) / (e.t - pT);
          const a = Math.max(1e-4, pV), b = Math.max(1e-4, e.v);
          return a * Math.pow(b / a, Math.min(1, Math.max(0, w)));
        }
        return tgt ? tgtVal(tgt, t) : pV;
      }
      const vPrev = tgt ? tgtVal(tgt, e.t) : pV;
      if (e.k === 'tgt') { tgt = { t0: e.t, v0: vPrev, target: e.v, tc: Math.max(1e-4, e.tc) }; pT = e.t; pV = vPrev; }
      else { pV = e.v; pT = e.t; tgt = null; }
    }
    return tgt ? tgtVal(tgt, t) : pV;
  }
}

// ------------------------------------------------------------ nodes

let NODE_SEQ = 0;
class RNode {
  constructor(kind) {
    this.kind = kind; this._id = NODE_SEQ++;
    this.connectedTo = []; this._inputs = [];
  }
  connect(dest) { this.connectedTo.push(dest); dest._inputs.push(this); return dest; }
  disconnect() { this.connectedTo = []; }
}

class RGain extends RNode {
  constructor() { super('gain'); this.gain = new RParam(1); }
}

class ROsc extends RNode {
  constructor() {
    super('osc');
    this.type = 'sine';
    this.frequency = new RParam(440);
    this.detune = new RParam(0);
    this.startedAt = null; this.stoppedAt = null;
  }
  start(t = 0) { this.startedAt = t; }
  stop(t = 0) { this.stoppedAt = t; }
}

class RBufSrc extends RNode {
  constructor() {
    super('src');
    this.buffer = null; this.loop = false;
    this.startedAt = null; this.stoppedAt = null;
  }
  start(t = 0) { this.startedAt = t; }
  stop(t = 0) { this.stoppedAt = t; }
}

class RBiquad extends RNode {
  constructor() {
    super('filter');
    this.type = 'lowpass';
    this.frequency = new RParam(350);
    this.Q = new RParam(1);
    this.gain = new RParam(0);
  }
}

class RCompressor extends RNode {
  constructor() {
    super('compressor');
    this.threshold = new RParam(-24); this.knee = new RParam(30);
    this.ratio = new RParam(12); this.attack = new RParam(0.003);
    this.release = new RParam(0.25);
    this.reduction = 0;
  }
}

class RBuffer {
  constructor(ch, len, rate) {
    this.numberOfChannels = ch; this.length = len; this.sampleRate = rate;
    this._data = new Float32Array(len);
  }
  getChannelData() { return this._data; }
}

class RenderCtx {
  constructor() {
    this.sampleRate = SR;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new RNode('destination');
    this._nodes = []; this._sources = [];
  }
  createGain() { const n = new RGain(); this._nodes.push(n); return n; }
  createDynamicsCompressor() { const n = new RCompressor(); this._nodes.push(n); return n; }
  createBiquadFilter() { const n = new RBiquad(); this._nodes.push(n); return n; }
  createOscillator() { const n = new ROsc(); this._nodes.push(n); this._sources.push(n); return n; }
  createBufferSource() { const n = new RBufSrc(); this._nodes.push(n); this._sources.push(n); return n; }
  createBuffer(ch, len, rate) { return new RBuffer(ch, len, rate); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  addEventListener() {}
  removeEventListener() {}
}

// ------------------------------------------------------------ vm load

function el() {
  return {
    textContent: '', innerHTML: '', value: '', disabled: false, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => true },
    style: {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    appendChild() {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
}

/** Load the real client audio files against a RenderCtx. */
function loadEngine() {
  const ctx = new RenderCtx();
  const store = new Map();
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
    fetch: () => Promise.reject(new Error('no net in renderer')),
    AudioContext: function () { return ctx; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  vm.runInContext(pub('mixer.js'), sandbox, { filename: 'mixer.js' });
  vm.runInContext(pub('zonemusic.js'), sandbox, { filename: 'zonemusic.js' });
  const api = vm.runInContext('({ AE, Mixer, ZoneMusic, forMap, pickTracks, MUSIC_LEVEL })', sandbox);
  const { LOOPS } = require('../src/music');
  api.Mixer.loops = LOOPS;
  api.Mixer.loopsById = new Map(LOOPS.map(l => [l.id, l]));
  api.AE.ensure();
  return { ctx, ...api, LOOPS };
}

// ------------------------------------------------------------ graph render

function waveSample(type, phase) {
  const s = Math.sin(phase);
  switch (type) {
    case 'square': return s >= 0 ? 1 : -1;
    case 'sawtooth': { const x = phase / (2 * Math.PI); return 2 * (x - Math.floor(x + 0.5)); }
    case 'triangle': return (2 / Math.PI) * Math.asin(Math.max(-1, Math.min(1, s)));
    default: return s;
  }
}

function biquadCoeffs(type, freq, q, gainDb, sr) {
  const f = Math.min(Math.max(freq, 10), sr / 2.05);
  const w = 2 * Math.PI * f / sr;
  const cos = Math.cos(w), sin = Math.sin(w);
  const alpha = sin / (2 * Math.max(0.0001, q));
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'highpass': b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'bandpass':
      // RBJ "constant 0 dB peak gain" bandpass (what Web Audio uses)
      b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
    case 'highshelf': {
      const t = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cos + t); b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - t); a0 = (A + 1) - (A - 1) * cos + t;
      a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - t; break;
    }
    case 'lowshelf': {
      const t = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + t); b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - t); a0 = (A + 1) + (A - 1) * cos + t;
      a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - t; break;
    }
    default: // lowpass
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/**
 * Render everything scheduled on the ctx into sample buffers.
 * Returns { dest, taps } where taps maps node -> the buffer AT
 * THAT NODE'S INPUT (post-summation, pre-processing): taps for
 * AE.master (raw source sum) and AE.limiter (what the limiter is
 * asked to swallow) drive the diagnosis.
 */
function renderGraph(ctx, seconds) {
  const N = Math.floor(seconds * SR);
  const dest = new Float32Array(N);
  const taps = new Map();

  const isShared = (node) => node === ctx.destination || node.kind === 'compressor' || node._inputs.length >= 2;

  // Per-source private chains -> accumulate into the first shared node.
  const accum = new Map(); // shared node -> Float32Array (its input)
  const accumFor = (node) => {
    if (!accum.has(node)) accum.set(node, new Float32Array(N));
    return accum.get(node);
  };

  for (const src of ctx._sources) {
    if (src.startedAt === null || src.startedAt === undefined) continue;
    const startS = Math.max(0, Math.floor(src.startedAt * SR));
    const stopS = Math.min(N, Math.ceil((src.stoppedAt !== null && src.stoppedAt !== undefined ? src.stoppedAt : seconds) * SR));
    if (startS >= N) continue;
    // Walk the chain: private nodes until the first shared node.
    const chain = [];
    let node = src;
    let entry = null;
    while (node && node !== ctx.destination) {
      const next = node.connectedTo[0];
      if (!next) break;
      if (isShared(next)) { entry = next; break; }
      chain.push(next);
      node = next;
    }
    if (!entry) continue; // chain never reaches a shared node / destination
    const endS = Math.min(N, stopS + Math.floor(0.15 * SR));
    let buf = new Float32Array(Math.max(0, endS - startS));
    // --- source signal
    if (src.kind === 'osc') {
      let phase = 0;
      for (let i = 0; i < buf.length; i++) {
        const t = (startS + i) / SR;
        if (t < src.startedAt || (src.stoppedAt !== null && t >= src.stoppedAt)) { buf[i] = 0; continue; }
        const f = src.frequency.valueAt(t) * Math.pow(2, src.detune.valueAt(t) / 1200);
        phase += 2 * Math.PI * f / SR;
        buf[i] = waveSample(src.type, phase);
      }
    } else if (src.kind === 'src') {
      const data = src.buffer ? src.buffer.getChannelData(0) : null;
      if (!data || !data.length) continue;
      for (let i = 0; i < buf.length; i++) {
        const t = (startS + i) / SR;
        if (t < src.startedAt || (src.stoppedAt !== null && t >= src.stoppedAt)) { buf[i] = 0; continue; }
        let idx = Math.floor((t - src.startedAt) * SR);
        if (src.loop) idx %= data.length; else if (idx >= data.length) { buf[i] = 0; continue; }
        buf[i] = data[idx];
      }
    }
    // --- private chain nodes
    for (const n of chain) {
      if (n.kind === 'gain') {
        for (let i = 0; i < buf.length; i++) buf[i] *= n.gain.valueAt((startS + i) / SR);
      } else if (n.kind === 'filter') {
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        for (let i = 0; i < buf.length; i++) {
          const t = (startS + i) / SR;
          const [b0, b1, b2, a1, a2] = biquadCoeffs(n.type, n.frequency.valueAt(t), n.Q.valueAt(t), n.gain.valueAt(t), SR);
          const x = buf[i];
          const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1; x1 = x; y2 = y1; y1 = y;
          buf[i] = y;
        }
      }
    }
    const target = accumFor(entry);
    for (let i = 0; i < buf.length; i++) target[startS + i] += buf[i];
  }

  // Shared subgraph: process each shared node once its input
  // buffer is complete, then carry its output onward — THROUGH
  // any single-input intermediate nodes (the v1.3 bus inserts a
  // trim gain + highpass between master and limiter; they are
  // linear hops, applied to the travelling buffer) — until the
  // next shared node or the destination.
  const sharedNodes = ctx._nodes.filter(n => isShared(n) && n !== ctx.destination);
  const processed = new Set();
  const applyNode = (n, input) => {
    if (n.kind === 'gain') {
      const out = new Float32Array(N);
      for (let i = 0; i < N; i++) out[i] = input[i] * n.gain.valueAt(i / SR);
      return out;
    }
    if (n.kind === 'filter') {
      const out = new Float32Array(N);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < N; i++) {
        const [b0, b1, b2, a1, a2] = biquadCoeffs(n.type, n.frequency.valueAt(i / SR), n.Q.valueAt(i / SR), n.gain.valueAt(i / SR), SR);
        const x = input[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        out[i] = y;
      }
      return out;
    }
    if (n.kind === 'compressor') {
      // Spec-shaped model: peak detector with attack/release
      // smoothing applied to the gain reduction in the dB domain.
      const th = n.threshold.value, knee = n.knee.value, ratio = n.ratio.value;
      const att = n.attack.value, rel = n.release.value;
      const attC = Math.exp(-1 / (Math.max(1e-4, att) * SR));
      const relC = Math.exp(-1 / (Math.max(1e-4, rel) * SR));
      const out = new Float32Array(N);
      let gr = 0; // smoothed gain reduction, dB
      let grPeak = 0, grSum = 0;
      for (let i = 0; i < N; i++) {
        const x = input[i];
        const xdB = 20 * Math.log10(Math.abs(x) + 1e-7);
        const over = xdB - th;
        let target = 0;
        if (over > knee / 2) target = over - over / ratio;
        else if (over > -knee / 2) { const u = (over + knee / 2) / knee; target = (1 - 1 / ratio) * knee * u * u / 2; }
        gr = target > gr ? attC * gr + (1 - attC) * target : relC * gr + (1 - relC) * target;
        if (gr > grPeak) grPeak = gr;
        grSum += gr;
        out[i] = x * Math.pow(10, -gr / 20);
      }
      n._grPeak = grPeak; n._grMean = grSum / N;
      return out;
    }
    return input;
  };

  const pending = new Set(sharedNodes);
  // Topological order over shared nodes: a shared node depends on
  // every shared node reachable by walking its input edges
  // backward THROUGH single-input intermediates (master depends
  // on the per-pass trim gains via their direct connection; the
  // limiter depends on master through trim+highpass).
  const depsCache = new Map();
  const depsOf = (n) => {
    if (depsCache.has(n)) return depsCache.get(n);
    const deps = new Set();
    const walk = (m, seen) => {
      for (const inp of m._inputs) {
        if (inp === n || seen.has(inp)) continue;
        seen.add(inp);
        if (isShared(inp) && inp !== ctx.destination) deps.add(inp);
        else walk(inp, seen);
      }
    };
    walk(n, new Set());
    depsCache.set(n, deps);
    return deps;
  };
  let guard = 0;
  while (pending.size && guard++ < 100) {
    let progressed = false;
    for (const n of [...pending]) {
      if (![...depsOf(n)].every(d => processed.has(d))) continue;
      const input = accumFor(n);
      taps.set(n, input.slice());
      let buf = applyNode(n, input);
      processed.add(n);
      pending.delete(n);
      progressed = true;
      // Carry onward through single-input intermediates.
      let next = n.connectedTo[0];
      while (next && next !== ctx.destination && !isShared(next)) {
        if (!taps.has(next)) taps.set(next, buf.slice()); // input tap for intermediates too
        buf = applyNode(next, buf);
        next = next.connectedTo[0];
      }
      if (!next || next === ctx.destination) {
        for (let i = 0; i < N; i++) dest[i] += buf[i];
      } else {
        const t2 = accumFor(next);
        for (let i = 0; i < N; i++) t2[i] += buf[i];
      }
    }
    if (!progressed) break;
  }
  for (const n of sharedNodes) if (n.kind === 'compressor' && n._grPeak !== undefined) {
    taps.set('grPeak', n._grPeak); taps.set('grMean', n._grMean);
  }
  return { dest, taps };
}

// ------------------------------------------------------------ analysis

function analyze(buf, sr = SR) {
  let peak = 0, sumSq = 0, clip = 0, over = 0, maxDelta = 0, clicks = 0, hardSteps = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
    sumSq += buf[i] * buf[i];
    if (a >= 0.999) clip++;
    if (a > 1.0) over++;
    if (i > 0) {
      const d = Math.abs(buf[i] - buf[i - 1]);
      if (d > maxDelta) maxDelta = d;
      if (d > 0.1) clicks++;
      // >0.5 in ONE sample cannot come from any envelope or
      // oscillator in this engine — only from a hard edge (a
      // clipped flat-top's corner, a cut voice). Noise TEXTURE
      // stays well under it (measured: hits peak ~0.28/sample).
      if (d > 0.5) hardSteps++;
    }
  }
  // Band energies via one-pole splits (LF <150Hz, HF >6kHz).
  const aLP = 1 - Math.exp(-2 * Math.PI * 150 / sr);
  const aHP = 1 - Math.exp(-2 * Math.PI * 6000 / sr);
  let lp = 0, hpPrev = 0, hpIn = 0, lfSq = 0, hfSq = 0;
  for (let i = 0; i < buf.length; i++) {
    lp += aLP * (buf[i] - lp);
    lfSq += lp * lp;
    const hp = buf[i] - hpPrev; // crude HF proxy: first difference scaled
    hfSq += hp * hp;
    hpPrev = buf[i];
  }
  const rms = Math.sqrt(sumSq / buf.length);
  return {
    peak, rms,
    clipSamples: clip, overSamples: over,
    maxDelta, clickSteps: clicks, hardSteps,
    lfRms: Math.sqrt(lfSq / buf.length),
    hfDiffRms: Math.sqrt(hfSq / buf.length),
  };
}
const dB = (x) => (20 * Math.log10(Math.max(1e-7, x))).toFixed(2);

// ------------------------------------------------------------ cases

const DRUM_STACK = ['dance-drums-3', 'pop-drums-2', 'dance-drums-1', 'latin-drums-1', 'latin-drums-3'];
function worstMix(bpm) {
  return {
    name: 'Worst Stack', bpm, bars: 8,
    tracks: DRUM_STACK.map(id => ({ cells: Array.from({ length: 8 }, (_, bar) => ({ loopId: id, bar })) })),
  };
}
function typicalMix(bpm) {
  return {
    name: 'Typical', bpm, bars: 8,
    tracks: [
      { cells: [0, 2, 4, 6].map(bar => ({ loopId: 'pop-drums-1', bar })) },
      { cells: [0, 2, 4, 6].map(bar => ({ loopId: 'pop-bass-1', bar })) },
      { cells: [0, 2, 4, 6].map(bar => ({ loopId: 'pop-mel-1', bar })) },
      { cells: [{ loopId: 'pop-pad-1', bar: 0 }, { loopId: 'pop-pad-1', bar: 4 }] },
      { cells: [{ loopId: 'pop-fx-1', bar: 0 }, { loopId: 'pop-fx-1', bar: 4 }] },
    ],
  };
}

function measure(label, mix, seconds) {
  const { ctx, AE, Mixer } = loadEngine();
  const end = AE.playMix(mix, 0.05);
  const { dest, taps } = renderGraph(ctx, seconds);
  const a = analyze(dest);
  const masterIn = taps.get(AE.master);
  const limIn = taps.get(AE.limiter);
  const am = masterIn ? analyze(masterIn) : null;
  const al = limIn ? analyze(limIn) : null;
  console.log(`\n== ${label} (bpm ${mix.bpm}) ==`);
  if (am) console.log(`   raw source sum @ master in : peak ${am.peak.toFixed(2)} (${dB(am.peak)} dBFS)`);
  if (al) console.log(`   at limiter input           : peak ${al.peak.toFixed(2)} (${dB(al.peak)} dBFS)`);
  console.log(`   DESTINATION                : peak ${a.peak.toFixed(3)} (${dB(a.peak)} dBFS), rms ${a.rms.toFixed(3)}`);
  console.log(`   clipped-by-DAC samples     : ${a.overSamples} over ±1.0 (${a.clipSamples} at ≥0.999)`);
  console.log(`   discontinuities            : max |Δ| ${a.maxDelta.toFixed(3)}, hard steps >0.5: ${a.hardSteps} (texture steps >0.1: ${a.clickSteps})`);
  console.log(`   limiter gain reduction     : peak ${taps.get('grPeak') !== undefined ? taps.get('grPeak').toFixed(1) : '?'} dB, mean ${taps.get('grMean') !== undefined ? taps.get('grMean').toFixed(1) : '?'} dB`);
  console.log(`   bands: LF rms ${a.lfRms.toFixed(3)}, HF-diff rms ${a.hfDiffRms.toFixed(4)}`);
  return { a, am, al, end };
}

if (require.main === module) {
  // Solo drum-loop peaks (per-loop normalization evidence).
  const { LOOPS } = require('../src/music');
  console.log('--- solo drum loops (1 pass, 140bpm, pre-master peak) ---');
  for (const l of LOOPS.filter(x => x.role === 'drums')) {
    const { ctx, AE } = loadEngine();
    AE.playMix({ name: 'solo', bpm: 140, bars: 2, tracks: [{ cells: [{ loopId: l.id, bar: 0 }] }] }, 0.05);
    const { taps } = renderGraph(ctx, 3.5);
    const inp = taps.get(AE.master);
    console.log(`   ${l.id.padEnd(15)} peak ${inp ? analyze(inp).peak.toFixed(3) : '?'}`);
  }
  measure('WORST drum stack, every-bar bubbles', worstMix(160), 13);
  measure('WORST drum stack, every-bar bubbles', worstMix(112), 18);
  measure('TYPICAL pop mix', typicalMix(112), 18);
  measure('TYPICAL pop mix', typicalMix(70), 28);
}

module.exports = { loadEngine, renderGraph, analyze, dB, worstMix, typicalMix, DRUM_STACK, SR };
