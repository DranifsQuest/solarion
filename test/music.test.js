'use strict';

/**
 * Solarion Phase 2 — music/stage test suite.
 *
 * Spawns a real server and drives it over HTTP + WebSocket:
 *   a. mix save/load round-trip + server-side validation rejections
 *      (unknown loopId, >5 tracks, 6th slot, oversized payload, bad bpm)
 *   b. stage flow: A queues in Solstice Bay, performance starts, B in
 *      the same room receives performance-start with identical mix data
 *   c. voting + pay: B's thumbs-up pays A exactly +5z at performance end
 *   d. anti-farm: self-vote rejected, double-vote counted once, votes
 *      from another map rejected, daily 350z cap enforced
 *   e. performer chat during a performance broadcasts room-wide (sing)
 *
 * Performance cycle used here: 2 bars @160bpm = 3s of music + 1.2s
 * start delay + 10s voting grace ≈ 14.5s per set.
 *
 * Run:  TEST_RUN=<n> node --test test/music.test.js (or npm test)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `mtest-run-${RUN}.db`);
const PORT = 49500 + Number(RUN) * 10;

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
  const r = await api(PORT, '/api/register', {
    username: name, password: 'secretpw',
    shirt: '#aa0000', pants: '#003366', skin_tone: '#f1c27d',
    hair_style: 'short', hair_color: '#222222',
  });
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`);
  // Phase 6: create the character before entering the world.
  const c = await api(PORT, '/api/create-character', { token: r.json.token, name, gender: 'M' });
  assert.equal(c.status, 200, `create ${name}: ${JSON.stringify(c.json)}`);
  const client = await connectClient(PORT, r.json.token);
  return { name, token: r.json.token, client, id: client.hello.you.id };
}

/** Teleport through the Gateway → Solstice Bay arch and wait for the map switch. */
async function toBay(user) {
  user.client.send({ type: 'debug-teleport', x: 480, y: 48 });
  await waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(),
    5000, `${user.name} arrives in solstice-bay`);
}

const SHORT_MIX = {
  name: 'Test Banger', bpm: 160, bars: 2,
  tracks: [
    { loopId: 'pop-drums-1', startBar: 0 },
    { loopId: 'pop-bass-1', startBar: 0 },
  ],
};

/** Save a mix and return the server's stored row (from mix-saved). */
async function saveMix(user, slot, data) {
  user.client.msgs.length = 0;
  user.client.send({ type: 'mix-save', slot, data });
  const saved = await waitFor(
    () => user.client.msgs.filter(m => m.type === 'mix-saved').pop(),
    5000, `mix saved for ${user.name}`);
  return saved.mix;
}

async function saveExpectError(user, slot, data, pattern) {
  user.client.msgs.length = 0;
  user.client.send({ type: 'mix-save', slot, data });
  const err = await waitFor(
    () => user.client.msgs.filter(m => m.type === 'mix-error').pop(),
    5000, `mix-error matching ${pattern}`);
  assert.match(err.error, pattern);
  return err;
}

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

test('loop catalog is served and well-formed', { timeout: 30000 }, async () => {
  const j = await fetch(`http://localhost:${PORT}/api/music/loops`).then(r => r.json());
  assert.equal(j.ok, true);
  assert.ok(j.loops.length >= 40, `expected 40+ loops, got ${j.loops.length}`);
  const ids = new Set(j.loops.map(l => l.id));
  assert.equal(ids.size, j.loops.length, 'loop ids unique');
  const genres = new Set(j.loops.map(l => l.genre));
  for (const g of ['Pop', 'Dance', 'Hip-Hop', 'Rock', 'Latin', 'Chill']) {
    assert.ok(genres.has(g), `genre ${g} present`);
  }
  const roles = new Set(j.loops.map(l => l.role));
  for (const r of ['drums', 'bass', 'melody', 'pad', 'fx']) assert.ok(roles.has(r), `role ${r} present`);
  assert.equal(j.bpmMin, 70);
  assert.equal(j.bpmMax, 160);
});

