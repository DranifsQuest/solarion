'use strict';

/**
 * Solarion Phase 3 — casino test suite.
 *
 * Spawns real server processes and drives them over HTTP + WebSocket:
 *   a. full 2-player poker hand start -> showdown; balances/chips move
 *      correctly server-side (chip conservation, private hole cards)
 *   b. 3-player hand producing a SIDE POT: exact distribution is
 *      pinned by a deterministic unit test against the ported table
 *      code (rigged cards/stacks); the live 3-player all-in hand
 *      proves the integration conserves every z coin
 *   c. invalid actions rejected (out of turn, bet beyond balance,
 *      occupied chair, act after folding / with no hand)
 *   d. slots: every bet size, exact balance math, bet > balance
 *      impossible, negative balance impossible, cooldown respected,
 *      proximity required
 *   e. poker state cleaned up on disconnect AND on map change
 *      (chips refunded, no phantom seats)
 *   f. balances persist across a server restart, including stranded
 *      table chips (crash ledger refund)
 *
 * Run:  TEST_RUN=<n> node --test test/casino.test.js (or npm test)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');

// Unit-level access to the ported engine (pure functions + table class).
// Point the DB layer at a throwaway file before requiring it.
process.env.SOLARION_DB_PATH = path.join(__dirname, '..', 'data', `ctest-unit-${process.env.TEST_RUN || '0'}.db`);
const casino = require('../src/casino');
casino.initLedger();

const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `ctest-run-${RUN}.db`);
const DB_RESTART = path.join(ROOT, 'data', `ctest-run-${RUN}-restart.db`);
const PORT = 49700 + Number(RUN) * 20;
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
    // SOLARION_REGISTER_LIMIT: this suite legitimately creates
    // >20 synthetic accounts from localhost (the production cap
    // of 20/hour/IP is pinned by security.test.js on its own
    // server; the v1.3.1 seat-release test tipped this file over).
    env: { ...process.env, SOLARION_PORT: String(port), SOLARION_DB_PATH: dbPath, SOLARION_TEST: '1', SOLARION_REGISTER_LIMIT: '100' },
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

async function balanceOf(user, port = PORT) {
  const r = await api(port, '/api/me', { token: user.token });
  assert.equal(r.status, 200);
  return r.json.avatar.zcoins;
}

async function toBay(user) {
  user.client.send({ type: 'debug-teleport', x: 1120, y: 48 });
  await waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(),
    5000, `${user.name} arrives in solstice-bay`);
}

/** Bay -> through the Casino building door -> Casino Lounge scene. */
async function toCasino(user) {
  await toBay(user);
  await sleep(1600); // portal debounce from the arch hop
  user.client.send({ type: 'debug-teleport', x: 496, y: 1200 }); // door tile, building east face
  await waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === 'casino-lounge').pop(),
    5000, `${user.name} arrives in casino-lounge`);
}

const T1 = { id: 'casino-lounge-poker-1', x: 176, y: 144 };
const T2 = { id: 'casino-lounge-poker-2', x: 400, y: 144 };
const SLOT1_SPOT = { x: 624, y: 112 }; // slot 1 stool (slots section moved east in the 36x24 casino, v1.2.3)

function latestTable(user, tableId) {
  return user.client.msgs.filter(m => m.type === 'poker-state' && m.id === tableId).pop() || null;
}

async function sitAt(user, table, chair) {
  user.client.send({ type: 'debug-teleport', x: table.x, y: table.y });
  await sleep(250);
  user.client.send({ type: 'poker', action: 'sit', table: table.id, chair });
  const st = await waitFor(() => {
    const s = latestTable(user, table.id);
    return s && s.chairs.some(c => c.name === user.name) ? s : null;
  }, 5000, `${user.name} seated at ${table.id} ${chair}`);
  return st;
}

function seatChips(state, name) {
  const c = state.chairs.find(ch => ch.name === name);
  return c ? c.chips + c.bet : null; // bet is still that seat's equity mid-hand
}

/** Drive a hand: whenever it's `user`'s turn, run strategy(state). */
async function driveHand(users, tableId, strategy, timeoutMs = 60000) {
  const start = Date.now();
  for (;;) {
    let doneState = null;
    for (const u of users) {
      const st = latestTable(u, tableId);
      if (st && st.state === 'done') doneState = st;
    }
    if (doneState) return doneState;
    if (Date.now() - start > timeoutMs) throw new Error('hand did not finish in time');
    for (const u of users) {
      const st = latestTable(u, tableId);
      if (!st) continue;
      const idx = st.chairs.findIndex(c => c.name === u.name);
      if (idx >= 0 && st.chairs[idx].acting) {
        strategy(u, st);
        await sleep(450);
      }
    }
    await sleep(200);
  }
}

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

// ------------------------------------------------------------------ b (unit)

test('side pots: buildPots + showdown distribute exactly (deterministic, ported engine)', { timeout: 30000 }, () => {
  const fakeGame = {
    getPlayer: () => null,
    send: () => {},
    broadcastToMap: () => {},
    savePosition: () => {},
  };
  const fakeCasino = { mapId: 'solstice-bay' };
  const def = {
    id: 'unit-table', x: 0, y: 0,
    chairs: ['N', 'E', 'S', 'W'].map((dir, i) => ({ dir, x: i * 10, y: 0 })),
  };
  const table = new casino.PokerTable(fakeGame, fakeCasino, def);
  const C = (r, s) => ({ r, s });
  // Community: 9♣ J♥ K♦ 4♣ 2♠
  table.community = [C(9, 'c'), C(11, 'h'), C(13, 'd'), C(4, 'c'), C(2, 's')];
  const mkSeat = (userId, name, hole, committed) => ({
    userId, name, chips: 0, bet: 0, committed, hole,
    inHand: true, folded: false, allIn: true, sittingOut: false,
  });
  // A: pair of Aces, committed 100. B: pair of Kings, committed 50.
  // C: Q♦ T♣ makes the 9–K straight, committed 20 (short stack).
  table.chairs[0].seat = mkSeat(1, 'A', [C(14, 's'), C(14, 'h')], 100);
  table.chairs[1].seat = mkSeat(2, 'B', [C(13, 's'), C(3, 'h')], 50);
  table.chairs[2].seat = mkSeat(3, 'C', [C(12, 'd'), C(10, 'c')], 20);
  table.dealerChair = 0;

  const pots = table.buildPots();
  assert.deepEqual(pots.map(p => p.amount), [60, 60, 50], 'pot ladder: main 60, side 60, side 50');
  assert.deepEqual(pots.map(p => p.eligible.map(s => s.name)), [['A', 'B', 'C'], ['A', 'B'], ['A']]);

  table.showdown();
  const chips = Object.fromEntries(table.chairs.filter(c => c.seat).map(c => [c.seat.name, c.seat.chips]));
  // C (straight) wins ONLY the main pot it was eligible for: 60.
  // A (Aces > Kings) wins both side pots: 60 + 50 = 110. B gets 0.
  assert.deepEqual(chips, { A: 110, B: 0, C: 60 });
  const won = Object.fromEntries(table.lastWinners.map(w => [w.name, w.amount]));
  assert.deepEqual(won, { C: 60, A: 110 });
  assert.equal(table.lastWinners.find(w => w.name === 'C').hand, 'Straight');
});

