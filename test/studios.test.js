'use strict';

/**
 * Solarion Phase 4 — cities / studios / avatar editing test suite.
 *
 * Spawns real server processes and drives them over HTTP + WebSocket:
 *   a. travel: Gateway -> each of the 4 new cities and back; players
 *      in different cities don't see each other; every city has a
 *      stage zone and a distinct palette
 *   b. a stage queue/performance/vote pays out in a NEW city
 *      (Neon District), reusing the Phase 2 protocol unchanged
 *   c. studio: owner buys furniture (exact atomic debit), insufficient
 *      funds rejected with balance untouched, place persists across
 *      relog AND across a full server restart; door/out-of-bounds/
 *      bad-rotation placements rejected
 *   d. visitor sees placed furniture, cannot buy/place/pickup/kick;
 *      owner kicks visitor -> Gateway, re-entry blocked; studio
 *      isolation (occupants of different studios never see each other)
 *   e. avatar edit: WS update is visible to another client without a
 *      relog, persists across relog, invalid style/color rejected;
 *      POST /api/avatar works and validates the same way
 *
 * Run:  TEST_RUN=<n> node --test test/studios.test.js (or npm test)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `stest-run-${RUN}.db`);
const DB_RESTART = path.join(ROOT, 'data', `stest-run-${RUN}-restart.db`);
const PORT = 49900 + Number(RUN) * 20;
const PORT_R1 = PORT + 5;
const PORT_R2 = PORT + 6;

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
      if (d.toString().includes('listening on')) { clearTimeout(t); resolve(child); }
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

async function makeUser(name, port = PORT) {
  const r = await api(port, '/api/register', {
    username: name, password: 'secretpw',
    shirt: '#aa0000', pants: '#003366', skin_tone: '#f1c27d',
    hair_style: 'short', hair_color: '#222222',
  });
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`);
  // Phase 6: create the character before entering the world.
  const c = await api(port, '/api/create-character', { token: r.json.token, name, gender: 'M' });
  assert.equal(c.status, 200, `create ${name}: ${JSON.stringify(c.json)}`);
  const client = await connectClient(port, r.json.token);
  return { name, token: r.json.token, client, id: client.hello.you.id };
}

/** Teleport onto a Gateway arch (tile coords) and wait for the map switch. */
async function travelViaArch(user, archTx, expectMapId) {
  await sleep(1600); // gateway debounce
  user.client.send({ type: 'debug-teleport', x: archTx * 32 + 32, y: 48 });
  return waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === expectMapId).pop(),
    5000, `${user.name} travels to ${expectMapId}`);
}

/** Teleport onto a return-gateway rect inside a city and wait for the hub. */
async function travelBack(user, cx, cy) {
  await sleep(1600);
  user.client.send({ type: 'debug-teleport', x: cx, y: cy });
  return waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === 'the-gateway').pop(),
    5000, `${user.name} returns to the-gateway`);
}

const SHORT_MIX = {
  name: 'Neon Test', bpm: 160, bars: 2,
  tracks: [
    { loopId: 'pop-drums-1', startBar: 0 },
    { loopId: 'pop-bass-1', startBar: 0 },
  ],
};

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

