'use strict';

/**
 * Solarion Phase 9 — MIX AUDIBILITY suite (Zan's hard requirement).
 *
 * When a mix is played — on a stage OR on a home radio — EVERYONE in
 * the room must hear it, INCLUDING the creator/performer. These tests
 * pin the protocol contract:
 *
 *   stage: performer + TWO audience members in the room each receive
 *     performance-start with IDENTICAL startAt / durationMs / mix
 *     data (so every client schedules the same playback from the
 *     same instant), and the performer's snapshot carries
 *     performing=true (their client enters the playing state).
 *   radio: the OWNER and a VISITOR in the home both receive the
 *     home-device broadcast with playing=true and the full track
 *     payload (for the mixes source: the complete mix data) — no
 *     matter who pressed play. A client in another room gets nothing.
 *
 * Run:  TEST_RUN=<n> node --test test/audibility.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `atest-run-${RUN}.db`);
const PORT = 49600 + Number(RUN) * 10;

const children = [];
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await sleep(50);
  }
}

function startServer(port, dbPath) {
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) { /* fresh */ }
  }
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, SOLARION_PORT: String(port), SOLARION_DB_PATH: dbPath, SOLARION_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  child.stderr.on('data', d => { out += d.toString(); });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start on ${port}; stderr: ${out}`)), 15000);
    child.stdout.on('data', d => {
      if (d.toString().includes('listening on')) { clearTimeout(t); resolve(child); }
    });
    child.on('error', reject);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 5000, 'server exit');
}

function api(port, route, body) {
  return fetch(`http://localhost:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json() }));
}

function connectClient(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`);
    const client = { ws, msgs: [], hello: null, send: (m) => ws.send(JSON.stringify(m)) };
    const t = setTimeout(() => { ws.close(); reject(new Error('no hello within 5s')); }, 5000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      client.msgs.push(m);
      if (m.type === 'hello') { client.hello = m; clearTimeout(t); resolve(client); }
    });
    ws.on('error', reject);
    ws.on('close', () => { if (!client.hello) { clearTimeout(t); reject(new Error('ws closed before hello')); } });
  });
}

async function makeUser(name) {
  const r = await api(PORT, '/api/register', { username: name, password: 'secretpw' });
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`);
  const c = await api(PORT, '/api/create-character', { token: r.json.token, name, gender: 'F' });
  assert.equal(c.status, 200, `create ${name}: ${JSON.stringify(c.json)}`);
  const client = await connectClient(PORT, r.json.token);
  return { name, token: r.json.token, client, id: client.hello.you.id };
}

async function toBay(user) {
  user.client.send({ type: 'debug-teleport', x: 1120, y: 48 });
  await waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(),
    5000, `${user.name} arrives in solstice-bay`);
}

const MIX = {
  name: 'Audible Anthem', bpm: 160, bars: 2,
  tracks: [
    { loopId: 'pop-drums-1', startBar: 0 },
    { loopId: 'pop-mel-1', startBar: 0 },
  ],
};

async function saveMix(user, slot, data) {
  user.client.send({ type: 'mix-save', slot, data });
  const saved = await waitFor(
    () => user.client.msgs.filter(m => m.type === 'mix-saved').pop(),
    5000, `mix saved for ${user.name}`);
  return saved.mix;
}

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

