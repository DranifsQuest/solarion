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