// ------------------------------------------------------------------ (a)
test('travel: all 4 new cities reachable, staged, distinct, and isolated', { timeout: 120000 }, async () => {
  const a = await makeUser('traveler_p4');
  const b = await makeUser('bystander_p4'); // parks in the Gateway

  const cities = [
    { id: 'neon-district', name: 'Neon District', archTx: 6, back: [1152, 1392], floor: '#17102b' },
    { id: 'cinder-mesa', name: 'Cinder Mesa', archTx: 20, back: [128, 1392], floor: '#c47b3a' },
    { id: 'frosthaven', name: 'Frosthaven', archTx: 48, back: [1152, 48], floor: '#d7edf7' },
    { id: 'verdant-hollow', name: 'Verdant Hollow', archTx: 62, back: [2144, 1392], floor: '#2e5d33' },
  ];
  const floors = new Set();
  for (const city of cities) {
    const arrived = await travelViaArch(a, city.archTx, city.id);
    assert.equal(arrived.map.name, city.name);
    assert.equal(arrived.map.floor, city.floor, `${city.id} palette floor`);
    floors.add(arrived.map.floor);
    assert.ok(arrived.map.stage, `${city.id} has a stage zone`);
    assert.equal(arrived.map.stage.speakers.length, 2, `${city.id} stage has 2 speakers`);
    assert.ok(arrived.map.gateways.some(g => g.label === 'The Gateway' && g.active), `${city.id} return gateway active`);
    // isolation: A is alone in this city; B (Gateway) stops seeing A
    await waitFor(() => {
      const s = a.client.msgs.filter(m => m.type === 'snapshot').pop();
      return s && s.players.length === 1 && s.players[0].id === a.id ? s : null;
    }, 5000, `A alone in ${city.id}`);
    await waitFor(() => {
      const snaps = b.client.msgs.filter(m => m.type === 'snapshot').slice(-3);
      return snaps.length >= 3 && snaps.every(s => !s.players.some(p => p.id === a.id)) ? true : null;
    }, 5000, `B no longer sees A while A is in ${city.id}`);
    const back = await travelBack(a, city.back[0], city.back[1]);
    assert.equal(back.map.id, 'the-gateway');
  }
  assert.equal(floors.size, 4, 'four distinct city palettes');
  a.client.ws.close(); b.client.ws.close();
});

// ------------------------------------------------------------------ (b)
test('stage performance works in Neon District (Phase 2 protocol, new city)', { timeout: 90000 }, async () => {
  const perf = await makeUser('neonperf_p4');
  const fan = await makeUser('neonfan_p4');
  // save a mix (Phase 2 CRUD, unchanged)
  perf.client.send({ type: 'mix-save', slot: 1, data: SHORT_MIX });
  const saved = await waitFor(() => perf.client.msgs.filter(m => m.type === 'mix-saved').pop(), 5000, 'mix saved');
  const mixId = saved.mix.id;
  // Phase 9 ritual: buy blanks + burn a CD before the stage will take you.
  perf.client.send({ type: 'buy-blanks' });
  await waitFor(() => perf.client.msgs.filter(m => m.type === 'cds' && m.blanks >= 10).pop(), 5000, 'blanks bought');
  perf.client.send({ type: 'burn-cd', mixId });
  await waitFor(() => perf.client.msgs.filter(m => m.type === 'cds' && m.cds.some(c => c.mixId === mixId)).pop(), 5000, 'CD burned');

  await travelViaArch(perf, 6, 'neon-district');
  await travelViaArch(fan, 6, 'neon-district');
  await sleep(300);

  perf.client.send({ type: 'stage-join', mixId });
  await waitFor(() => fan.client.msgs.filter(m => m.type === 'stage-queue' && m.mapId === 'neon-district' && m.queue.some(e => e.userId === perf.id)).pop(),
    5000, 'fan sees the neon stage queue');
  const start = await waitFor(() => fan.client.msgs.filter(m => m.type === 'performance-start').pop(), 5000, 'neon performance-start');
  assert.equal(start.performerId, perf.id);
  assert.deepEqual(start.mix, SHORT_MIX);
  fan.client.send({ type: 'vote', value: 1 });
  await waitFor(() => fan.client.msgs.filter(m => m.type === 'vote-ack').pop(), 5000, 'vote acked in neon');
  const end = await waitFor(() => fan.client.msgs.filter(m => m.type === 'performance-end').pop(), 30000, 'neon performance-end');
  assert.equal(end.up, 1);
  assert.equal(end.earned, 5, 'performer paid +5z in a new city');
  const zMsg = await waitFor(() => perf.client.msgs.filter(m => m.type === 'zcoins').pop(), 5000, 'perf zcoins update');
  assert.equal(zMsg.zcoins, 85, '100 − 20 (blank pack) + 5 earned = 85');
  perf.client.ws.close(); fan.client.ws.close();
});

