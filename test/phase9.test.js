'use strict';

/**
 * Solarion Phase 9 — adjustments suite.
 *
 * Covers, per item: (2/3) click-to-move pathfinding + run toggle,
 * (4) navigator data + travel, (6) friends lifecycle + join-friend,
 * (5) burn-to-CD ritual + trophy awards + Top-40 chart, (7) emotes +
 * profile cards, (10) homes v2 (paint/floors, expansion, lock,
 * naming), (11) bartender daily free drink + tip, (12) poker
 * spectators + table chat + slots jackpot accrual/payout.
 *
 * Run:  TEST_RUN=<n> node --test test/phase9.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `p9test-run-${RUN}.db`);
const PORT = 49700 + Number(RUN) * 10;

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

async function makeUser(name, gender = 'M') {
  const r = await api(PORT, '/api/register', { username: name, password: 'secretpw' });
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`);
  const c = await api(PORT, '/api/create-character', { token: r.json.token, name, gender });
  assert.equal(c.status, 200, `create ${name}: ${JSON.stringify(c.json)}`);
  const client = await connectClient(PORT, r.json.token);
  return { name, token: r.json.token, client, id: client.hello.you.id };
}

function myPos(user) {
  const s = user.client.msgs.filter(m => m.type === 'snapshot').pop();
  const me = s && s.players.find(p => p.id === user.id);
  return me || null;
}

async function waitPos(user, pred, timeoutMs, label) {
  return waitFor(() => {
    const p = myPos(user);
    return p && pred(p) ? p : null;
  }, timeoutMs, label);
}

const SHORT_MIX = {
  name: 'P9 Banger', bpm: 160, bars: 2,
  tracks: [{ loopId: 'pop-drums-1', startBar: 0 }, { loopId: 'pop-bass-1', startBar: 0 }],
};

async function saveMix(user, slot, data) {
  user.client.send({ type: 'mix-save', slot, data });
  const saved = await waitFor(
    () => user.client.msgs.filter(m => m.type === 'mix-saved').pop(),
    5000, `mix saved for ${user.name}`);
  return saved.mix;
}

async function toBay(user) {
  user.client.send({ type: 'debug-teleport', x: 1120, y: 48 });
  await waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(),
    5000, `${user.name} arrives in solstice-bay`);
}

// ------------------------------------------------------------ item 5: ritual

test('burn-to-CD: stage refuses without a CD; burning works; the CD is spent at set start', { timeout: 90000 }, async () => {
  const u = await makeUser('ritual_p9');
  const other = await makeUser('ritual_other_p9');
  const mix = await saveMix(u, 1, SHORT_MIX);
  const otherMix = await saveMix(other, 1, { ...SHORT_MIX, name: 'Not Yours' });
  await toBay(u);

  // No CD → the stage refuses with the ritual explanation.
  u.client.send({ type: 'stage-join', mixId: mix.id });
  const refuse = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Burn .* to a CD first/.test(m.text)).pop(),
    5000, 'stage refuses without CD');
  assert.ok(refuse);
  await sleep(400);
  assert.equal(u.client.msgs.filter(m => m.type === 'performance-start').length, 0, 'no performance without a CD');

  // Can't burn someone else's mix.
  u.client.send({ type: 'buy-blanks' });
  const wallet = await waitFor(() => u.client.msgs.filter(m => m.type === 'cds' && m.blanks === 10).pop(), 5000, 'pack of 10 blanks');
  assert.equal(wallet.blanks, 10);
  u.client.send({ type: 'burn-cd', mixId: otherMix.id });
  const ownErr = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /only burn your own/.test(m.text)).pop(),
    5000, 'burn refuses foreign mix');
  assert.ok(ownErr);

  // Burn own → 9 blanks, 1 CD carrying the mix TITLE.
  u.client.send({ type: 'burn-cd', mixId: mix.id });
  const burned = await waitFor(() => u.client.msgs.filter(m => m.type === 'cds' && m.cds.length === 1).pop(), 5000, 'CD burned');
  assert.equal(burned.blanks, 9);
  assert.equal(burned.cds[0].name, 'P9 Banger', 'CD carries the mix title');

  // Now the stage takes us; when the set starts the CD is consumed.
  u.client.send({ type: 'stage-join', mixId: mix.id });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'performance-start').pop(), 8000, 'performance starts with CD');
  const after = await waitFor(() => u.client.msgs.filter(m => m.type === 'cds' && m.cds.length === 0).pop(), 5000, 'CD consumed at set start');
  assert.equal(after.blanks, 9);
  u.client.ws.close(); other.client.ws.close();
});

test('gold trophy at 25 lifetime up-votes + Top-40 chart ranks the set', { timeout: 180000 }, async () => {
  // 9 fans × 3 cities (stage cooldowns are per-map) = 27 lifetime
  // up-votes on one mix — crosses the Gold threshold of 25 without
  // tripping the per-IP account-creation rate limit with 25 fans.
  const perf = await makeUser('gold_p9');
  const mix = await saveMix(perf, 1, SHORT_MIX);
  perf.client.send({ type: 'buy-blanks' });
  await waitFor(() => perf.client.msgs.filter(m => m.type === 'cds' && m.blanks === 10).pop(), 5000, 'blanks');
  for (let i = 0; i < 3; i++) perf.client.send({ type: 'burn-cd', mixId: mix.id });
  await waitFor(() => perf.client.msgs.filter(m => m.type === 'cds' && m.cds.length === 3).pop(), 5000, '3 CDs burned');
  const archFor = (user, label) => user.client.hello.map.gateways.find(g => g.label === label);
  const lastMapId = (u) => {
    const m = [...u.client.msgs].reverse().find(x => x.type === 'map');
    return m ? m.map.id : (u.client.hello ? u.client.hello.map.id : null);
  };
  async function hopOnto(u, x, y) {
    // Portal checks run on movement/teleport and are debounced for
    // 1.5s after each scene switch: step off, wait out the debounce,
    // step back on.
    u.client.send({ type: 'debug-teleport', x, y: y + 72 });
    await sleep(1750);
    u.client.send({ type: 'debug-teleport', x, y });
  }
  async function travelTo(u, label, cityId) {
    if (lastMapId(u) !== 'the-gateway') {
      const lastMap = [...u.client.msgs].reverse().find(x => x.type === 'map');
      const back = lastMap.map.gateways[0]; // the return arch
      await hopOnto(u, back.x + 32, back.y + 16);
      await waitFor(() => lastMapId(u) === 'the-gateway', 8000, `${u.name} back to the Gateway`);
    }
    const arch = archFor(u, label);
    await hopOnto(u, arch.x + 32, arch.y + 16);
    await waitFor(() => lastMapId(u) === cityId, 8000, `${u.name} reaches ${cityId}`);
  }
  const fans = [];
  for (let i = 0; i < 9; i++) fans.push(await makeUser(`goldfan${i}_p9`));
  let totalUps = 0;
  for (const [city, label] of [['solstice-bay', 'Solstice Bay'], ['neon-district', 'Neon District'], ['cinder-mesa', 'Cinder Mesa']]) {
    for (const u of [perf, ...fans]) await travelTo(u, label, city);
    await sleep(300);
    const endsBefore = perf.client.msgs.filter(m => m.type === 'performance-end').length;
    const startsBefore = perf.client.msgs.filter(m => m.type === 'performance-start').length;
    perf.client.send({ type: 'stage-join', mixId: mix.id });
    await waitFor(() => {
      const starts = perf.client.msgs.filter(m => m.type === 'performance-start');
      return starts.length > startsBefore ? starts[starts.length - 1] : null;
    }, 10000, `set starts in ${city}`);
    for (const f of fans) f.client.send({ type: 'vote', value: 1 });
    const end = await waitFor(() => {
      const ends = perf.client.msgs.filter(m => m.type === 'performance-end');
      return ends.length > endsBefore ? ends[ends.length - 1] : null;
    }, 40000, `set ends in ${city}`);
    assert.equal(end.up, 9, `9 fans vote in ${city}`);
    totalUps += end.up;
  }
  assert.equal(totalUps, 27);
  // Item 9: the room saw the votes float by (vote-fx broadcasts).
  assert.ok(perf.client.msgs.filter(m => m.type === 'vote-fx' && m.value === 1).length >= 9,
    'vote-fx broadcasts reached the room');
  const fanfare = await waitFor(() => perf.client.msgs.filter(m => m.type === 'notice' && /GOLD RECORD/.test(m.text)).pop(),
    5000, 'gold record fanfare');
  assert.ok(fanfare);

  perf.client.send({ type: 'chart' });
  const chart = await waitFor(() => perf.client.msgs.filter(m => m.type === 'chart').pop(), 5000, 'chart payload');
  assert.equal(chart.windowDays, 7);
  assert.equal(chart.entries[0].mixId, mix.id, 'the gold mix tops the chart');
  assert.equal(chart.entries[0].title, 'P9 Banger');
  assert.equal(chart.entries[0].ups, 27);
  assert.equal(chart.entries[0].performer, perf.name);
  perf.client.ws.close();
  for (const f of fans) f.client.ws.close();
});

test('records unit: platinum at 100 lifetime ups (once each), chart window excludes old sets', { timeout: 30000 }, async () => {
  process.env.SOLARION_DB_PATH = path.join(ROOT, 'data', `p9-unit-run-${RUN}.db`);
  for (const f of [process.env.SOLARION_DB_PATH]) { try { fs.unlinkSync(f); } catch (e) { /* fresh */ } }
  const { db, q } = require('../src/db');
  require('../src/studio').init();
  require('../src/music').init();
  const records = require('../src/records');
  records.init();
  const u = q.insertUser.run('unit_p9', 'x', 0);
  const uid = Number(u.lastInsertRowid);
  q.insertAvatar.run(uid, 'unit_p9', '#3aa7e0', '#2b3a55', '#f1c27d', 'short', '#3a2a1c', 'the-gateway', 0, 0, 0);
  const mx = db.prepare("INSERT INTO mixes (user_id, slot, name, data, updated_at) VALUES (?, 1, 'Unit Song', '{}', 0)").run(uid);
  const mixId = Number(mx.lastInsertRowid);

  assert.deepEqual(records.recordPerformance(mixId, uid, 60, 0), ['gold-record'], 'gold at ≥25');
  assert.deepEqual(records.recordPerformance(mixId, uid, 39, 0), [], 'nothing new at 99');
  assert.deepEqual(records.recordPerformance(mixId, uid, 1, 0), ['platinum-record'], 'platinum at 100');
  assert.deepEqual(records.recordPerformance(mixId, uid, 50, 0), [], 'trophies are awarded once each');
  const trophies = db.prepare("SELECT item_id FROM studio_items WHERE owner_id = ? ORDER BY item_id").all(uid);
  assert.deepEqual(trophies.map(t => t.item_id), ['gold-record', 'platinum-record'], 'both trophies in home inventory');

  // Chart window: an 8-day-old monster set must NOT chart.
  db.prepare('INSERT INTO perf_history (mix_id, performer_id, up, down, ts) VALUES (?, ?, 500, 0, ?)')
    .run(mixId, uid, Date.now() - 8 * 24 * 3600 * 1000);
  const entries = records.chart();
  const mine = entries.find(e => e.mixId === mixId);
  assert.equal(mine.ups, 150, 'chart counts only the trailing 7 days (60+39+1+50)');
});