// ------------------------------------------------------------------ a

test('poker: full 2-player hand start -> showdown, chip conservation, private hole cards', { timeout: 90000 }, async () => {
  const a = await makeUser('pk_alice');
  const b = await makeUser('pk_bob');
  assert.equal(a.client.hello.zcoins, 5000);
  assert.equal(b.client.hello.zcoins, 5000);
  await toCasino(a); await toCasino(b);

  await sitAt(a, T1, 'N');
  await sitAt(b, T1, 'S');
  // Buy-in moved 100z from each balance into chips (server-side).
  assert.equal(await balanceOf(a), 4800, 'A balance debited by buy-in (200z max stack)');
  assert.equal(await balanceOf(b), 4800, 'B balance debited by buy-in (200z max stack)');

  // Hole cards are dealt privately: each player gets exactly one
  // poker-cards message, and the two hands share no card.
  const cardsA = await waitFor(() => a.client.msgs.filter(m => m.type === 'poker-cards').pop(), 20000, 'A hole cards (after countdown)');
  const cardsB = await waitFor(() => b.client.msgs.filter(m => m.type === 'poker-cards').pop(), 5000, 'B hole cards');
  assert.equal(cardsA.cards.length, 2);
  assert.equal(cardsB.cards.length, 2);
  assert.equal(a.client.msgs.filter(m => m.type === 'poker-cards').length, 1, 'A received cards once');
  assert.equal(b.client.msgs.filter(m => m.type === 'poker-cards').length, 1, 'B received cards once');
  for (const c of cardsA.cards) assert.ok(!cardsB.cards.includes(c), 'hands are disjoint (unique deck)');

  // Check/call the hand down to showdown.
  const done = await driveHand([a, b], T1.id, (u, st) => {
    u.client.send({ type: 'poker', action: 'act', table: T1.id, act: st.toCall > 0 ? 'call' : 'check' });
  });
  assert.equal(done.state, 'done');
  assert.ok(Array.isArray(done.winners) && done.winners.length >= 1, 'a winner was paid');
  const wonTotal = done.winners.reduce((s, w) => s + w.amount, 0);
  assert.equal(wonTotal, done.pot, `winners paid exactly the pot (${wonTotal} == ${done.pot})`);
  assert.ok(done.community.length === 5 || done.reveal, 'showdown reached with a full board or a reveal');

  // After cleanup: every z coin is accounted for (balances + stacks).
  const idle = await waitFor(() => {
    const s = latestTable(a, T1.id);
    return s && s.state === 'idle' ? s : null;
  }, 15000, 'table back to idle after hand');
  const total = (await balanceOf(a)) + seatChips(idle, a.name)
    + (await balanceOf(b)) + seatChips(idle, b.name);
  assert.equal(total, 10000, 'chip conservation: two 200z stacks + 4,800z balances');
  a.client.ws.close(); b.client.ws.close();
});

// ------------------------------------------------------------------ b (live)

test('poker: live 3-player all-in hand creates side-pot ladder and conserves chips', { timeout: 90000 }, async () => {
  const a = await makeUser('sp_ann');
  const b = await makeUser('sp_ben');
  const c = await makeUser('sp_cyd');
  await toCasino(a); await toCasino(b); await toCasino(c);
  await sitAt(a, T1, 'N');
  await sitAt(b, T1, 'E');
  await sitAt(c, T1, 'S');
  // Unequal stacks (test hook): 100 / 50 / 20 — the classic side-pot setup.
  a.client.send({ type: 'debug-casino', op: 'set-chips', chips: 100 });
  b.client.send({ type: 'debug-casino', op: 'set-chips', chips: 50 });
  c.client.send({ type: 'debug-casino', op: 'set-chips', chips: 20 });
  await sleep(300);

  const done = await driveHand([a, b, c], T1.id, (u) => {
    u.client.send({ type: 'poker', action: 'act', table: T1.id, act: 'allin' });
  });
  assert.ok(done.winners && done.winners.length >= 1);
  const wonTotal = done.winners.reduce((s, w) => s + w.amount, 0);
  assert.equal(wonTotal, done.pot, 'all pots paid out in full');
  // The short stack (Cyd, 20 in) can never win more than the main pot
  // (20 x 3 = 60) — side-pot eligibility is enforced by the engine.
  const cydWin = (done.winners.find(w => w.name === c.name) || { amount: 0 }).amount;
  assert.ok(cydWin <= 60, `short stack won ${cydWin}z (max main pot 60)`);

  const idle = await waitFor(() => {
    const s = latestTable(a, T1.id);
    return s && s.state === 'idle' ? s : null;
  }, 15000, 'table idle after side-pot hand');
  // System total after the debug stack-set: chips 100+50+20 = 170,
  // plus balances of 4,800 each (5,000 welcome − the 200z max buy-in).
  const total = seatChips(idle, a.name) + seatChips(idle, b.name) + seatChips(idle, c.name)
    + (await balanceOf(a)) + (await balanceOf(b)) + (await balanceOf(c));
  assert.equal(total, 14570, 'chip conservation across the side-pot hand');
  a.client.ws.close(); b.client.ws.close(); c.client.ws.close();
});

// ------------------------------------------------------------------ c