// ------------------------------------------------------------- (c) + (d)
test('studio: buy/place/persist, visitor limits, kick + block, isolation', { timeout: 120000 }, async () => {
  const owner = await makeUser('owner_p4');
  const visitor = await makeUser('visitor_p4');
  const other = await makeUser('elsewhere_p4');

  // Owner enters their own studio by username.
  owner.client.send({ type: 'enter-studio', owner: 'owner_p4' });
  const entered = await waitFor(() => owner.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).pop(),
    5000, 'owner enters own studio');
  assert.equal(entered.map.name, "owner_p4's Studio");
  assert.ok(entered.map.studio && entered.map.studio.ownerId === owner.id, 'studio scene payload carries owner');
  assert.deepEqual(entered.furniture, [], 'studio starts empty');
  const state0 = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state' && m.isOwner).pop(), 5000, 'owner studio-state');
  assert.ok(state0.catalog.length >= 12, `catalog has 12+ items, got ${state0.catalog.length}`);
  assert.deepEqual(state0.inventory, []);
  assert.equal(owner.client.hello.zcoins, 100);

  // Insufficient funds first: jukebox is 250z, balance is 100z.
  owner.client.send({ type: 'studio-buy', itemId: 'jukebox' });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'notice' && /Not enough z coins/.test(m.text)).pop(),
    5000, 'insufficient-funds rejection');
  // Buy a chair for exactly 40z: balance and inventory must move exactly.
  owner.client.send({ type: 'studio-buy', itemId: 'cozy-chair' });
  const zAfterChair = await waitFor(() => owner.client.msgs.filter(m => m.type === 'zcoins').pop(), 5000, 'zcoins after chair buy');
  assert.equal(zAfterChair.zcoins, 60, 'chair debited exactly 40z from 100z (failed jukebox buy left balance untouched)');
  const state1 = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state' && m.inventory.length === 1).pop(),
    5000, 'chair in inventory');
  const chair = state1.inventory[0];
  assert.equal(chair.itemId, 'cozy-chair');
  assert.equal(chair.placed, false);

  // Buy a rug 35z -> 25z.
  owner.client.send({ type: 'studio-buy', itemId: 'sun-rug' });
  const zAfterRug = await waitFor(() => owner.client.msgs.filter(m => m.type === 'zcoins' && m.zcoins === 25).pop(), 5000, 'zcoins after rug buy');
  assert.equal(zAfterRug.zcoins, 25);
  const state2 = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state' && m.inventory.length === 2).pop(),
    5000, 'rug in inventory');
  const rug = state2.inventory.find(i => i.itemId === 'sun-rug');

  // Invalid placements: door tile, out of bounds, bad rotation.
  owner.client.send({ type: 'studio-place', instanceItemId: chair.instanceId, x: 10, y: 13, rot: 0 });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'notice' && /door tile/.test(m.text)).pop(), 5000, 'door placement rejected');
  owner.client.send({ type: 'studio-place', instanceItemId: chair.instanceId, x: 0, y: 0, rot: 0 });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'notice' && /outside the studio walls/.test(m.text)).pop(), 5000, 'oob placement rejected');
  owner.client.send({ type: 'studio-place', instanceItemId: chair.instanceId, x: 5, y: 5, rot: 9 });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'notice' && /Rotation/.test(m.text)).pop(), 5000, 'bad rot rejected');

  // Valid placements broadcast live furniture.
  owner.client.send({ type: 'studio-place', instanceItemId: chair.instanceId, x: 5, y: 5, rot: 1 });
  const furn1 = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-furniture' && m.furniture.length === 1).pop(),
    5000, 'chair placement broadcast');
  assert.equal(furn1.furniture[0].x, 5);
  assert.equal(furn1.furniture[0].y, 5);
  assert.equal(furn1.furniture[0].rot, 1);
  owner.client.send({ type: 'studio-place', instanceItemId: rug.instanceId, x: 6, y: 5, rot: 0 });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-furniture' && m.furniture.length === 2).pop(),
    5000, 'rug placement broadcast');

  // A third player sits in their OWN studio (by userId): isolation.
  other.client.send({ type: 'enter-studio', owner: other.id });
  await waitFor(() => other.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${other.id}`).pop(),
    5000, 'other enters own studio by userId');
  await waitFor(() => {
    const s = owner.client.msgs.filter(m => m.type === 'snapshot').pop();
    return s && !s.players.some(p => p.id === other.id) && !s.players.some(p => p.id === visitor.id) ? s : null;
  }, 5000, 'owner snapshot excludes players in other scenes');

  // Visitor enters owner's studio and SEES the placed furniture.
  visitor.client.send({ type: 'enter-studio', owner: 'owner_p4' });
  const vEntered = await waitFor(() => visitor.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).pop(),
    5000, 'visitor enters owner studio');
  assert.equal(vEntered.furniture.length, 2, 'visitor entry payload includes placed furniture');
  assert.deepEqual(vEntered.furniture.map(f => f.itemId).sort(), ['cozy-chair', 'sun-rug']);
  const vState = await waitFor(() => visitor.client.msgs.filter(m => m.type === 'studio-state').pop(), 5000, 'visitor studio-state');
  assert.equal(vState.isOwner, false);
  assert.equal(vState.catalog, undefined, 'visitors never receive the owner catalog/inventory payload');
  // And the owner sees the visitor arrive in snapshots.
  await waitFor(() => {
    const s = owner.client.msgs.filter(m => m.type === 'snapshot').pop();
    return s && s.players.some(p => p.id === visitor.id) ? s : null;
  }, 5000, 'owner sees visitor in studio snapshot');
  // Chat inside the studio is per-instance: owner hears visitor, `other` does not.
  visitor.client.send({ type: 'chat', text: 'nice studio!' });
  await waitFor(() => owner.client.msgs.some(m => m.type === 'chat' && m.text === 'nice studio!'), 5000, 'studio chat delivered in-instance');
  await sleep(400);
  assert.equal(other.client.msgs.filter(m => m.type === 'chat' && m.text === 'nice studio!').length, 0, 'studio chat does not leak to another studio');

  // Visitor CANNOT buy / place / pickup / kick — all rejected server-side.
  visitor.client.msgs.length = 0;
  visitor.client.send({ type: 'studio-buy', itemId: 'cozy-chair' });
  await waitFor(() => visitor.client.msgs.filter(m => m.type === 'notice' && /only buy furniture in your own studio/.test(m.text)).pop(),
    5000, 'visitor buy rejected');
  visitor.client.send({ type: 'studio-place', instanceItemId: chair.instanceId, x: 3, y: 3, rot: 0 });
  await waitFor(() => visitor.client.msgs.filter(m => m.type === 'notice' && /only place furniture in your own studio/.test(m.text)).pop(),
    5000, 'visitor place rejected');
  visitor.client.send({ type: 'studio-pickup', instanceItemId: chair.instanceId });
  await waitFor(() => visitor.client.msgs.filter(m => m.type === 'notice' && /only pick up furniture in your own studio/.test(m.text)).pop(),
    5000, 'visitor pickup rejected');
  visitor.client.send({ type: 'studio-kick', userId: owner.id });
  await waitFor(() => visitor.client.msgs.filter(m => m.type === 'notice' && /Only the studio owner can kick/.test(m.text)).pop(),
    5000, 'visitor kick rejected');
  // Furniture is untouched by all of that (owner's view of the world).
  owner.client.send({ type: 'studio-state' });
  const stateAfter = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state' && m.inventory.length === 2).pop(),
    5000, 'owner state after visitor attempts');
  const chairAfter = stateAfter.inventory.find(i => i.itemId === 'cozy-chair');
  assert.equal(chairAfter.placed, true);
  assert.equal(chairAfter.x, 5);
  assert.equal(chairAfter.y, 5);

  // Owner kicks the visitor: visitor lands in the Gateway, re-entry blocked.
  owner.client.send({ type: 'studio-kick', userId: visitor.id });
  const kicked = await waitFor(() => visitor.client.msgs.filter(m => m.type === 'map' && m.map.id === 'the-gateway').pop(),
    5000, 'kicked visitor lands in the Gateway');
  assert.ok(kicked);
  await waitFor(() => visitor.client.msgs.filter(m => m.type === 'notice' && /kicked from/.test(m.text)).pop(), 5000, 'kick notice');
  visitor.client.msgs.length = 0;
  visitor.client.send({ type: 'enter-studio', owner: 'owner_p4' });
  await waitFor(() => visitor.client.msgs.filter(m => m.type === 'notice' && /try again in/.test(m.text)).pop(),
    5000, 're-entry blocked after kick');
  await sleep(300);
  assert.equal(visitor.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).length, 0,
    'blocked visitor did not re-enter');

  // Visitor leaving normally returns to where they came from (Gateway).
  other.client.send({ type: 'leave-studio' });
  await waitFor(() => other.client.msgs.filter(m => m.type === 'map' && m.map.id === 'the-gateway').pop(),
    5000, 'leave-studio returns to the Gateway');

  // Persistence across RELOG: owner disconnects, reconnects, re-enters.
  owner.client.ws.close();
  await sleep(400);
  const relog = await connectClient(PORT, owner.token);
  assert.equal(relog.hello.zcoins, 25, 'balance persisted across relog (100 - 40 - 35)');
  relog.send({ type: 'enter-studio', owner: 'owner_p4' });
  const reEntered = await waitFor(() => relog.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${owner.id}`).pop(),
    5000, 'owner re-enters studio after relog');
  assert.equal(reEntered.furniture.length, 2, 'placed furniture persisted across relog');
  assert.deepEqual(
    reEntered.furniture.map(f => [f.itemId, f.x, f.y, f.rot]).sort(),
    [['cozy-chair', 5, 5, 1], ['sun-rug', 6, 5, 0]].sort(),
    'exact placements persisted');
  relog.close ? relog.close() : relog.ws.close();
  visitor.client.ws.close(); other.client.ws.close();
});

