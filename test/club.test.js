'use strict';

/**
 * Solarion — Club Mirage tests (v1.4): the Neon District's go-go
 * bar. Covers the room as DATA (big interior, three stages each
 * with a named blonde curvy-figure dancer fixture, a bar with a
 * named bartender, the door graph both ways, the client payload),
 * the shared bar/vice wiring at the club's bar (the daily free
 * drink + 10z house tip, then 5z pours, vice-state counting — the
 * same game.js path the casinos use), and the dancer tip economy
 * end to end: preset amounts only, ringside proximity to the
 * dancer's stage, a per-player cooldown, the guarded debit (the
 * tip is a pure SINK — nobody is credited), the room-wide flourish
 * broadcast, nearest-dancer resolution when no id is sent, and the
 * insufficient-funds refusal. Plus a club-chair sit/stand/re-sit
 * regression for the universal seat-release law.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { MAPS, clientMap, isSolidTile } = require('../src/maps');
const { TIP_AMOUNTS } = require('../src/club');

const RUN = process.env.TEST_RUN || 'x';
const PORT = 50700 + (Number(RUN) || 0) * 20;
const DB = path.join(__dirname, '..', 'data', `club-run-${RUN}.db`);
const BASE = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await sleep(50);
  }
}

async function api(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['src/server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, SOLARION_PORT: String(PORT), SOLARION_DB_PATH: DB, SOLARION_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('listening on')) resolve(child);
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out.slice(-400)}`)));
    setTimeout(() => reject(new Error(`server start timeout: ${out.slice(-400)}`)), 20000);
  });
}

async function connectClient(token) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(token)}`);
  const client = { ws, msgs: [], hello: null, send: (m) => ws.send(JSON.stringify(m)) };
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('ws connect timeout')), 8000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      client.msgs.push(m);
      if (m.type === 'hello') { client.hello = m; clearTimeout(to); resolve(); }
    });
    ws.on('error', reject);
  });
  return client;
}

async function makeUser(name) {
  const reg = await api('/api/register', { username: name, password: 'secretpw' });
  assert.equal(reg.status, 200, `register ${name}`);
  const cc = await api('/api/create-character', { token: reg.json.token, name, gender: 'F' });
  assert.equal(cc.status, 200, `create ${name}`);
  const client = await connectClient(reg.json.token);
  return { name, token: reg.json.token, id: client.hello.you.id, client };
}

function teleport(user, x, y) { user.client.send({ type: 'debug-teleport', x, y }); }

/** Consume map messages in order (never a stale previous visit). */
async function arriveMap(user, mapId) {
  if (!user._seen) user._seen = {};
  const want = (user._seen[mapId] || 0) + 1;
  const m = await waitFor(() => {
    const all = user.client.msgs.filter(x => x.type === 'map' && x.map.id === mapId);
    return all.length >= want ? all[want - 1] : null;
  }, 6000, `${user.name} arrives in ${mapId}`);
  user._seen[mapId] = want;
  return m;
}

async function fund(user, zcoins) {
  user.client.send({ type: 'debug-casino', op: 'set-balance', zcoins });
  await waitFor(() => user.client.msgs.filter(m => m.type === 'zcoins' && m.zcoins === zcoins).pop(),
    5000, `${user.name} funded ${zcoins}z`);
}

async function balanceOf(token) {
  const s = await api('/api/me', { token });
  return s.json.avatar.zcoins;
}

let server;
before(async () => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix); } catch (e) { /* fresh */ } }
  server = await startServer();
});
after(async () => {
  if (server) server.kill('SIGTERM');
  await sleep(200);
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix); } catch (e) { /* ignore */ } }
});

// ---------------------------------------------------------------- data

test('club mirage: a big room with three stages, blonde curvy dancers, and a bar', () => {
  const club = MAPS['club-mirage'];
  assert.ok(club, 'club-mirage map exists');
  assert.equal(club.tiles.w, 40);
  assert.equal(club.tiles.h, 26);
  assert.ok(club.club, 'club def present');
  assert.equal(club.club.stages.length, 3, 'three little stages');
  const names = [];
  for (const stg of club.club.stages) {
    assert.ok(stg.pole, 'every stage has a pole');
    const d = stg.dancer;
    assert.ok(d, 'every stage has its dancer');
    names.push(d.name);
    assert.equal(d.look.gender, 'F');
    assert.equal(d.look.figure, 'curvy', `${d.name} dances with the curvier fixture figure`);
    // blonde: a light, warm hair colour (high red+green, some blue)
    const hex = d.look.hair_color;
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    assert.ok(r > 200 && g > 160 && b > 70 && r >= g && g > b, `${d.name} is blonde (${hex})`);
    // she stands ON her stage, not embedded in a wall tile
    const tx = Math.floor(d.x / 32), ty = Math.floor(d.y / 32);
    assert.ok(!isSolidTile(club, tx, ty), `${d.name} stands on a walkable tile`);
    assert.ok(d.x >= stg.x && d.x < stg.x + stg.w && d.y >= stg.y && d.y < stg.y + stg.h,
      `${d.name} stands inside her stage rect`);
  }
  assert.deepEqual(names.sort(), ['Lola', 'Roxy', 'Vega']);
  assert.ok(club.club.bar, 'the bar has a patron spot');
  assert.equal(club.club.bartender.name, 'Mira');
  assert.ok(!isSolidTile(club, Math.floor(club.club.bar.x / 32), Math.floor(club.club.bar.y / 32)),
    'the bar patron spot is standable');
  assert.deepEqual(TIP_AMOUNTS, [5, 10, 25, 50, 100], 'tip presets mirror the stage tip box');
});

