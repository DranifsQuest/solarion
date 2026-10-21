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
const SLOT1_SPOT = { x: 528, y: 112 }; // slot 1's stool in the slots section (sit to spin)

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
  a.client.send({ type: 'debug-teleport', x: 480, y: 592 }); // lounge door-back rect
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
  assert.equal(offer1.amount, Math.min(startA, 200), 'offer quotes the server buy-in (min(balance, 200))');
  assert.equal(await balanceOf(a), startA, 'sitting down moved no chips');
  a.client.send({ type: 'poker', action: 'state' });
  await sleep(300);
  assert.ok(!latestTable(a, T1.id).chairs.some(c => c.name === a.name), 'no game seat before buying in');
  // Decline: watch from the chair, still no chips anywhere.
  a.client.send({ type: 'poker', action: 'watch' });
  await sleep(300);
  assert.equal(await balanceOf(a), startA, 'declining moved no chips');
  assert.ok(!latestTable(a, T1.id).chairs.some(c => c.name === a.name), 'a watcher holds no game seat');
  // Stand (E), sit again (E), this time accept.
  a.client.send({ type: 'interact' });
  await sleep(300);
  a.client.send({ type: 'interact' });
  await waitFor(
    () => a.client.msgs.filter(m => m.type === 'poker-offer').length >= 2 ? true : null,
    5000, 're-sitting re-offers the buy-in');
  a.client.send({ type: 'poker', action: 'buyin' });
  const seated = await waitFor(() => {
    const s = latestTable(a, T1.id);
    return s && s.chairs.some(c => c.name === a.name) ? s : null;
  }, 5000, 'accepting seats the player with chips');
  assert.equal(seatChips(seated, a.name), offer1.amount, 'the quoted stack bought in');
  assert.equal(await balanceOf(a), startA - offer1.amount, 'buy-in debited exactly once');
  // Second player at a RUNNING table sees the established buy-in.
  b.client.send({ type: 'debug-teleport', x: T1.x, y: T1.y });
  await sleep(300);
  b.client.send({ type: 'interact' });
  const offer2 = await waitFor(
    () => b.client.msgs.filter(m => m.type === 'poker-offer').pop(),
    5000, 'second sitter gets the offer');
  assert.equal(offer2.established, true, 'table has a player: established game');
  const startB = await balanceOf(b);
  assert.equal(offer2.amount, Math.min(startB, 200), 'joiner is quoted the table buy-in');
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