test('friends: request → accept, presence + locations, join-friend travel, remove', { timeout: 60000 }, async () => {
  const a = await makeUser('pal_a_p9');
  const b = await makeUser('pal_b_p9');
  // A asks; B is notified and sees the incoming request.
  a.client.send({ type: 'friend-request', username: b.name });
  await waitFor(() => b.client.msgs.filter(m => m.type === 'friend-request' && m.fromId === a.id).pop(),
    5000, 'B notified of friend request');
  const inc = await waitFor(() => {
    const f = b.client.msgs.filter(m => m.type === 'friends').pop();
    return f && f.incoming.some(u => u.id === a.id) ? f : null;
  }, 5000, 'B friends payload shows incoming');
  assert.ok(inc);
  // B accepts.
  b.client.send({ type: 'friend-respond', userId: a.id, accept: true });
  const fa = await waitFor(() => {
    const f = a.client.msgs.filter(m => m.type === 'friends').pop();
    return f && f.friends.some(u => u.id === b.id) ? f : null;
  }, 5000, 'A sees B as friend');
  assert.equal(fa.friends.find(u => u.id === b.id).online, true, 'friend presence: online');

  // B travels to the Bay; A's refreshed list shows the location.
  await toBay(b);
  a.client.send({ type: 'friend-list' });
  const loc = await waitFor(() => {
    const f = a.client.msgs.filter(m => m.type === 'friends').pop();
    const e = f && f.friends.find(u => u.id === b.id);
    return e && e.mapId === 'solstice-bay' ? e : null;
  }, 5000, 'A sees B in Solstice Bay');
  assert.equal(loc.mapName, 'Solstice Bay');

  // Navigator shows the Bay with the friend marker + counts.
  a.client.send({ type: 'navigator' });
  const nav = await waitFor(() => a.client.msgs.filter(m => m.type === 'navigator').pop(), 5000, 'navigator payload');
  const bay = nav.places.find(pl => pl.id === 'solstice-bay');
  assert.ok(bay && bay.count >= 1, 'navigator counts the bay occupants');
  assert.ok(bay.friends.includes(b.name), 'navigator marks where friends are');
  assert.ok(nav.places.some(pl => pl.id === 'casino-lounge'), 'navigator lists interiors');

  // A joins B through the standard transfer.
  a.client.msgs.length = 0;
  a.client.send({ type: 'join-friend', userId: b.id });
  const arrived = await waitFor(() => a.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(),
    8000, 'A joins B in the bay');
  assert.equal(arrived.transferMs, 3000, 'join-friend rides the 3s transfer');
  await waitPos(a, p => Math.hypot(p.x - myPos(b).x, p.y - myPos(b).y) < 160, 10000, 'A lands near B');

  // Navigator travel to a city directly.
  a.client.send({ type: 'navigate', mapId: 'frosthaven' });
  await waitFor(() => a.client.msgs.filter(m => m.type === 'map' && m.map.id === 'frosthaven').pop(),
    8000, 'A navigates to Frosthaven');

  // Remove: both sides drop the friendship; join is refused afterwards.
  a.client.send({ type: 'friend-remove', userId: b.id });
  await waitFor(() => {
    const f = a.client.msgs.filter(m => m.type === 'friends').pop();
    return f && !f.friends.some(u => u.id === b.id) ? f : null;
  }, 5000, 'friendship removed for A');
  a.client.send({ type: 'join-friend', userId: b.id });
  const refusal = await waitFor(() => a.client.msgs.filter(m => m.type === 'notice' && /only join a friend/.test(m.text)).pop(),
    5000, 'join refused for non-friend');
  assert.ok(refusal);
  a.client.ws.close(); b.client.ws.close();
});