test('club mirage: the door graph — Neon face door in, club door back out', () => {
  const neon = MAPS['neon-district'];
  const club = MAPS['club-mirage'];
  const inDoor = neon.doors.find(d => d.target === 'club-mirage');
  assert.ok(inDoor, 'Neon has a door to the club');
  assert.equal(inDoor.label, 'Club Mirage');
  const outDoor = club.doors.find(d => d.target === 'neon-district');
  assert.ok(outDoor, 'the club has a door back to Neon');
  // both landings standable
  assert.ok(!isSolidTile(club, Math.floor(inDoor.targetSpawn.x / 32), Math.floor(inDoor.targetSpawn.y / 32)),
    'the club-side landing is standable');
  assert.ok(!isSolidTile(neon, Math.floor(outDoor.targetSpawn.x / 32), Math.floor(outDoor.targetSpawn.y / 32)),
    'the Neon-side landing is standable');
  // the building sits on the Neon map with its door on the front face
  const b = neon.buildings.find(x => x.style === 'club');
  assert.ok(b, 'Neon renders a club-styled building');
  assert.equal(inDoor.y / 32, b.ty + b.th, 'the door sits on the facade front row');
  assert.ok(inDoor.x / 32 >= b.tx && inDoor.x / 32 < b.tx + b.tw, 'the door is within the facade span');
});

test('club mirage: the client payload carries stages, dancers, bar and bartender', () => {
  const cm = clientMap(MAPS['club-mirage']);
  assert.ok(cm.club, 'club serialized');
  assert.equal(cm.club.stages.length, 3);
  assert.equal(cm.club.stages[0].dancer.look.figure, 'curvy', 'fixture figure reaches the client');
  assert.ok(cm.club.bartender.look, 'bartender look serialized');
  assert.equal(cm.club.bar.x, MAPS['club-mirage'].club.bar.x, 'bar spot serialized in px');
});

// ---------------------------------------------------------------- flow

test('club mirage: walk in through the Neon door; drinks pour on the shared vice path', async () => {
  const u = await makeUser('club_cleo');
  await fund(u, 300);
  // gateway -> Neon gatehouse arch
  teleport(u, 224, 48);
  await arriveMap(u, 'neon-district');
  await sleep(1600); // portal debounce
  // the club's front door (Neon tile 9,38 -> px centre)
  teleport(u, 304, 1232);
  const entered = await arriveMap(u, 'club-mirage');
  assert.equal(entered.map.club.stages.length, 3, 'entered the club through its door');

  // stand at the bar and drink: first of the day is the house's
  await sleep(1600); // arrival transfer lock
  const bar = MAPS['club-mirage'].club.bar;
  teleport(u, bar.x, bar.y);
  await sleep(300);
  u.client.send({ type: 'buy-drink' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /on the house/.test(m.text)).pop(),
    5000, 'the club pours the daily free drink');
  assert.equal(await balanceOf(u.token), 310, 'free drink + the 10z house tip');
  u.client.send({ type: 'buy-drink' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && m.drinks === 2).pop(),
    5000, 'vice-state counts the second drink');
  assert.equal(await balanceOf(u.token), 305, 'the second pour costs 5z');
  u.client.ws.close();
});

