'use strict';

/**
 * Solarion Phase 5 — security regression suite.
 *
 * Spawns a real server WITHOUT the bulk-test abuse-limit escape hatch
 * (SOLARION_TEST_NO_ABUSE_LIMITS is deliberately NOT set), so the real
 * production limits are exercised:
 *   - WS frame size cap (64 KB) + malformed/null frame fuzzing: the
 *     server must never crash (pre-fix, {type:'stage-join', mixId:{}}
 *     killed the process via an unbindable SQLite parameter).
 *   - Malformed HTTP bodies return JSON 4xx, never a 500 stack page
 *     (pre-fix, a numeric login password threw inside bcrypt).
 *   - Reserved usernames (admin/system/...) can't be registered.
 *   - Login lockout: per-IP + per-account, trigger + timed release.
 *   - Registration throttle: per-IP cap on new accounts.
 *   - Concurrency races: duplicate votes pay once per voter, the daily
 *     bonus grants exactly once across racing connects, poker double-
 *     sit is impossible and chips can't leak across accounts, slot
 *     spins can't beat the cooldown.
 *   - z coins are untradeable (soul doc §9.24): no message type moves
 *     them between accounts; avatar-update is whitelist-only.
 *   - SOLARION_TEST debug hooks are dead when the env var is unset.
 *
 * Run:  TEST_RUN=<n> npm test   (or node --test test/security.test.js)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB_MAIN = path.join(ROOT, 'data', `sec-run-${RUN}-main.db`);
const DB_NOTEST = path.join(ROOT, 'data', `sec-run-${RUN}-notest.db`);
const PORT = 49300 + Number(RUN) * 20;
const PORT_NOTEST = PORT + 10;
const REGISTER_LIMIT = 20; // auth.js default SOLARION_REGISTER_LIMIT

const children = [];
let registrations = 0; // successful registrations against the main server

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

function startServer(port, dbPath, extraEnv, wipe = true) {
  if (wipe) {
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      try { fs.unlinkSync(f); } catch (e) { /* fresh */ }
    }
  }
  const env = { ...process.env, SOLARION_PORT: String(port), SOLARION_DB_PATH: dbPath, ...extraEnv };
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}

async function health(port) {
  const r = await fetch(`http://localhost:${port}/health`);
  return { status: r.status, json: await r.json() };
}

function connectClient(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`);
    const client = { ws, msgs: [], hello: null, send: (m) => ws.send(JSON.stringify(m)), closed: false, closeCode: null };
    ws.on('close', (code) => { client.closed = true; client.closeCode = code; });
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('no hello within 5s')); }, 5000);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      client.msgs.push(m);
      if (m.type === 'hello') { client.hello = m; clearTimeout(t); resolve(client); }
    });
    ws.on('error', () => { if (!client.hello) { clearTimeout(t); reject(new Error('ws error before hello')); } });
  });
}

/** Register on the MAIN security server and count the success. */
async function registerOk(name) {
  const r = await api(PORT, '/api/register', { username: name, password: 'secretpw' });
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`);
  registrations++;
  return { name, token: r.json.token, avatar: r.json.avatar };
}

async function makeUser(name) {
  const u = await registerOk(name);
  const client = await connectClient(PORT, u.token);
  return { ...u, client, id: client.hello.you.id };
}

async function balanceOf(token) {
  const r = await api(PORT, '/api/me', { token });
  assert.equal(r.status, 200);
  return r.json.avatar.zcoins;
}

async function toBay(user) {
  user.client.send({ type: 'debug-teleport', x: 480, y: 48 });
  await waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(),
    5000, `${user.name} arrives in solstice-bay`);
}

let mainChild = null;

before(async () => {
  const env = { SOLARION_TEST: '1', SOLARION_LOGIN_LOCKOUT_MS: '2500' };
  // The whole point of this suite: real abuse limits apply.
  delete process.env.SOLARION_TEST_NO_ABUSE_LIMITS;
  mainChild = await startServer(PORT, DB_MAIN, env);
});

after(async () => {
  for (const c of [...children]) await stopServer(c).catch(() => {});
});

// ------------------------------------------------------------------

