'use strict';

/**
 * Solarion Phase 1 — test suite.
 *
 * Spawns real server processes and drives them over HTTP + WebSocket:
 *   1. register/login flow (+ validation, + /api/me)
 *   2. session survives a full server restart (same token, avatar + z coins)
 *   3. two simultaneous clients in the same map see each other
 *   4. server-authoritative movement + wall collision
 *   5. gateway travel Gateway -> Solstice Bay -> Gateway; sealed gateways stay sealed
 *   6. daily +100z bonus credited exactly once per day across relogs
 *   7. per-map chat + rate limiting
 *   8. /health reports status and map/player counts
 *
 * Run:  TEST_RUN=<n> node --test test/test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB_MAIN = path.join(ROOT, 'data', `test-run-${RUN}-main.db`);
const DB_RESTART = path.join(ROOT, 'data', `test-run-${RUN}-restart.db`);
const PORT_MAIN = 48000 + Number(RUN) * 20;
const PORT_RESTART = PORT_MAIN + 1;
const PORT_RESTART2 = PORT_MAIN + 2;

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

function startServer(port, dbPath, wipe = true) {
  if (wipe) {
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try { fs.unlinkSync(f); } catch (e) { /* fresh */ }
    }
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
      if (d.toString().includes('listening on')) {
        clearTimeout(t);
        resolve(child);
      }
    });
    child.on('error', reject);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 5000, 'server exit');
  const i = children.indexOf(child);
  if (i >= 0) children.splice(i, 1);
}

function api(port, route, body) {
  return fetch(`http://localhost:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json() }));
}

/** Connect a ws client; collects all messages; resolves after hello. */
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

function latestSnapshotOf(client, selfId) {
  const snaps = client.msgs.filter(m => m.type === 'snapshot');
  if (!snaps.length) return null;
  const me = snaps[snaps.length - 1].players.find(p => p.id === selfId);
  return me || null;
}

let serverPort = PORT_MAIN;
let users = {}; // name -> { token, avatar, client }

async function registerUser(name, extra) {
  const r = await api(serverPort, '/api/register', {
    username: name, password: 'secretpw',
    shirt: '#aa0000', pants: '#003366', skin_tone: '#f1c27d',
    hair_style: 'short', hair_color: '#222222', ...extra,
  });
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`);
  assert.ok(r.json.ok && r.json.token);
  users[name] = { token: r.json.token, avatar: r.json.avatar };
  return users[name];
}

before(async () => {
  await startServer(PORT_MAIN, DB_MAIN);
});

after(async () => {
  for (const c of [...children]) await stopServer(c).catch(() => {});
});

