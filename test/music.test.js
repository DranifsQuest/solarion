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
  user.client.send({ type: 'debug-teleport', x: 1120, y: 48 });
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

/** Phase 9 ritual: performing needs a burned CD — buy a pack + burn. */
async function prepCd(user, mixId) {
  user.client.send({ type: 'buy-blanks' });
  await waitFor(() => user.client.msgs.filter(m => m.type === 'cds' && m.blanks >= 10).pop(), 5000, 'blanks bought');
  user.client.send({ type: 'burn-cd', mixId });
  await waitFor(() => user.client.msgs.filter(m => m.type === 'cds' && m.cds.some(c => c.mixId === mixId)).pop(), 5000, 'CD burned');
}

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
  assert.equal(a.client.hello.zcoins, 5000, 'A starts at 5,000z (welcome bonus)');
  await prepCd(a, mixA.id); // Phase 9: −20z for the blank pack

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

  // (d) anti-farm votes: self-vote + cross-map vote rejected; and
  //     the v1.1 switch rule — the opposite thumb MOVES your vote.
  a.client.send({ type: 'vote', value: 1 });            // self-vote → rejected
  c.client.send({ type: 'vote', value: 1 });            // wrong map → rejected
  b.client.send({ type: 'vote', value: 1 });            // the one legit vote
  const ack = await waitFor(() => b.client.msgs.filter(m => m.type === 'vote-ack').pop(), 5000, 'B vote acked');
  assert.equal(ack.value, 1);
  b.client.send({ type: 'vote', value: 1 });            // same thumb again → silent no-op
  await sleep(250);
  assert.equal(b.client.msgs.filter(m => m.type === 'vote-ack').length, 1, 'same-thumb re-click earns no second ack');
  b.client.send({ type: 'vote', value: -1 });           // opposite thumb → SWITCH
  const ack2 = await waitFor(() => b.client.msgs.filter(m => m.type === 'vote-ack' && m.value === -1).pop(), 5000, 'B switch acked');
  assert.equal(ack2.value, -1);
  const fx = b.client.msgs.filter(m => m.type === 'vote-fx').pop();
  assert.deepEqual({ up: fx.up, down: fx.down }, { up: 0, down: 1 }, 'vote-fx carries the live tallies after the switch');

  // (c) performance end: the switched vote lands as a DOWN vote →
  //     no up-votes, no pay.
  const endB = await waitFor(() => b.client.msgs.filter(m => m.type === 'performance-end').pop(), 30000, 'B performance-end');
  assert.equal(endB.up, 0, 'the up-vote was switched away');
  assert.equal(endB.down, 1, 'the switched down-vote counts');
  assert.equal(endB.earned, 0, 'no up-votes → performer earns 0z');
  const endA = await waitFor(() => a.client.msgs.filter(m => m.type === 'performance-end').pop(), 5000, 'A performance-end');
  assert.deepEqual(
    { up: endA.up, down: endA.down, earned: endA.earned },
    { up: endB.up, down: endB.down, earned: endB.earned },
    'results broadcast matches for performer and audience');
  const zMsg = await waitFor(() => a.client.msgs.filter(m => m.type === 'zcoins').pop(), 5000, 'A zcoins update');
  assert.equal(zMsg.zcoins, 4980, 'A balance 5000 − 20 (blank pack) + 0 = 4980');

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
  await prepCd(d, mixD.id);
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
  assert.equal(zMsg.zcoins, 4982, 'D balance 5000 − 20 (blank pack) + 2 = 4982');
  d.client.ws.close(); e.client.ws.close();
});

test('stage v1.1: tip drop box moves z atomically; self/ghost/invalid tips refused', { timeout: 90000 }, async () => {
  const perf = await makeUser('tipstar_p2');
  const fan = await makeUser('tipfan_p2');
  const mix = await saveMix(perf, 1, SHORT_MIX);
  await prepCd(perf, mix.id);
  await toBay(perf);
  await toBay(fan);
  await sleep(300);

  // Tip with nobody on stage → refused politely, no money moves.
  fan.client.send({ type: 'tip', amount: 25 });
  const ghost = await waitFor(() => fan.client.msgs.filter(m => m.type === 'notice' && /Nobody is performing/.test(m.text)).pop(), 5000, 'ghost tip refused');
  assert.ok(ghost);

  perf.client.send({ type: 'stage-join', mixId: mix.id });
  await waitFor(() => fan.client.msgs.filter(m => m.type === 'performance-start').pop(), 8000, 'set starts');

  // Self-tip → refused.
  perf.client.send({ type: 'tip', amount: 25 });
  const self = await waitFor(() => perf.client.msgs.filter(m => m.type === 'notice' && /tip your own/.test(m.text)).pop(), 5000, 'self-tip refused');
  assert.ok(self);

  // Non-preset amount → refused (the drop box only offers presets).
  fan.client.send({ type: 'tip', amount: 7 });
  const preset = await waitFor(() => fan.client.msgs.filter(m => m.type === 'notice' && /preset/.test(m.text)).pop(), 5000, 'non-preset tip refused');
  assert.ok(preset);

  // A real 25z tip: fan 5000 → 4975, performer 4980 → 5005, both told.
  fan.client.send({ type: 'tip', amount: 25 });
  const fanZ = await waitFor(() => fan.client.msgs.filter(m => m.type === 'zcoins').pop(), 5000, 'fan debited');
  assert.equal(fanZ.zcoins, 4975, 'fan paid exactly 25z');
  const got = await waitFor(() => perf.client.msgs.filter(m => m.type === 'notice' && /tipped you 25z/.test(m.text)).pop(), 5000, 'performer told about the tip');
  assert.ok(got);
  const perfZ = await waitFor(() => perf.client.msgs.filter(m => m.type === 'zcoins').pop(), 5000, 'performer credited');
  assert.equal(perfZ.zcoins, 5005, 'performer 4980 (after CD pack) + 25 tip');
  const fanNote = await waitFor(() => fan.client.msgs.filter(m => m.type === 'notice' && /You tipped/.test(m.text)).pop(), 5000, 'fan confirmed');
  assert.ok(fanNote);

  // Insufficient funds: drain the fan (test hook) — the tip must
  // refuse atomically: balance untouched, no phantom credit.
  fan.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: 10 });
  await waitFor(() => fan.client.msgs.filter(m => m.type === 'zcoins' && m.zcoins === 10).pop(), 5000, 'fan drained to 10z');
  fan.client.send({ type: 'tip', amount: 25 });
  const poor = await waitFor(() => fan.client.msgs.filter(m => m.type === 'notice' && /needs 25z/.test(m.text)).pop(), 5000, 'insufficient-funds tip refused');
  assert.ok(poor);
  await sleep(300);
  assert.equal(perf.client.msgs.filter(m => m.type === 'notice' && /tipped you/.test(m.text)).length, 1, 'no phantom second tip landed');
  perf.client.ws.close(); fan.client.ws.close();
});