test('poker: invalid actions are rejected', { timeout: 90000 }, async () => {
  const a = await makeUser('bad_andy');
  const b = await makeUser('bad_beth');
  const c = await makeUser('bad_cleo');
  await toCasino(a); await toCasino(b); await toCasino(c);
  await sitAt(a, T2, 'N');
  await sitAt(b, T2, 'S');

  // Act with no hand running (idle/countdown): rejected.
  a.client.msgs.length = 0;
  a.client.send({ type: 'poker', action: 'act', table: T2.id, act: 'check' });
  const noHand = await waitFor(() => a.client.msgs.filter(m => m.type === 'notice' && /No hand in progress/.test(m.text)).pop(),
    5000, 'act-with-no-hand rejected');
  assert.ok(noHand);

  // Occupied chair: Cleo tries to take Andy's chair.
  c.client.send({ type: 'debug-teleport', x: T2.x, y: T2.y });
  await sleep(250);
  c.client.msgs.length = 0;
  c.client.send({ type: 'poker', action: 'sit', table: T2.id, chair: 'N' });
  const taken = await waitFor(() => c.client.msgs.filter(m => m.type === 'notice' && /chair is taken/.test(m.text)).pop(),
    5000, 'occupied chair rejected');
  assert.ok(taken);

  // Wait for the hand, then: out-of-turn act, over-balance raise, fold + act-after-fold.
  await waitFor(() => a.client.msgs.filter(m => m.type === 'poker-cards').pop(), 20000, 'hand dealt');
  const st = await waitFor(() => {
    const s = latestTable(a, T2.id);
    return s && s.chairs.some(ch => ch.acting) ? s : null;
  }, 5000, 'a chair is acting');
  const actingIdx = st.chairs.findIndex(ch => ch.acting);
  assert.ok(actingIdx >= 0, 'someone is acting');
  const actor = st.chairs[actingIdx].name === a.name ? a : b;
  const other = actor === a ? b : a;

  other.client.msgs.length = 0;
  other.client.send({ type: 'poker', action: 'act', table: T2.id, act: 'fold' });
  const oot = await waitFor(() => other.client.msgs.filter(m => m.type === 'notice' && /Not your turn/.test(m.text)).pop(),
    5000, 'out-of-turn act rejected');
  assert.ok(oot);
  // ... and the out-of-turn fold did NOT fold them (fresh state request,
  // since a rejected act triggers no broadcast):
  const stateCount = a.client.msgs.filter(m => m.type === 'poker-state' && m.id === T2.id).length;
  a.client.send({ type: 'poker', action: 'state' });
  const stAfter = await waitFor(() => {
    const all = a.client.msgs.filter(m => m.type === 'poker-state' && m.id === T2.id);
    return all.length > stateCount ? all[all.length - 1] : null;
  }, 5000, 'fresh table state');
  const otherChair = stAfter.chairs.find(ch => ch.name === other.name);
  assert.equal(otherChair.folded, false, 'out-of-turn fold had no effect');

  actor.client.msgs.length = 0;
  actor.client.send({ type: 'poker', action: 'act', table: T2.id, act: 'raise', amount: 99999 });
  const tooBig = await waitFor(() => actor.client.msgs.filter(m => m.type === 'notice' && /Not enough chips/.test(m.text)).pop(),
    5000, 'raise beyond stack rejected');
  assert.ok(tooBig);

  // Legal fold ends the heads-up hand; acting again afterwards is rejected.
  actor.client.send({ type: 'poker', action: 'act', table: T2.id, act: 'fold' });
  const doneSt = await waitFor(() => {
    const s = latestTable(a, T2.id);
    return s && s.state === 'done' ? s : null;
  }, 10000, 'hand ends on fold');
  assert.ok(doneSt.winners && doneSt.winners.length === 1, 'uncontested pot awarded');
  actor.client.msgs.length = 0;
  actor.client.send({ type: 'poker', action: 'act', table: T2.id, act: 'check' });
  const afterFold = await waitFor(() => actor.client.msgs.filter(m => m.type === 'notice' && /(No hand in progress|Not your turn)/.test(m.text)).pop(),
    5000, 'act after folding rejected');
  assert.ok(afterFold);
  a.client.ws.close(); b.client.ws.close(); c.client.ws.close();
});

// ------------------------------------------------------------------ d

test('slots: bet sizes, exact balance math, insufficient funds, cooldown, proximity', { timeout: 60000 }, async () => {
  const u = await makeUser('slot_sue');
  await toBay(u);

  // Wrong scene entirely: from the bay a spin is refused (the
  // machines live in the Casino Lounge interior since Phase B).
  u.client.msgs.length = 0;
  u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  const wrongMap = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Casino Lounge/.test(m.text)).pop(),
    5000, 'spin from the bay rejected');
  assert.ok(wrongMap);
  assert.equal(await balanceOf(u), 5000, 'balance untouched by refused spin');

  // Inside the lounge but not seated at a machine: refused — since
  // the Phase B amendment you play slots SITTING on the machine's
  // stool in the slots section. (Already in the bay: door hop only.)
  await sleep(1600); // portal debounce from the arch hop
  u.client.send({ type: 'debug-teleport', x: 496, y: 1200 });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'map' && m.map.id === 'casino-lounge').pop(),
    5000, 'slot_sue in lounge');
  u.client.send({ type: 'debug-teleport', x: 700, y: 420 }); // poker floor side, no stool
  await sleep(300);
  u.client.msgs.length = 0;
  u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  const far = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Take a seat at a slot machine/.test(m.text)).pop(),
    5000, 'spin while unseated rejected');
  assert.ok(far);
  assert.equal(await balanceOf(u), 5000, 'balance untouched by refused spin');

  // Standing ON the stool spot isn't enough either — you must sit.
  u.client.send({ type: 'debug-teleport', x: SLOT1_SPOT.x, y: SLOT1_SPOT.y });
  await sleep(300);
  u.client.msgs.length = 0;
  u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  const standing = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Take a seat at a slot machine/.test(m.text)).pop(),
    5000, 'spin while standing on the stool rejected');
  assert.ok(standing);
  assert.equal(await balanceOf(u), 5000, 'balance untouched by refused spin');

  // Sit on machine 1's stool and spin at each bet size; math exact.
  await sleep(3400); // outlast the transfer lock from the door hop
  u.client.send({ type: 'interact' });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'sit-state' && m.seated).pop(),
    5000, 'seated at slot machine 1');
  let expected = 5000; // v1.1 welcome bonus starting balance
  for (const bet of [5, 10, 25]) {
    u.client.msgs.length = 0;
    u.client.send({ type: 'slots', action: 'spin', bet });
    const res = await waitFor(() => u.client.msgs.filter(m => m.type === 'slot-result').pop(), 5000, `spin at ${bet}z`);
    assert.equal(res.bet, bet);
    assert.equal(res.reels.length, 3);
    // Payout recomputed from the PORTED paytable must match exactly.
    const syms = res.reels.map(id => casino.SLOT_SYMBOLS.find(s => s.id === id));
    if (res.reels.every(id => id === 'sun')) {
      // Phase 9: three Suns pays the progressive pool, not the 50× line.
      assert.equal(res.win, res.jackpotWin, 'sun×3 pays the jackpot pool');
      assert.ok(res.jackpotWin >= 250, 'jackpot pays at least the 250z reseed');
    } else {
      assert.equal(res.win, casino.slotPayout(syms, bet), 'win matches ported paytable');
    }
    expected = expected - bet + res.win;
    assert.equal(res.zcoins, expected, 'server balance math exact');
    assert.equal(await balanceOf(u), expected, 'DB balance matches');
    await sleep(casino.SLOT_COOLDOWN_MS + 200); // respect the cooldown
  }

  // Cooldown: two spins back-to-back -> exactly one result.
  u.client.msgs.length = 0;
  u.client.send({ type: 'slots', action: 'spin', bet: 5 });
  u.client.send({ type: 'slots', action: 'spin', bet: 5 });
  await sleep(700);
  assert.equal(u.client.msgs.filter(m => m.type === 'slot-result').length, 1, 'second rapid spin swallowed by cooldown');
  await sleep(casino.SLOT_COOLDOWN_MS);

  // Bet above balance: refused, balance unchanged, balance never negative.
  u.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: 10 });
  await sleep(200);
  assert.equal(await balanceOf(u), 10);
  u.client.msgs.length = 0;
  u.client.send({ type: 'slots', action: 'spin', bet: 25 });
  const broke = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Not enough z coins/.test(m.text)).pop(),
    5000, 'bet > balance rejected');
  assert.ok(broke);
  assert.equal(u.client.msgs.filter(m => m.type === 'slot-result').length, 0);
  assert.equal(await balanceOf(u), 10, 'balance unchanged after refused bet');

  // Zero balance: still cannot spin (no negative balances, ever).
  u.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: 0 });
  await sleep(200);
  u.client.send({ type: 'slots', action: 'spin', bet: 5 });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Not enough z coins/.test(m.text)).pop(),
    5000, 'spin at 0z rejected');
  assert.equal(await balanceOf(u), 0, 'balance stays exactly 0');

  // Invalid bet size refused.
  u.client.msgs.length = 0;
  u.client.send({ type: 'slots', action: 'spin', bet: 7 });
  const badBet = await waitFor(() => u.client.msgs.filter(m => m.type === 'notice' && /Choose a wager/.test(m.text)).pop(),
    5000, 'invalid bet size rejected');
  assert.ok(badBet);
  u.client.ws.close();
});