test('register/login flow and validation', { timeout: 30000 }, async () => {
  const bad = await api(serverPort, '/api/register', { username: 'x', password: 'secretpw' });
  assert.equal(bad.status, 400);
  const dup1 = await registerUser('alice_p1');
  assert.equal(dup1.avatar.name, 'alice_p1');
  assert.equal(dup1.avatar.skin_tone, '#f1c27d');
  assert.equal(dup1.avatar.hair_style, 'short');
  const dup2 = await api(serverPort, '/api/register', { username: 'alice_p1', password: 'secretpw' });
  assert.equal(dup2.status, 400);
  assert.match(dup2.json.error, /taken/);
  const wrong = await api(serverPort, '/api/login', { username: 'alice_p1', password: 'wrongpw' });
  assert.equal(wrong.status, 401);
  const ok = await api(serverPort, '/api/login', { username: 'alice_p1', password: 'secretpw' });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
  const me = await api(serverPort, '/api/me', { token: ok.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.avatar.name, 'alice_p1');
  users.alice_p1.token = ok.json.token;
});

test('two simultaneous clients in the same map see each other', { timeout: 30000 }, async () => {
  await registerUser('bob_p1');
  const a = await connectClient(serverPort, users.alice_p1.token);
  const b = await connectClient(serverPort, users.bob_p1.token);
  users.alice_p1.client = a;
  users.bob_p1.client = b;
  assert.equal(a.hello.map.id, 'the-gateway');
  assert.equal(b.hello.map.id, 'the-gateway');
  const aId = a.hello.you.id, bId = b.hello.you.id;
  users.alice_p1.id = aId; users.bob_p1.id = bId;
  await waitFor(() => {
    const s = a.msgs.filter(m => m.type === 'snapshot').pop();
    return s && s.players.some(p => p.id === bId);
  }, 5000, 'A sees B in snapshots');
  await waitFor(() => {
    const s = b.msgs.filter(m => m.type === 'snapshot').pop();
    return s && s.players.some(p => p.id === aId);
  }, 5000, 'B sees A in snapshots');
  const bobSnap = b.msgs.filter(m => m.type === 'snapshot').pop().players.find(p => p.id === bId);
  assert.equal(bobSnap.name, 'bob_p1');
  assert.equal(bobSnap.skin_tone, '#f1c27d');
});

test('server-authoritative movement and wall collision', { timeout: 30000 }, async () => {
  const c = users.bob_p1.client;
  const id = users.bob_p1.id;
  // Near the west wall: tile col 0 is solid, wall edge at x=32, min centre x=44.
  c.send({ type: 'debug-teleport', x: 76, y: 320 });
  await sleep(300);
  c.send({ type: 'input', keys: { left: true } });
  await sleep(700);
  c.send({ type: 'input', keys: {} });
  const pos = await waitFor(() => latestSnapshotOf(c, id), 3000, 'snapshot after left push');
  assert.ok(pos.x >= 42 && pos.x <= 80, `x clamped by wall, got ${pos.x}`);
  const xBefore = pos.x, yBefore = pos.y;
  c.send({ type: 'input', keys: { up: true } });
  await sleep(650);
  c.send({ type: 'input', keys: {} });
  const pos2 = await waitFor(() => {
    const p = latestSnapshotOf(c, id);
    return p && p.y < yBefore - 40 ? p : null;
  }, 5000, 'moved north');
  assert.ok(Math.abs(pos2.x - xBefore) < 6, `x unchanged while moving up (${pos2.x} vs ${xBefore})`);
});

test('gateway travel: Gateway -> Solstice Bay -> Gateway; sealed stays sealed', { timeout: 60000 }, async () => {
  const a = users.alice_p1.client;
  const b = users.bob_p1.client;
  const aId = users.alice_p1.id, bId = users.bob_p1.id;
  // Solstice Bay gateway rect on the-gateway: x=14*32=448, y=32, w=64,h=32 -> center (480,48)
  a.send({ type: 'debug-teleport', x: 480, y: 48 });
  const toBay = await waitFor(() => a.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(), 5000, 'map switch to solstice-bay');
  assert.equal(toBay.map.name, 'Solstice Bay');
  assert.ok(Math.abs(toBay.you.x - 512) < 2 && Math.abs(toBay.you.y - 480) < 2, 'spawned at bay spawn');
  assert.ok(toBay.map.gateways.some(g => g.label === 'The Gateway' && g.active), 'return gateway listed');
  // B still in the-gateway must stop seeing A (fresh snapshots only —
  //  older ones in the buffer legitimately still show her pre-travel)
  await waitFor(() => {
    const snaps = b.msgs.filter(m => m.type === 'snapshot').slice(-3);
    return snaps.length >= 3 && snaps.every(s => !s.players.some(p => p.id === aId)) ? true : null;
  }, 5000, 'B stops seeing A in fresh snapshots');
  // A sees only herself in the bay
  await waitFor(() => {
    const s = a.msgs.filter(m => m.type === 'snapshot').pop();
    return s && s.players.length === 1 && s.players[0].id === aId;
  }, 5000, 'A alone in solstice-bay');
  // Back through the return gateway: x=15*32=480, y=17*32=544, w=64 -> center (512,560)
  await sleep(1600); // gateway debounce
  a.send({ type: 'debug-teleport', x: 512, y: 560 });
  const toHub = await waitFor(() => a.msgs.filter(m => m.type === 'map' && m.map.id === 'the-gateway').pop(), 5000, 'map switch back to the-gateway');
  assert.equal(toHub.map.name, 'The Gateway');
  // sealed gateway: neon-district arch at x=4*32=128, y=32 -> center (160,48)
  await sleep(1600);
  a.send({ type: 'debug-teleport', x: 160, y: 48 });
  const notice = await waitFor(() => a.msgs.filter(m => m.type === 'notice' && /isn't open yet/.test(m.text)).pop(), 5000, 'sealed notice');
  assert.ok(notice);
  assert.equal(a.msgs.filter(m => m.type === 'map' && m.map.id === 'neon-district').length, 0, 'no travel to sealed city');
});

test('daily +100z bonus credited exactly once per day', { timeout: 30000 }, async () => {
  await registerUser('carol_p1');
  const c1 = await connectClient(serverPort, users.carol_p1.token);
  assert.equal(c1.hello.bonusGranted, true);
  assert.equal(c1.hello.zcoins, 100);
  c1.ws.close();
  await sleep(300);
  const c2 = await connectClient(serverPort, users.carol_p1.token);
  assert.equal(c2.hello.bonusGranted, false, 'no second bonus same day');
  assert.equal(c2.hello.zcoins, 100, 'balance unchanged');
  c2.ws.close();
});

test('per-map chat with rate limiting', { timeout: 30000 }, async () => {
  const a = users.alice_p1.client; // the-gateway
  const b = users.bob_p1.client;   // the-gateway
  const aName = 'alice_p1';
  b.msgs.length = 0; // fresh view
  a.send({ type: 'chat', text: 'hello world' });
  await waitFor(() => b.msgs.some(m => m.type === 'chat' && m.text === 'hello world' && m.from === aName), 5000, 'chat delivered');
  for (let i = 0; i < 12; i++) a.send({ type: 'chat', text: `spam-${i}` });
  await sleep(800);
  const fromA = b.msgs.filter(m => m.type === 'chat' && m.from === aName).length;
  assert.ok(fromA <= 7, `rate limited: B received ${fromA} of 13 from A (expect <= 7)`);
  // rate-limit notice should have reached A
  assert.ok(a.msgs.some(m => m.type === 'notice' && /too fast/.test(m.text)), 'A got rate-limit notice');
});

test('/health reports status and counts', { timeout: 30000 }, async () => {
  const r = await fetch(`http://localhost:${serverPort}/health`).then(r => r.json());
  assert.equal(r.ok, true);
  assert.equal(r.game, 'solarion');
  assert.equal(r.phase, 3);
  assert.ok(r.uptime_s >= 0);
  assert.equal(typeof r.maps['the-gateway'], 'number');
  assert.equal(typeof r.maps['solstice-bay'], 'number');
  assert.equal(r.players_online, r.maps['the-gateway'] + r.maps['solstice-bay']);
  assert.ok(r.players_online >= 2, `expected >=2 online, got ${r.players_online}`);
});

test('session survives a full server restart (same token, avatar + z coins intact)', { timeout: 60000 }, async () => {
  const child1 = await startServer(PORT_RESTART, DB_RESTART);
  const reg = await api(PORT_RESTART, '/api/register', { username: 'dave_p1', password: 'secretpw' });
  assert.equal(reg.status, 200);
  const avatarId = reg.json.avatar.id;
  const token = reg.json.token;
  const c1 = await connectClient(PORT_RESTART, token);
  assert.equal(c1.hello.zcoins, 100);
  c1.ws.close();
  await stopServer(child1);
  await startServer(PORT_RESTART2, DB_RESTART, false);
  const c2 = await connectClient(PORT_RESTART2, token);
  assert.equal(c2.hello.you.id, avatarId, 'same avatar after restart');
  assert.equal(c2.hello.you.name, 'dave_p1');
  assert.equal(c2.hello.zcoins, 100, 'z-coin balance intact after restart');
  assert.equal(c2.hello.bonusGranted, false, 'no duplicate daily bonus after restart');
  assert.equal(c2.hello.map.id, 'the-gateway');
  c2.ws.close();
});