test('HTTP: malformed bodies -> JSON 4xx (never 500), reserved names rejected', { timeout: 30000 }, async () => {
  const u = await registerOk('sec_http');
  // numeric password used to throw inside bcrypt -> 500 + stack trace
  const numPw = await api(PORT, '/api/login', { username: 'sec_http', password: 12345 });
  assert.equal(numPw.status, 401, `numeric password login: ${numPw.status}`);
  assert.ok(numPw.json && numPw.json.ok === false, 'JSON error body, not HTML stack page');
  const objUser = await api(PORT, '/api/login', { username: { x: 1 }, password: 'secretpw' });
  assert.equal(objUser.status, 401);
  const arrBody = await fetch(`http://localhost:${PORT}/api/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2,3]',
  });
  assert.equal(arrBody.status, 400);
  const badJson = await fetch(`http://localhost:${PORT}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  assert.equal(badJson.status, 400, 'malformed JSON -> 400');
  assert.ok((await badJson.json()).ok === false, 'malformed JSON -> JSON error body');
  // reserved / impersonation names
  for (const name of ['admin', 'System', 'SOLARION', 'moderator', 'support', 'root']) {
    const r = await api(PORT, '/api/register', { username: name, password: 'secretpw' });
    assert.equal(r.status, 400, `reserved name ${name} rejected`);
    assert.match(r.json.error, /reserved/);
  }
  // password minimum (pre-existing rule, verified) + a good login works
  const short = await api(PORT, '/api/register', { username: 'sec_shortpw', password: '12345' });
  assert.equal(short.status, 400);
  const ok = await api(PORT, '/api/login', { username: 'sec_http', password: 'secretpw' });
  assert.equal(ok.status, 200);
  assert.ok(u.token);
});

test('WS fuzz: malformed/null/absurd frames never crash the server', { timeout: 60000 }, async () => {
  const u = await makeUser('sec_fuzz');
  await toBay(u); // in the bay so stage-join reaches the (patched) DB path
  const frames = [
    Buffer.from([0x00, 0xff, 0x00, 0x01]),               // null/binary garbage
    'null', '[]', '"hello"', '123', 'true', ' ', '',      // non-object JSON
    JSON.stringify({}),                                   // missing type
    JSON.stringify({ type: 42 }),                         // non-string type
    JSON.stringify({ type: 'x'.repeat(500) }),            // absurd type
    JSON.stringify({ type: 'stage-join', mixId: { x: 1 } }),  // THE pre-fix crasher
    JSON.stringify({ type: 'stage-join', mixId: [1, 2] }),
    JSON.stringify({ type: 'stage-join', mixId: null }),
    JSON.stringify({ type: 'stage-join', mixId: '1; DROP TABLE users' }),
    JSON.stringify({ type: 'mix-delete', slot: {} }),
    JSON.stringify({ type: 'mix-save', slot: [], data: null }),
    JSON.stringify({ type: 'mix-save', slot: 1, data: { name: 'y'.repeat(50000), bpm: 100, bars: 1, tracks: [{ loopId: 'pop-drums-1', startBar: 0 }] } }),
    JSON.stringify({ type: 'vote', value: {} }),
    JSON.stringify({ type: 'vote', value: 999 }),
    JSON.stringify({ type: 'vote', value: 'up' }),
    JSON.stringify({ type: 'chat', text: { a: 1 } }),
    JSON.stringify({ type: 'chat', text: [1, 2, 3] }),
    JSON.stringify({ type: 'chat', text: null }),
    JSON.stringify({ type: 'input', keys: null }),
    JSON.stringify({ type: 'input', keys: 'all' }),
    JSON.stringify({ type: 'poker', action: {}, table: {}, chair: [] }),
    JSON.stringify({ type: 'poker', action: 'act', act: 'raise', amount: { evil: 1 } }),
    JSON.stringify({ type: 'slots', action: 'spin', bet: {} }),
    JSON.stringify({ type: 'slots', action: 'spin', bet: -1000 }),
    JSON.stringify({ type: 'enter-studio', owner: {} }),
    JSON.stringify({ type: 'enter-studio', owner: 'z'.repeat(5000) }),
    JSON.stringify({ type: 'avatar-update', hair_style: {}, body_color: 42, zcoins: 999999 }),
    '{"type":"debug-teleport","x":1e999,"y":null}',
  ];
  for (const f of frames) {
    u.client.ws.send(f);
    await sleep(30);
  }
  await sleep(500);
  assert.equal(mainChild.exitCode, null, 'server process still alive after fuzz');
  const h = await health(PORT);
  assert.equal(h.status, 200);
  assert.equal(h.json.phase, 5, '/health reports phase 5');
  // the fuzzed client is still fully functional
  u.client.msgs.length = 0;
  u.client.send({ type: 'chat', text: 'still here' });
  await waitFor(() => u.client.msgs.some(m => m.type === 'chat' && m.text === 'still here'), 5000, 'chat works after fuzz');
  // studio fuzz from inside the user's own studio (reaches DB paths)
  u.client.send({ type: 'enter-studio', owner: 'sec_fuzz' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'map' && String(m.map.id).startsWith('studio:')).pop(), 5000, 'entered own studio');
  const studioFrames = [
    JSON.stringify({ type: 'studio-place', instanceItemId: {}, x: 1, y: 1 }),
    JSON.stringify({ type: 'studio-place', instanceItemId: '1 OR 1=1', x: 1, y: 1 }),
    JSON.stringify({ type: 'studio-place', instanceItemId: 1, x: {}, y: [], rot: 'x' }),
    JSON.stringify({ type: 'studio-pickup', instanceItemId: [1] }),
    JSON.stringify({ type: 'studio-kick', userId: {} }),
    JSON.stringify({ type: 'studio-buy', itemId: {} }),
    JSON.stringify({ type: 'studio-buy', itemId: 'x'.repeat(10000) }),
  ];
  for (const f of studioFrames) { u.client.ws.send(f); await sleep(30); }
  await sleep(400);
  assert.equal(mainChild.exitCode, null, 'server still alive after studio fuzz');
  assert.equal((await health(PORT)).status, 200);
  u.client.ws.close();
});

test('WS frame size cap: >64KB frame kills only that connection', { timeout: 30000 }, async () => {
  const u = await makeUser('sec_size');
  const big = JSON.stringify({ type: 'chat', text: 'A'.repeat(200 * 1024) });
  u.client.ws.send(big);
  await waitFor(() => u.client.closed, 5000, 'oversize connection closed by server');
  assert.ok(u.client.closeCode === 1009 || u.client.closeCode === 1006,
    `closed for frame size (code ${u.client.closeCode})`);
  assert.equal(mainChild.exitCode, null, 'server alive');
  assert.equal((await health(PORT)).status, 200, 'health still answers');
});

test('SOLARION_TEST debug hooks are dead when the env var is unset', { timeout: 30000 }, async () => {
  const env = { ...process.env };
  delete env.SOLARION_TEST;
  delete env.SOLARION_TEST_NO_ABUSE_LIMITS;
  const dbPath = DB_NOTEST;
  if (true) {
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  }
  const child = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...env, SOLARION_PORT: String(PORT_NOTEST), SOLARION_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no-test server did not start')), 15000);
    child.stdout.on('data', d => { if (d.toString().includes('test-mode: false')) { clearTimeout(t); resolve(); } });
    child.on('error', reject);
  });
  const reg = await api(PORT_NOTEST, '/api/register', { username: 'sec_notest', password: 'secretpw' });
  assert.equal(reg.status, 200);
  const c = await connectClient(PORT_NOTEST, reg.json.token);
  assert.equal(c.hello.zcoins, 100, 'starts with the daily bonus only');
  c.send({ type: 'debug-teleport', x: 480, y: 48 });       // would enter Solstice Bay if live
  c.send({ type: 'debug-casino', op: 'set-balance', zcoins: 999999 });
  c.send({ type: 'debug-seed-perf', earned: 300 });
  await sleep(900);
  assert.equal(c.msgs.filter(m => m.type === 'map').length, 0, 'debug-teleport ignored: no map switch');
  c.ws.close();
  await sleep(300);
  const c2 = await connectClient(PORT_NOTEST, reg.json.token);
  assert.equal(c2.hello.zcoins, 100, 'debug-casino ignored: balance untouched');
  c2.ws.close();
  await stopServer(child);
});

