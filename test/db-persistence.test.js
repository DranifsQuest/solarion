'use strict';

/**
 * Solarion — DB persistence / driver-switch tests (persistent-DB build).
 *
 * Covers the src/db.js driver contract:
 *   DATABASE_URL unset                      -> node:sqlite at SOLARION_DB_PATH
 *   DATABASE_URL=file:<path>                -> sync `libsql` driver, local file
 *   DATABASE_URL=libsql://… (+AUTH_TOKEN)   -> sync `libsql` driver, Turso remote
 * db.js exports DB_DRIVER ('sqlite' | 'libsql') and DB_REMOTE (bool).
 *
 *   1. LOCAL PATH REGRESSION — in-process require of src/db.js with a
 *      tmp SOLARION_DB_PATH and DATABASE_URL unset: DB_DRIVER must be
 *      'sqlite', DB_REMOTE false, and a register/query round-trip
 *      through `q` must work. This is the path every existing suite
 *      (and today's production) runs on.
 *   2. LIBSQL DRIVER SELECTION — in-process require with
 *      DATABASE_URL=file:<tmp>: DB_DRIVER must be 'libsql',
 *      DB_REMOTE false, and the same `q` round-trip must work
 *      against the libsql-backed file.
 *   3. LIBSQL LOCAL-FILE PERSISTENCE — the real server booted TWICE
 *      against one libsql file (DATABASE_URL=file:…): register +
 *      create-character + WS hello on boot 1; after a full process
 *      restart, login + /api/me + WS hello on boot 2 must return the
 *      same account and the intact character look.
 *      DRIVER SIGNAL: /health and the boot log do NOT expose the
 *      selected driver (checked 2026-10-22 — /health returns
 *      ok/game/phase/version/uptime/players/maps/tick only), so this
 *      test proves the libsql path indirectly but conclusively:
 *      SOLARION_DB_PATH is pointed at a DECOY tmp file for both
 *      boots. If the server had silently fallen back to node:sqlite,
 *      every write would land in the decoy and the DATABASE_URL file
 *      would never be created. Asserting (decoy missing) AND
 *      (DATABASE_URL file exists, non-empty) AND (data survived the
 *      restart) can only hold if the libsql driver served both
 *      boots. Test 2 pins the selection directly via DB_DRIVER.
 *   4. REMOTE (Turso) — SKIP-CLEAN unless BOTH
 *      SOLARION_TEST_REMOTE_DB_URL (libsql://…) and
 *      SOLARION_TEST_REMOTE_DB_TOKEN are set. When set, it repeats
 *      the two-boot persistence flow against the real endpoint AND
 *      runs the transaction-atomicity probe (the pre-friends
 *      go/no-go check): two connections interleave the casino-style
 *      guarded debit (BEGIN IMMEDIATE; UPDATE … WHERE balance >= x;
 *      COMMIT) and the final balance must equal the serialized
 *      outcome, with a failed guard leaving NO partial write behind.
 *
 * Run:  TEST_RUN=<n> node --test test/db-persistence.test.js
 * Remote: SOLARION_TEST_REMOTE_DB_URL=libsql://… \
 *         SOLARION_TEST_REMOTE_DB_TOKEN=… \
 *         TEST_RUN=<n> node --test test/db-persistence.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || 'x';
const PORT_LIBSQL = 51100 + (Number(RUN) || 0) * 20;
const PORT_REMOTE = PORT_LIBSQL + 1;
const ROOT = path.join(__dirname, '..');
const SFX = Date.now().toString(36).slice(-6);
const PW = 'secretpw';

const children = [];
const tmpDirs = [];

function mkTmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `solarion-${tag}-`));
  tmpDirs.push(dir);
  return dir;
}

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

// ------------------------------------------------------------ server boot
// Mirrors test/club.test.js / test/test.js: real child process,
// SOLARION_PORT + SOLARION_DB_PATH + SOLARION_TEST=1, ready when the
// boot log prints 'listening on'. DB-driver env keys are SCRUBBED
// from the inherited env first, then set explicitly per boot, so a
// stray DATABASE_URL in the caller's shell can never leak into a
// boot that is supposed to exercise the local path (or vice versa).
function startServer(port, extraEnv) {
  const env = { ...process.env, SOLARION_PORT: String(port), SOLARION_TEST: '1' };
  delete env.DATABASE_URL;
  delete env.DATABASE_AUTH_TOKEN;
  delete env.SOLARION_DB_DRIVER;
  Object.assign(env, extraEnv);
  const child = spawn('node', ['src/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child._out = '';
  child.stdout.on('data', (d) => { child._out += d.toString(); });
  child.stderr.on('data', (d) => { child._out += d.toString(); });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start on ${port}; output: ${child._out.slice(-400)}`)), 30000);
    child.stdout.on('data', () => {
      if (child._out.includes('listening on')) { clearTimeout(t); resolve(child); }
    });
    child.on('exit', (code) => {
      if (!child._out.includes('listening on')) {
        clearTimeout(t);
        reject(new Error(`server exited early (${code}) on ${port}: ${child._out.slice(-400)}`));
      }
    });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitFor(() => child.exitCode !== null, 5000, 'server exit');
  } catch (e) {
    child.kill('SIGKILL');
    await waitFor(() => child.exitCode !== null, 5000, 'server kill');
  }
  const i = children.indexOf(child);
  if (i >= 0) children.splice(i, 1);
}

after(async () => {
  for (const c of [...children]) await stopServer(c).catch(() => {});
  for (const dir of tmpDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
});

// ------------------------------------------------------------ http / ws

async function api(port, route, body) {
  const res = await fetch(`http://localhost:${port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function connectClient(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws?token=${encodeURIComponent(token)}`);
    const client = { ws, msgs: [], hello: null, send: (m) => ws.send(JSON.stringify(m)) };
    const t = setTimeout(() => { try { ws.terminate(); } catch (e) {} reject(new Error('no hello within 8s')); }, 8000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      client.msgs.push(m);
      if (m.type === 'hello') { client.hello = m; clearTimeout(t); resolve(client); }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// A distinctive, non-default look — every axis differs from the
// appearance defaults, so an intact round-trip cannot be a fluke of
// defaults being re-applied after the restart.
const LOOK = {
  gender: 'F', face: 'heart', eyes: 'lash', eye_color: '#1e4d8f',
  nose: 'tiny', lips: 'rose', skin_tone: '#c68642',
  hair_style: 'ponytail', hair_color: '#c0392b', top_style: 'hoodie',
  body_color: '#e5639e', bottom_style: 'skirt', accent_color: '#2b3a55',
  shoe_color: '#ffd23f', accessory: 'glasses',
};
const LOOK_KEYS = Object.keys(LOOK);

function assertLookIntact(avatar, username, where) {
  assert.ok(avatar, `${where}: no avatar`);
  assert.equal(avatar.name, username, `${where}: avatar name`);
  assert.equal(avatar.created, true, `${where}: character must still be marked created`);
  for (const k of LOOK_KEYS) {
    assert.equal(avatar[k], LOOK[k], `${where}: avatar.${k} = ${avatar[k]}, expected ${LOOK[k]}`);
  }
}

/**
 * The two-boot persistence flow shared by the libsql-local test and
 * the remote test: boot -> register -> create-character -> WS hello;
 * kill; boot again on the SAME database -> login -> /api/me -> WS
 * hello; the account and the full character look must be intact,
 * and the welcome bonus must NOT be granted a second time.
 */
