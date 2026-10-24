'use strict';

/**
 * Solarion v1.9 — the Visitors test suite.
 *
 * Spawns a real server (SOLARION_TEST=1, so the Threshold's show
 * runs compressed: SCENE_MS 8000 instead of four minutes) and
 * drives the full escape loop over HTTP + WebSocket:
 *   a. summon rights: hello.canSummon is Zantheon-only; a guest's
 *      summon is refused, Zantheon's call brings Orenius to the
 *      Gateway (visitor-state reaches the room)
 *   b. the blue fruit: dialogue opens (mode 'fruit', his four
 *      lines), blue ends it and the guest stays in the Gateway
 *   c. the red fruit: the guest wakes in the Threshold, SEATED and
 *      captive (a move-to order goes nowhere), the scene streams,
 *      the portal opens on the timeline
 *   d. through the portal: the guest lands in Elsewhere; the
 *      Navigator hides both hidden places; navigate-home from
 *      Elsewhere is refused ("the way is shut")
 *   e. Agent Sims: summoned by the owner, his dialogue is mode
 *      'code'; a wrong code earns a refusal line and no movement;
 *      code 571 sends the guest home to the Gateway
 *   f. fast travel INTO a hidden place is refused too
 *
 * Run:  TEST_RUN=<n> node --test test/visitors.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `vtest-run-${RUN}.db`);
const PORT = 51300 + Number(RUN) * 20;

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
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${token}`);
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
  const c = await api(PORT, '/api/create-character', { token: r.json.token, name, gender: 'M' });
  assert.equal(c.status, 200, `create ${name}: ${JSON.stringify(c.json)}`);
  const client = await connectClient(PORT, r.json.token);
  return { name, token: r.json.token, client, id: client.hello.you.id };
}

const selfOf = (u) => {
  const s = u.client.msgs.filter(m => m.type === 'snapshot').pop();
  return s ? s.players.find(p => p.id === u.id) : null;
};
const lastMap = (u) => u.client.msgs.filter(m => m.type === 'map').pop();

let server;
let owner;   // the account named exactly 'zantheon'
let guest;

before(async () => {
  server = await startServer(PORT, DB);
  owner = await makeUser('zantheon');
  guest = await makeUser('visitorguest');
});

after(async () => {
  for (const u of [owner, guest]) { try { u.client.ws.close(); } catch (e) { /* done */ } }
  await stopServer(server);
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* done */ } }
});