test('stage audibility: performer + 2 audience receive identical performance-start', { timeout: 90000 }, async () => {
  const perf = await makeUser('audio_perf');
  const fan1 = await makeUser('audio_fan1');
  const fan2 = await makeUser('audio_fan2');
  const elsewhere = await makeUser('audio_far');
  const mix = await saveMix(perf, 1, MIX);
  // Phase 9 ritual: a burned CD is the price of the stage.
  perf.client.send({ type: 'buy-blanks' });
  await waitFor(() => perf.client.msgs.filter(m => m.type === 'cds' && m.blanks >= 10).pop(), 5000, 'blanks bought');
  perf.client.send({ type: 'burn-cd', mixId: mix.id });
  await waitFor(() => perf.client.msgs.filter(m => m.type === 'cds' && m.cds.some(c => c.mixId === mix.id)).pop(), 5000, 'CD burned');
  await toBay(perf); await toBay(fan1); await toBay(fan2);
  // `elsewhere` stays in the Gateway.
  await sleep(300);

  perf.client.send({ type: 'stage-join', mixId: mix.id });
  const starts = {};
  for (const [key, u] of [['perf', perf], ['fan1', fan1], ['fan2', fan2]]) {
    starts[key] = await waitFor(
      () => u.client.msgs.filter(m => m.type === 'performance-start').pop(),
      8000, `${key} receives performance-start`);
  }
  // Identical timing + payload for EVERYONE, performer included.
  assert.equal(starts.perf.startAt, starts.fan1.startAt, 'performer startAt == fan1 startAt');
  assert.equal(starts.perf.startAt, starts.fan2.startAt, 'performer startAt == fan2 startAt');
  assert.equal(starts.perf.durationMs, starts.fan1.durationMs);
  assert.deepEqual(starts.perf.mix, MIX, 'performer receives the full mix data');
  assert.deepEqual(starts.perf.mix, starts.fan2.mix, 'identical mix data for performer and audience');
  assert.equal(starts.perf.performerId, perf.id);
  // The performer's client enters the playing state: snapshots flag
  // them performing (mic prop + shout mode ride on this flag).
  await waitFor(() => {
    const s = perf.client.msgs.filter(m => m.type === 'snapshot').pop();
    const me = s && s.players.find(p => p.id === perf.id);
    return me && me.performing === true ? me : null;
  }, 5000, 'performer snapshot performing=true (own client playing state)');
  // A client in another map hears nothing.
  await sleep(300);
  assert.equal(elsewhere.client.msgs.filter(m => m.type === 'performance-start').length, 0,
    'client in another map receives no performance-start');
  // Everyone gets the same results card at the end.
  fan1.client.send({ type: 'vote', value: 1 });
  fan2.client.send({ type: 'vote', value: 1 });
  const endPerf = await waitFor(() => perf.client.msgs.filter(m => m.type === 'performance-end').pop(), 30000, 'performer performance-end');
  assert.equal(endPerf.up, 2);
  assert.equal(endPerf.earned, 10);
  for (const u of [perf, fan1, fan2, elsewhere]) u.client.ws.close();
});