// ------------------------------------------------------------------ e

test('cleanup: disconnect and map change cash out and free the seat', { timeout: 60000 }, async () => {
  const a = await makeUser('gone_gail');
  const watcher = await makeUser('gone_walt');
  await toCasino(a); await toCasino(watcher);
  await sitAt(a, T1, 'N');
  assert.equal(await balanceOf(a), 4800, 'buy-in debited (200z max stack from the 5,000z welcome)');

  // Disconnect mid-sit: chips must come straight back, seat freed.
  a.client.ws.close();
  await sleep(800);
  assert.equal(await balanceOf(a), 5000, 'chips refunded on disconnect');
  const stFree = await waitFor(() => {
    const s = latestTable(watcher, T1.id);
    return s && s.chairs.every(ch => !ch.name) ? s : null;
  }, 5000, 'no phantom seat after disconnect');
  assert.ok(stFree);

  // Reconnect (respawned in the lounge — her saved scene), sit
  // again, then leave through the lounge door: the map change must
  // also cash out and free the seat.
  const a2client = await connectClient(PORT, a.token);
  a.client = a2client;
  assert.equal(a2client.hello.map.id, 'casino-lounge', 'respawned in the lounge');
  assert.equal(a2client.hello.zcoins, 5000);
  await sitAt(a, T1, 'W');
  assert.equal(await balanceOf(a), 4800);
  await sleep(1600); // portal debounce
  a.client.send({ type: 'debug-teleport', x: 544, y: 720 }); // lounge door-back rect (door (16,22) since v1.2.3)
  await waitFor(() => a.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(),
    5000, 'gail leaves through the lounge door');
  await sleep(300);
  assert.equal(await balanceOf(a), 5000, 'chips refunded on map change');
  const stFree2 = await waitFor(() => {
    const s = latestTable(watcher, T1.id);
    return s && s.chairs.every(ch => !ch.name) ? s : null;
  }, 5000, 'no phantom seat after map change');
  assert.ok(stFree2);
  a.client.ws.close(); watcher.client.ws.close();
});

// ------------------------------------------------------------------ f

test('persistence: balances survive restart; stranded table chips are refunded', { timeout: 90000 }, async () => {
  const child1 = await startServer(PORT_R1, DB_RESTART);
  const u = await makeUser('rest_ruth', PORT_R1);
  assert.equal(u.client.hello.zcoins, 5000);
  // Travel to the bay, through the casino door, and spin once so the
  // balance is a non-round number.
  u.client.send({ type: 'debug-teleport', x: 1120, y: 48 });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(), 5000, 'ruth in bay');
  await sleep(1600); // portal debounce from the arch hop
  u.client.send({ type: 'debug-teleport', x: 496, y: 1200 });
  await waitFor(() => u.client.msgs.filter(m => m.type === 'map' && m.map.id === 'casino-lounge').pop(), 5000, 'ruth in lounge');
  u.client.send({ type: 'debug-teleport', x: SLOT1_SPOT.x, y: SLOT1_SPOT.y });
  await sleep(3400); // outlast the transfer lock from the door hop
  u.client.send({ type: 'interact' }); // sit on the stool to spin
  await waitFor(() => u.client.msgs.filter(m => m.type === 'sit-state' && m.seated).pop(), 5000, 'ruth seated at slot 1');
  u.client.send({ type: 'slots', action: 'spin', bet: 10 });
  const res = await waitFor(() => u.client.msgs.filter(m => m.type === 'slot-result').pop(), 5000, 'ruth spins');
  const balanceAfterSpin = res.zcoins;
  assert.equal(await balanceOf(u, PORT_R1), balanceAfterSpin);
  u.client.ws.close();
  await stopServer(child1);

  // Restart on the same DB: slot balance intact, no double bonus.
  const child2 = await startServer(PORT_R2, DB_RESTART, false);
  const c2 = await connectClient(PORT_R2, u.token);
  assert.equal(c2.hello.zcoins, balanceAfterSpin, 'balance intact after restart');
  assert.equal(c2.hello.bonusGranted, false);
  u.client = c2;
  u.token = u.token;

  // Sit at a table (balance -> chips), then kill the server mid-sit:
  // the casino_chips ledger must refund her in full on next login.
  c2.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(250);
  c2.send({ type: 'poker', action: 'sit', table: T1.id, chair: 'N' });
  await waitFor(() => c2.msgs.filter(m => m.type === 'poker-state' && m.chairs.some(ch => ch.name === 'rest_ruth')).pop(),
    5000, 'ruth seated before the crash');
  assert.equal(await balanceOf(u, PORT_R2), balanceAfterSpin - 200, 'the 200z max buy-in is on the table');
  c2.ws.close();
  await stopServer(child2);

  const child3 = await startServer(PORT_R1, DB_RESTART, false);
  const c3 = await connectClient(PORT_R1, u.token);
  assert.equal(c3.hello.zcoins, balanceAfterSpin, 'stranded chips refunded exactly once after restart');
  // And no phantom seat: table state is clean.
  c3.send({ type: 'poker', action: 'state' });
  const st = await waitFor(() => c3.msgs.filter(m => m.type === 'poker-state' && m.id === T1.id).pop(), 5000, 'table state after restart');
  assert.ok(st.chairs.every(ch => !ch.name), 'no phantom seats after restart');
  c3.ws.close();
  await stopServer(child3);
});

// ---------------------------------------------------------------- v1.1.1 join flow
// Sit first, money second: E at a table pops the buy-in offer.
// Declining moves NO chips; accepting runs the atomic buy-in.