test('stage lockout (Item A): platform is the performer\'s alone mid-set, open between sets', { timeout: 90000 }, async () => {
  const a = await makeUser('lock_perf');
  const b = await makeUser('lock_fan');
  const mixA = await saveMix(a, 1, SHORT_MIX);
  await prepCd(a, mixA.id);
  await toBay(a);
  await toBay(b);
  await sleep(300);

  // Bay stage rect (tiles 33..42 x 6..8) and pit (rows 9..11) in px.
  const STAGE = { x0: 1056, x1: 1376, y0: 192, y1: 288 };
  const PIT = { x0: 1056, x1: 1376, y0: 288, y1: 384 };
  const posOf = (u, who) => {
    const s = u.client.msgs.filter(m => m.type === 'snapshot').pop();
    const p = s && s.players.find(q => q.id === who);
    return p ? { x: p.x, y: p.y } : null;
  };

  a.client.send({ type: 'stage-join', mixId: mixA.id });
  await waitFor(() => a.client.msgs.filter(m => m.type === 'performance-start').pop(), 5000, 'set started');

  // Bystander in the pit holds NORTH for 1.6s: walks up to the
  // platform edge and no further — never inside the stage rect.
  b.client.send({ type: 'debug-teleport', x: 1216, y: 336 });
  await sleep(250);
  b.client.send({ type: 'input', keys: { up: true } });
  await sleep(1600);
  b.client.send({ type: 'input', keys: {} });
  const bPos = await waitFor(() => posOf(b, b.id), 5000, 'B position sampled');
  assert.ok(bPos.y < 330, `B walked toward the stage (y=${bPos.y})`);
  assert.ok(bPos.y >= STAGE.y1 - 4, `B never entered the platform (y=${bPos.y} >= ${STAGE.y1})`);
  assert.ok(!(bPos.x > STAGE.x0 && bPos.x < STAGE.x1 && bPos.y > STAGE.y0 && bPos.y < STAGE.y1), 'B outside the stage rect');

  // Teleported onto the platform mid-set: swept into the pit.
  b.client.send({ type: 'debug-teleport', x: 1216, y: 240 });
  const swept = await waitFor(() => {
    const p = posOf(b, b.id);
    return p && p.x >= PIT.x0 && p.x <= PIT.x1 && p.y >= PIT.y0 && p.y <= PIT.y1 ? p : null;
  }, 5000, 'B stepped off into the pit');
  assert.ok(swept, 'non-performer on the platform is relocated to the pit');

  // The performer moves freely ON the platform (and stays on it).
  const aBefore = await waitFor(() => posOf(a, a.id), 5000, 'A position sampled');
  a.client.send({ type: 'input', keys: { right: true } });
  await sleep(700);
  a.client.send({ type: 'input', keys: {} });
  const aAfter = await waitFor(() => posOf(a, a.id), 5000, 'A moved');
  assert.ok(aAfter.x > aBefore.x + 10, `performer walks the platform (${aBefore.x} -> ${aAfter.x})`);
  assert.ok(aAfter.x >= STAGE.x0 && aAfter.x <= STAGE.x1 && aAfter.y >= STAGE.y0 && aAfter.y <= STAGE.y1,
    'performer stays on the platform');

  // Set ends (3s mix + 10s grace): the lock releases and the
  // bystander can step up onto the platform.
  await waitFor(() => b.client.msgs.filter(m => m.type === 'performance-end').pop(), 30000, 'set ended');
  b.client.send({ type: 'input', keys: { up: true } });
  await sleep(1500);
  b.client.send({ type: 'input', keys: {} });
  const bUp = await waitFor(() => posOf(b, b.id), 5000, 'B position after release');
  assert.ok(bUp.y < STAGE.y1, `after the set, B steps onto the platform (y=${bUp.y})`);

  a.client.ws.close(); b.client.ws.close();
});