test('club mirage: tips — presets, proximity, cooldown, the sink, the flourish', async () => {
  const tipper = await makeUser('club_tess');
  const watcher = await makeUser('club_wren');
  await fund(tipper, 300);
  await fund(watcher, 123); // a known balance, to prove the sink credits nobody
  // both into the club
  for (const u of [tipper, watcher]) {
    teleport(u, 224, 48);
    await arriveMap(u, 'neon-district');
    await sleep(1600);
    teleport(u, 304, 1232);
    await arriveMap(u, 'club-mirage');
  }
  const club = MAPS['club-mirage'].club;
  const [stg1, stg2] = club.stages;
  await sleep(1600); // arrival transfer locks
  // tipper ringside at stage 1; watcher loiters mid-room and must
  // still SEE the flourish (it is a room broadcast)
  teleport(tipper, stg1.x + stg1.w / 2, stg1.y + stg1.h + 40);
  teleport(watcher, 960, 600);
  await sleep(300);

  tipper.client.send({ type: 'tip-dancer', dancer: stg1.dancer.id, amount: 25 });
  await waitFor(() => tipper.client.msgs.filter(m => m.type === 'zcoins' && m.zcoins === 275).pop(),
    5000, 'tip debits 25z');
  const fl = await waitFor(() => watcher.client.msgs.filter(m =>
    m.type === 'dancer-flourish' && m.dancer === stg1.dancer.id && m.amount === 25 && m.from === 'club_tess').pop(),
    5000, 'the room sees Roxy flourish');
  assert.ok(fl);
  assert.equal(await balanceOf(watcher.token), 123, 'the watcher gains nothing — a tip is a sink');

  // immediate re-tip: the cooldown refuses, no debit
  tipper.client.send({ type: 'tip-dancer', dancer: stg1.dancer.id, amount: 5 });
  await waitFor(() => tipper.client.msgs.filter(m => m.type === 'notice' && /still twirling/.test(m.text)).pop(),
    5000, 'cooldown notice');
  assert.equal(await balanceOf(tipper.token), 275, 'cooldown tip never debited');

  // a non-preset amount is refused outright
  await sleep(2600);
  tipper.client.send({ type: 'tip-dancer', dancer: stg1.dancer.id, amount: 7 });
  await waitFor(() => tipper.client.msgs.filter(m => m.type === 'notice' && /preset/.test(m.text)).pop(),
    5000, 'preset notice');
  assert.equal(await balanceOf(tipper.token), 275, 'non-preset tip never debited');

  // across the room is too far for THAT dancer
  teleport(tipper, 960, 640);
  await sleep(300);
  tipper.client.send({ type: 'tip-dancer', dancer: stg1.dancer.id, amount: 10 });
  await waitFor(() => tipper.client.msgs.filter(m => m.type === 'notice' && /Sidle up/.test(m.text)).pop(),
    5000, 'proximity notice');
  assert.equal(await balanceOf(tipper.token), 275, 'distant tip never debited');

  // no id: the tip finds the nearest dancer (stage 2 from its front)
  teleport(tipper, stg2.x + stg2.w / 2, stg2.y + stg2.h + 40);
  await sleep(300);
  tipper.client.send({ type: 'tip-dancer', amount: 10 });
  await waitFor(() => watcher.client.msgs.filter(m =>
    m.type === 'dancer-flourish' && m.dancer === stg2.dancer.id && m.amount === 10).pop(),
    5000, 'nearest-dancer flourish (Vega)');
  assert.equal(await balanceOf(tipper.token), 265);

  // empty pockets: the guarded debit refuses cleanly
  await fund(tipper, 10);
  await sleep(2600);
  tipper.client.send({ type: 'tip-dancer', dancer: stg2.dancer.id, amount: 25 });
  await waitFor(() => tipper.client.msgs.filter(m => m.type === 'notice' && /needs 25z/.test(m.text)).pop(),
    5000, 'insufficient-funds notice');
  assert.equal(await balanceOf(tipper.token), 10, 'broke tip never debited');

  tipper.client.ws.close();
  watcher.client.ws.close();
});

test('club mirage: a table chair sits, releases, and re-sits', async () => {
  const u = await makeUser('club_sana');
  teleport(u, 224, 48);
  await arriveMap(u, 'neon-district');
  await sleep(1600);
  teleport(u, 304, 1232);
  await arriveMap(u, 'club-mirage');
  await sleep(1600); // arrival transfer lock
  const chair = MAPS['club-mirage'].seats[0];
  teleport(u, chair.x, chair.y);
  await sleep(300);
  u.client.send({ type: 'interact' });
  const seated = await waitFor(() => {
    const s = u.client.msgs.filter(m => m.type === 'snapshot').pop();
    const me = s && s.players.find(p => p.id === u.id);
    return me && me.seated ? me : null;
  }, 5000, 'seated on a club chair');
  assert.equal(seated.seatId, chair.id);
  // wiggle off (the v1.3.1 leak path), then sit again
  u.client.send({ type: 'input', keys: { left: true } });
  await sleep(450);
  u.client.send({ type: 'input', keys: {} });
  await sleep(250);
  teleport(u, chair.x, chair.y);
  await sleep(300);
  u.client.send({ type: 'interact' });
  const reseated = await waitFor(() => {
    const s = u.client.msgs.filter(m => m.type === 'snapshot').pop();
    const me = s && s.players.find(p => p.id === u.id);
    return me && me.seatId === chair.id ? me : null;
  }, 5000, 're-seated on the same club chair');
  assert.ok(reseated, 'the chair released cleanly');
  u.client.ws.close();
});