test('poker join flow: sit -> offer -> watch (no chips) -> buy in (atomic)', { timeout: 120000 }, async () => {
  const a = await makeUser('offer_andy');
  const b = await makeUser('offer_beth');
  await toCasino(a);
  await toCasino(b);
  await sleep(1700); // outlast arrival locks
  a.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(300);
  a.client.send({ type: 'interact' });
  const startA = await balanceOf(a);
  const offer1 = await waitFor(
    () => a.client.msgs.filter(m => m.type === 'poker-offer').pop(),
    5000, 'first sitter gets the buy-in offer');
  assert.equal(offer1.table, T1.id);
  assert.equal(offer1.established, false, 'empty table: no established game');
  assert.equal(offer1.amount, null, 'empty table: no buy-in set yet (v1.1.2)');
  assert.deepEqual(offer1.choices, [50, 100, 200, 500], 'the setter picks from the presets');
  assert.equal(offer1.balance, startA, 'the offer carries the sitter balance');
  assert.equal(offer1.canAfford, true);
  assert.equal(await balanceOf(a), startA, 'sitting down moved no chips');
  a.client.send({ type: 'poker', action: 'state' });
  await sleep(300);
  assert.ok(!latestTable(a, T1.id).chairs.some(c => c.name === a.name), 'no game seat before buying in');
  // Decline: watch from the chair, still no chips anywhere.
  a.client.send({ type: 'poker', action: 'watch' });
  await sleep(300);
  assert.equal(await balanceOf(a), startA, 'declining moved no chips');
  assert.ok(!latestTable(a, T1.id).chairs.some(c => c.name === a.name), 'a watcher holds no game seat');
  // Stand (E), sit again (E), this time accept — the first sitter
  // SETS the table buy-in (200z here, a preset like the old default).
  a.client.send({ type: 'interact' });
  await sleep(300);
  a.client.send({ type: 'interact' });
  await waitFor(
    () => a.client.msgs.filter(m => m.type === 'poker-offer').length >= 2 ? true : null,
    5000, 're-sitting re-offers the buy-in');
  a.client.send({ type: 'poker', action: 'buyin', amount: 200 });
  const seated = await waitFor(() => {
    const s = latestTable(a, T1.id);
    return s && s.chairs.some(c => c.name === a.name) ? s : null;
  }, 5000, 'accepting seats the player with chips');
  assert.equal(seatChips(seated, a.name), 200, 'the chosen stack bought in');
  assert.equal(seated.buyin, 200, 'the table now owns a 200z buy-in');
  assert.equal(await balanceOf(a), startA - 200, 'buy-in debited exactly once');
  // Second player at a SET table is quoted the table's buy-in.
  b.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(300);
  b.client.send({ type: 'interact' });
  const offer2 = await waitFor(
    () => b.client.msgs.filter(m => m.type === 'poker-offer').pop(),
    5000, 'second sitter gets the offer');
  assert.equal(offer2.established, true, 'table buy-in is set: established game');
  const startB = await balanceOf(b);
  assert.equal(offer2.amount, 200, 'joiner is quoted THE TABLE buy-in, not their own');
  assert.equal(offer2.balance, startB);
  b.client.send({ type: 'poker', action: 'watch' });
  await sleep(300);
  assert.equal(await balanceOf(b), startB, 'the joiner declining moved no chips');
  // Slots: the spin is named + broadcast for the cabinet animation.
  b.client.send({ type: 'interact' }); // stand from the spectator chair
  await sleep(300);
  b.client.send({ type: 'debug-teleport', x: SLOT1_SPOT.x, y: SLOT1_SPOT.y });
  await sleep(300);
  b.client.send({ type: 'interact' }); // the stool wins over any table offer
  await sleep(300);
  b.client.send({ type: 'slots', action: 'spin', bet: 5 });
  const res = await waitFor(
    () => b.client.msgs.filter(m => m.type === 'slot-result').pop(),
    5000, 'slot result arrives');
  assert.equal(res.slot, 'casino-lounge-slot-1', 'the result names its machine');
  const fx = await waitFor(
    () => b.client.msgs.filter(m => m.type === 'slot-fx' && m.slot === res.slot).pop(),
    5000, 'the cabinet fx broadcast reaches the room');
  assert.deepEqual(fx.reels, res.reels, 'fx reels match the result');
  a.client.ws.close();
  b.client.ws.close();
});

// ---------------------------------------------------------------- v1.3.1
// Item 6 regression (Zan, live, Neon Casino 2026-10-22): a poker
// spectator's chair reservation was never released when they stood
// via MOVEMENT input — the tick cleared p.seated directly and the
// casino never heard about it. Four sit/stand cycles leaked all
// four chairs; every re-sit answered "Every chair at this table is
// taken". These tests pin every release path.

test('seat release (item 6): spectator chairs free on movement-stand, tray stand, and zone transfer; chips seats veto movement', { timeout: 180000 }, async () => {
  const a = await makeUser('sr_alice');
  const b = await makeUser('sr_bob');
  await toCasino(a);
  await sleep(1700); // outlast arrival locks
  const offersOf = (u) => u.client.msgs.filter(m => m.type === 'poker-offer').length;
  const stoodUp = (u) => {
    const s = u.client.msgs.filter(m => m.type === 'sit-state').pop();
    return s && s.seated === false ? true : null;
  };
  // Sit as spectator, stand via MOVEMENT input — five cycles. With
  // the leak, the fifth sit finds every chair "taken".
  for (let i = 0; i < 5; i++) {
    a.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
    await sleep(250);
    a.client.send({ type: 'interact' });
    await waitFor(() => offersOf(a) >= i + 1 ? true : null, 5000, `sit #${i + 1} re-offers the buy-in`);
    a.client.send({ type: 'input', keys: { left: true } });
    await sleep(150);
    a.client.send({ type: 'input', keys: {} });
    await waitFor(() => stoodUp(a), 5000, `movement stand #${i + 1} releases the chair`);
  }
  // The tray's Stand releases a spectator hold too (was a silent no-op).
  a.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(250);
  a.client.send({ type: 'interact' });
  await waitFor(() => offersOf(a) >= 6 ? true : null, 5000, 'sixth sit offers');
  a.client.send({ type: 'poker', action: 'stand', table: T1.id });
  await waitFor(() => stoodUp(a), 5000, 'tray stand releases the spectator chair');
  // Transferring out of the zone frees the chair for ANOTHER player.
  a.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(250);
  a.client.send({ type: 'interact' });
  await waitFor(() => offersOf(a) >= 7 ? true : null, 5000, 'seventh sit offers');
  a.client.send({ type: 'debug-teleport', x: 544, y: 720 }); // lounge exit door -> the bay
  await waitFor(
    () => a.client.msgs.filter(m => m.type === 'map' && m.map.id === 'solstice-bay').pop(),
    5000, 'a leaves the lounge');
  await toCasino(b);
  await sleep(1700);
  b.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(250);
  b.client.send({ type: 'interact' });
  await waitFor(() => offersOf(b) >= 1 ? true : null, 5000, 'b can take the chair a left by transfer');
  // A bought-in seat VETOES movement-stand (chips stay put); the tray
  // stand cashes out and the chair is free again afterwards.
  b.client.send({ type: 'poker', action: 'buyin', amount: 50 });
  await waitFor(() => {
    const s = latestTable(b, T1.id);
    return s && s.chairs.some(c => c.name === b.name) ? true : null;
  }, 5000, 'b buys in');
  b.client.send({ type: 'input', keys: { left: true } });
  await sleep(400);
  b.client.send({ type: 'input', keys: {} });
  assert.ok(latestTable(b, T1.id).chairs.some(c => c.name === b.name), 'movement does NOT eject a chips seat');
  b.client.send({ type: 'poker', action: 'stand', table: T1.id });
  await waitFor(() => {
    const s = latestTable(b, T1.id);
    return s && !s.chairs.some(c => c.name === b.name) ? true : null;
  }, 5000, 'tray stand cashes b out');
  b.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(250);
  b.client.send({ type: 'interact' });
  await waitFor(() => offersOf(b) >= 2 ? true : null, 5000, 'b can sit again after cashing out');
  a.client.ws.close();
  b.client.ws.close();
});