// ------------------------------------------------------------------ (c2)
test('studio furniture persists across a full server restart', { timeout: 60000 }, async () => {
  const child1 = await startServer(PORT_R1, DB_RESTART);
  const u = await makeUser('restarter_p4', PORT_R1);
  u.client.send({ type: 'enter-studio', owner: 'restarter_p4' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${u.id}`).pop(), 5000, 'enter studio (pre-restart)');
  u.client.send({ type: 'studio-buy', itemId: 'glow-lamp' }); // 55z
  const zMsg = await waitFor(() => u.client.msgs.filter(m => m.type === 'zcoins').pop(), 5000, 'lamp buy');
  assert.equal(zMsg.zcoins, 45);
  const st = await waitFor(() => u.client.msgs.filter(m => m.type === 'studio-state' && m.inventory.length === 1).pop(), 5000, 'lamp in inventory');
  const lamp = st.inventory[0];
  u.client.send({ type: 'studio-place', instanceItemId: lamp.instanceId, x: 3, y: 4, rot: 2 });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'studio-furniture' && m.furniture.length === 1).pop(), 5000, 'lamp placed');
  u.client.ws.close();
  await stopServer(child1);

  await startServer(PORT_R2, DB_RESTART, false); // same DB, no wipe
  const u2 = await connectClient(PORT_R2, u.token);
  assert.equal(u2.hello.zcoins, 45, 'balance survived restart');
  u2.send({ type: 'enter-studio', owner: 'restarter_p4' });
  const entered = await waitFor(() => u2.msgs.filter(m => m.type === 'map' && m.map.id === `studio:${u.id}`).pop(), 5000, 'enter studio (post-restart)');
  assert.equal(entered.furniture.length, 1, 'placed furniture survived a full server restart');
  assert.equal(entered.furniture[0].itemId, 'glow-lamp');
  assert.equal(entered.furniture[0].x, 3);
  assert.equal(entered.furniture[0].y, 4);
  assert.equal(entered.furniture[0].rot, 2);
  u2.ws.close();
});

// ------------------------------------------------------------------ (e)
test('avatar editing: live for the room, persists, invalid rejected (WS + HTTP)', { timeout: 60000 }, async () => {
  const editor = await makeUser('editor_p4');
  const watcher = await makeUser('watcher_p4'); // same map (Gateway spawn)

  // WS update — full new look.
  editor.client.send({
    type: 'avatar-update',
    hair_style: 'spiky', hair_color: '#ff0000', body_color: '#00ff00', accent_color: '#0000ff',
  });
  const updated = await waitFor(() => editor.client.msgs.filter(m => m.type === 'avatar-updated').pop(), 5000, 'avatar-updated echo');
  assert.equal(updated.avatar.hair_style, 'spiky');
  assert.equal(updated.avatar.hair_color, '#ff0000');
  assert.equal(updated.avatar.body_color, '#00ff00');
  assert.equal(updated.avatar.accent_color, '#0000ff');

  // The watcher sees the new look in snapshots WITHOUT the editor relogging.
  const seen = await waitFor(() => {
    const s = watcher.client.msgs.filter(m => m.type === 'snapshot').pop();
    const p = s && s.players.find(pl => pl.id === editor.id);
    return p && p.hair_style === 'spiky' && p.hair_color === '#ff0000' && p.body_color === '#00ff00' && p.accent_color === '#0000ff' ? p : null;
  }, 5000, 'watcher snapshot shows new look live');
  assert.ok(seen);

  // Invalid style and invalid color are rejected; look stays spiky/green.
  editor.client.msgs.length = 0;
  editor.client.send({ type: 'avatar-update', hair_style: 'dreadhawk' });
  await waitFor(() => editor.client.msgs.filter(m => m.type === 'notice' && /Invalid hair style/.test(m.text)).pop(), 5000, 'bad style rejected');
  editor.client.send({ type: 'avatar-update', hair_color: 'red' });
  await waitFor(() => editor.client.msgs.filter(m => m.type === 'notice' && /Invalid hair color/.test(m.text)).pop(), 5000, 'bad color rejected');
  const still = await waitFor(() => {
    const s = watcher.client.msgs.filter(m => m.type === 'snapshot').pop();
    const p = s && s.players.find(pl => pl.id === editor.id);
    return p && p.hair_style === 'spiky' ? p : null;
  }, 5000, 'look unchanged after invalid updates');
  assert.equal(still.body_color, '#00ff00');

  // HTTP endpoint: same validation, partial update.
  const badHttp = await api(PORT, '/api/avatar', { token: editor.token, hair_style: 'dreadhawk' });
  assert.equal(badHttp.status, 400);
  const noAuth = await api(PORT, '/api/avatar', { token: 'deadbeefdeadbeefdeadbeef', hair_style: 'long' });
  assert.equal(noAuth.status, 401);
  const okHttp = await api(PORT, '/api/avatar', { token: editor.token, hair_style: 'long' });
  assert.equal(okHttp.status, 200);
  assert.equal(okHttp.json.avatar.hair_style, 'long');
  assert.equal(okHttp.json.avatar.body_color, '#00ff00', 'partial HTTP update merged with WS look');

  // Persistence across relog.
  editor.client.ws.close();
  await sleep(400);
  const relog = await connectClient(PORT, editor.token);
  assert.equal(relog.hello.you.hair_style, 'long', 'HTTP edit persisted across relog');
  assert.equal(relog.hello.you.hair_color, '#ff0000');
  assert.equal(relog.hello.you.body_color, '#00ff00');
  assert.equal(relog.hello.you.accent_color, '#0000ff');
  relog.ws.close();
  watcher.client.ws.close();
});