test('emotes broadcast + snapshot state; profiles carry look, mixes, friend status', { timeout: 60000 }, async () => {
  const a = await makeUser('emo_a_p9');
  const b = await makeUser('emo_b_p9');
  const mix = await saveMix(a, 1, { ...SHORT_MIX, name: 'Profile Song' });
  assert.ok(mix.id);
  a.client.send({ type: 'emote', emote: 'dance' });
  const ev = await waitFor(() => b.client.msgs.filter(m => m.type === 'emote' && m.userId === a.id).pop(),
    5000, 'B receives A emote broadcast');
  assert.equal(ev.emote, 'dance');
  await waitFor(() => {
    const s = b.client.msgs.filter(m => m.type === 'snapshot').pop();
    const pa = s && s.players.find(p => p.id === a.id);
    return pa && pa.emote === 'dance' ? pa : null;
  }, 5000, 'snapshot carries the active emote');
  // Bad emote names are dropped.
  a.client.send({ type: 'emote', emote: 'backflip' });
  await sleep(400);
  assert.equal(b.client.msgs.filter(m => m.type === 'emote' && m.emote === 'backflip').length, 0);

  b.client.send({ type: 'profile', userId: a.id });
  const prof = await waitFor(() => b.client.msgs.filter(m => m.type === 'profile').pop(), 5000, 'profile payload');
  assert.equal(prof.profile.name, a.name);
  assert.equal(prof.profile.online, true);
  assert.ok(prof.profile.look && prof.profile.look.gender, 'profile carries the look');
  assert.deepEqual(prof.profile.mixes.map(m => m.name), ['Profile Song'], 'profile lists mix titles');
  assert.equal(prof.profile.friendStatus, 'none');
  a.client.ws.close(); b.client.ws.close();
});

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