test('stale socket close cannot kill the live session (reconnect race)', { timeout: 30000 }, async () => {
  const u = await registerOk('sec_stale');
  const c1 = await connectClient(PORT, u.token);
  const c2 = await connectClient(PORT, u.token); // replaces c1 server-side
  await sleep(700); // c1's close event fires server-side here
  c2.msgs.length = 0;
  c2.send({ type: 'chat', text: 'live and well' });
  await waitFor(() => c2.msgs.some(m => m.type === 'chat' && m.text === 'live and well'),
    5000, 'live player still in the world after stale close');
  c2.ws.close();
  assert.ok(c1);
});

test('daily bonus race: 6 concurrent connects grant the bonus exactly once', { timeout: 30000 }, async () => {
  const u = await registerOk('sec_bonus');
  const clients = await Promise.all(Array.from({ length: 6 }, () => connectClient(PORT, u.token)));
  const granted = clients.filter(c => c.hello.bonusGranted === true).length;
  assert.equal(granted, 1, `exactly one bonus grant across racing connects, got ${granted}`);
  for (const c of clients) assert.equal(c.hello.zcoins, 100, 'every hello sees the single 100z balance');
  assert.equal(await balanceOf(u.token), 100);
  for (const c of clients) { try { c.ws.close(); } catch (e) {} }
});