// ---------------------------------------------------------------- v1.1.2
// Per-table buy-ins: the TABLE owns the amount. The first accepted
// buy-in SETS it from the presets; joiners pay exactly that (never
// their own min(balance, 200)); forged setter choices are refused
// server-side; the amount clears when the table empties; a rebuy
// tops back up to the table amount.

test('poker per-table buy-ins: setter sets, joiners match, forgeries refused, clears on empty, rebuy to table amount', { timeout: 150000 }, async () => {
  const setter = await makeUser('tb_setter');
  const joiner = await makeUser('tb_joiner');
  const poor = await makeUser('tb_poor');
  const broke = await makeUser('tb_broke');
  poor.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: 120 });
  broke.client.send({ type: 'debug-casino', op: 'set-balance', zcoins: 300 });
  await sleep(250);
  assert.equal(await balanceOf(poor), 120);
  assert.equal(await balanceOf(broke), 300);
  await toCasino(setter); await toCasino(joiner); await toCasino(poor); await toCasino(broke);
  await sleep(1700); // outlast arrival locks

  const sitOffer = async (u) => {
    u.client.send({ type: 'debug-teleport', x: T2.x, y: T2.y });
    await sleep(300);
    u.client.send({ type: 'interact' });
    return waitFor(() => u.client.msgs.filter(m => m.type === 'poker-offer').pop(),
      5000, `${u.name} gets the buy-in offer`);
  };
  const standUp = async (u) => {
    u.client.send({ type: 'poker', action: 'stand', table: T2.id });
    await waitFor(() => {
      const s = latestTable(u, T2.id);
      return s && !s.chairs.some(c => c.name === u.name) ? s : null;
    }, 5000, `${u.name} stood up`);
  };

  // --- the setter SETS 100 at the empty table
  const offerS = await sitOffer(setter);
  assert.equal(offerS.established, false);
  assert.equal(offerS.amount, null, 'unset table quotes no amount');
  const balS0 = await balanceOf(setter);
  setter.client.send({ type: 'poker', action: 'buyin', amount: 100 });
  const stSet = await waitFor(() => {
    const s = latestTable(setter, T2.id);
    return s && s.buyin === 100 && s.chairs.some(c => c.name === setter.name) ? s : null;
  }, 5000, 'setter seated, table buy-in = 100');
  assert.equal(seatChips(stSet, setter.name), 100);
  assert.equal(await balanceOf(setter), balS0 - 100, 'setter debited exactly the chosen 100');

  // --- the joiner pays THE TABLE's 100, not their own min(balance, 200)
  const offerJ = await sitOffer(joiner);
  assert.equal(offerJ.established, true);
  assert.equal(offerJ.amount, 100);
  assert.equal(offerJ.canAfford, true);
  const balJ0 = await balanceOf(joiner);
  joiner.client.send({ type: 'poker', action: 'buyin', amount: 500 }); // "asking" 500 changes nothing
  const stJoin = await waitFor(() => {
    const s = latestTable(joiner, T2.id);
    return s && s.chairs.some(c => c.name === joiner.name) ? s : null;
  }, 5000, 'joiner seated');
  assert.equal(seatChips(stJoin, joiner.name), 100);
  assert.equal(await balanceOf(joiner), balJ0 - 100, 'joiner debited exactly the table amount');

  // --- a full hand at the 100z table conserves every coin
  const done = await driveHand([setter, joiner], T2.id, (u, st) => {
    u.client.send({ type: 'poker', action: 'act', table: T2.id, act: st.toCall > 0 ? 'call' : 'check' });
  });
  assert.equal(done.state, 'done');
  const idle1 = await waitFor(() => {
    const s = latestTable(setter, T2.id);
    return s && s.state === 'idle' ? s : null;
  }, 15000, 'table idle after the 100z hand');
  const total1 = (await balanceOf(setter)) + seatChips(idle1, setter.name)
    + (await balanceOf(joiner)) + seatChips(idle1, joiner.name);
  assert.equal(total1, 10000, 'chip conservation across a hand at a non-200 table amount');

  // --- rebuy tops back up to the TABLE amount (100), not the old 200 cap
  setter.client.send({ type: 'debug-casino', op: 'set-chips', chips: 40 });
  await sleep(300);
  const balS1 = await balanceOf(setter);
  setter.client.send({ type: 'poker', action: 'rebuy', table: T2.id });
  await waitFor(() => {
    const s = latestTable(setter, T2.id);
    return s && seatChips(s, setter.name) === 100 ? s : null;
  }, 5000, 'rebuy restores the table stack');
  assert.equal(await balanceOf(setter), balS1 - 60, 'rebuy debited exactly the 60z difference to the table buy-in');

  // --- the table empties -> the buy-in clears
  await standUp(setter);
  await standUp(joiner);
  const stEmpty = await waitFor(() => {
    const s = latestTable(setter, T2.id);
    return s && s.buyin === null && s.chairs.every(c => !c.name) ? s : null;
  }, 5000, 'buy-in cleared when the table emptied');
  assert.ok(stEmpty);

  // --- forged setter choices are refused server-side (poor has 120z)
  const offerP = await sitOffer(poor);
  assert.equal(offerP.established, false, 'the emptied table is unset again');
  assert.equal(offerP.balance, 120);
  const offersBefore = poor.client.msgs.filter(m => m.type === 'poker-offer').length;
  poor.client.send({ type: 'poker', action: 'buyin', amount: 500 }); // above balance: refused
  await waitFor(() => poor.client.msgs.filter(m => m.type === 'poker-offer').length > offersBefore ? true : null,
    5000, 'a fresh offer follows the refusal');
  await sleep(200);
  assert.equal(await balanceOf(poor), 120, 'forged 500 choice debited nothing');
  assert.ok(!latestTable(poor, T2.id).chairs.some(c => c.name === poor.name), 'forged choice seated nobody');
  poor.client.send({ type: 'poker', action: 'buyin', amount: 75 }); // not a preset: refused
  await sleep(400);
  assert.equal(await balanceOf(poor), 120, 'non-preset choice debited nothing');
  assert.ok(!latestTable(poor, T2.id).chairs.some(c => c.name === poor.name), 'non-preset choice seated nobody');
  poor.client.send({ type: 'poker', action: 'buyin', amount: 100 }); // legal: sets the table
  await waitFor(() => {
    const s = latestTable(poor, T2.id);
    return s && s.buyin === 100 && s.chairs.some(c => c.name === poor.name) ? s : null;
  }, 5000, 'poor sets the table at 100');
  assert.equal(await balanceOf(poor), 20, 'legal setter choice debited exactly 100');
  await standUp(poor);
  assert.equal(await balanceOf(poor), 120, 'standing refunded the stack');
  await waitFor(() => {
    const s = latestTable(poor, T2.id);
    return s && s.buyin === null ? s : null;
  }, 5000, 'buy-in cleared again after poor leaves');

  // --- setter at 500; a 300z joiner is refused clean, can still watch
  const offerS2 = await sitOffer(setter);
  assert.equal(offerS2.established, false);
  const balS2 = await balanceOf(setter);
  setter.client.send({ type: 'poker', action: 'buyin', amount: 500 });
  await waitFor(() => {
    const s = latestTable(setter, T2.id);
    return s && s.buyin === 500 && s.chairs.some(c => c.name === setter.name) ? s : null;
  }, 5000, 'setter re-sets the table at 500');
  assert.equal(await balanceOf(setter), balS2 - 500, 'setter debited exactly 500');
  const offerB = await sitOffer(broke);
  assert.equal(offerB.established, true);
  assert.equal(offerB.amount, 500);
  assert.equal(offerB.canAfford, false, 'a 300z joiner cannot afford a 500z table');
  const offersB = broke.client.msgs.filter(m => m.type === 'poker-offer').length;
  broke.client.send({ type: 'poker', action: 'buyin' });
  await waitFor(() => broke.client.msgs.filter(m => m.type === 'poker-offer').length > offersB ? true : null,
    5000, 'the refusal re-offers with the insufficient state');
  await sleep(200);
  assert.equal(await balanceOf(broke), 300, 'insufficient joiner debited nothing');
  assert.ok(!latestTable(broke, T2.id).chairs.some(c => c.name === broke.name), 'insufficient joiner holds no seat');
  broke.client.send({ type: 'poker', action: 'watch' }); // spectating still works
  await sleep(300);
  assert.equal(await balanceOf(broke), 300, 'watching moved no chips');
  await standUp(setter);
  await waitFor(() => {
    const s = latestTable(setter, T2.id);
    return s && s.buyin === null ? s : null;
  }, 5000, 'buy-in cleared at the end');

  setter.client.ws.close(); joiner.client.ws.close(); poor.client.ws.close(); broke.client.ws.close();
});