// ------------------------------------------------------------ items 2/3 + 14 data

test('click-to-move: routes across the plaza and around obstacles; solid targets snap', { timeout: 60000 }, async () => {
  const u = await makeUser('walker_p9');
  // map payload carries named areas (item 14 data)
  assert.ok(u.client.hello.map.areas && u.client.hello.map.areas.some(a => a.name === 'Fountain Plaza'),
    'gateway map ships named areas');

  // Straightforward route east of spawn.
  u.client.send({ type: 'move-to', x: 1424, y: 720 });
  await waitPos(u, p => Math.hypot(p.x - 1424, p.y - 720) < 42, 20000, 'arrives at plaza target');

  // Around the NW market block to the far north-west.
  u.client.send({ type: 'move-to', x: 176, y: 80 });
  await waitPos(u, p => Math.hypot(p.x - 176, p.y - 80) < 48, 30000, 'routes around the market block');

  // A solid target (inside the market block) snaps to a nearby walkable point.
  u.client.send({ type: 'move-to', x: 176, y: 208 });
  await waitPos(u, p => Math.hypot(p.x - 176, p.y - 208) < 7 * 32, 30000, 'solid target snaps nearby');
  const p = myPos(u);
  assert.ok(Math.hypot(p.x - 176, p.y - 208) < 7 * 32);

  // Garbage payloads are ignored, nobody moves, server lives.
  // (First let the snapped route fully finish: sample until stable.)
  await waitFor(() => {
    const a = myPos(u);
    return sleep(450).then(() => {
      const b = myPos(u);
      return a && b && Math.hypot(b.x - a.x, b.y - a.y) < 2 ? b : null;
    });
  }, 15000, 'walker settles');
  const before = myPos(u);
  u.client.send({ type: 'move-to', x: { evil: 1 }, y: [] });
  u.client.send({ type: 'move-to', x: 'north', y: null });
  await sleep(600);
  const afterP = myPos(u);
  assert.ok(Math.hypot(afterP.x - before.x, afterP.y - before.y) < 8, 'garbage move-to does not move the player');
  u.client.ws.close();
});

test('run toggle: running covers clearly more ground than walking', { timeout: 60000 }, async () => {
  const u = await makeUser('runner_p9');
  await sleep(200);
  async function dash(run) {
    u.client.send({ type: 'debug-teleport', x: 400, y: 1000 }); // open ground, Gateway south
    await sleep(400);
    const p0 = myPos(u);
    u.client.send({ type: 'run', on: run });
    u.client.send({ type: 'input', keys: { right: true } });
    await sleep(1200);
    u.client.send({ type: 'input', keys: {} });
    const p1 = myPos(u);
    return p1.x - p0.x;
  }
  const walk = await dash(false);
  const run = await dash(true);
  assert.ok(walk > 120, `walk dash moved (${walk}px)`);
  assert.ok(run > walk * 1.35, `run dash (${run}px) beats walk (${walk}px) by >35%`);
  u.client.ws.close();
});