test('vote race: hammered duplicate votes count once per voter, payout exact', { timeout: 90000 }, async () => {
  const perf = await makeUser('sec_perf');
  const v1 = await makeUser('sec_v1');
  const v2 = await makeUser('sec_v2');
  perf.client.send({
    type: 'mix-save', slot: 1,
    data: { name: 'Race Mix', bpm: 160, bars: 2, tracks: [{ loopId: 'pop-drums-1', startBar: 0 }] },
  });
  const saved = await waitFor(() => perf.client.msgs.filter(m => m.type === 'mix-saved').pop(), 5000, 'mix saved');
  await toBay(perf); await toBay(v1); await toBay(v2);
  perf.client.send({ type: 'stage-join', mixId: saved.mix.id });
  await waitFor(() => v1.client.msgs.filter(m => m.type === 'performance-start').pop(), 8000, 'performance started');
  // Both voters hammer 30 duplicate votes each, as fast as the socket allows.
  for (let i = 0; i < 30; i++) { v1.client.send({ type: 'vote', value: 1 }); v2.client.send({ type: 'vote', value: 1 }); }
  const end = await waitFor(() => v1.client.msgs.filter(m => m.type === 'performance-end').pop(), 40000, 'performance end');
  assert.equal(end.up, 2, 'one vote per voter despite 30x hammering');
  assert.equal(end.earned, 10, 'payout is exactly 2 votes x 5z');
  assert.equal(v1.client.msgs.filter(m => m.type === 'vote-ack').length, 1, 'v1 got exactly one vote-ack');
  assert.equal(v2.client.msgs.filter(m => m.type === 'vote-ack').length, 1, 'v2 got exactly one vote-ack');
  assert.equal(await balanceOf(perf.token), 110, 'performer balance 100 + 10 exactly');
  perf.client.ws.close(); v1.client.ws.close(); v2.client.ws.close();
});

test('poker: double-sit impossible, no cross-account chip leak, totals conserved', { timeout: 60000 }, async () => {
  const a = await makeUser('sec_pk_a');
  const b = await makeUser('sec_pk_b');
  await toBay(a); await toBay(b);
  const T1 = { id: 'solstice-bay-poker-1', x: 176, y: 464 };
  a.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(300);
  for (let i = 0; i < 10; i++) a.client.send({ type: 'poker', action: 'sit', table: T1.id, chair: 'N' });
  a.client.send({ type: 'poker', action: 'sit', table: 'solstice-bay-poker-2', chair: 'N' }); // other table too
  await sleep(800);
  const allStates = a.client.msgs.filter(m => m.type === 'poker-state');
  const lastT1 = allStates.filter(m => m.id === T1.id).pop();
  assert.equal(lastT1.chairs.filter(c => c.name === 'sec_pk_a').length, 1, 'A occupies exactly one chair');
  const lastT2 = allStates.filter(m => m.id === 'solstice-bay-poker-2').pop();
  assert.equal(lastT2.chairs.filter(c => c.name === 'sec_pk_a').length, 0, 'A is not also at table 2');
  assert.equal(await balanceOf(a.token), 0, 'A debited exactly one 100z buy-in');
  assert.equal(lastT1.chairs.find(c => c.name === 'sec_pk_a').chips, 100, 'A holds exactly 100 chips');
  // B sits, then A stands: A's own chips come back, B's are untouched.
  b.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(300);
  b.client.send({ type: 'poker', action: 'sit', table: T1.id, chair: 'E' });
  await waitFor(() => {
    const s = b.client.msgs.filter(m => m.type === 'poker-state' && m.id === T1.id).pop();
    return s && s.chairs.some(c => c.name === 'sec_pk_b') ? s : null;
  }, 5000, 'B seated');
  a.client.send({ type: 'poker', action: 'stand' });
  await waitFor(async () => (await balanceOf(a.token)) === 100, 5000, 'A cashed out own chips');
  const stB = b.client.msgs.filter(m => m.type === 'poker-state' && m.id === T1.id).pop();
  const bChips = stB.chairs.find(c => c.name === 'sec_pk_b').chips;
  assert.equal(bChips, 100, 'B chips untouched by A cash-out');
  assert.equal(await balanceOf(b.token), 0, 'B balance untouched by A cash-out');
  assert.equal(100 + 0 + bChips, 200, 'z + chips conserved across both accounts');
  b.client.send({ type: 'poker', action: 'stand' });
  await waitFor(async () => (await balanceOf(b.token)) === 100, 5000, 'B cashed out');
  a.client.ws.close(); b.client.ws.close();
});

