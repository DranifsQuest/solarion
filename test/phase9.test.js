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