async function exercisePersistence({ port, extraEnv, username }) {
  // ---- boot 1: register + create + connect
  const s1 = await startServer(port, extraEnv);
  let token1;
  try {
    const reg = await api(port, '/api/register', { username, password: PW });
    assert.equal(reg.status, 200, `register ${username}: ${JSON.stringify(reg.json)}`);
    assert.ok(reg.json.token, 'register returns a session token');
    assert.equal(reg.json.avatar.created, false, 'fresh account starts uncreated');
    token1 = reg.json.token;

    const cc = await api(port, '/api/create-character', { token: token1, name: username, ...LOOK });
    assert.equal(cc.status, 200, `create-character ${username}: ${JSON.stringify(cc.json)}`);
    assertLookIntact(cc.json.avatar, username, 'boot 1 create-character');

    const c1 = await connectClient(port, token1);
    try {
      assert.equal(c1.hello.you.name, username, 'boot 1 hello: name');
      for (const k of ['gender', 'face', 'eyes', 'nose', 'lips', 'hair_style', 'bottom_style']) {
        assert.equal(c1.hello.you[k], LOOK[k], `boot 1 hello: you.${k}`);
      }
      assert.equal(c1.hello.zcoins, 5000, 'boot 1 hello: 5,000z welcome bonus on first connect');
    } finally { c1.ws.close(); }
  } finally {
    await stopServer(s1);
  }

  // ---- boot 2: same database — login must work, look intact
  const s2 = await startServer(port, extraEnv);
  try {
    const li = await api(port, '/api/login', { username, password: PW });
    assert.equal(li.status, 200, `login after restart: ${JSON.stringify(li.json)}`);
    assert.ok(li.json.token, 'login after restart returns a token');

    const me = await api(port, '/api/me', { token: li.json.token });
    assert.equal(me.status, 200, `/api/me after restart: ${JSON.stringify(me.json)}`);
    assertLookIntact(me.json.avatar, username, 'boot 2 /api/me');

    const c2 = await connectClient(port, li.json.token);
    try {
      assert.equal(c2.hello.you.name, username, 'boot 2 hello: name');
      for (const k of ['gender', 'face', 'eyes', 'nose', 'lips', 'hair_style', 'bottom_style']) {
        assert.equal(c2.hello.you[k], LOOK[k], `boot 2 hello: you.${k}`);
      }
      assert.equal(c2.hello.bonusGranted, false, 'boot 2 hello: welcome bonus must not re-grant after restart');
      assert.equal(c2.hello.zcoins, 5000, 'boot 2 hello: balance persisted across restart');
    } finally { c2.ws.close(); }
    return { bootLog: s2._out };
  } finally {
    await stopServer(s2);
  }
}

