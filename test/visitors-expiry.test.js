'use strict';
/*
 * test/visitors-expiry.test.js — v1.9.2 regression: a summoned
 * visitor LEAVES when the visit ends.
 *
 * X, live on v1.9 (2026-10-24): "Orenius didn't go away after 3
 * minutes." Root cause: isPresent() OR-ed the cached st.present
 * flag back into itself, so presence latched true forever (and
 * scheduledNow() was never consulted, so the daily 8 PM window
 * could never fire either). This suite boots the server with
 * SOLARION_VISIT_MS=2500 — a 2.5-second visit, schedule disabled
 * — and proves: summon -> present -> expiry -> absent -> talking
 * to the empty air does nothing -> a fresh summon works again.
 * The mechanism is shared by Orenius and Agent Sims (one
 * isPresent/refreshPresence path), so one visitor stands for both.
 *
 * Run:  TEST_RUN=<n> node --test test/visitors-expiry.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `vexp-run-${RUN}.db`);
const PORT = 51400 + Number(RUN) * 20;

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
    env: {
      ...process.env, SOLARION_PORT: String(port), SOLARION_DB_PATH: dbPath,
      SOLARION_TEST: '1', SOLARION_VISIT_MS: '2500',
    },
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

let server;
let owner;

before(async () => {
  server = await startServer(PORT, DB);
  owner = await makeUser('zantheon');
});

after(async () => {
  try { owner.client.ws.close(); } catch (e) { /* done */ }
  await stopServer(server);
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* done */ } }
});

const states = () => owner.client.msgs.filter(m => m.type === 'visitor-state' && m.id === 'orenius');

test('a summoned visitor leaves when the visit ends', { timeout: 60000 }, async () => {
  assert.equal(owner.client.hello.you.canSummon, true, 'the owner can summon');

  owner.client.send({ type: 'visitor-summon', id: 'orenius' });
  await waitFor(() => states().filter(m => m.present).pop(), 5000, 'summoned: Orenius present');

  // The regression: without any further action, the visit expires
  // and the room is told he is gone.
  await waitFor(() => states().filter(m => !m.present).pop(), 9000, 'the visit ends: Orenius gone');

  // Talking to the empty air opens nothing.
  owner.client.send({ type: 'visitor-talk', id: 'orenius' });
  await sleep(700);
  assert.ok(!owner.client.msgs.some(m => m.type === 'visitor-dialogue' && m.id === 'orenius'),
    'no dialogue with an absent visitor');

  // And the state machine is reusable: a fresh summon works.
  owner.client.send({ type: 'visitor-summon', id: 'orenius' });
  await waitFor(() => states().filter(m => m.present).length >= 2, 5000, 'summoned again: present again');
  await waitFor(() => states().filter(m => !m.present).length >= 2, 9000, 'and gone again on schedule');
});
