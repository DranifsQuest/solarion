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
const { MAPS, collides, gatewayAt } = require('../src/maps');

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
    assert.equal(cz2.tiles.w, 30, `${cid} width`); assert.equal(cz2.tiles.h, 20, `${cid} height`);
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
  assert.equal(cafe.tiles.w, 20); assert.equal(cafe.tiles.h, 13);
  assert.equal(cafe.seats.length, 13, 'café has 13 seats (10 café + 3 hearth-side, Phase 10)');
  const hookah = MAPS['hookah-lounge'];
  assert.equal(hookah.tiles.w, 20); assert.equal(hookah.tiles.h, 14);
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
  const built = { 'the-gateway': 2, 'solstice-bay': 1, 'neon-district': 1, 'cinder-mesa': 1 };
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
    'cinder-mesa': 'forge', 'frosthaven': 'icesculpt', 'verdant-hollow': 'greattree',
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
  assert.equal(arrived.transferMs, 3000, 'map message carries the fixed transfer window');
  assert.equal(arrived.map.name, 'Casino Lounge');
  assert.ok(Math.abs(arrived.you.x - 496) < 2 && Math.abs(arrived.you.y - 528) < 2, 'placed at the lounge entryway');
  assert.equal(arrived.map.casino.tables.length, 6, 'client payload lists 6 tables');
  assert.equal(arrived.map.casino.slots.length, 10, 'client payload lists 10 slots');
  assert.ok(arrived.map.casino.bartender && arrived.map.casino.bartender.name, 'client payload names the bartender');

  // INPUT LOCKED: hold "right" for 1.2s mid-window — the snapshot
  // position must not move at all.
  u.client.send({ type: 'input', keys: { right: true } });
  await sleep(1200);
  const lockedPos = selfIn(u.client, u.id);
  assert.ok(lockedPos, 'snapshots flow during the transfer window');
  assert.ok(Math.abs(lockedPos.x - 496) < 1 && Math.abs(lockedPos.y - 528) < 1,
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
  teleport(u, 480, 592); // lounge door-back rect
  const back = await arriveMap(u, 'solstice-bay');
  assert.equal(back.transferMs, 3000);
  assert.ok(Math.abs(back.you.x - 528) < 2 && Math.abs(back.you.y - 1200) < 2, 'lands outside the casino door (off the pad, so it cannot bounce back in)');
  u.client.ws.close();
});

// ------------------------------------------------------------------ c

test('door transfer gateway ⇄ café round trip', { timeout: 60000 }, async () => {
  const u = await makeUser('cafe_cleo');
  teleport(u, 2000, 1040); // café door tile on the Gateway
  const inCafe = await arriveMap(u, 'gateway-cafe');
  assert.equal(inCafe.map.name, 'Gateway Café');
  assert.ok(Math.abs(inCafe.you.x - 336) < 2 && Math.abs(inCafe.you.y - 336) < 2, 'placed at the café entrance');
  assert.equal(inCafe.map.seats.length, 13, 'café seats in the client payload');
  await sleep(1600);
  teleport(u, 336, 368); // café door-back rect
  const back = await arriveMap(u, 'the-gateway');
  assert.ok(Math.abs(back.you.x - 2000) < 2 && Math.abs(back.you.y - 1008) < 2, 'lands outside the café door');
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
  teleport(u, 880, 368); // machine 10's stool (east wall of the slots section)
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