test('slots race: 25 rapid spins execute exactly one (cooldown), accounting exact', { timeout: 30000 }, async () => {
  const u = await makeUser('sec_slot');
  await toBay(u);
  u.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: 1000 });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'zcoins' && m.zcoins === 1000).pop(), 5000, 'balance seeded');
  u.client.send({ type: 'debug-teleport', x: 144, y: 560 }); // slot machine 1 spot
  await sleep(300);
  u.client.msgs.length = 0;
  for (let i = 0; i < 25; i++) u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  await sleep(1800);
  const results = u.client.msgs.filter(m => m.type === 'slot-result');
  assert.equal(results.length, 1, `exactly one spin executed in the burst, got ${results.length}`);
  assert.equal(results[0].zcoins, 1000 - 10 + results[0].win, 'balance = seed - one bet + that spin\'s win');
  assert.equal(await balanceOf(u.token), results[0].zcoins);
  u.client.ws.close();
});

test('studio ownership + avatar-update whitelist', { timeout: 60000 }, async () => {
  const owner = await makeUser('sec_owner');
  const guest = await makeUser('sec_guest');
  // Owner enters own studio and buys the cheapest catalog item (poster, 25z).
  owner.client.send({ type: 'enter-studio', owner: 'sec_owner' });
  const ostate = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state' && m.isOwner).pop(), 5000, 'owner studio state');
  assert.ok(ostate.catalog.some(i => i.id === 'poster'));
  owner.client.send({ type: 'studio-buy', itemId: 'poster' });
  const afterBuy = await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state' && m.inventory && m.inventory.length === 1).pop(), 5000, 'owner bought poster');
  const itemId = afterBuy.inventory[0].instanceId;
  assert.equal(await balanceOf(owner.token), 75, 'owner paid exactly 25z');
  // Guest enters owner's studio and tries everything forbidden.
  guest.client.send({ type: 'enter-studio', owner: 'sec_owner' });
  await waitFor(() => guest.client.msgs.filter(m => m.type === 'map' && String(m.map.id).startsWith('studio:')).pop(), 5000, 'guest inside owner studio');
  guest.client.send({ type: 'studio-place', instanceItemId: itemId, x: 5, y: 5, rot: 0 });
  guest.client.send({ type: 'studio-pickup', instanceItemId: itemId });
  guest.client.send({ type: 'studio-buy', itemId: 'poster' });
  guest.client.send({ type: 'studio-kick', userId: owner.id });
  await sleep(700);
  guest.client.send({ type: 'studio-state' });
  const gstate = await waitFor(() => guest.client.msgs.filter(m => m.type === 'studio-state').pop(), 5000, 'guest studio state');
  assert.equal(gstate.furniture.length, 0, 'guest could not place the owner\'s item');
  assert.equal(await balanceOf(guest.token), 100, 'guest balance untouched (buy in foreign studio rejected)');
  assert.equal(await balanceOf(owner.token), 75, 'owner balance untouched by guest actions');
  const ostate2 = await new Promise(async (resolve) => {
    owner.client.msgs.length = 0;
    owner.client.send({ type: 'studio-state' });
    resolve(await waitFor(() => owner.client.msgs.filter(m => m.type === 'studio-state').pop(), 5000, 'owner state recheck'));
  });
  assert.equal(ostate2.inventory.length, 1, 'owner still owns the poster');
  assert.equal(ostate2.inventory[0].placed, false, 'poster was never placed by the guest');
  // Avatar-update whitelist: look changes, money/name/id do not.
  guest.client.send({ type: 'avatar-update', hair_style: 'spiky', zcoins: 999999, name: 'pwned', user_id: 1, map_id: 'x' });
  await waitFor(() => guest.client.msgs.filter(m => m.type === 'notice' && /look saved/.test(m.text)).pop(), 5000, 'look saved notice');
  const me = await api(PORT, '/api/me', { token: guest.token });
  assert.equal(me.json.avatar.hair_style, 'spiky', 'whitelisted field applied');
  assert.equal(me.json.avatar.zcoins, 100, 'zcoins field NOT settable via avatar-update');
  assert.equal(me.json.avatar.name, 'sec_guest', 'name NOT settable via avatar-update');
  owner.client.ws.close(); guest.client.ws.close();
});