test('radio audibility: owner + visitor both receive the playing state with full mix data', { timeout: 90000 }, async () => {
  const owner = await makeUser('audio_owner');
  const guest = await makeUser('audio_guest');
  const outsider = await makeUser('audio_out');
  const mix = await saveMix(owner, 1, { ...MIX, name: 'Radio Hit' });

  // Owner enters their home, buys + places a Boombox.
  owner.client.send({ type: 'enter-studio', owner: owner.name });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).pop(),
    8000, 'owner enters own studio');
  const state = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state' && m.isOwner).pop(),
    5000, 'owner studio-state');
  const boom = state.catalog.find(i => i.id === 'boombox');
  assert.ok(boom, 'boombox in catalog');
  owner.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: 1000 });
  await sleep(200);
  owner.client.send({ type: 'studio-buy', itemId: 'boombox' });
  const inv = await waitFor(() => {
    const s = owner.client.msgs.filter(m => m.type === 'studio-state').pop();
    return s && s.inventory && s.inventory.some(i => i.itemId === 'boombox') ? s : null;
  }, 5000, 'boombox in inventory');
  const inst = inv.inventory.find(i => i.itemId === 'boombox');
  owner.client.send({ type: 'studio-place', instanceItemId: inst.instanceId, x: 5, y: 5, rot: 0 });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-furniture'
    && m.furniture.some(f => f.instanceId === inst.instanceId)).pop(), 5000, 'boombox placed');

  // Guest visits; outsider stays in the Gateway.
  guest.client.send({ type: 'enter-studio', owner: owner.name });
  await waitFor(() => guest.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).pop(),
    8000, 'guest enters studio');
  await sleep(300);
  owner.client.msgs.length = 0; guest.client.msgs.length = 0; outsider.client.msgs.length = 0;

  // VISITOR presses play on the mixes source; BOTH owner and visitor
  // must receive the playing broadcast with the full mix payload.
  guest.client.send({ type: 'home-device', instanceId: inst.instanceId, action: 'source', source: 'mixes' });
  await waitFor(() => guest.client.msgs.filter(m => m.type === 'home-device' && m.device).pop(), 5000, 'guest source ack');
  guest.client.send({ type: 'home-device', instanceId: inst.instanceId, action: 'play' });
  const playOwner = await waitFor(() => owner.client.msgs.filter(m => m.type === 'home-device'
    && m.device && m.device.playing === true).pop(), 5000, 'OWNER receives radio playing broadcast');
  const playGuest = await waitFor(() => guest.client.msgs.filter(m => m.type === 'home-device'
    && m.device && m.device.playing === true).pop(), 5000, 'guest receives radio playing broadcast');
  for (const [who, msg] of [['owner', playOwner], ['guest', playGuest]]) {
    assert.equal(msg.device.source, 'mixes', `${who}: mixes source`);
    assert.equal(msg.device.track.kind, 'mix', `${who}: mix track`);
    assert.equal(msg.device.track.name, 'Radio Hit', `${who}: mix title rides along`);
    assert.deepEqual(msg.device.track.mix, { ...MIX, name: 'Radio Hit' }, `${who}: FULL mix data for local playback`);
    assert.ok(msg.device.startedAt > Date.now() - 1000, `${who}: server start timestamp present`);
  }
  assert.equal(playOwner.device.startedAt, playGuest.device.startedAt, 'identical startedAt for owner and guest');
  // The outsider hears nothing.
  await sleep(300);
  assert.equal(outsider.client.msgs.filter(m => m.type === 'home-device').length, 0, 'outsider receives no device state');

  // OWNER presses stop, then plays the LOOP source: both still in sync.
  owner.client.send({ type: 'home-device', instanceId: inst.instanceId, action: 'stop' });
  await waitFor(() => guest.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.playing === false).pop(),
    5000, 'guest receives stop');
  owner.client.send({ type: 'home-device', instanceId: inst.instanceId, action: 'source', source: 'loops' });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'home-device' && m.device && m.device.source === 'loops').pop(),
    5000, 'owner loops source');
  owner.client.msgs.length = 0; guest.client.msgs.length = 0;
  owner.client.send({ type: 'home-device', instanceId: inst.instanceId, action: 'play' });
  const loopOwner = await waitFor(() => owner.client.msgs.filter(m => m.type === 'home-device'
    && m.device && m.device.playing === true && m.device.track && m.device.track.kind === 'loop').pop(),
    5000, 'owner receives loop playing broadcast');
  const loopGuest = await waitFor(() => guest.client.msgs.filter(m => m.type === 'home-device'
    && m.device && m.device.playing === true && m.device.track && m.device.track.kind === 'loop').pop(),
    5000, 'guest receives loop playing broadcast');
  assert.equal(loopOwner.device.startedAt, loopGuest.device.startedAt, 'loop play: identical startedAt');
  assert.ok(mix, 'mix saved');
  for (const u of [owner, guest, outsider]) u.client.ws.close();
});

// ------------------------------------------------------------ v1.1