test('mix save/load round-trip and validation rejections', { timeout: 30000 }, async () => {
  const u = await makeUser('mixer_p2');
  // valid save round-trips with normalized data intact
  const mix = await saveMix(u, 1, SHORT_MIX);
  assert.equal(mix.slot, 1);
  assert.equal(mix.name, 'Test Banger');
  assert.deepEqual(mix.data, SHORT_MIX);
  // list shows exactly that mix
  u.client.msgs.length = 0;
  u.client.send({ type: 'mix-list' });
  const list = await waitFor(() => u.client.msgs.filter(m => m.type === 'mixes').pop(), 5000, 'mix list');
  assert.equal(list.mixes.length, 1);
  assert.deepEqual(list.mixes[0].data, SHORT_MIX);
  // unknown loopId rejected
  await saveExpectError(u, 2, { name: 'Bad', bpm: 120, bars: 4, tracks: [{ loopId: 'no-such-loop', startBar: 0 }] }, /Unknown loop/);
  // >5 tracks rejected
  const six = Array.from({ length: 6 }, () => ({ loopId: 'pop-drums-1', startBar: 0 }));
  await saveExpectError(u, 2, { name: 'Too Many', bpm: 120, bars: 4, tracks: six }, /1–5 tracks/);
  // 6th slot rejected (max 5 per account, slots are 1–5)
  await saveExpectError(u, 6, SHORT_MIX, /Slot must be 1–5/);
  await saveExpectError(u, 0, SHORT_MIX, /Slot must be 1–5/);
  // bad bpm rejected
  await saveExpectError(u, 2, { ...SHORT_MIX, bpm: 300 }, /Tempo/);
  await saveExpectError(u, 2, { ...SHORT_MIX, bpm: 40 }, /Tempo/);
  // oversized payload rejected (>8KB JSON)
  const big = { ...SHORT_MIX, name: 'Big', junk: 'x'.repeat(9000) };
  await saveExpectError(u, 2, big, /too large/);
  // fill remaining slots 2–5, then verify cap: a 5-slot account listing
  for (let s = 2; s <= 5; s++) await saveMix(u, s, { ...SHORT_MIX, name: `Filler ${s}` });
  u.client.msgs.length = 0;
  u.client.send({ type: 'mix-list' });
  const full = await waitFor(() => u.client.msgs.filter(m => m.type === 'mixes').pop(), 5000, 'full list');
  assert.equal(full.mixes.length, 5);
  assert.deepEqual(full.mixes.map(m => m.slot), [1, 2, 3, 4, 5]);
  // delete works
  u.client.send({ type: 'mix-delete', slot: 3 });
  const afterDel = await waitFor(() => {
    const l = u.client.msgs.filter(m => m.type === 'mixes').pop();
    return l && l.mixes.length === 4 ? l : null;
  }, 5000, 'list after delete');
  assert.ok(!afterDel.mixes.some(m => m.slot === 3));
  u.client.ws.close();
});