test('z coins are untradeable: transfer-shaped messages move nothing', { timeout: 30000 }, async () => {
  const a = await makeUser('sec_give_a');
  const b = await makeUser('sec_give_b');
  assert.equal(await balanceOf(a.token), 100);
  assert.equal(await balanceOf(b.token), 100);
  const attempts = [
    { type: 'transfer', to: 'sec_give_b', amount: 50 },
    { type: 'give', to: b.id, amount: 50 },
    { type: 'trade', to: b.id, zcoins: 50 },
    { type: 'pay', userId: b.id, amount: 50 },
    { type: 'poker', action: 'give', userId: b.id, amount: 50 },
    { type: 'slots', action: 'give', bet: 10 },
    { type: 'chat', text: '/give sec_give_b 50' },
  ];
  for (const m of attempts) a.client.send(m);
  await sleep(800);
  assert.equal(await balanceOf(a.token), 100, 'sender balance unchanged');
  assert.equal(await balanceOf(b.token), 100, 'recipient balance unchanged');
  a.client.ws.close(); b.client.ws.close();
});

test('login lockout: triggers at the limit, blocks the CORRECT password, releases after expiry', { timeout: 60000 }, async () => {
  await registerOk('sec_lock');
  let lastStatus = 0;
  for (let i = 0; i < 10; i++) {
    const r = await api(PORT, '/api/login', { username: 'sec_lock', password: 'wrongpw' });
    assert.ok(r.status === 401 || r.status === 429, `attempt ${i + 1}: ${r.status}`);
    lastStatus = r.status;
  }
  assert.equal(lastStatus, 429, 'lockout tripped by the 10th failure');
  const blocked = await api(PORT, '/api/login', { username: 'sec_lock', password: 'secretpw' });
  assert.equal(blocked.status, 429, 'even the correct password is refused while locked');
  assert.match(blocked.json.error, /Too many failed logins/);
  await sleep(3200); // env lockout is 2500ms in this suite
  const ok = await api(PORT, '/api/login', { username: 'sec_lock', password: 'secretpw' });
  assert.equal(ok.status, 200, 'lockout released after expiry — correct login succeeds');
});

test('registration throttle: per-IP cap on new accounts', { timeout: 120000 }, async () => {
  const before = registrations;
  let blockedAt = -1;
  for (let i = 0; i < 30; i++) {
    const r = await api(PORT, '/api/register', { username: `sec_thr_${RUN}_${i}`, password: 'secretpw' });
    if (r.status === 429) { blockedAt = i; break; }
    assert.equal(r.status, 200, `throttle-loop register ${i}: ${JSON.stringify(r.json)}`);
    registrations++;
  }
  assert.ok(blockedAt >= 0, 'registration eventually throttled with 429');
  assert.equal(registrations, REGISTER_LIMIT,
    `exactly ${REGISTER_LIMIT} successful registrations from this IP in the window (was ${before} before this test)`);
  const stillBlocked = await api(PORT, '/api/register', { username: `sec_thr_${RUN}_x`, password: 'secretpw' });
  assert.equal(stillBlocked.status, 429, 'still throttled inside the window');
});