// Item 5 — the REAL perform path, modeled faithfully: the actual
// public/mixer.js running in a vm against a fake AudioContext that
// behaves like a strict browser — created SUSPENDED, and
// programmatic resume() does NOT un-suspend it (only a user gesture
// does). The pre-v1.1 client scheduled the set unconditionally onto
// ctx.currentTime; on a suspended context currentTime is FROZEN, so
// every source sat at a timestamp on a clock that never advanced —
// the performer heard silence while the room (whose contexts were
// warm) heard the show. This test fails on that code: it asserts
// nothing is scheduled while the context is frozen, and that once
// the context runs, the deferred set finally schedules.
test('performer audibility (v1.1): a cold context defers instead of scheduling into silence', { timeout: 30000 }, async () => {
  const vm = require('node:vm');
  const musicMod = require('../src/music.js');

  const starts = [];
  class FakeParam {
    constructor(v = 0) { this.value = v; }
    setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} setTargetAtTime() {} cancelScheduledValues() {}
  }
  class FakeNode {
    constructor(kind) { this._kind = kind; this.gain = new FakeParam(1); this.frequency = new FakeParam(440); this.detune = new FakeParam(0); this.Q = new FakeParam(1); this.type = ''; this.buffer = null; }
    connect() {} disconnect() {}
    start(when) { starts.push({ when, wall: Date.now() }); }
    stop() {}
  }
  class FakeCtx {
    static instances = [];
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 44100; this.destination = {}; this._ls = {}; FakeCtx.instances.push(this); }
    createGain() { return new FakeNode('gain'); }
    createOscillator() { return new FakeNode('osc'); }
    createBiquadFilter() { return new FakeNode('filter'); }
    createBufferSource() { return new FakeNode('src'); }
    createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    addEventListener(ev, fn) { (this._ls[ev] ||= []).push(fn); }
    removeEventListener(ev, fn) { this._ls[ev] = (this._ls[ev] || []).filter(f => f !== fn); }
    emit(ev) { for (const f of this._ls[ev] || []) f(); }
    resume() { return Promise.resolve(); } // strict browser: no gesture, no resume
    gesture() { this.state = 'running'; this.emit('statechange'); }
  }
  const fakeEl = () => ({
    style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener() {}, appendChild() {},
  });
  const sandbox = {
    console, Date, Math, JSON, Map, Set, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: { getElementById: () => fakeEl(), createElement: () => fakeEl(), addEventListener() {} },
    fetch: () => Promise.reject(new Error('no network in the vm')),
    AudioContext: FakeCtx,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'mixer.js'), 'utf8'), sandbox);
  const Mixer = sandbox.SolarionMixer;
  assert.ok(Mixer, 'mixer module loaded in the vm');
  Mixer.hooks = { send() {}, toast() {}, esc: (s) => String(s), getMe: () => ({ id: 42 }), getMapDef: () => null };
  Mixer.buildDom();
  Mixer.loops = musicMod.LOOPS;
  Mixer.loopsById = new Map(musicMod.LOOPS.map(l => [l.id, l]));

  const mix = { name: 'Cold Start', bpm: 160, bars: 2, tracks: [{ loopId: 'pop-drums-1', startBar: 0 }, { loopId: 'pop-bass-1', startBar: 0 }] };
  const startAt = Date.now() + 1200;
  Mixer.handle({ type: 'performance-start', performerId: 42, performerName: 'Cold', mixName: 'Cold Start', mix, startAt, durationMs: 3000 });
  await sleep(350);
  assert.equal(starts.length, 0, 'NOTHING is scheduled onto a frozen (suspended) context — the old code scheduled the whole set here and the performer heard silence');

  // The set's start time passes with the context STILL frozen —
  // then the performer's next real gesture un-suspends it.
  const ctx = FakeCtx.instances[0];
  assert.ok(ctx, 'engine created a context');
  await sleep(1450); // now ≈ startAt + 600ms
  assert.equal(starts.length, 0, 'still nothing scheduled while frozen, even past startAt');
  const gestureAt = Date.now();
  ctx.gesture();
  await sleep(250);
  assert.ok(starts.length > 0, 'once the context runs, the deferred set is scheduled');
  // A performance is ONE pass — there is no later grid point — so a
  // late wake joins from the top of the mix, immediately: the first
  // source sounds within a beat of the gesture. (ctx.currentTime
  // never advances in the fake, so a source sounds at
  // schedule-wall-time + its ctx timestamp.)
  const soundWall = (e) => e.wall + e.when * 1000;
  const firstSound = Math.min(...starts.map(soundWall));
  assert.ok(firstSound >= gestureAt - 50 && firstSound < gestureAt + 700, `late join plays from the top at once (first sound ${Math.round(firstSound - gestureAt)}ms after the gesture)`);

  // Warm path: a second set with the context already running
  // schedules immediately, at startAt itself.
  Mixer.handle({ type: 'performance-end', performerId: 42, performerName: 'Cold', mixName: 'Cold Start', up: 0, down: 0, earned: 0 });
  starts.length = 0;
  const startAt2 = Date.now() + 1200;
  Mixer.handle({ type: 'performance-start', performerId: 42, performerName: 'Cold', mixName: 'Cold Start', mix, startAt: startAt2, durationMs: 3000 });
  await sleep(200);
  assert.ok(starts.length > 0, 'warm context schedules immediately');
  const soundWall2 = (e) => e.wall + e.when * 1000;
  const firstSound2 = Math.min(...starts.map(soundWall2));
  assert.ok(Math.abs(firstSound2 - startAt2) < 500, 'warm join is at startAt (in sync with the room)');
  Mixer.handle({ type: 'performance-end', performerId: 42, performerName: 'Cold', mixName: 'Cold Start', up: 0, down: 0, earned: 0 });
});