// ------------------------------------------------------------------ Item G

test('slot stools: seated player faces the machine in BOTH casinos (Item G)', { timeout: 90000 }, async () => {
  const selfOf = (u) => {
    const s = u.client.msgs.filter(m => m.type === 'snapshot').pop();
    return s ? s.players.find(p => p.id === u.id) : null;
  };
  const sitAndCheck = async (u, spot, wantDir, label) => {
    u.client.send({ type: 'debug-teleport', x: spot.x, y: spot.y });
    await sleep(300);
    u.client.msgs.length = 0;
    u.client.send({ type: 'interact' });
    await waitFor(() => u.client.msgs.filter(m => m.type === 'sit-state' && m.seated).pop(), 5000, `seated ${label}`);
    const me = await waitFor(() => { const s = selfOf(u); return s && s.seated ? s : null; }, 5000, `snapshot seated ${label}`);
    assert.equal(me.dir, wantDir, `${label}: seated facing is toward the machine`);
    assert.ok(Math.hypot(me.x - spot.x, me.y - spot.y) < 2, `${label}: sitter anchored ON the stool`);
    u.client.send({ type: 'interact' }); // stand back up
    await waitFor(() => u.client.msgs.filter(m => m.type === 'sit-state' && !m.seated).pop(), 5000, `stood ${label}`);
  };

  // Casino Lounge: north-row machine (stool south of it, face up)
  // and an east-wall machine (stool west of it, face right/east).
  const u = await makeUser('facing_fay');
  await toCasino(u);
  await sleep(3400); // transfer lock
  await sitAndCheck(u, { x: 624, y: 140 }, 'up', 'lounge north-row slot'); // v1.4.1: stool 70px south of the cabinet centre (screen-space footprint law)
  await sitAndCheck(u, { x: 1040, y: 192 }, 'right', 'lounge east-wall slot'); // v1.4.1: stool 64px west + 16px south (was v1.3.1's 52px due-west, which painted over the cabinet on screen)
  u.client.ws.close();

  // Neon Casino: the east-wall row from Zan's screenshot.
  const v = await makeUser('facing_vic');
  v.client.send({ type: 'debug-teleport', x: 224, y: 48 });
  await waitFor(() => v.client.msgs.filter(m => m.type === 'map' && m.map.id === 'neon-district').pop(), 5000, 'vic in neon-district');
  await sleep(1600); // portal debounce
  v.client.send({ type: 'debug-teleport', x: 1968, y: 1232 }); // casino door (FRONT/south face since v1.2.2 Item 8)
  await waitFor(() => v.client.msgs.filter(m => m.type === 'map' && m.map.id === 'neon-casino').pop(), 5000, 'vic in neon-casino');
  await sleep(3400); // transfer lock
  await sitAndCheck(v, { x: 1040, y: 192 }, 'right', 'neon east-wall slot');
  await sitAndCheck(v, { x: 624, y: 140 }, 'up', 'neon north-row slot');
  v.client.ws.close();
});

// ------------------------------------------------------------------ v1.5
// Feature 2 (one-player minimum + house match) and the accounting
// fix that shipped with it. Unit legs are deterministic against
// the ported table; live legs drive real hands at table 2.

test('accounting: raise-and-fold pays the TRUE pot (bet is a subset of committed)', { timeout: 30000 }, () => {
  const fakeGame = { getPlayer: () => null, send: () => {}, broadcastToMap: () => {}, savePosition: () => {} };
  const fakeCasino = { mapId: 'casino-lounge', stepOffChair: () => {} };
  const def = { id: 'unit-acct', x: 0, y: 0, chairs: ['N', 'E', 'S', 'W'].map((dir, i) => ({ dir, x: i * 10, y: 0 })) };
  const t = new casino.PokerTable(fakeGame, fakeCasino, def);
  const mk = (userId, name) => ({ userId, name, chips: 200, buyin: 200, bet: 0, committed: 0, hole: [], inHand: false, folded: false, allIn: false, sittingOut: false });
  const P = (userId) => ({ userId, x: 0, y: 0 }); // act() proximity-guards: stand AT the table (0,0)
  t.chairs[0].seat = mk(1, 'A'); t.chairs[1].seat = mk(2, 'B');
  t.startHand();
  t.act(P(2), 'raise', 25); // small blind raises to 25 (committed 25)
  t.act(P(1), 'fold');      // big blind folds (committed 5)
  const total = t.chairs.reduce((a, c) => a + (c.seat ? c.seat.chips : 0), 0);
  assert.equal(total, 400, 'no chips created by the settlement');
  assert.equal(t.lastWinners[0].amount, 30, 'the pot was 25 + 5, not double-counted');
});