test('the visitors: summon rights, two fruits, the chair, the portal, the code', { timeout: 120000 }, async () => {
  // (a) summon rights ride hello — and only on the owner's account.
  assert.equal(owner.client.hello.you.canSummon, true, 'zantheon can summon');
  assert.equal(guest.client.hello.you.canSummon, false, 'a guest cannot summon');

  guest.client.send({ type: 'visitor-summon', id: 'orenius' });
  const refusal = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'notice' && /Nothing happens/.test(m.text)).pop(),
    5000, 'guest summon refused');
  assert.ok(refusal);
  await sleep(300);
  assert.ok(!guest.client.msgs.some(m => m.type === 'visitor-state' && m.id === 'orenius' && m.present),
    'no Orenius after a guest summon');

  owner.client.send({ type: 'visitor-summon', id: 'orenius' });
  const state = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'visitor-state' && m.id === 'orenius' && m.present).pop(),
    5000, 'Orenius present in the Gateway');
  assert.equal(state.name, 'Orenius');

  // Stand at his shoulder: the anchor is tile (33,24) = (1072,784).
  guest.client.send({ type: 'debug-teleport', x: 1072, y: 836 });
  await sleep(250);

  // (b) the blue fruit.
  guest.client.send({ type: 'visitor-talk', id: 'orenius' });
  const dlg = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'visitor-dialogue' && m.id === 'orenius').pop(),
    5000, 'Orenius dialogue opens');
  assert.equal(dlg.mode, 'fruit');
  assert.equal(dlg.lines.length, 4);
  guest.client.send({ type: 'visitor-choice', choice: 'blue' });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'visitor-dialogue-end' && m.id === 'orenius').pop(),
    5000, 'blue fruit ends the talk');
  await sleep(300);
  assert.ok(!lastMap(guest) || lastMap(guest).map.id === 'the-gateway', 'blue fruit: still in the Gateway');

  // (c) the red fruit — the chair, the lock, the show.
  guest.client.send({ type: 'visitor-talk', id: 'orenius' });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'visitor-dialogue' && m.id === 'orenius').length >= 2,
    5000, 'Orenius dialogue reopens');
  guest.client.send({ type: 'visitor-choice', choice: 'red' });
  const thMap = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'map' && m.map.id === 'the-threshold').pop(),
    5000, 'red fruit: the Threshold');
  assert.ok(thMap.map.portal, 'the Threshold map carries its portal spot');
  const scene = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'scene-state' && m.phase === 'running').pop(),
    5000, 'the scene is running');
  assert.equal(scene.actors.length, 4, 'a crew of four');
  const seated = await waitFor(() => { const s = selfOf(guest); return s && s.seated ? s : null; },
    5000, 'the guest is seated in the chair');
  assert.ok(Math.hypot(seated.x - 304, seated.y - 272) < 2, 'seated on the chair tile (9,8)');
  // Captive: a walk order goes nowhere.
  guest.client.send({ type: 'move-to', x: 120, y: 120 });
  await sleep(800);
  const still = selfOf(guest);
  assert.ok(still && Math.hypot(still.x - 304, still.y - 272) < 2, 'captive: the chair holds (no movement)');
  // Captions arrive while the crew works.
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'scene-line').pop(),
    5000, 'scene captions flow');
  // The portal opens on the (compressed) timeline.
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'scene-state' && m.portalOpen).pop(),
    15000, 'the portal opens');
  const freed = await waitFor(() => { const s = selfOf(guest); return s && !s.seated ? s : null; },
    5000, 'the chair lets go when the portal opens');
  assert.ok(freed);

  // (d) through the portal.
  guest.client.send({ type: 'move-to', x: 304, y: 80 });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'map' && m.map.id === 'elsewhere').pop(),
    8000, 'through the portal: Elsewhere');
  guest.client.send({ type: 'navigator' });
  const nav = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'navigator').pop(),
    5000, 'navigator answers');
  const placeIds = nav.places.map(pl => pl.id);
  assert.ok(!placeIds.includes('elsewhere'), 'Elsewhere is hidden from the Navigator');
  assert.ok(!placeIds.includes('the-threshold'), 'the Threshold is hidden from the Navigator');
  assert.equal(placeIds.length, 11, 'the public world still lists eleven places');
  guest.client.send({ type: 'navigate-home', ownerId: guest.id });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'notice' && /way is shut/.test(m.text)).pop(),
    5000, 'navigate-home out of Elsewhere is refused');
  await sleep(250);
  assert.equal(lastMap(guest).map.id, 'elsewhere', 'still in Elsewhere after the refused warp');

  // (e) Agent Sims and the code.
  owner.client.send({ type: 'visitor-summon', id: 'sims' });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'visitor-state' && m.id === 'sims' && m.present).pop(),
    5000, 'Agent Sims present in Elsewhere');
  // The guest stands at the spawn (432,336); Sims waits at (432,240) — in talk range.
  guest.client.send({ type: 'visitor-talk', id: 'sims' });
  const sdlg = await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'visitor-dialogue' && m.id === 'sims').pop(),
    5000, 'Sims dialogue opens');
  assert.equal(sdlg.mode, 'code');
  assert.equal(sdlg.name, 'Agent Sims');
  guest.client.send({ type: 'visitor-code', code: '999' });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'visitor-dialogue-line' && m.id === 'sims').pop(),
    5000, 'a wrong code earns the refusal line');
  await sleep(250);
  assert.equal(lastMap(guest).map.id, 'elsewhere', 'a wrong code goes nowhere');
  guest.client.send({ type: 'visitor-code', code: '571' });
  await waitFor(
    () => guest.client.msgs.filter(m => m.type === 'map' && m.map.id === 'the-gateway').pop(),
    5000, 'code 571: home to the Gateway');

  // (f) fast travel INTO a hidden place is refused, even for the owner.
  owner.client.msgs.length = 0;
  owner.client.send({ type: 'navigate', mapId: 'elsewhere' });
  await waitFor(
    () => owner.client.msgs.filter(m => m.type === 'notice' && /way is shut/.test(m.text)).pop(),
    5000, 'owner navigate into Elsewhere is refused');
  assert.ok(!owner.client.msgs.some(m => m.type === 'map' && m.map.id === 'elsewhere'),
    'the owner did not warp');
});