// Item 14 — zone music resolution + toggle/ducking contract.
test('zone music (v1.1): every map resolves a composition; toggle + ducking gate the level', { timeout: 30000 }, async () => {
  const zm = require('../public/zonemusic.js');
  const { MAPS } = require('../src/maps.js');
  const musicMod = require('../src/music.js');
  for (const id of Object.keys(MAPS)) {
    const spec = zm.forMap(id, Boolean(MAPS[id].casino));
    assert.ok(spec && spec.genre && spec.bpm > 0, `${id} resolves a composition`);
    const tracks = zm.pickTracks(spec, musicMod.LOOPS, id);
    assert.ok(tracks.length >= 2, `${id} composition layers ${tracks.length} loops`);
    for (const t of tracks) assert.ok(spec.roles.includes(t.role), `${id}: track role ${t.role} is in the composition`);
  }
  assert.ok(zm.forMap('studio:self', false), 'player homes resolve');
  assert.equal(zm.forMap('neon-district', false).genre, 'Dance', 'Neon pulses');
  assert.equal(zm.forMap('frosthaven', false).genre, 'Chill', 'Frosthaven stays calm');
  assert.equal(zm.forMap('verdant-hollow', false).genre, 'Pop', 'Verdant is mellow pop');

  const ZM = zm.ZoneMusic;
  globalThis.SolarionMixer = { perf: { active: false } };
  globalThis.SolarionStudio = { radioKey: null };
  globalThis.SolarionSfx = { muted: false };
  try {
    ZM.enabled = true;
    assert.equal(ZM.targetLevel(), zm.MUSIC_LEVEL, 'on + nothing foreground = full zone-music level');
    globalThis.SolarionMixer.perf.active = true;
    assert.equal(ZM.targetLevel(), 0, 'a live stage performance ducks zone music to silent');
    globalThis.SolarionMixer.perf.active = false;
    globalThis.SolarionStudio.radioKey = 'owner:1:loop';
    assert.equal(ZM.targetLevel(), 0, 'a sounding home radio ducks zone music');
    globalThis.SolarionStudio.radioKey = null;
    ZM.setEnabled(false);
    assert.equal(ZM.enabled, false);
    assert.equal(ZM.targetLevel(), 0, 'toggle off silences zone music');
    ZM.setEnabled(true);
    assert.equal(ZM.targetLevel(), zm.MUSIC_LEVEL, 'toggle back on restores it');
  } finally {
    delete globalThis.SolarionMixer;
    delete globalThis.SolarionStudio;
    delete globalThis.SolarionSfx;
  }
});
