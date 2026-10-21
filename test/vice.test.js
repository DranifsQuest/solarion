'use strict';

/**
 * Solarion — Phase B AMENDMENT tests: the second casino (Neon),
 * bartender drinks (5z, haze state, pass out at 10), and the Cinder
 * Mesa hookah lounge (5z puffs, hippy at 10). Numbers under test are
 * the documented production rules: drinks 5z, puffs 5z, and the v1.1
 * window model (Zan, 2026-10-21): the ENTIRE drunk / high state —
 * level, haze, wobble, pass-out, hippy — lives in a 30s window from
 * the LAST drink / puff; each new one refreshes the window and
 * stacks the level; when it lapses the player is simply sober.
 * Pass out is 20s at 10 drinks and hippy 20s at 10 puffs, both
 * inside the window; waking from either = sober, no residual level
 * (the old decay 1 pt / 60s and wake-at-2 are gone). Time is
 * fast-forwarded ONLY through the SOLARION_TEST debug-vice hook
 * (dead in production) — the state transitions asserted are the
 * real server code paths.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const casino = require('../src/casino');

const RUN = process.env.TEST_RUN || 'x';
const PORT = 48900 + (Number(RUN) || 0) * 20;
const DB = path.join(__dirname, '..', 'data', `vice-run-${RUN}.db`);
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

async function balanceOf(token) {
  const s = await api('/api/me', { token });
  return s.json.avatar.zcoins;
}

function selfIn(client, userId) {
  const s = client.msgs.filter(m => m.type === 'snapshot').pop();
  return s ? s.players.find(p => p.id === userId) || null : null;
}

async function fund(user, zcoins) {
  user.client.send({ type: 'debug-casino', op: 'set-balance', zcoins });
  await waitFor(() => user.client.msgs.filter(m => m.type === 'zcoins' && m.zcoins === zcoins).pop(),
    5000, `${user.name} funded ${zcoins}z`);
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

// Travel helpers -------------------------------------------------------

async function toNeon(user) { teleport(user, 224, 48); await arriveMap(user, 'neon-district'); }
async function toNeonCasino(user) {
  await toNeon(user);
  await sleep(1600); // portal debounce
  teleport(user, 1968, 944); // casino door, north face of the SE block
  return arriveMap(user, 'neon-casino');
}
async function toBayCasino(user) {
  teleport(user, 1120, 48);
  await arriveMap(user, 'solstice-bay');
  await sleep(1600);
  teleport(user, 496, 1200);
  return arriveMap(user, 'casino-lounge');
}
async function toHookah(user) {
  teleport(user, 672, 48); // Cinder arch
  await arriveMap(user, 'cinder-mesa');
  await sleep(1600);
  teleport(user, 976, 1008); // hookah lounge door
  return arriveMap(user, 'hookah-lounge');
}

// ------------------------------------------------------------------ 1

test('neon casino: door transfer works both ways, payload is a full casino', { timeout: 60000 }, async () => {
  const u = await makeUser('neon_nina');
  const arrived = await toNeonCasino(u);
  assert.equal(arrived.transferMs, 3000, 'door transfer uses the 3s load screen');
  assert.equal(arrived.map.name, 'Neon Casino');
  assert.ok(Math.abs(arrived.you.x - 496) < 2 && Math.abs(arrived.you.y - 528) < 2, 'placed at the entryway');
  assert.equal(arrived.map.casino.tables.length, 6, 'neon casino has 6 tables');
  assert.equal(arrived.map.casino.slots.length, 10, 'neon casino has 10 slots');
  assert.equal(arrived.map.casino.bartender.name, 'Vex', 'neon bartender on the payload');
  // Door back to Neon District, landing outside the casino door.
  await sleep(1600);
  teleport(u, 480, 592);
  const back = await arriveMap(u, 'neon-district');
  assert.ok(Math.abs(back.you.x - 1968) < 2 && Math.abs(back.you.y - 912) < 2, 'lands outside the neon casino door');
  u.client.ws.close();
});

// ------------------------------------------------------------------ 2

test('drinks: exactly 5z a round, count tracked + visible, 10th drink passes you out', { timeout: 90000 }, async () => {
  const u = await makeUser('drink_dana');
  const watcher = await makeUser('drink_walt');
  const arrived = await toBayCasino(u);
  assert.equal(arrived.map.casino.bartender.name, 'Salty Sam', 'bay bartender on the payload');
  await toBayCasino(watcher);
  await fund(u, 200);

  // No bar, no drink: from the Gateway a purchase is refused.
  const g = await makeUser('drink_gwen');
  g.client.send({ type: 'buy-drink' });
  const noBar = await waitFor(() => g.client.msgs.filter(m => m.type === 'notice' && /no bar here/.test(m.text)).pop(),
    5000, 'buy-drink refused away from a bar');
  assert.ok(noBar);
  assert.equal(await balanceOf(g.token), 5000, 'refused purchase charges nothing');
  g.client.ws.close();

  // At the bar: each drink is exactly -5z and +1 on the counter.
  teleport(u, 176, 528); // patron spot in front of the counter
  await sleep(300);
  for (let i = 1; i <= 3; i++) {
    u.client.msgs.length = 0;
    u.client.send({ type: 'buy-drink' });
    const vs = await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state').pop(),
      5000, `vice-state after drink ${i}`);
    assert.equal(vs.drinks, i, `drink count is ${i}`);
    // Phase 9: the day's FIRST drink is free AND tips +10z; the rest cost 5z.
    assert.equal(await balanceOf(u.token), 215 - 5 * i, `drink ${i} balance (first free + 10z tip, then 5z each)`);
  }
  // The count is broadcast state: the watcher sees it in snapshots.
  const seen = await waitFor(() => {
    const p = selfIn(watcher.client, u.id);
    return p && p.drinks === 3 ? p : null;
  }, 5000, 'watcher sees drinks:3 in snapshots');
  assert.equal(seen.fallen, false);

  // Drinks 4..10 — the 10th knocks her out cold.
  for (let i = 4; i <= 10; i++) u.client.send({ type: 'buy-drink' });
  const out = await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && m.passedOut).pop(),
    8000, 'passed out at the 10th drink');
  assert.equal(out.drinks, 10);
  assert.equal(await balanceOf(u.token), 165, 'ten drinks: first free (+10z tip), nine at 5z = net −35z from 200');
  const fallenSeen = await waitFor(() => {
    const p = selfIn(watcher.client, u.id);
    return p && p.fallen ? p : null;
  }, 5000, 'watcher sees the fallen pose in snapshots');
  assert.equal(fallenSeen.drinks, 10);

  // INPUT LOCKED while out: movement input changes nothing...
  const before0 = selfIn(u.client, u.id);
  u.client.send({ type: 'input', keys: { right: true } });
  await sleep(900);
  const after0 = selfIn(u.client, u.id);
  assert.ok(Math.abs(after0.x - before0.x) < 1 && Math.abs(after0.y - before0.y) < 1,
    `no movement while passed out (was ${before0.x},${before0.y} now ${after0.x},${after0.y})`);
  u.client.send({ type: 'input', keys: {} });

  // ...but chat keeps working.
  u.client.send({ type: 'chat', text: 'ssooo dizzy…' });
  const chat = await waitFor(() => watcher.client.msgs.filter(m => m.type === 'chat' && m.fromId === u.id).pop(),
    5000, 'chat works while passed out');
  assert.ok(chat);

  // Buying more while out cold is refused.
  u.client.msgs.length = 0;
  u.client.send({ type: 'buy-drink' });
  const refused = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /out cold/.test(m.text)).pop(),
    5000, 'no drinks while passed out');
  assert.ok(refused);
  assert.equal(await balanceOf(u.token), 165);

  // Wake (test hook fast-forwards the 20s window): up again — and
  // v1.1: waking means SOBER. There is no residual level any more.
  u.client.send({ type: 'debug-vice', op: 'wake' });
  const woke = await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && !m.passedOut).pop(),
    5000, 'wakes up after the window');
  assert.equal(woke.drinks, 0, 'waking from pass-out = sober (level 0)');
  const upSeen = await waitFor(() => {
    const p = selfIn(watcher.client, u.id);
    return p && !p.fallen && p.drinks === 0 ? p : null;
  }, 5000, 'watcher sees her back on her feet, sober');
  assert.ok(upSeen);

  // Insufficient balance: a drink is refused and nothing changes.
  await fund(u, 4);
  u.client.msgs.length = 0;
  u.client.send({ type: 'buy-drink' });
  const broke = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /costs 5z/.test(m.text)).pop(),
    5000, 'drink refused without 5z');
  assert.ok(broke);
  assert.equal(await balanceOf(u.token), 4, 'no charge for a refused drink');
  const vsNow = u.client.msgs.filter(m => m.type === 'vice-state').pop();
  assert.ok(!vsNow || vsNow.drinks === 0, 'count unchanged by refused drink (still sober)');
  u.client.ws.close(); watcher.client.ws.close();
});

// ------------------------------------------------------------------ 3

test('hookah lounge: 5z puffs counted, 10th puff turns you hippy for the room', { timeout: 90000 }, async () => {
  const u = await makeUser('hookah_hana');
  const watcher = await makeUser('hookah_hugh');
  const arrived = await toHookah(u);
  assert.equal(arrived.map.name, 'Hookah Lounge');
  assert.equal(arrived.map.hookahs.length, 4, 'client payload lists 4 hookah stations');
  await toHookah(watcher);
  await fund(u, 200);

  // Sit at station 1 (west seat) — interacting again takes a puff.
  await sleep(3400); // outlast the transfer lock from the door hop
  teleport(u, 176, 160); // between station 1's two seats
  await sleep(300);
  u.client.send({ type: 'interact' });
  const seated = await waitFor(() => {
    const p = selfIn(u.client, u.id);
    return p && p.seated ? p : null;
  }, 5000, 'seated at the hookah');
  assert.ok(seated);

  for (let i = 1; i <= 3; i++) {
    u.client.msgs.length = 0;
    u.client.send({ type: 'interact' });
    const vs = await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state').pop(),
      5000, `vice-state after puff ${i}`);
    assert.equal(vs.puffs, i, `puff count is ${i}`);
    assert.equal(await balanceOf(u.token), 200 - 5 * i, `puff ${i} charged exactly 5z`);
    const still = await waitFor(() => {
      const p = selfIn(u.client, u.id);
      return p && p.seated ? p : null;
    }, 5000, `still seated after puff ${i}`);
    assert.ok(still, 'puffing does not stand you up');
  }

  // Puffs 4..10 — the 10th flips the switch: hippy, visible to all.
  for (let i = 4; i <= 10; i++) u.client.send({ type: 'interact' });
  const trippy = await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && m.hippy).pop(),
    8000, 'hippy at the 10th puff');
  assert.equal(trippy.puffs, 0, 'the trip resets the puff count');
  assert.equal(await balanceOf(u.token), 200 - 50, 'ten puffs cost exactly 50z');
  const hippySeen = await waitFor(() => {
    const p = selfIn(watcher.client, u.id);
    return p && p.hippy ? p : null;
  }, 5000, 'watcher sees the hippy override in snapshots');
  assert.equal(hippySeen.accessory, 'headband', 'hippy wears the headband');
  assert.equal(hippySeen.body_color, '#ff5da2', 'hippy wears tie-dye pink');

  // The window ends (test hook) and the real look returns untouched.
  u.client.send({ type: 'debug-vice', op: 'unhippy' });
  const back = await waitFor(() => {
    const p = selfIn(watcher.client, u.id);
    return p && !p.hippy ? p : null;
  }, 5000, 'hippy reverts after the window');
  assert.equal(back.accessory, 'none', 'real accessory restored (default look)');
  assert.equal(back.body_color, '#3aa7e0', 'real top colour restored (default look)');

  // Insufficient balance: puff refused, count unchanged.
  await fund(u, 0);
  u.client.msgs.length = 0;
  u.client.send({ type: 'interact' });
  const broke = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /costs 5z/.test(m.text)).pop(),
    5000, 'puff refused without 5z');
  assert.ok(broke);
  assert.equal(await balanceOf(u.token), 0, 'no charge for a refused puff');
  u.client.ws.close(); watcher.client.ws.close();
});

// ------------------------------------------------------------------ 4

test('neon casino slots: sit-to-spin on the second casino floor', { timeout: 60000 }, async () => {
  const u = await makeUser('neon_slot_ned');
  await toNeonCasino(u);
  teleport(u, 528, 112); // slot 1's stool, neon slots section
  await sleep(300);
  u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  const refused = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Take a seat/.test(m.text)).pop(),
    5000, 'standing spin refused in the neon casino');
  assert.ok(refused);
  await sleep(3400); // outlast the transfer lock from the door hop
  u.client.send({ type: 'interact' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'sit-state' && m.seated).pop(),
    5000, 'seated at neon slot 1');
  u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  const res = await waitFor(() => u.client.msgs.filter(m => m.type === 'slot-result').pop(), 5000, 'neon slot result');
  const syms = res.reels.map(id => casino.SLOT_SYMBOLS.find(s => s.id === id));
  assert.equal(res.win, casino.slotPayout(syms, 10), 'win matches the ported paytable');
  assert.equal(res.zcoins, 5000 - 10 + res.win, 'balance math exact');
  assert.equal(await balanceOf(u.token), res.zcoins);
  u.client.ws.close();
});

// ------------------------------------------------------------------ 5

test('vice windows (v1.1): drink + smoke states begin AND end in-zone, 30s after last use', { timeout: 120000 }, async () => {
  // ---- drinks, in the Casino Lounge, never leaving the zone
  const u = await makeUser('window_wanda');
  const watcher = await makeUser('window_walt');
  await toBayCasino(u);
  await toBayCasino(watcher);
  await fund(u, 500);
  teleport(u, 176, 528);
  await sleep(300);
  const mapsBefore = u.client.msgs.filter(m => m.type === 'map').length;

  for (let i = 0; i < 3; i++) u.client.send({ type: 'buy-drink' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && m.drinks === 3).pop(), 5000, 'drinks live in-zone');
  const seen3 = await waitFor(() => {
    const p = selfIn(watcher.client, u.id);
    return p && p.drinks === 3 ? p : null;
  }, 5000, 'watcher sees drinks:3 in-zone');
  assert.ok(seen3);

  // 29s in: still drunk — the window has not lapsed.
  u.client.send({ type: 'debug-vice', op: 'age', ms: 29000 });
  await sleep(450);
  assert.equal(selfIn(watcher.client, u.id).drinks, 3, 'still drunk 29s after the last drink');

  // A 4th drink at 29s refreshes the whole window (+30s more).
  u.client.send({ type: 'buy-drink' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && m.drinks === 4).pop(), 5000, 're-drink stacks to 4');
  u.client.send({ type: 'debug-vice', op: 'age', ms: 29000 });
  await sleep(450);
  assert.equal(selfIn(watcher.client, u.id).drinks, 4, 'refreshed window: still drunk at +29s');

  // Past 30s from the LAST drink: sober, same zone, no map change.
  u.client.send({ type: 'debug-vice', op: 'age', ms: 2000 });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && m.drinks === 0).pop(), 5000, 'sober when the window lapses — in-zone');
  const seen0 = await waitFor(() => {
    const p = selfIn(watcher.client, u.id);
    return p && p.drinks === 0 ? p : null;
  }, 5000, 'watcher sees her sober in-zone');
  assert.ok(seen0);
  assert.equal(u.client.msgs.filter(m => m.type === 'map').length, mapsBefore, 'the whole drink lifecycle happened with NO zone change');

  // Pass-out cannot outlive the window: 10th drink, then age past
  // 30s — the player wakes SOBER (the window governs, not the 20s).
  u.client.send({ type: 'debug-vice', op: 'set-drinks', count: 9 });
  u.client.send({ type: 'buy-drink' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && m.passedOut).pop(), 8000, 'passed out at 10');
  u.client.send({ type: 'debug-vice', op: 'age', ms: 31000 });
  const woke = await waitFor(() => u.client.msgs.filter(m => m.type === 'vice-state' && !m.passedOut && m.drinks === 0).pop(), 5000, 'pass-out ends with the window — sober');
  assert.ok(woke);
  u.client.ws.close(); watcher.client.ws.close();

  // ---- puffs mirror the same model in the Hookah Lounge
  const s = await makeUser('window_sana');
  const sWatch = await makeUser('window_saul');
  await toHookah(s);
  await toHookah(sWatch);
  await fund(s, 500);
  await sleep(3400); // outlast the transfer lock from the door hop
  teleport(s, 176, 160);
  await sleep(300);
  s.client.send({ type: 'interact' });
  await waitFor(() => {
    const p = selfIn(s.client, s.id);
    return p && p.seated ? p : null;
  }, 5000, 'seated at the hookah');
  const sMaps = s.client.msgs.filter(m => m.type === 'map').length;
  for (let i = 0; i < 3; i++) s.client.send({ type: 'interact' });
  await waitFor(() => s.client.msgs.filter(m => m.type === 'vice-state' && m.puffs === 3).pop(), 5000, 'puffs live in-zone');
  const sSeen3 = await waitFor(() => {
    const p = selfIn(sWatch.client, s.id);
    return p && p.puffs === 3 ? p : null;
  }, 5000, 'watcher sees puffs:3 in-zone (the haze state)');
  assert.ok(sSeen3);

  // Hippy at 10 — inside the window…
  s.client.send({ type: 'debug-vice', op: 'set-puffs', count: 9 });
  s.client.send({ type: 'interact' });
  await waitFor(() => s.client.msgs.filter(m => m.type === 'vice-state' && m.hippy).pop(), 8000, 'hippy at the 10th puff');
  // …and the window takes the hippy with it at 30s from the last puff.
  s.client.send({ type: 'debug-vice', op: 'age', ms: 31000 });
  const clear = await waitFor(() => s.client.msgs.filter(m => m.type === 'vice-state' && !m.hippy && m.puffs === 0).pop(), 5000, 'smoke state fully clears with the window');
  assert.ok(clear);
  const sSeen = await waitFor(() => {
    const p = selfIn(sWatch.client, s.id);
    return p && !p.hippy ? p : null;
  }, 5000, 'watcher sees the hippy gone in-zone');
  assert.ok(sSeen);
  assert.equal(s.client.msgs.filter(m => m.type === 'map').length, sMaps, 'the whole smoke lifecycle also stayed in-zone');
  s.client.ws.close(); sWatch.client.ws.close();
});
