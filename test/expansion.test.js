'use strict';

/**
 * Solarion Phase 7 ("Phase B" — the big world) test suite.
 *
 *   a. map data sanity at the new scale: dimensions (~5x), spawns,
 *      gateways, doors, seats, stage, casino counts (6 tables/10 slots)
 *   b. door transfer Solstice Bay ⇄ Casino Lounge at protocol level,
 *      incl. the transfer state: the map message carries transferMs
 *      and movement input is LOCKED for the window, then released
 *   c. Gateway ⇄ Gateway Café door round trip with exact landing spots
 *   d. sitting: sit -> snapshot shows seated + facing -> chat works
 *      seated -> occupied seat refused -> re-interact stands ->
 *      movement input stands
 *   e. sitting on placed studio furniture (cozy chair)
 *   f. a full poker hand on one of the NEW tables (table 6)
 *   g. a spin on one of the NEW slot machines (machine 10)
 *
 * Run:  TEST_RUN=<n> node --test test/expansion.test.js (or npm test)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');

process.env.SOLARION_DB_PATH = path.join(__dirname, '..', 'data', `xtest-unit-${process.env.TEST_RUN || '0'}.db`);
const casino = require('../src/casino');
casino.initLedger();
const { MAPS, collides, gatewayAt, clientMap } = require('../src/maps');
const FISHING = require('../src/fishing');

const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `xtest-run-${RUN}.db`);
const PORT = 49900 + Number(RUN) * 20;

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

async function balanceOf(user) {
  const r = await api(PORT, '/api/me', { token: user.token });
  assert.equal(r.status, 200);
  return r.json.avatar.zcoins;
}

function selfIn(client, userId) {
  const s = client.msgs.filter(m => m.type === 'snapshot').pop();
  return s ? s.players.find(p => p.id === userId) || null : null;
}

function teleport(user, x, y) {
  user.client.send({ type: 'debug-teleport', x, y });
}
async function arriveMap(user, mapId) {
  // Consume map messages IN ORDER: each call waits for the NEXT map
  // message for that scene (a bare filter().pop() would happily
  // return the stale message from the previous visit).
  if (!user._seen) user._seen = {};
  const want = (user._seen[mapId] || 0) + 1;
  const m = await waitFor(() => {
    const all = user.client.msgs.filter(x => x.type === 'map' && x.map.id === mapId);
    return all.length >= want ? all[want - 1] : null;
  }, 6000, `${user.name} arrives in ${mapId}`);
  user._seen[mapId] = want;
  return m;
}
async function toBay(user) { teleport(user, 1120, 48); await arriveMap(user, 'solstice-bay'); }
async function toCasino(user) { await toBay(user); await sleep(1600); teleport(user, 496, 1200); await arriveMap(user, 'casino-lounge'); }

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

// ------------------------------------------------------------------ a

test('map data: ~5x scale, spawns/portals/seats/stage all sane', { timeout: 30000 }, () => {
  const OLD_TILES = 32 * 20; // the pre-Phase-B footprint
  const big = ['the-gateway', 'solstice-bay', 'neon-district', 'cinder-mesa', 'frosthaven', 'verdant-hollow'];
  for (const id of big) {
    const m = MAPS[id];
    assert.ok(m, `${id} exists`);
    assert.equal(m.tiles.w, 72, `${id} width`);
    assert.equal(m.tiles.h, 45, `${id} height`);
    const ratio = (m.tiles.w * m.tiles.h) / OLD_TILES;
    assert.ok(ratio >= 4.8 && ratio <= 5.4, `${id} is ~5x the old area (got ${ratio.toFixed(2)}x)`);
    assert.equal(collides(m, m.spawn.x, m.spawn.y, 12), false, `${id} spawn is standable`);
    for (const g of m.gateways) {
      assert.ok(MAPS[g.target], `${id} gateway target ${g.target} exists`);
      assert.equal(collides(m, g.x + g.w / 2, g.y + g.h / 2, 12), false, `${id} gateway pad standable`);
    }
    for (const d of m.doors || []) {
      assert.equal(collides(m, d.x + d.w / 2, d.y + d.h / 2, 12), false, `${id} door pad standable`);
      if (d.target === 'studio:self') continue; // Phase 10: the home door resolves per-player
      assert.ok(MAPS[d.target], `${id} door target ${d.target} exists`);
      assert.equal(collides(MAPS[d.target], d.targetSpawn.x, d.targetSpawn.y, 12), false, `${id} door landing standable`);
    }
    assert.ok((m.seats || []).length >= 4, `${id} has sittable seats (got ${(m.seats || []).length})`);
    for (const s of m.seats) {
      assert.equal(collides(m, s.x, s.y, 12), false, `${id} seat ${s.id} standable`);
      assert.ok(['up', 'down', 'left', 'right'].includes(s.dir), `${id} seat ${s.id} has a facing`);
    }
  }
  // staged cities
  for (const id of ['solstice-bay', 'neon-district', 'cinder-mesa', 'frosthaven', 'verdant-hollow']) {
    assert.ok(MAPS[id].stage, `${id} has a stage`);
    assert.equal(MAPS[id].stage.speakers.length, 2, `${id} stage has 2 speakers`);
  }
  // interiors — Phase B amendment: exactly TWO casinos, one layout.
  for (const cid of ['casino-lounge', 'neon-casino']) {
    const cz2 = MAPS[cid];
    assert.equal(cz2.tiles.w, 36, `${cid} width`); assert.equal(cz2.tiles.h, 24, `${cid} height`);
    assert.ok(cz2.casino, `${cid} carries the casino def`);
    assert.equal(cz2.casino.tables.length, 6, `${cid}: six poker tables`);
    for (const t of cz2.casino.tables) assert.equal(t.chairs.length, 4, `${t.id} has 4 chairs`);
    assert.equal(cz2.casino.slots.length, 10, `${cid}: ten slot machines`);
    for (const t of cz2.casino.tables) {
      for (const c of t.chairs) assert.equal(collides(cz2, c.x, c.y, 12), false, `${t.id} chair ${c.dir} standable`);
    }
    // Slots section is physically separate from the tables (west):
    // every machine sits at x >= 500 while every table is at x <= 450,
    // and every machine has a stool seat wired to it.
    for (const s of cz2.casino.slots) {
      assert.ok(s.x >= 500, `${s.id} is in the slots section (x=${s.x})`);
      assert.equal(collides(cz2, s.ix, s.iy, 12), false, `${s.id} stool standable`);
      assert.ok(cz2.seats.some(seat => seat.id === s.seatId && seat.kind === 'stool'), `${s.id} has its stool seat`);
    }
    for (const t of cz2.casino.tables) assert.ok(t.x <= 450, `${t.id} stays on the poker floor (x=${t.x})`);
    // the bar: patron spot + bartender, both standable/reachable
    assert.ok(cz2.casino.bar, `${cid} has a bar`);
    assert.ok(cz2.casino.bartender && cz2.casino.bartender.name, `${cid} has a named bartender`);
    assert.equal(collides(cz2, cz2.casino.bar.x, cz2.casino.bar.y, 12), false, `${cid} bar spot standable`);
  }
  // NO poker/slots anywhere else: the two casinos are the only
  // scenes carrying a casino def.
  for (const [id2, m2] of Object.entries(MAPS)) {
    if (id2 !== 'casino-lounge' && id2 !== 'neon-casino') assert.ok(!m2.casino, `${id2} has no casino`);
  }
  const cafe = MAPS['gateway-cafe'];
  assert.equal(cafe.tiles.w, 32); assert.equal(cafe.tiles.h, 20);
  assert.equal(cafe.seats.length, 17, 'café has 17 seats (12 table chairs at three 4-seat tables + a 5-seat hearth arc, v1.2.2 Item 4)');
  const hookah = MAPS['hookah-lounge'];
  assert.equal(hookah.tiles.w, 26); assert.equal(hookah.tiles.h, 18);
  assert.equal(hookah.hookahs.length, 4, 'four hookah stations');
  assert.equal(hookah.seats.filter(s => s.kind === 'hookah').length, 8, 'two seats per hookah station');
  // door graph: bay ⇄ lounge, gateway ⇄ café, neon ⇄ neon casino,
  // cinder ⇄ hookah lounge
  assert.ok(MAPS['solstice-bay'].doors.some(d => d.target === 'casino-lounge'), 'bay has the casino door');
  assert.ok(MAPS['casino-lounge'].doors.some(d => d.target === 'solstice-bay'), 'lounge has the door back');
  assert.ok(MAPS['the-gateway'].doors.some(d => d.target === 'gateway-cafe'), 'gateway has the café door');
  assert.ok(cafe.doors.some(d => d.target === 'the-gateway'), 'café has the door back');
  assert.ok(MAPS['neon-district'].doors.some(d => d.target === 'neon-casino'), 'neon has the casino door');
  assert.ok(MAPS['neon-casino'].doors.some(d => d.target === 'neon-district'), 'neon casino has the door back');
  assert.ok(MAPS['cinder-mesa'].doors.some(d => d.target === 'hookah-lounge'), 'cinder has the hookah door');
  assert.ok(hookah.doors.some(d => d.target === 'cinder-mesa'), 'hookah lounge has the door back');
});

// ------------------------------------------------------------------ a2 (Lane C)

test('gatehouses: every gateway is a structure — dir, solid flanks, walkable passage, clear spawnOut', { timeout: 30000 }, () => {
  for (const [id, m] of Object.entries(MAPS)) {
    for (const g of m.gateways || []) {
      assert.ok(g.dir === 'N' || g.dir === 'S', `${id} gateway ${g.label} names its edge`);
      assert.ok(g.spawnOut, `${id} gateway ${g.label} carries an arrival point`);
      const tx = Math.round(g.x / 32), ty = Math.round(g.y / 32);
      const rows = g.dir === 'S' ? [ty, ty - 1] : [ty, ty + 1];
      // the tower flanks are SOLID at the tile level
      for (const ry of rows) {
        assert.ok(collides(m, (tx - 1) * 32 + 16, ry * 32 + 16, 4), `${id} ${g.label} west tower solid`);
        assert.ok(collides(m, (tx + 2) * 32 + 16, ry * 32 + 16, 4), `${id} ${g.label} east tower solid`);
      }
      // the passage between the towers stays walkable
      const passY = g.dir === 'S' ? ty - 1 : ty + 1;
      assert.equal(collides(m, g.x + g.w / 2, passY * 32 + 16, 12), false, `${id} ${g.label} passage walkable`);
      // the arrival point: standable and NOT inside any trigger rect
      assert.equal(collides(m, g.spawnOut.x, g.spawnOut.y, 12), false, `${id} ${g.label} spawnOut standable`);
      assert.equal(gatewayAt(m, g.spawnOut.x, g.spawnOut.y), null, `${id} ${g.label} spawnOut clear of triggers (no bounce-back)`);
      // the reverse gatehouse exists and points back
      const back = (MAPS[g.target].gateways || []).find(x => x.target === id);
      assert.ok(back, `${g.target} has the gatehouse back to ${id}`);
    }
  }
});

test('facades + zone character: one building per enterable place, heroes, textured ground', { timeout: 30000 }, () => {
  // exactly one quality facade per enterable place; the tiles under
  // a facade are solid, and its door stands just outside the rect.
  const built = { 'the-gateway': 2, 'solstice-bay': 1, 'neon-district': 2, 'cinder-mesa': 1 };
  for (const [id, n] of Object.entries(built)) {
    assert.equal((MAPS[id].buildings || []).length, n, `${id} has ${n} facade(s)`);
  }
  for (const [id, m] of Object.entries(MAPS)) {
    for (const b of m.buildings || []) {
      const ccx = (b.tx + b.tw / 2) * 32, ccy = (b.ty + b.th / 2) * 32;
      assert.ok(collides(m, ccx, ccy, 4), `${id} facade ${b.name} stands on solid tiles`);
      // some door tile touches the facade's edge (the real door IN the building)
      const touches = (m.doors || []).some(d => {
        const dtx = Math.round(d.x / 32), dty = Math.round(d.y / 32);
        const beside = (dtx >= b.tx - 1 && dtx <= b.tx + b.tw && (dty === b.ty - 1 || dty === b.ty + b.th))
          || (dty >= b.ty - 1 && dty <= b.ty + b.th && (dtx === b.tx - 1 || dtx === b.tx + b.tw));
        return beside;
      });
      assert.ok(touches, `${id} facade ${b.name} has its door on an edge`);
    }
  }
  // one hero landmark per city + the Gateway's fountain, textured
  // ground somewhere in every big map (no flat single-colour zones)
  const heroes = {
    'the-gateway': 'fountain', 'solstice-bay': 'lighthouse', 'neon-district': 'neonsign',
    'cinder-mesa': 'hearth', 'frosthaven': 'icesculpt', 'verdant-hollow': 'greattree',
  };
  for (const [id, kind] of Object.entries(heroes)) {
    assert.ok((MAPS[id].props || []).some(p => p.kind === kind), `${id} flies its hero: ${kind}`);
    const chars = new Set(MAPS[id].tiles.rows.join('').split(''));
    const textured = ['b', 's', 'p'].filter(c => chars.has(c));
    assert.ok(textured.length >= 1, `${id} has textured ground (${textured.join(',') || 'none'})`);
  }
});

// ------------------------------------------------------------------ b

test('door transfer bay ⇄ lounge with the 3s input lock', { timeout: 60000 }, async () => {
  const u = await makeUser('door_dan');
  await toBay(u);
  await sleep(1600); // portal debounce from the arch hop

  teleport(u, 496, 1200); // the casino door tile in the bay
  const arrived = await arriveMap(u, 'casino-lounge');
  const t0 = Date.now();
  assert.equal(arrived.transferMs, 1500, 'map message carries the fixed transfer window');
  assert.equal(arrived.map.name, 'Casino Lounge');
  assert.ok(Math.abs(arrived.you.x - 560) < 2 && Math.abs(arrived.you.y - 656) < 2, 'placed at the lounge entryway');
  assert.equal(arrived.map.casino.tables.length, 6, 'client payload lists 6 tables');
  assert.equal(arrived.map.casino.slots.length, 10, 'client payload lists 10 slots');
  assert.ok(arrived.map.casino.bartender && arrived.map.casino.bartender.name, 'client payload names the bartender');

  // INPUT LOCKED: hold "right" for 1.2s mid-window — the snapshot
  // position must not move at all.
  u.client.send({ type: 'input', keys: { right: true } });
  await sleep(1200);
  const lockedPos = selfIn(u.client, u.id);
  assert.ok(lockedPos, 'snapshots flow during the transfer window');
  assert.ok(Math.abs(lockedPos.x - 560) < 1 && Math.abs(lockedPos.y - 656) < 1,
    `no movement while locked (got ${lockedPos.x},${lockedPos.y})`);

  // After the window the same held input moves the player.
  await waitFor(() => Date.now() - t0 > 3300, 5000, 'transfer window elapsed');
  const moved = await waitFor(() => {
    const p = selfIn(u.client, u.id);
    return p && p.x > 536 ? p : null;
  }, 5000, 'movement released after the window');
  assert.ok(moved);
  u.client.send({ type: 'input', keys: {} });

  // Door back to the bay, landing right outside the casino door.
  await sleep(1600);
  teleport(u, 544, 720); // lounge door-back rect
  const back = await arriveMap(u, 'solstice-bay');
  assert.equal(back.transferMs, 1500);
  assert.ok(Math.abs(back.you.x - 528) < 2 && Math.abs(back.you.y - 1200) < 2, 'lands outside the casino door (off the pad, so it cannot bounce back in)');
  u.client.ws.close();
});

// ------------------------------------------------------------------ c

test('door transfer gateway ⇄ café round trip', { timeout: 60000 }, async () => {
  const u = await makeUser('cafe_cleo');
  teleport(u, 2000, 1168); // café door tile on the Gateway (FRONT/south face since v1.2.2 Item 8)
  const inCafe = await arriveMap(u, 'gateway-cafe');
  assert.equal(inCafe.map.name, 'Gateway Café');
  assert.ok(Math.abs(inCafe.you.x - 528) < 2 && Math.abs(inCafe.you.y - 528) < 2, 'placed at the café entrance');
  assert.equal(inCafe.map.seats.length, 17, 'café seats in the client payload');
  await sleep(1600);
  teleport(u, 512, 592); // café door-back rect
  const back = await arriveMap(u, 'the-gateway');
  assert.ok(Math.abs(back.you.x - 2000) < 2 && Math.abs(back.you.y - 1200) < 2, 'lands outside the café door');
  u.client.ws.close();
});

// ------------------------------------------------------------------ d

test('sitting: snapshot pose, chat seated, occupancy, stand both ways', { timeout: 60000 }, async () => {
  const a = await makeUser('sit_sam');
  const b = await makeUser('sit_sue');
  // Gateway bench seat 1 sits at tile (31,19) = (1008,624), facing right.
  teleport(a, 1008, 646);
  teleport(b, 700, 700); // bystander with a clear view (same scene)
  await sleep(400);

  a.client.send({ type: 'interact' });
  const seatedSnap = await waitFor(() => {
    const p = (b.client.msgs.filter(m => m.type === 'snapshot').pop() || { players: [] }).players.find(x => x.id === a.id);
    return p && p.seated ? p : null;
  }, 5000, 'bystander snapshot shows Sam seated');
  assert.equal(seatedSnap.dir, 'right', 'seated avatar faces the seat direction');
  assert.ok(Math.abs(seatedSnap.x - 1008) < 1 && Math.abs(seatedSnap.y - 624) < 1, 'snapped into the seat');

  // Chat works while seated.
  b.client.msgs.length = 0;
  a.client.send({ type: 'chat', text: 'lovely bench' });
  await waitFor(() => b.client.msgs.some(m => m.type === 'chat' && m.text === 'lovely bench' && m.fromId === a.id),
    5000, 'seated chat delivered');

  // The very same seat refuses a second sitter.
  teleport(b, 1008, 646);
  await sleep(300);
  b.client.msgs.length = 0;
  b.client.send({ type: 'interact' });
  await waitFor(() => b.client.msgs.some(m => m.type === 'notice' && /seat is taken/.test(m.text)),
    5000, 'occupied seat refused');
  const bSnap = await waitFor(() => selfIn(b.client, b.id), 5000, 'snapshot of the second sitter');
  assert.equal(bSnap.seated, false, 'second sitter stayed standing');

  // Re-interact stands.
  a.client.send({ type: 'interact' });
  await waitFor(() => {
    const p = selfIn(b.client, a.id);
    return p && p.seated === false ? p : null;
  }, 5000, 're-interact stands Sam up');

  // Sit again; movement input stands instead.
  a.client.send({ type: 'interact' });
  await waitFor(() => {
    const p = selfIn(b.client, a.id);
    return p && p.seated ? p : null;
  }, 5000, 'Sam seated again');
  a.client.send({ type: 'input', keys: { left: true } });
  const stood = await waitFor(() => {
    const p = selfIn(b.client, a.id);
    return p && p.seated === false ? p : null;
  }, 5000, 'movement input stands Sam');
  assert.ok(Math.abs(stood.x - 1008) < 20, 'the standing input was consumed, not a slide');
  a.client.send({ type: 'input', keys: {} });
  a.client.ws.close(); b.client.ws.close();
});

// ------------------------------------------------------------------ v1.3.1
// Item 13: beach towels are LYING seats — one character per towel,
// and occupancy releases on stand and on transfer (the item-6
// discipline, regression-pinned here for the towel family).

test('beach towels (item 13): lying seats occupy + release on stand and transfer', { timeout: 90000 }, async () => {
  const a = await makeUser('towel_tess');
  const b = await makeUser('towel_tom');
  await toBay(a);
  await toBay(b);
  await sleep(1800); // outlast the arrival transfer lock (interact is swallowed inside it)
  // Towel seat 7 at tile (20,33) = (656,1072), under its umbrella.
  teleport(a, 656, 1094);
  await sleep(300);
  a.client.send({ type: 'interact' });
  const lying = await waitFor(() => {
    const p = selfIn(a.client, a.id);
    return p && p.seated ? p : null;
  }, 5000, 'Tess lies down on the towel');
  assert.equal(lying.seatId, 'solstice-bay-seat-7', 'the towel is the seat');
  // One character per towel.
  teleport(b, 656, 1094);
  await sleep(300);
  b.client.msgs.length = 0;
  b.client.send({ type: 'interact' });
  await waitFor(() => b.client.msgs.some(m => m.type === 'notice' && /seat is taken/.test(m.text)),
    5000, 'occupied towel refused');
  // Movement stands her up; the towel frees immediately.
  a.client.send({ type: 'input', keys: { left: true } });
  await waitFor(() => {
    const p = selfIn(a.client, a.id);
    return p && p.seated === false ? p : null;
  }, 5000, 'movement stands Tess up from the towel');
  a.client.send({ type: 'input', keys: {} });
  b.client.send({ type: 'interact' });
  await waitFor(() => {
    const p = selfIn(b.client, b.id);
    return p && p.seated ? p : null;
  }, 5000, 'Tom takes the freed towel');
  // Transferring out of the zone frees it again.
  b.client.send({ type: 'debug-teleport', x: 1152, y: 1392 }); // the return arch
  await arriveMap(b, 'the-gateway');
  teleport(a, 656, 1094);
  await sleep(300);
  a.client.send({ type: 'interact' });
  await waitFor(() => {
    const p = selfIn(a.client, a.id);
    return p && p.seated ? p : null;
  }, 5000, 'Tess retakes the towel after Tom transferred out');
  a.client.ws.close(); b.client.ws.close();
});

// ------------------------------------------------------------------ e

test('sitting on placed studio furniture (cozy chair)', { timeout: 60000 }, async () => {
  const owner = await makeUser('sit_owner');
  owner.client.send({ type: 'enter-studio', owner: 'sit_owner' });
  await arriveMap(owner, `studio:${owner.id}`);
  await sleep(3300); // entry transfer window: interact is locked while it runs
  owner.client.send({ type: 'studio-buy', itemId: 'cozy-chair' });
  const state = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state' && m.inventory.length === 1).pop(),
    5000, 'chair bought');
  const chair = state.inventory[0];
  owner.client.send({ type: 'studio-place', instanceItemId: chair.instanceId, x: 5, y: 5, rot: 0 });
  await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-furniture' && m.furniture.length === 1).pop(),
    5000, 'chair placed');
  // Chair tile (5,5) centre is (176,176); stand just south of it.
  teleport(owner, 176, 202);
  await sleep(300);
  owner.client.send({ type: 'interact' });
  const seated = await waitFor(() => {
    const p = selfIn(owner.client, owner.id);
    return p && p.seated ? p : null;
  }, 5000, 'seated on the studio chair');
  assert.ok(Math.abs(seated.x - 176) < 1 && Math.abs(seated.y - 176) < 1, 'snapped onto the chair tile');
  owner.client.send({ type: 'interact' });
  await waitFor(() => {
    const p = selfIn(owner.client, owner.id);
    return p && p.seated === false ? p : null;
  }, 5000, 'stood back up in the studio');
  owner.client.ws.close();
});

// ------------------------------------------------------------------ f

test('poker: full hand on NEW table 6, chips conserved', { timeout: 90000 }, async () => {
  const a = await makeUser('newtab_ann');
  const b = await makeUser('newtab_bob');
  await toCasino(a); await toCasino(b);
  const T6 = { id: 'casino-lounge-poker-6', x: 400, y: 464 };
  for (const [u, chair] of [[a, 'N'], [b, 'S']]) {
    teleport(u, T6.x, T6.y);
    await sleep(250);
    u.client.send({ type: 'poker', action: 'sit', table: T6.id, chair });
    await waitFor(() => {
      const s = u.client.msgs.filter(m => m.type === 'poker-state' && m.id === T6.id).pop();
      return s && s.chairs.some(c => c.name === u.name) ? s : null;
    }, 5000, `${u.name} seated at table 6`);
    // Poker seats read as sitting in snapshots, facing the table.
    const snap = await waitFor(() => {
      const p = selfIn(u.client, u.id);
      return p && p.seated ? p : null;
    }, 5000, `${u.name} snapshot shows the poker seat as sitting`);
    assert.equal(snap.dir, chair === 'N' ? 'down' : 'up', 'poker sitter faces the table');
  }
  assert.equal(await balanceOf(a), 4800);
  assert.equal(await balanceOf(b), 4800);
  await waitFor(() => a.client.msgs.filter(m => m.type === 'poker-cards').pop(), 20000, 'hand dealt on table 6');
  // Both all-in whenever acting -> the hand must run to done.
  const start = Date.now();
  let done = null;
  while (!done && Date.now() - start < 60000) {
    for (const u of [a, b]) {
      const st = u.client.msgs.filter(m => m.type === 'poker-state' && m.id === T6.id).pop();
      if (st && st.state === 'done') done = st;
      if (st) {
        const idx = st.chairs.findIndex(c => c.name === u.name);
        if (idx >= 0 && st.chairs[idx].acting) {
          u.client.send({ type: 'poker', action: 'act', table: T6.id, act: 'allin' });
          await sleep(400);
        }
      }
    }
    await sleep(200);
  }
  assert.ok(done, 'hand reached done on table 6');
  const wonTotal = done.winners.reduce((s, w) => s + w.amount, 0);
  assert.equal(wonTotal, done.pot, 'the pot was paid in full');
  const idle = await waitFor(() => {
    const s = a.client.msgs.filter(m => m.type === 'poker-state' && m.id === T6.id).pop();
    return s && s.state === 'idle' ? s : null;
  }, 15000, 'table 6 back to idle');
  const stacks = idle.chairs.reduce((n, c) => n + (c.chips || 0) + (c.bet || 0), 0);
  // Conservation: two 200z buy-ins on the table + 4,800z balances.
  assert.equal(stacks + (await balanceOf(a)) + (await balanceOf(b)), 10000, 'chips conserved on table 6');
  a.client.ws.close(); b.client.ws.close();
});

// ------------------------------------------------------------------ g

test('slots: a spin on NEW machine 10 (east wall) pays by the ported paytable', { timeout: 60000 }, async () => {
  const u = await makeUser('newslot_ned');
  await toCasino(u);
  teleport(u, 1052, 432); // machine 10 stool (east wall; v1.3.1 pulled out to a 52px gap, Item 8)
  await sleep(300);
  // Standing at the machine is not enough in the new layout — sit.
  u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  const refused = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Take a seat/.test(m.text)).pop(),
    5000, 'unseated spin refused');
  assert.ok(refused);
  await sleep(3400); // outlast the transfer lock from the door hop
  u.client.send({ type: 'interact' });
  const seatedSnap = await waitFor(() => {
    const p = selfIn(u.client, u.id);
    return p && p.seated ? p : null;
  }, 5000, 'seated at machine 10');
  assert.equal(seatedSnap.dir, 'right', 'east-wall stool faces the machine');
  u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  const res = await waitFor(() => u.client.msgs.filter(m => m.type === 'slot-result').pop(), 5000, 'spin result on machine 10');
  assert.equal(res.bet, 10);
  assert.equal(res.reels.length, 3);
  const syms = res.reels.map(id => casino.SLOT_SYMBOLS.find(s => s.id === id));
  assert.equal(res.win, casino.slotPayout(syms, 10), 'win matches the ported paytable');
  assert.equal(res.zcoins, 5000 - 10 + res.win, 'balance math exact');
  assert.equal(await balanceOf(u), res.zcoins, 'DB balance matches');
  u.client.ws.close();
});

// ------------------------------------------------------------------ h (v1.1.1)

test('fishing: the math contract + pond geography', () => {
  // 10 distinct species, flat 1z — variety is flavour, not tiers.
  assert.equal(FISHING.FISH.length, 10);
  assert.equal(new Set(FISHING.FISH.map(f => f.id)).size, 10);
  assert.equal(new Set(FISHING.FISH.map(f => f.name)).size, 10);
  assert.equal(FISHING.PAYOUT_Z, 1);
  // X's contract: a fish every 3–6 casts on average.
  const mean = 1 / FISHING.CATCH_P;
  assert.ok(mean >= 3 && mean <= 6, `mean casts per fish ${mean.toFixed(2)} within [3, 6]`);
  // Seeded RNG: the roll + pick honour the contract deterministically.
  let seed = 123456789;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let catches = 0; const N = 20000;
  for (let i = 0; i < N; i++) if (FISHING.rollCatch(rng)) catches++;
  const rate = catches / N;
  assert.ok(rate > 0.19 && rate < 0.25, `seeded catch rate ${rate} ≈ CATCH_P ${FISHING.CATCH_P}`);
  seed = 987654321;
  const seenSpecies = new Set();
  for (let i = 0; i < 2000; i++) seenSpecies.add(FISHING.pickFish(rng).id);
  assert.equal(seenSpecies.size, 10, 'seeded picks cover all 10 species');
  // The Verdant pond: bigger than the v1.1 pond, and the audience
  // grid's back row keeps >= 3 clear tiles from the waterline.
  const verdant = MAPS['verdant-hollow'];
  let water = 0, waterTop = Infinity;
  verdant.tiles.rows.forEach((row, ty) => {
    for (const ch of row) if (ch === '%') { water++; if (ty < waterTop) waterTop = ty; }
  });
  assert.ok(water >= 60, `pond has ${water} water tiles (grew from 50)`);
  const audience = verdant.seats.filter(s => Number(s.id.split('-').pop()) >= 101);
  const backRow = Math.max(...audience.map(s => Math.floor(s.y / 32)));
  assert.ok(waterTop - backRow >= 4, `back row ty${backRow} vs waterline ty${waterTop}: >=3 clear tiles`);
  // v1.2 (Items N/O): NO fixed spots — proximity fishing. The maps
  // opt in via `fishable` (Frosthaven: `frozen` ice fishing), the
  // flags ride the client payload (the prompt needs them), and
  // every fishable map has standable bank tiles next to its water.
  assert.equal(verdant.fishing, undefined, 'fixed Verdant spots are gone');
  assert.ok(!verdant.props.some(p => p.kind === 'fishingpole'), 'rod-stand props removed');
  assert.equal(verdant.fishable, true);
  const frost = MAPS['frosthaven'];
  assert.equal(frost.fishable, true, 'Frosthaven offers ice fishing');
  assert.equal(frost.frozen, true);
  assert.equal(clientMap(verdant).fishable, true, 'fishable rides the client payload');
  assert.equal(clientMap(frost).fishable, true);
  assert.equal(clientMap(frost).frozen, true);
  for (const m of [verdant, frost]) {
    let banks = 0, ice = 0;
    m.tiles.rows.forEach((row, ty) => {
      [...row].forEach((ch, tx) => {
        if (ch === '%') ice++;
      });
    });
    for (let ty = 1; ty < m.tiles.h - 1; ty++) for (let tx = 1; tx < m.tiles.w - 1; tx++) {
      const here = m.tiles.rows[ty][tx];
      if (here === '%') continue;
      const nearWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => m.tiles.rows[ty + dy][tx + dx] === '%');
      if (nearWater && !collides(m, tx * 32 + 16, ty * 32 + 16, 12)) banks++;
    }
    assert.ok(ice >= 30, `${m.id}: ${ice} water/ice tiles`);
    assert.ok(banks >= 8, `${m.id}: ${banks} standable bank tiles for proximity casts`);
  }
});

test('fishing: cast → catch pays exactly 1z, holds the fish up, one cast at a time', { timeout: 90000 }, async () => {
  const u = await makeUser('fish_faye');
  const w = await makeUser('fish_walt'); // witness: the catch is room-visible
  teleport(u, 2016, 48); // the Gateway's Verdant Hollow arch
  await arriveMap(u, 'verdant-hollow');
  teleport(w, 2016, 48);
  await arriveMap(w, 'verdant-hollow');
  await sleep(3300); // outlast the transfer lock
  // v1.2: any bank tile works — this is the pond's north shore.
  const spot = { x: 33 * 32 + 16, y: 39 * 32 + 16 };
  teleport(u, spot.x, spot.y);
  teleport(w, spot.x + 64, spot.y);
  await sleep(300);
  const before = await balanceOf(u);
  // Forced catch + on-demand resolve (TEST hooks) = deterministic.
  u.client.send({ type: 'debug-fish', op: 'force-catch' });
  u.client.send({ type: 'interact' });
  const castNotice = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /cast your line/.test(m.text)).pop(),
    5000, 'cast starts at the spot');
  assert.ok(castNotice);
  // A second interact mid-cast is refused, never stacked.
  u.client.send({ type: 'interact' });
  const busy = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /already in the water/.test(m.text)).pop(),
    5000, 'second cast refused while one is active');
  assert.ok(busy);
  u.client.send({ type: 'debug-fish', op: 'resolve-now' });
  const caught = await waitFor(() => u.client.msgs.filter(m => m.type === 'fish-caught').pop(), 5000, 'catch broadcast reaches the fisher');
  assert.ok(FISHING.FISH.some(f => f.id === caught.fish), `broadcast carries a real species (${caught.fish})`);
  assert.equal(caught.playerId, u.id);
  const witnessed = await waitFor(() => w.client.msgs.filter(m => m.type === 'fish-caught').pop(), 5000, 'catch broadcast reaches the room');
  assert.equal(witnessed.fish, caught.fish);
  // The hold-up rides snapshots while its second lasts.
  const held = await waitFor(() => {
    const p = selfIn(u.client, u.id);
    return p && p.heldFish === caught.fish ? p : null;
  }, 3000, 'held fish visible in snapshots');
  assert.ok(held);
  assert.equal(await balanceOf(u), before + 1, 'exactly +1z for the catch');
  // Forced miss: no credit, no broadcast, just the nibble notice.
  const catchCount = u.client.msgs.filter(m => m.type === 'fish-caught').length;
  u.client.send({ type: 'debug-fish', op: 'force-miss' });
  u.client.send({ type: 'interact' });
  u.client.send({ type: 'debug-fish', op: 'resolve-now' });
  const nibble = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /nibble/.test(m.text)).pop(), 5000, 'miss resolves with a nibble');
  assert.ok(nibble);
  await sleep(300);
  assert.equal(u.client.msgs.filter(m => m.type === 'fish-caught').length, catchCount, 'no catch broadcast on a miss');
  assert.equal(await balanceOf(u), before + 1, 'a miss pays nothing');
  // v1.2: the room saw the CASTS too, each landing ON the water.
  const casts = w.client.msgs.filter(m => m.type === 'fish-cast' && m.playerId === u.id);
  assert.ok(casts.length >= 2, `witness saw ${casts.length} cast events`);
  for (const c of casts) {
    const lt = MAPS['verdant-hollow'].tiles.rows[Math.floor(c.landY / 32)][Math.floor(c.landX / 32)];
    assert.equal(lt, '%', 'the bobber lands on water, 2-3 tiles out');
    assert.equal(c.ice, false, 'open pond, not ice');
  }
  u.client.ws.close();
  w.client.ws.close();
});

test('fishing v1.2: ice fishing at Frosthaven + water notices, never the sit error', { timeout: 120000 }, async () => {
  const u = await makeUser('ice_ingrid');
  // --- Frosthaven: cast from the frozen pond's south edge.
  teleport(u, 1568, 48); // the Gateway's Frosthaven arch
  await arriveMap(u, 'frosthaven');
  await sleep(3300);
  teleport(u, 10 * 32 + 16, 11 * 32 + 16); // ice edge, pond spans y3-10
  await sleep(300);
  const before = await balanceOf(u);
  u.client.send({ type: 'debug-fish', op: 'force-catch' });
  u.client.send({ type: 'interact' });
  const drill = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /drill a hole/.test(m.text)).pop(),
    5000, 'ice cast starts with the drill notice');
  assert.ok(drill, 'ice fishing casts at the frozen pond');
  const castEv = u.client.msgs.filter(m => m.type === 'fish-cast').pop();
  assert.equal(castEv.ice, true, 'cast event flagged as ice');
  assert.equal(MAPS['frosthaven'].tiles.rows[Math.floor(castEv.landY / 32)][Math.floor(castEv.landX / 32)], '%',
    'the hole lands ON the ice');
  u.client.send({ type: 'debug-fish', op: 'resolve-now' });
  const caught = await waitFor(() => u.client.msgs.filter(m => m.type === 'fish-caught').pop(), 5000, 'ice catch broadcasts');
  assert.ok(caught);
  assert.equal(await balanceOf(u), before + 1, 'ice fish pays the same flat 1z');
  assert.ok(!u.client.msgs.some(m => m.type === 'notice' && /Nothing to sit on/.test(m.text)),
    'E at a pond NEVER returns the sit error (Item N sit-spam regression)');
  // --- Gateway fountain: one clear notice, not silence/sit error.
  const g = await makeUser('fount_fred');
  teleport(g, 32 * 32 + 16, 21 * 32 + 16); // one tile west of the fountain water
  await sleep(300);
  g.client.send({ type: 'interact' });
  const fn = await waitFor(() => g.client.msgs.filter(m => m.type === 'notice' && /No fishing in the fountain/.test(m.text)).pop(),
    5000, 'fountain edge answers with the fountain notice');
  assert.ok(fn);
  // --- Solstice Bay waterline: the open-sea notice.
  const b = await makeUser('sea_sue');
  teleport(b, 1120, 48); // the Gateway's Solstice Bay arch
  await arriveMap(b, 'solstice-bay');
  await sleep(3300);
  teleport(b, 36 * 32 + 16, 5 * 32 + 16); // boardwalk at the waterline
  await sleep(300);
  b.client.send({ type: 'interact' });
  const sn = await waitFor(() => b.client.msgs.filter(m => m.type === 'notice' && /open sea is too rough/.test(m.text)).pop(),
    5000, 'bay waterline answers with the rough-sea notice');
  assert.ok(sn);
  u.client.ws.close(); g.client.ws.close(); b.client.ws.close();
});