test('stage: queue, synchronized performance, voting pays +5z, anti-farm rules, performer sing-chat', { timeout: 90000 }, async () => {
  const a = await makeUser('performer_p2');   // performer
  const b = await makeUser('fan_p2');         // audience in the bay
  const c = await makeUser('faraway_p2');     // stays in the Gateway
  const mixA = await saveMix(a, 1, SHORT_MIX);
  assert.equal(a.client.hello.zcoins, 100, 'A starts at 100z (daily bonus)');

  await toBay(a);
  await toBay(b);
  await sleep(300);

  // A joins the queue; both A and B see the queue broadcast with A in it.
  a.client.send({ type: 'stage-join', mixId: mixA.id });
  const qB = await waitFor(() => b.client.msgs.filter(m => m.type === 'stage-queue' && m.queue.some(e => e.userId === a.id)).pop(),
    5000, 'B sees A in the stage queue');
  assert.equal(qB.queue[0].mixName, 'Test Banger');

  // Performance starts; A and B get identical mix data; C (other map) gets nothing.
  const startA = await waitFor(() => a.client.msgs.filter(m => m.type === 'performance-start').pop(), 5000, 'A performance-start');
  const startB = await waitFor(() => b.client.msgs.filter(m => m.type === 'performance-start').pop(), 5000, 'B performance-start');
  assert.equal(startB.performerId, a.id);
  assert.equal(startB.performerName, 'performer_p2');
  assert.deepEqual(startB.mix, SHORT_MIX, 'B received the full mix data');
  assert.deepEqual(startA.mix, startB.mix, 'A and B received identical mix data');
  assert.ok(startB.startAt > Date.now() - 1000 && startB.startAt < Date.now() + 5000, 'startAt ≈ now + 1.2s');
  assert.equal(startB.durationMs, 3000, '2 bars @160bpm = 3000ms');
  assert.equal(c.client.msgs.filter(m => m.type === 'performance-start').length, 0, 'C in another map hears nothing');

  // snapshots flag A as performing (client uses this for the mic sprite)
  await waitFor(() => {
    const s = b.client.msgs.filter(m => m.type === 'snapshot').pop();
    const pa = s && s.players.find(p => p.id === a.id);
    return pa && pa.performing === true ? pa : null;
  }, 5000, 'A flagged performing in snapshots');

  // (e) performer chat during the set broadcasts room-wide in sing mode;
  //     a client in another map must NOT receive it.
  a.client.send({ type: 'chat', text: 'thank you solstice bay!' });
  const singB = await waitFor(() => b.client.msgs.filter(m => m.type === 'chat' && m.text === 'thank you solstice bay!').pop(),
    5000, 'B hears performer chat');
  assert.equal(singB.sing, true, 'performer chat flagged sing (room-wide shout)');
  await sleep(300);
  assert.equal(c.client.msgs.filter(m => m.type === 'chat' && m.text === 'thank you solstice bay!').length, 0,
    'C in another map does not hear it');

  // (d) anti-farm votes: self-vote, cross-map vote, double vote.
  a.client.send({ type: 'vote', value: 1 });            // self-vote → rejected
  c.client.send({ type: 'vote', value: 1 });            // wrong map → rejected
  b.client.send({ type: 'vote', value: 1 });            // the one legit vote
  const ack = await waitFor(() => b.client.msgs.filter(m => m.type === 'vote-ack').pop(), 5000, 'B vote acked');
  assert.equal(ack.value, 1);
  b.client.send({ type: 'vote', value: -1 });           // double vote → counted once (first wins)

  // (c) performance end: exactly one thumbs-up → A paid exactly +5z.
  const endB = await waitFor(() => b.client.msgs.filter(m => m.type === 'performance-end').pop(), 30000, 'B performance-end');
  assert.equal(endB.up, 1, 'exactly one thumbs-up counted');
  assert.equal(endB.down, 0, 'double-vote down not counted');
  assert.equal(endB.earned, 5, 'performer earned exactly +5z');
  const endA = await waitFor(() => a.client.msgs.filter(m => m.type === 'performance-end').pop(), 5000, 'A performance-end');
  assert.deepEqual(
    { up: endA.up, down: endA.down, earned: endA.earned },
    { up: endB.up, down: endB.down, earned: endB.earned },
    'results broadcast matches for performer and audience');
  const zMsg = await waitFor(() => a.client.msgs.filter(m => m.type === 'zcoins').pop(), 5000, 'A zcoins update');
  assert.equal(zMsg.zcoins, 105, 'A balance 100 + 5 = 105');

  // performer cooldown: immediate rejoin is refused
  a.client.msgs.length = 0;
  a.client.send({ type: 'stage-join', mixId: mixA.id });
  const cd = await waitFor(() => a.client.msgs.filter(m => m.type === 'notice' && /breather/.test(m.text)).pop(),
    5000, 'cooldown notice');
  assert.ok(cd);

  a.client.ws.close(); b.client.ws.close(); c.client.ws.close();
});

test('stage: daily performance-earnings cap of 350z is enforced', { timeout: 90000 }, async () => {
  const d = await makeUser('capped_p2');
  const e = await makeUser('capfan_p2');
  const mixD = await saveMix(d, 1, SHORT_MIX);
  await toBay(d);
  await toBay(e);
  // Seed D at 348z earned today (test-only hook): a +5z vote may only pay 2z.
  d.client.send({ type: 'debug-seed-perf', earned: 348 });
  await sleep(200);
  d.client.send({ type: 'stage-join', mixId: mixD.id });
  await waitFor(() => e.client.msgs.filter(m => m.type === 'performance-start').pop(), 5000, 'D performance-start');
  e.client.send({ type: 'vote', value: 1 });
  const end = await waitFor(() => e.client.msgs.filter(m => m.type === 'performance-end').pop(), 30000, 'D performance-end');
  assert.equal(end.up, 1);
  assert.equal(end.earned, 2, 'cap clamps the +5z vote pay to the remaining 2z of the 350z daily cap');
  const zMsg = await waitFor(() => d.client.msgs.filter(m => m.type === 'zcoins').pop(), 5000, 'D zcoins update');
  assert.equal(zMsg.zcoins, 102, 'D balance 100 + 2 = 102');
  d.client.ws.close(); e.client.ws.close();
});