test('solo poker unit: lone hand runs the full board, house matches 1:1', { timeout: 30000 }, () => {
  const fakeGame = { getPlayer: () => null, send: () => {}, broadcastToMap: () => {}, savePosition: () => {} };
  const fakeCasino = { mapId: 'casino-lounge', stepOffChair: () => {} };
  const def = { id: 'unit-solo', x: 0, y: 0, chairs: ['N', 'E', 'S', 'W'].map((dir, i) => ({ dir, x: i * 10, y: 0 })) };
  const mk = (userId, name) => ({ userId, name, chips: 200, buyin: 200, bet: 0, committed: 0, hole: [], inHand: false, folded: false, allIn: false, sittingOut: false });
  const P = (userId) => ({ userId, x: 0, y: 0 }); // act() proximity-guards: stand AT the table (0,0)
  // Check-down solo hand: ante 5, matched 5, wins 10.
  const t = new casino.PokerTable(fakeGame, fakeCasino, def);
  t.chairs[0].seat = mk(1, 'Solo');
  t.startHand();
  assert.equal(t.soloHand, true, 'the solo latch sets at the deal');
  const st0 = t.publicState();
  assert.equal(st0.solo, true);
  assert.equal(st0.houseMatch, 5, 'the ante is already matched in the display pot');
  assert.equal(st0.pot, 10, 'display pot = stake + house match');
  let guard = 0;
  while (t.state !== 'done' && guard++ < 40) {
    if (t.actionChair >= 0) t.act(P(1), 'check'); else t.checkHandEnd();
  }
  assert.equal(t.state, 'done');
  assert.equal(t.community.length, 5, 'the full board ran out');
  assert.equal(t.chairs[0].seat.chips, 205, 'net = +own contribution (5), house matched');
  // Solo hand with a raise: contribution 50, matched 50, wins 100.
  const t2 = new casino.PokerTable(fakeGame, fakeCasino, def);
  t2.chairs[0].seat = mk(1, 'Solo');
  t2.startHand();
  t2.act(P(1), 'raise', 50);
  assert.equal(t2.publicState().pot, 100, 'the match grows with the contribution');
  guard = 0;
  while (t2.state !== 'done' && guard++ < 40) {
    if (t2.actionChair >= 0) t2.act(P(1), 'check'); else t2.checkHandEnd();
  }
  assert.equal(t2.chairs[0].seat.chips, 250, 'net = +50 on a 50 contribution');
});

test('solo poker unit: a 2-player hand that folds to one pays NO house match', { timeout: 30000 }, () => {
  const fakeGame = { getPlayer: () => null, send: () => {}, broadcastToMap: () => {}, savePosition: () => {} };
  const fakeCasino = { mapId: 'casino-lounge', stepOffChair: () => {} };
  const def = { id: 'unit-boundary', x: 0, y: 0, chairs: ['N', 'E', 'S', 'W'].map((dir, i) => ({ dir, x: i * 10, y: 0 })) };
  const mk = (userId, name) => ({ userId, name, chips: 200, buyin: 200, bet: 0, committed: 0, hole: [], inHand: false, folded: false, allIn: false, sittingOut: false });
  const P = (userId) => ({ userId, x: 0, y: 0 }); // act() proximity-guards: stand AT the table (0,0)
  const t = new casino.PokerTable(fakeGame, fakeCasino, def);
  t.chairs[0].seat = mk(1, 'A'); t.chairs[1].seat = mk(2, 'B');
  t.startHand();
  assert.equal(t.soloHand, false, 'dealt with two: never solo');
  let guard = 0;
  while (t.state !== 'done' && guard++ < 40) {
    const i = t.actionChair;
    if (i < 0) { t.checkHandEnd(); continue; }
    if (t.chairs[i].seat.name === 'B') t.act(P(2), 'fold');
    else t.act(P(1), t.currentBet > t.chairs[i].seat.bet ? 'call' : 'check');
  }
  assert.equal(t.state, 'done');
  assert.equal(t.publicState().houseMatch, 0, 'no house money in a folded-down hand');
  const total = t.chairs.reduce((a, c) => a + (c.seat ? c.seat.chips : 0), 0);
  assert.equal(total, 400, 'chips conserved exactly — nothing matched, nothing created');
});

test('poker live: SOLO hand deals, board broadcasts street by street, matched pot pays', { timeout: 120000 }, async () => {
  const u = await makeUser('solo_sam');
  await toCasino(u);
  await sitAt(u, T2, 'N'); // direct sit buys in 200; alone at the table
  assert.equal(await balanceOf(u), 4800);
  const done = await driveHand([u], T2.id, (usr, st) => {
    usr.client.send({ type: 'poker', action: 'act', table: T2.id, act: st.toCall > 0 ? 'call' : 'check' });
  });
  assert.equal(done.solo, true, 'the hand was latched solo at the deal');
  assert.ok(done.houseMatch > 0, 'the house matched the solo contribution');
  assert.equal(done.houseMatch * 2, done.pot, 'pot = contribution + equal match');
  const wonTotal = done.winners.reduce((s, w) => s + w.amount, 0);
  assert.equal(wonTotal, done.pot, 'the winner collects the full matched pot');
  // Feature 1's broadcast contract: the board arrived street by
  // street in the table state (3 on the flop, 4 turn, 5 river).
  const lengths = new Set(
    u.client.msgs.filter(m => m.type === 'poker-state' && m.id === T2.id).map(m => (m.community || []).length));
  assert.ok(lengths.has(3) && lengths.has(4) && lengths.has(5),
    `board lengths broadcast: ${[...lengths].sort().join(',')}`);
  const idle = await waitFor(() => {
    const s = latestTable(u, T2.id);
    return s && s.state === 'idle' ? s : null;
  }, 15000, 'solo table back to idle');
  assert.equal(seatChips(idle, u.name), 200 + done.houseMatch,
    'stack grew by exactly the house match (own stake returned)');
  u.client.ws.close();
});

test('poker live: 2-player hand folding down pays no match (boundary)', { timeout: 120000 }, async () => {
  const a = await makeUser('bd_amy');
  const b = await makeUser('bd_ben');
  await toCasino(a); await toCasino(b);
  await sitAt(a, T2, 'N');
  await sitAt(b, T2, 'S');
  const done = await driveHand([a, b], T2.id, (u, st) => {
    if (u.name === b.name) u.client.send({ type: 'poker', action: 'act', table: T2.id, act: 'fold' });
    else u.client.send({ type: 'poker', action: 'act', table: T2.id, act: st.toCall > 0 ? 'call' : 'check' });
  });
  assert.equal(done.solo, false, 'dealt with two players');
  assert.equal(done.houseMatch, 0, 'no house match in a multi-player hand');
  const wonTotal = done.winners.reduce((s, w) => s + w.amount, 0);
  assert.equal(wonTotal, done.pot, 'winner paid the true pot only');
  const idle = await waitFor(() => {
    const s = latestTable(a, T2.id);
    return s && s.state === 'idle' ? s : null;
  }, 15000, 'boundary table back to idle');
  const total = (await balanceOf(a)) + seatChips(idle, a.name)
    + (await balanceOf(b)) + seatChips(idle, b.name);
  assert.equal(total, 10000, 'chips conserved — the house added nothing');
  a.client.ws.close(); b.client.ws.close();
});
