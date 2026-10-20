'use strict';

/**
 * Solarion Phase 6 — character creation tests.
 *
 *   1. the gate: register alone cannot enter the world (WS close
 *      4403); after POST /api/create-character it can; creation is
 *      one-shot (second call 409)
 *   2. per-axis validation + fuzz: every axis rejects invalid values,
 *      cross-gender values, wrong types; failures never consume the
 *      one-shot creation; name rules enforced
 *   3. M and F characters carry distinct, complete appearance data
 *      in world snapshots
 *   4. the in-game editor exposes the same axes, and a gender switch
 *      normalizes per-gender axes to the new gender's defaults
 *   5. a created character persists across relog AND server restart
 *   6. migration: a v1-shaped database boots into schema v2 — the
 *      legacy avatar keeps its v1 look, gains the new axes as
 *      defaults, is marked created, and can enter the world
 *
 * Run:  TEST_RUN=<n> node --test test/creation.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const PORT = 49100 + Number(RUN) * 20;
const PORT_R = PORT + 1;
const PORT_R2 = PORT + 2;
const PORT_MIG = PORT + 3;
const DB_MAIN = path.join(ROOT, 'data', `test-run-${RUN}-creation.db`);
const DB_RST = path.join(ROOT, 'data', `test-run-${RUN}-creation-restart.db`);
const DB_V1 = path.join(ROOT, 'data', `test-run-${RUN}-creation-v1.db`);

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
/** Connect expecting the server to close us; resolves the close code. */
function connectExpectClose(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`);
    const t = setTimeout(() => { ws.close(); reject(new Error('no close within 5s')); }, 5000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello') { clearTimeout(t); reject(new Error('unexpected hello for uncreated account')); }
    });
    ws.on('error', () => {});
    ws.on('close', (code) => { clearTimeout(t); resolve(code); });
  });
}
async function registerOnly(port, name) {
  const r = await api(port, '/api/register', { username: name, password: 'secretpw' });
  assert.equal(r.status, 200, `register ${name}: ${JSON.stringify(r.json)}`);
  return r.json;
}

before(async () => { await startServer(PORT, DB_MAIN); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

// ------------------------------------------------------------------
test('the gate: no world entry before creation; one-shot creation', { timeout: 30000 }, async () => {
  const reg = await registerOnly(PORT, 'gate_gwen');
  assert.equal(reg.avatar.created, false, 'fresh account avatar is uncreated');
  assert.equal(reg.avatar.name, 'gate_gwen', 'placeholder name is the username');

  const code = await connectExpectClose(PORT, reg.token);
  assert.equal(code, 4403, `uncreated WS connect closed with 4403, got ${code}`);

  const noTok = await api(PORT, '/api/create-character', { token: 'deadbeef', name: 'Gwen', gender: 'F' });
  assert.equal(noTok.status, 401, 'creation requires a session');

  const look = {
    name: 'Gwen Stacy', gender: 'F', face: 'heart', eyes: 'lash', eye_color: '#1e4d8f',
    nose: 'tiny', lips: 'rose', skin_tone: '#c68642', hair_style: 'ponytail',
    hair_color: '#c0392b', top_style: 'hoodie', body_color: '#e5639e',
    bottom_style: 'skirt', accent_color: '#2b3a55', shoe_color: '#ffd23f', accessory: 'glasses',
  };
  const c = await api(PORT, '/api/create-character', { token: reg.token, ...look });
  assert.equal(c.status, 200, `create: ${JSON.stringify(c.json)}`);
  assert.equal(c.json.avatar.created, true);
  for (const [k, v] of Object.entries(look)) assert.equal(c.json.avatar[k], v, `avatar.${k}`);

  const again = await api(PORT, '/api/create-character', { token: reg.token, ...look });
  assert.equal(again.status, 409, 'second creation rejected as one-shot');

  const client = await connectClient(PORT, reg.token);
  assert.equal(client.hello.you.name, 'Gwen Stacy');
  assert.equal(client.hello.you.gender, 'F');
  assert.equal(client.hello.you.face, 'heart');
  assert.equal(client.hello.you.bottom_style, 'skirt');
  client.ws.close();
});

// ------------------------------------------------------------------
test('per-axis validation: invalid, cross-gender, wrong-type all rejected', { timeout: 60000 }, async () => {
  const reg = await registerOnly(PORT, 'fuzz_fred');
  const base = {
    token: reg.token, name: 'Fred', gender: 'M', face: 'classic', eyes: 'round',
    eye_color: '#20242c', nose: 'button', lips: 'natural', skin_tone: '#f1c27d',
    hair_style: 'short', hair_color: '#3a2a1c', top_style: 'tee', body_color: '#3aa7e0',
    bottom_style: 'pants', accent_color: '#2b3a55', shoe_color: '#23262b', accessory: 'none',
  };
  const badCases = [
    ['gender', 'X'], ['gender', 'male'], ['gender', 1], ['gender', {}],
    ['face', 'nope'], ['face', 'heart'], // heart is F-only
    ['eyes', 'nope'], ['eyes', 'lash'], // lash is F-only
    ['nose', 'nope'], ['nose', 'tiny'], // tiny is F-only
    ['lips', 'nope'], ['lips', 'rose'], // rose is F-only
    ['hair_style', 'nope'], ['hair_style', 'ponytail'], // ponytail is F-only
    ['bottom_style', 'skirt'], // skirt is F-only
    ['skin_tone', '#000000'], ['skin_tone', 'tan'], ['skin_tone', 7],
    ['eye_color', '#123456'], ['eye_color', 'blue'],
    ['shoe_color', '#000000'], ['shoe_color', 'black'],
    ['top_style', 'tuxedo'], ['accessory', 'crown'], ['accessory', 'halo'],
    ['hair_color', 'red'], ['hair_color', '#12345'], ['hair_color', 42], ['hair_color', {}],
    ['body_color', 'blue'], ['accent_color', '#zzzzzz'],
    ['face', null], ['eyes', ['round']], ['nose', { x: 1 }],
  ];
  for (const [axis, bad] of badCases) {
    const r = await api(PORT, '/api/create-character', { ...base, [axis]: bad });
    assert.equal(r.status, 400, `${axis}=${JSON.stringify(bad)} rejected (got ${r.status})`);
    assert.match(r.json.error, /Invalid/, `${axis} error message`);
  }
  // name rules
  for (const badName of ['', 'ab', 'A'.repeat(21), 'Bad!Name', 'admin', 'System', 'has\ttab']) {
    const r = await api(PORT, '/api/create-character', { ...base, name: badName });
    assert.equal(r.status, 400, `name ${JSON.stringify(badName)} rejected (got ${r.status})`);
  }
  // none of the failures consumed the one-shot creation
  const me = await api(PORT, '/api/me', { token: reg.token });
  assert.equal(me.json.avatar.created, false, 'failed creations leave the account uncreated');
  const good = await api(PORT, '/api/create-character', base);
  assert.equal(good.status, 200, `valid create after fuzz: ${JSON.stringify(good.json)}`);
  assert.equal(good.json.avatar.created, true);
});

// ------------------------------------------------------------------
test('M and F characters carry distinct, complete snapshot appearance', { timeout: 30000 }, async () => {
  const mkF = await registerOnly(PORT, 'snap_fay');
  const fLook = {
    name: 'Fay', gender: 'F', face: 'heart', eyes: 'winged', nose: 'tiny', lips: 'red',
    hair_style: 'twintails', bottom_style: 'skirt', accessory: 'sunglasses', top_style: 'sweater',
  };
  const cf = await api(PORT, '/api/create-character', { token: mkF.token, ...fLook });
  assert.equal(cf.status, 200);
  const mkM = await registerOnly(PORT, 'snap_max');
  const mLook = {
    name: 'Max', gender: 'M', face: 'square', eyes: 'bold', nose: 'long', lips: 'smirk',
    hair_style: 'mohawk', bottom_style: 'cargo', accessory: 'cap', top_style: 'jacket',
  };
  const cm = await api(PORT, '/api/create-character', { token: mkM.token, ...mLook });
  assert.equal(cm.status, 200);

  const fc = await connectClient(PORT, mkF.token);
  const mc = await connectClient(PORT, mkM.token);
  const axes = ['gender', 'face', 'eyes', 'eye_color', 'nose', 'lips', 'skin_tone',
    'hair_style', 'hair_color', 'top_style', 'body_color', 'bottom_style',
    'accent_color', 'shoe_color', 'accessory'];
  const snapF = await waitFor(() => {
    const s = fc.msgs.filter(m => m.type === 'snapshot').pop();
    const p = s && s.players.find(pl => pl.id === mc.hello.you.id);
    return p || null;
  }, 5000, 'F sees M in snapshot');
  for (const axis of axes) assert.ok(axis in snapF, `snapshot player carries ${axis}`);
  for (const [k, v] of Object.entries(mLook)) assert.equal(snapF[k], v, `snapshot M ${k}`);
  const snapM = mc.hello.players.find(p => p.id === fc.hello.you.id)
    || (await waitFor(() => {
      const s = mc.msgs.filter(m => m.type === 'snapshot').pop();
      return s && s.players.find(pl => pl.id === fc.hello.you.id);
    }, 5000, 'M sees F in snapshot'));
  for (const [k, v] of Object.entries(fLook)) assert.equal(snapM[k], v, `snapshot F ${k}`);
  assert.notEqual(snapF.gender, snapM.gender);
  fc.ws.close(); mc.ws.close();
});

// ------------------------------------------------------------------
test('editor parity: full axes editable; gender switch normalizes', { timeout: 30000 }, async () => {
  const reg = await registerOnly(PORT, 'edit_edie');
  const c = await api(PORT, '/api/create-character', {
    token: reg.token, name: 'Edie', gender: 'F', hair_style: 'ponytail',
    bottom_style: 'skirt', face: 'heart', lips: 'cupid',
  });
  assert.equal(c.status, 200);
  const client = await connectClient(PORT, reg.token);

  // switch to M over WS: F-only axes fall back to M defaults
  client.send({ type: 'avatar-update', gender: 'M' });
  const upd = await waitFor(() => client.msgs.filter(m => m.type === 'avatar-updated').pop(), 5000, 'gender switch echo');
  assert.equal(upd.avatar.gender, 'M');
  assert.equal(upd.avatar.bottom_style, 'pants', 'skirt normalized to pants');
  assert.equal(upd.avatar.hair_style, 'short', 'ponytail normalized to short');
  assert.equal(upd.avatar.face, 'classic', 'heart normalized to classic');
  assert.equal(upd.avatar.lips, 'natural', 'cupid normalized to natural');

  // M-only values now accepted; F-only values rejected with a notice
  client.send({ type: 'avatar-update', hair_style: 'mohawk', face: 'chiseled', accessory: 'beanie' });
  const upd2 = await waitFor(() => client.msgs.filter(m => m.type === 'avatar-updated' && m.avatar.hair_style === 'mohawk').pop(), 5000, 'M look echo');
  assert.equal(upd2.avatar.hair_style, 'mohawk');
  assert.equal(upd2.avatar.accessory, 'beanie');
  client.msgs.length = 0;
  client.send({ type: 'avatar-update', bottom_style: 'skirt' });
  await waitFor(() => client.msgs.filter(m => m.type === 'notice' && /Invalid/.test(m.text)).pop(), 5000, 'F-only bottom rejected for M');

  // HTTP parity: same validation + normalization rules
  const http = await api(PORT, '/api/avatar', { token: reg.token, gender: 'F' });
  assert.equal(http.status, 200);
  assert.equal(http.json.avatar.gender, 'F');
  assert.equal(http.json.avatar.hair_style, 'long', 'mohawk normalized to F default long');
  assert.equal(http.json.avatar.face, 'classic');
  const httpBad = await api(PORT, '/api/avatar', { token: reg.token, eyes: 'bold' }); // bold is M-only
  assert.equal(httpBad.status, 400);
  client.ws.close();
});

// ------------------------------------------------------------------
test('creation persists across relog and full server restart', { timeout: 60000 }, async () => {
  const child1 = await startServer(PORT_R, DB_RST);
  const reg = await registerOnly(PORT_R, 'stay_sana');
  const look = {
    name: 'Sana', gender: 'F', face: 'oval', eyes: 'double-lash', eye_color: '#6e2a8f',
    nose: 'snub', lips: 'plum', skin_tone: '#6f4420', hair_style: 'braids',
    hair_color: '#e8c88a', top_style: 'button-up', body_color: '#ffd23f',
    bottom_style: 'leggings', accent_color: '#14663c', shoe_color: '#e8e4da', accessory: 'headband',
  };
  const c = await api(PORT_R, '/api/create-character', { token: reg.token, ...look });
  assert.equal(c.status, 200);
  const c1 = await connectClient(PORT_R, reg.token);
  assert.equal(c1.hello.you.name, 'Sana');
  c1.ws.close();
  await stopServer(child1);

  await startServer(PORT_R2, DB_RST, false);
  const me = await api(PORT_R2, '/api/me', { token: reg.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.avatar.created, true, 'still created after restart');
  for (const [k, v] of Object.entries(look)) assert.equal(me.json.avatar[k], v, `persisted ${k}`);
  const c2 = await connectClient(PORT_R2, reg.token);
  assert.equal(c2.hello.you.face, 'oval');
  assert.equal(c2.hello.you.hair_style, 'braids');
  c2.ws.close();
});

// ------------------------------------------------------------------
test('migration: v1-shaped DB boots to schema v2, legacy avatar intact + created', { timeout: 60000 }, async () => {
  // Build a genuine v1 database by hand (schema from v1 db.js).
  for (const f of [DB_V1, DB_V1 + '-wal', DB_V1 + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
  const { DatabaseSync } = require('node:sqlite');
  const bcrypt = require('bcryptjs');
  const v1 = new DatabaseSync(DB_V1);
  v1.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE avatars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      body_color TEXT NOT NULL DEFAULT '#3aa7e0',
      accent_color TEXT NOT NULL DEFAULT '#2b3a55',
      skin_tone TEXT NOT NULL DEFAULT '#f1c27d',
      hair_style TEXT NOT NULL DEFAULT 'short',
      hair_color TEXT NOT NULL DEFAULT '#3a2a1c',
      map_id TEXT NOT NULL DEFAULT 'the-gateway',
      x REAL NOT NULL DEFAULT 512,
      y REAL NOT NULL DEFAULT 560,
      zcoins INTEGER NOT NULL DEFAULT 0,
      last_bonus_day TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_ip TEXT
    );
  `);
  const now = Date.now();
  v1.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  const u = v1.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)')
    .run('legacy_p6', bcrypt.hashSync('secretpw', 10), now);
  v1.prepare(`INSERT INTO avatars (user_id, name, body_color, accent_color, skin_tone, hair_style, hair_color, map_id, x, y, zcoins, created_at)
    VALUES (?, 'Legacy Six', '#123456', '#654321', '#8d5524', 'spiky', '#abcdef', 'the-gateway', 512, 560, 250, ?)`)
    .run(u.lastInsertRowid, now);
  v1.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, last_ip) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-token-p6-0123456789abcdef', u.lastInsertRowid, now, now + 30 * 24 * 3600 * 1000, '127.0.0.1');
  v1.close();

  const child = await startServer(PORT_MIG, DB_V1, false);
  const me = await api(PORT_MIG, '/api/me', { token: 'legacy-token-p6-0123456789abcdef' });
  assert.equal(me.status, 200, `legacy session resolves: ${JSON.stringify(me.json)}`);
  const a = me.json.avatar;
  assert.equal(a.created, true, 'v1 avatar backfilled as created');
  assert.equal(a.name, 'Legacy Six');
  assert.equal(a.body_color, '#123456', 'v1 shirt color kept');
  assert.equal(a.accent_color, '#654321', 'v1 pants color kept');
  assert.equal(a.skin_tone, '#8d5524', 'v1 skin tone kept');
  assert.equal(a.hair_style, 'spiky', 'v1 hair style kept');
  assert.equal(a.hair_color, '#abcdef', 'v1 hair color kept');
  assert.equal(a.zcoins, 250, 'v1 balance kept');
  assert.equal(a.gender, 'M');
  assert.equal(a.face, 'classic');
  assert.equal(a.top_style, 'tee');
  assert.equal(a.bottom_style, 'pants');
  assert.equal(a.shoe_color, '#23262b');
  assert.equal(a.accessory, 'none');

  const client = await connectClient(PORT_MIG, 'legacy-token-p6-0123456789abcdef');
  assert.equal(client.hello.you.name, 'Legacy Six', 'legacy avatar enters the world, no creation demanded');
  assert.equal(client.hello.you.hair_style, 'spiky');
  client.ws.close();
  await stopServer(child);

  // The file on disk is now schema v2 with the new columns.
  const after = new DatabaseSync(DB_V1, { readOnly: true });
  const ver = after.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(ver.value, '2', 'schema_version bumped to 2');
  const cols = after.prepare('PRAGMA table_info(avatars)').all().map(r => r.name);
  for (const col of ['gender', 'face', 'eyes', 'eye_color', 'nose', 'lips', 'top_style', 'bottom_style', 'shoe_color', 'accessory', 'created']) {
    assert.ok(cols.includes(col), `avatars has ${col}`);
  }
  after.close();
});