// ------------------------------------------- in-process db.js loading
// db.js reads its env ONCE at require time. Load it fresh (require
// cache busted) under a controlled env, run fn(mod), then close the
// handle, bust the cache again, and restore the caller's env.
const DB_ENV_KEYS = ['SOLARION_DB_PATH', 'DATABASE_URL', 'DATABASE_AUTH_TOKEN', 'SOLARION_DB_DRIVER'];

function loadDbFresh(envOverrides, fn) {
  const saved = {};
  for (const k of DB_ENV_KEYS) {
    saved[k] = process.env[k];
    if (envOverrides[k] === undefined) delete process.env[k];
    else process.env[k] = envOverrides[k];
  }
  const dbPath = require.resolve('../src/db.js');
  delete require.cache[dbPath];
  let mod = null;
  try {
    mod = require(dbPath);
    return fn(mod);
  } finally {
    try { if (mod && mod.db && typeof mod.db.close === 'function') mod.db.close(); } catch (e) { /* ignore */ }
    delete require.cache[dbPath];
    for (const k of DB_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function qRoundTrip(mod, username) {
  const now = Date.now();
  mod.q.insertUser.run(username, 'not-a-real-hash', now);
  const row = mod.q.userByName.get(username);
  assert.ok(row, `q.userByName finds ${username}`);
  assert.equal(row.username, username);
  assert.equal(row.pass_hash, 'not-a-real-hash');
  assert.equal(Number(row.created_at), now);
}

// ---------------------------------------------------------------- 1 + 2

test('local path regression: DATABASE_URL unset selects node:sqlite and q round-trips', { timeout: 30000 }, () => {
  const dir = mkTmpDir('sqlite-reg');
  const dbFile = path.join(dir, 'local.db');
  loadDbFresh({ SOLARION_DB_PATH: dbFile }, (mod) => {
    assert.equal(mod.DB_DRIVER, 'sqlite', `DB_DRIVER must be 'sqlite' with DATABASE_URL unset, got ${mod.DB_DRIVER}`);
    assert.equal(mod.DB_REMOTE, false, 'DB_REMOTE must be false on the local path');
    assert.equal(mod.DB_PATH, dbFile, 'local driver must open SOLARION_DB_PATH');
    qRoundTrip(mod, `reg_${SFX}`);
  });
  assert.ok(fs.existsSync(dbFile), 'node:sqlite created the SOLARION_DB_PATH file');
});

test('libsql driver selection: DATABASE_URL=file: selects libsql (local file, not remote)', { timeout: 30000 }, () => {
  const dir = mkTmpDir('libsql-sel');
  const dbFile = path.join(dir, 'selected.db');
  loadDbFresh({ SOLARION_DB_PATH: path.join(dir, 'decoy.db'), DATABASE_URL: `file:${dbFile}` }, (mod) => {
    assert.equal(mod.DB_DRIVER, 'libsql', `DB_DRIVER must be 'libsql' with DATABASE_URL=file:, got ${mod.DB_DRIVER}`);
    assert.equal(mod.DB_REMOTE, false, 'DB_REMOTE must be false for a file: URL');
    qRoundTrip(mod, `sel_${SFX}`);
  });
  assert.ok(fs.existsSync(dbFile), 'libsql driver created/wrote the DATABASE_URL file');
});

// ---------------------------------------------------------------- 3

test('libsql local file: account + character survive a full server restart', { timeout: 90000 }, async () => {
  const dir = mkTmpDir('libsql-persist');
  const dbFile = path.join(dir, 'persist.db');
  const decoy = path.join(dir, 'decoy-sqlite.db');
  const username = `dbpa${SFX}`;
  const extraEnv = { SOLARION_DB_PATH: decoy, DATABASE_URL: `file:${dbFile}` };

  await exercisePersistence({ port: PORT_LIBSQL, extraEnv, username });

  // Indirect driver proof (see header): the writes can only have
  // landed in the DATABASE_URL file if the libsql driver served
  // both boots — node:sqlite would have used the decoy path.
  assert.ok(fs.existsSync(dbFile), 'libsql file exists at the DATABASE_URL path');
  assert.ok(fs.statSync(dbFile).size > 0, 'libsql file is non-empty after two boots of writes');
  assert.ok(!fs.existsSync(decoy), 'SOLARION_DB_PATH decoy was never created — no silent node:sqlite fallback');
});

// ---------------------------------------------------------------- 4

const REMOTE_URL = process.env.SOLARION_TEST_REMOTE_DB_URL || '';
const REMOTE_TOKEN = process.env.SOLARION_TEST_REMOTE_DB_TOKEN || '';
const REMOTE_SET = /^libsql:\/\//.test(REMOTE_URL) && REMOTE_TOKEN.length > 0;

test('remote (Turso): persistence across restart + transaction atomicity probe', {
  timeout: 240000,
  skip: REMOTE_SET ? false
    : 'SKIPPED — remote DB test not configured: set SOLARION_TEST_REMOTE_DB_URL (libsql://…) and SOLARION_TEST_REMOTE_DB_TOKEN to run the remote persistence + transaction-atomicity go/no-go probe',
}, async () => {
  // ---- persistence against the real endpoint (two real boots)
  const dir = mkTmpDir('remote-persist');
  const username = `dbpr${SFX}`;
  await exercisePersistence({
    port: PORT_REMOTE,
    extraEnv: {
      SOLARION_DB_PATH: path.join(dir, 'decoy-sqlite.db'),
      DATABASE_URL: REMOTE_URL,
      DATABASE_AUTH_TOKEN: REMOTE_TOKEN,
    },
    username,
  });

  // ---- transaction-atomicity probe — THE PRE-FRIENDS GO/NO-GO CHECK.
  // Two independent connections to the remote endpoint interleave
  // the casino pattern (BEGIN IMMEDIATE; conditional UPDATE …
  // WHERE balance >= x; COMMIT). The guarded debits must behave
  // exactly as if serialized: no double-spend across connections,
  // and a debit whose guard fails must leave NO partial write.
  const FAIL = (msg) => assert.fail(
    `\n*** REMOTE TRANSACTION ATOMICITY PROBE FAILED — NO-GO for friends/casino on the remote DB ***\n*** ${msg}\n*** Do NOT ship the remote DB for money-moving features until this passes. ***`);

  let Libsql;
  try {
    Libsql = require('libsql');
  } catch (e) {
    FAIL(`the sync 'libsql' package is not resolvable from the test process (${e.message}) — the probe could not run at all`);
  }
  const DbClass = Libsql.Database || Libsql.default || Libsql;
  const openRemote = () => new DbClass(REMOTE_URL, { authToken: REMOTE_TOKEN });
  // changes() with a fallback for driver builds whose run() omits it.
  const runChanges = (conn, sql, ...params) => {
    const r = conn.prepare(sql).run(...params);
    if (r && typeof r.changes === 'number') return r.changes;
    const c = conn.prepare('SELECT changes() AS c').get();
    return c ? Number(c.c) : NaN;
  };

  const tbl = `persist_probe_${SFX.replace(/[^a-z0-9]/gi, '')}`;
  const GUARDED_DEBIT = `UPDATE ${tbl} SET balance = balance - ? WHERE id = 1 AND balance >= ?`;
  let A = null; let B = null;
  try {
    A = openRemote();
    B = openRemote();
    A.exec(`DROP TABLE IF EXISTS ${tbl}`);
    A.exec(`CREATE TABLE ${tbl} (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL, marker TEXT)`);
    A.prepare(`INSERT INTO ${tbl} (id, balance, marker) VALUES (1, 100, 'init')`).run();
    const readRow = () => A.prepare(`SELECT balance, marker FROM ${tbl} WHERE id = 1`).get();

    // A opens an interactive transaction and debits 60 of 100.
    A.exec('BEGIN IMMEDIATE');
    const aChanges = runChanges(A, GUARDED_DEBIT, 60, 60);
    if (aChanges !== 1) FAIL(`A's guarded debit inside BEGIN IMMEDIATE changed ${aChanges} rows, expected 1`);

    // While A's transaction is still open, B attempts the same
    // debit. On a correct remote interactive-transaction
    // implementation B must NOT be able to commit a second 60z
    // debit against the same 100z: its BEGIN/write must block,
    // error, or (if it somehow proceeds) its transaction is
    // discarded here and re-probed after A commits.
    let bInterleave = 'blocked-or-errored';
    try {
      B.exec('BEGIN IMMEDIATE');
      const bChanges = runChanges(B, GUARDED_DEBIT, 60, 60);
      bInterleave = `began-and-changed-${bChanges}`;
      B.exec('ROLLBACK'); // discard the attempt either way; the serialized re-probe below is the verdict
    } catch (e) {
      try { B.exec('ROLLBACK'); } catch (e2) { /* no txn open */ }
    }

    A.exec('COMMIT');
    const afterA = readRow();
    if (!afterA || afterA.balance !== 40) {
      FAIL(`after A commits, balance = ${afterA && afterA.balance}, expected exactly 40 (100 - 60). Interleave outcome: ${bInterleave}`);
    }

    // Serialized re-probe: B's 60z debit must now FAIL its guard
    // (only 40z left) and its whole transaction — including an
    // unrelated marker write made BEFORE the guard — must roll
    // back atomically, leaving no partial write behind.
    B.exec('BEGIN IMMEDIATE');
    B.prepare(`UPDATE ${tbl} SET marker = 'B-partial' WHERE id = 1`).run();
    const bGuard = runChanges(B, GUARDED_DEBIT, 60, 60);
    if (bGuard !== 0) {
      try { B.exec('ROLLBACK'); } catch (e) { /* ignore */ }
      FAIL(`B's guarded debit of 60 against a 40 balance changed ${bGuard} rows — the WHERE balance >= x guard did not hold remotely`);
    }
    B.exec('ROLLBACK');
    const afterB = readRow();
    if (!afterB || afterB.balance !== 40 || afterB.marker !== 'init') {
      FAIL(`failed-guard transaction left a partial write: balance=${afterB && afterB.balance} marker=${afterB && afterB.marker}, expected balance=40 marker='init'`);
    }

    // A final serialized debit of exactly the remainder succeeds.
    A.exec('BEGIN IMMEDIATE');
    const a2Changes = runChanges(A, GUARDED_DEBIT, 40, 40);
    if (a2Changes !== 1) FAIL(`final guarded debit of 40 changed ${a2Changes} rows, expected 1`);
    A.exec('COMMIT');
    const finalRow = readRow();
    if (!finalRow || finalRow.balance !== 0) {
      FAIL(`final balance = ${finalRow && finalRow.balance}, expected exactly 0 (100 - 60 - 40, failed 60 correctly rejected). Interleave outcome: ${bInterleave}`);
    }
  } catch (e) {
    if (e && e.code === 'ERR_ASSERTION') throw e;
    FAIL(`probe errored: ${e && e.message}`);
  } finally {
    try { if (A) A.exec(`DROP TABLE IF EXISTS ${tbl}`); } catch (e) { /* ignore */ }
    try { if (A && typeof A.close === 'function') A.close(); } catch (e) { /* ignore */ }
    try { if (B && typeof B.close === 'function') B.close(); } catch (e) { /* ignore */ }
  }
});
