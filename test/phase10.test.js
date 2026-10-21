'use strict';

/**
 * Solarion Phase 10 ("Phase E" — the Warm Home pass) test suite.
 *
 *   a. door conversion data: every door in every public map is a
 *      REAL door — a label, a standable pad, a resolvable target
 *      (map id or the per-player 'studio:self' home door); every
 *      interior has its door back; hearths/lanterns/string lights
 *      ride the client payload as props.
 *   b. the home door round trip at protocol level: Gateway "My Home"
 *      door -> own studio (3s transfer lock enforced) -> walk onto
 *      the studio's own door tile -> back in the Gateway, landed
 *      OUTSIDE the front door (never on its pad).
 *   c. warm furniture: fireplace / string lights / porch lantern
 *      purchase at exact prices, placement, and the placed payload
 *      types the client renders + glows from.
 *   d. warm defaults: a brand-new home wears Warm Wood walls and
 *      Classic Wood floors out of the box.
 *   e. client wiring (source-level, same pattern as input-guard):
 *      doors are drawn by drawDoor + swung by tickDoors, the door
 *      sound exists, the hearth crackle exists, the load screen is
 *      the warm doorway.
 *
 * Run:  TEST_RUN=<n> node --test test/phase10.test.js (or npm test)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');

const { MAPS, clientMap } = require('../src/maps');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `xtest-p10-run-${RUN}.db`);
const PORT = 50500 + Number(RUN) * 20;

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

async function fund(user, amount) {
  user.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: amount });
  await waitFor(() => user.client.msgs.filter(m => m.type === 'zcoins' && m.zcoins === amount).pop(),
    5000, `${user.name} funded to ${amount}`);
}

function selfIn(client, userId) {
  const s = client.msgs.filter(m => m.type === 'snapshot').pop();
  return s ? s.players.find(p => p.id === userId) || null : null;
}

function teleport(user, x, y) {
  user.client.send({ type: 'debug-teleport', x, y });
}

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

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

// ------------------------------------------------------------------ a

test('door conversion: every door is labelled, resolvable, and interiors have their door back', () => {
  const interiors = ['casino-lounge', 'neon-casino', 'gateway-cafe', 'hookah-lounge'];
  let doorCount = 0;
  for (const [id, m] of Object.entries(MAPS)) {
    for (const d of m.doors || []) {
      doorCount++;
      assert.ok(d.label && d.label.length > 1, `${id} door has a name over its lintel`);
      assert.ok(d.target === 'studio:self' || MAPS[d.target], `${id} door target ${d.target} resolves`);
    }
    // client payload: doors carry the home flag, props ride along
    const cm = clientMap(m);
    for (const d of cm.doors) {
      assert.equal(typeof d.home, 'boolean', `${id} client door carries the home flag`);
    }
  }
  assert.ok(doorCount >= 9, `the world has real doors everywhere (got ${doorCount})`);
  for (const id of interiors) {
    assert.ok((MAPS[id].doors || []).length >= 1, `${id} has its door back out`);
  }
  // the home door stands in the Gateway, flagged as a home door
  const gw = clientMap(MAPS['the-gateway']);
  const homeDoor = gw.doors.find(d => d.home);
  assert.ok(homeDoor, 'gateway client payload flags the My Home door');
  assert.equal(homeDoor.label, 'My Home');
  // cozy dressing made it into the payloads
  const cafe = clientMap(MAPS['gateway-cafe']);
  assert.ok(cafe.props.some(p => p.kind === 'hearth'), 'café payload carries its hearth');
  const hookah = clientMap(MAPS['hookah-lounge']);
  assert.ok(hookah.props.some(p => p.kind === 'hearth'), 'hookah lounge payload carries its hearth');
  const gwProps = gw.props.map(p => p.kind);
  for (const kind of ['lantern', 'lamp', 'stringlights', 'rug']) {
    assert.ok(gwProps.includes(kind), `gateway dressing includes ${kind}`);
  }
});

// ------------------------------------------------------------------ b

test('home door round trip: Gateway front door -> own home (3s lock) -> out the home door', { timeout: 60000 }, async () => {
  const u = await makeUser('home_dora');
  // Step onto the My Home door pad on the Gateway (tile 7,22).
  teleport(u, 240, 720);
  const home = await arriveMap(u, `studio:${u.id}`);
  const t0 = Date.now();
  assert.equal(home.transferMs, 3000, 'home entry rides the fixed 3s transfer');
  assert.ok(home.map.studio && home.map.studio.door, 'the home scene carries its own door');

  // INPUT LOCKED mid-window: hold "up" — no movement at all.
  u.client.send({ type: 'input', keys: { up: true } });
  await sleep(1200);
  const locked = selfIn(u.client, u.id);
  assert.ok(locked, 'snapshots flow during the home transfer');
  assert.ok(Math.abs(locked.x - home.you.x) < 1 && Math.abs(locked.y - home.you.y) < 1,
    `no movement while the door window runs (got ${locked.x},${locked.y})`);
  u.client.send({ type: 'input', keys: {} });
  await waitFor(() => Date.now() - t0 > 3400, 6000, 'transfer window elapsed');

  // Walk out through the home's OWN door (tier-0 door tile: 10,13).
  await sleep(1600); // portal debounce from the entry hop
  teleport(u, 336, 432);
  const back = await arriveMap(u, 'the-gateway');
  assert.equal(back.transferMs, 3000);
  // Landed OUTSIDE the front door: one tile south of the pad (7,23),
  // never on the pad itself, so the door cannot bounce you back in.
  assert.ok(Math.abs(back.you.x - 240) < 2 && Math.abs(back.you.y - 752) < 2,
    `lands outside the front door (got ${back.you.x},${back.you.y})`);
  await sleep(2200); // stand there past the debounce — no bounce-back
  const still = selfIn(u.client, u.id);
  assert.ok(still, 'still present in the Gateway (no bounce back home)');
  const extraHomes = u.client.msgs.filter(x => x.type === 'map' && x.map.id === `studio:${u.id}`);
  assert.equal(extraHomes.length, 1, 'exactly one home entry happened');
  u.client.ws.close();
});

// ------------------------------------------------------------------ c

test('warm furniture: fireplace, string lights and lantern buy at exact prices and place', { timeout: 60000 }, async () => {
  const u = await makeUser('hearth_hana');
  await fund(u, 1000);
  u.client.send({ type: 'enter-studio', owner: u.name });
  await arriveMap(u, `studio:${u.id}`);
  await waitFor(() => u.client.msgs.filter(m => m.type === 'studio-state' && m.isOwner).pop(),
    5000, 'owner studio-state');

  const buy = async (itemId, price, x, y, wantType) => {
    u.client.send({ type: 'studio-buy', itemId });
    const st = await waitFor(() => u.client.msgs.filter(m => m.type === 'studio-state'
      && m.inventory && m.inventory.some(i => i.itemId === itemId && !i.placed)).pop(),
      5000, `bought ${itemId}`);
    const item = st.inventory.find(i => i.itemId === itemId && !i.placed);
    u.client.send({ type: 'studio-place', instanceItemId: item.instanceId, x, y, rot: 0 });
    const placed = await waitFor(() => u.client.msgs.filter(m => m.type === 'studio-furniture'
      && m.furniture.some(f => f.instanceId === item.instanceId)).pop(),
      5000, `placed ${itemId}`);
    const f = placed.furniture.find(f2 => f2.instanceId === item.instanceId);
    assert.equal(f.type, wantType, `${itemId} places as type ${wantType} (the client renders + glows from this)`);
    return price;
  };

  let spent = 0;
  spent += await buy('hearth-fireplace', 300, 5, 5, 'hearth');
  spent += await buy('string-lights', 65, 6, 5, 'lights');
  spent += await buy('porch-lantern', 50, 7, 5, 'lantern');
  assert.equal(spent, 415);
  const bal = (await api(PORT, '/api/me', { token: u.token })).json.avatar.zcoins;
  assert.equal(bal, 1000 - 415, `exact debits for the warm set (balance ${bal})`);
  u.client.ws.close();
});

// ------------------------------------------------------------------ d

test('warm defaults: a brand-new home wears Warm Wood + Classic Wood', { timeout: 30000 }, async () => {
  const u = await makeUser('defaults_drew');
  u.client.send({ type: 'enter-studio', owner: u.name });
  const home = await arriveMap(u, `studio:${u.id}`);
  assert.equal(home.map.wall, '#4a3423', 'default wall is Warm Wood');
  assert.equal(home.map.floor, '#8a6844', 'default floor is Classic Wood');
  assert.equal(home.map.floorAlt, '#7f613e', 'default floor alt is Classic Wood alt');
  u.client.ws.close();
});

// ------------------------------------------------------------------ e

test('client wiring: doors swing, door sound + crackle exist, load screen is the warm doorway', () => {
  const client = fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8');
  const sfx = fs.readFileSync(path.join(ROOT, 'public', 'sfx.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // the old warp-pad door pass is gone; doors come from drawDoor/tickDoors
  assert.ok(client.includes('function drawDoor('), 'client draws real doors');
  assert.ok(client.includes('function tickDoors('), 'client animates door swings');
  assert.ok(!client.includes("fillText('🚪'"), 'no emoji-on-a-pad door rendering remains');
  assert.ok(client.includes("window.SolarionSfx.play('door')"), 'door swing plays the door sound');
  assert.ok(client.includes('drawHearthAt'), 'hearths render with animated flame');
  assert.ok(client.includes('setHearth('), 'client drives the crackle from the fire');
  // arrival priming: the destination door starts open behind the load screen
  assert.ok(client.includes('doorAnims.set(doorKeyOf(bestD)'), 'arrival door is primed open');
  // sounds exist
  assert.ok(sfx.includes("case 'door':"), 'sfx has the door creak');
  assert.ok(sfx.includes('_applyHearth'), 'sfx has the hearth crackle bed');
  // the warm doorway load screen
  assert.ok(html.includes('id="loadSub"'), 'load screen has the welcome line');
  assert.ok(html.includes('loadLamp'), 'load screen has the lantern');
  assert.ok(css.includes('#6b4a2a'), 'UI palette carries the warm wood border tone');
});
