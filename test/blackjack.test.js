'use strict';

/**
 * Solarion v1.5 — blackjack + solo-poker test suite.
 *
 * Unit legs drive the ported BlackjackTable with RIGGED decks
 * (nextDeck is an instance method; tests override it) so every
 * rule is pinned deterministically: hand values, dealer stands
 * on all 17s, blackjack pays 3:2 (floored), bust loses, push
 * returns, double mechanics, the dealer-natural peek, multi-seat
 * independence, a solo-seat round, and chip conservation.
 *
 * Live legs spawn a real server: sit at the converted table
 * (casino-lounge-blackjack-1), bet, play stand-always rounds,
 * and check the stack deltas against the server's own reported
 * results — plus the v1.6 standing table rule (Order 5):
 * disconnect mid-round FORFEITS the bet; the stack (minus the
 * bet) lands back in the balance and no settlement ever follows.
 * The v1.5 ghost-seat rule is retired and its test replaced.
 *
 * Run:  TEST_RUN=<n> node --test test/blackjack.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');
const fs = require('fs');

process.env.SOLARION_DB_PATH = path.join(__dirname, '..', 'data', `bjtest-unit-${process.env.TEST_RUN || '0'}.db`);
const casino = require('../src/casino');
casino.initLedger();
const bj = require('../src/blackjack');

const WebSocket = require('ws');

const RUN = process.env.TEST_RUN || '0';
const ROOT = path.join(__dirname, '..');
const DB = path.join(ROOT, 'data', `bjtest-run-${RUN}.db`);
const PORT = 50900 + Number(RUN) * 20;

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

async function toCasino(user) {
  await toBay(user);
  await sleep(1600); // portal debounce from the arch hop
  user.client.send({ type: 'debug-teleport', x: 496, y: 1200 }); // door tile, building east face
  await waitFor(
    () => user.client.msgs.filter(m => m.type === 'map' && m.map.id === 'casino-lounge').pop(),
    5000, `${user.name} arrives in casino-lounge`);
}

// Table #4 (12,11) in the shared casino build -> the blackjack table.
const BJT = { id: 'casino-lounge-blackjack-1', x: 400, y: 336 };

function latestBj(user, tableId) {
  return user.client.msgs.filter(m => m.type === 'blackjack-state' && m.id === tableId).pop() || null;
}
function myChair(state, name) {
  return state ? state.chairs.find(c => c.name === name) : null;
}
function netOf(state, name) {
  const r = state && (state.results || []).find(x => x.name === name);
  return r ? r.amount : null;
}

async function sitBj(user, chair = 'S') {
  user.client.send({ type: 'debug-teleport', x: BJT.x, y: BJT.y });
  await sleep(250);
  user.client.send({ type: 'blackjack', action: 'sit', table: BJT.id, chair });
  const st = await waitFor(() => {
    const s = latestBj(user, BJT.id);
    const c = myChair(s, user.name);
    return c && Number.isFinite(c.chips) ? s : null;
  }, 5000, `${user.name} seated at blackjack with chips`);
  return st;
}

/** Play one round stand-always; returns the payout state. */
async function playRound(user, bet, timeoutMs = 90000) {
  const startLen = user.client.msgs.length;
  let betSent = false;
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > timeoutMs) throw new Error('blackjack round did not finish in time');
    const fresh = user.client.msgs.slice(startLen).filter(m => m.type === 'blackjack-state' && m.id === BJT.id);
    const st = fresh[fresh.length - 1];
    if (st) {
      const mine = myChair(st, user.name);
      if (st.state === 'betting' && mine && !mine.bet && !betSent) {
        user.client.send({ type: 'blackjack', action: 'bet', table: BJT.id, amount: bet });
        betSent = true;
      } else if (st.state === 'playing' && mine && mine.acting) {
        user.client.send({ type: 'blackjack', action: 'act', table: BJT.id, act: 'stand' });
        await sleep(300);
      } else if (st.state === 'payout' && mine && mine.result) {
        return st;
      }
    }
    await sleep(200);
  }
}

before(async () => { await startServer(PORT, DB); });
after(async () => { for (const c of [...children]) await stopServer(c).catch(() => {}); });

// ------------------------------------------------------------------ unit

const C = (r, s) => ({ r, s });
const fakeGame = { getPlayer: () => null, send: () => {}, broadcastToMap: () => {}, savePosition: () => {} };
const fakeSys = { mapId: 'casino-lounge', pokerSeated: () => false, stepOffChair: () => {} };
const bjDef = { id: 'bj-unit', x: 0, y: 0, chairs: ['N', 'E', 'S', 'W'].map((dir, i) => ({ dir, x: i * 10, y: 0 })) };

function unitTable(deckSeq) {
  const t = new bj.BlackjackTable(fakeGame, fakeSys, bjDef);
  // Deal order is deck.pop(): dealer up, dealer hole, then seats.
  t.nextDeck = () => deckSeq.slice().reverse();
  return t;
}
function unitSeat(t, i, id, name, chips = 200) {
  t.chairs[i].seat = { userId: id, name, chips, buyin: chips, bet: 0, hand: [], doubled: false, done: false, result: null };
}
function unitBet(t, i, amount) {
  const s = t.chairs[i].seat;
  s.chips -= amount; s.bet = amount;
}
const P = (id) => ({ userId: id, x: 0, y: 0 });

test('blackjack unit: hand values (aces demote, soft, natural)', () => {
  assert.deepEqual(bj.handValue([C(14, 's'), C(6, 'h')]), { total: 17, soft: true, bust: false, blackjack: false });
  assert.deepEqual(bj.handValue([C(14, 's'), C(14, 'h'), C(9, 'd')]), { total: 21, soft: true, bust: false, blackjack: false });
  assert.deepEqual(bj.handValue([C(14, 's'), C(13, 'h')]), { total: 21, soft: true, bust: false, blackjack: true });
  assert.deepEqual(bj.handValue([C(10, 's'), C(6, 'h'), C(9, 'd')]), { total: 25, soft: false, bust: true, blackjack: false });
  assert.deepEqual(bj.handValue([C(5, 's'), C(5, 'h'), C(14, 'd')]), { total: 21, soft: true, bust: false, blackjack: false });
});

test('blackjack unit: dealer stands on ALL 17s, hits 16', () => {
  // Soft 17 (A+6) stands: player 19 wins without the dealer drawing.
  let t = unitTable([C(14, 's'), C(6, 'h'), C(10, 'd'), C(9, 'c'), C(5, 'h')]);
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 10); t.startRound();
  t.act(P(1), 'stand');
  assert.equal(t.dealerHand.length, 2, 'dealer stood on soft 17');
  assert.equal(t.chairs[0].seat.result, 'win');
  // Hard 16 draws: 5 makes 21, player 20 loses.
  t = unitTable([C(10, 's'), C(6, 'h'), C(10, 'd'), C(10, 'c'), C(5, 'h')]);
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 10); t.startRound();
  t.act(P(1), 'stand');
  assert.equal(t.dealerHand.length, 3, 'dealer hit 16');
  assert.equal(t.chairs[0].seat.result, 'lose');
});

test('blackjack unit: natural pays 3:2, floored to whole chips', () => {
  const t = unitTable([C(9, 's'), C(7, 'h'), C(14, 'd'), C(13, 'c')]);
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 5); t.startRound(); // bet 5 -> wins floor(7.5)=7
  const s = t.chairs[0].seat;
  assert.equal(s.result, 'blackjack');
  assert.equal(s.chips, 200 - 5 + 5 + 7, 'stake back + 7 profit');
});

test('blackjack unit: bust loses, push returns, dealer bust pays', () => {
  // Bust: 16 hits a king.
  let t = unitTable([C(10, 's'), C(7, 'h'), C(10, 'd'), C(6, 'c'), C(13, 'h')]);
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 10); t.startRound();
  t.act(P(1), 'hit');
  assert.equal(t.chairs[0].seat.result, 'bust');
  assert.equal(t.chairs[0].seat.chips, 190);
  // Push: 19 vs 19.
  t = unitTable([C(10, 's'), C(9, 'h'), C(10, 'd'), C(9, 'c')]);
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 10); t.startRound();
  t.act(P(1), 'stand');
  assert.equal(t.chairs[0].seat.result, 'push');
  assert.equal(t.chairs[0].seat.chips, 200, 'push returns the bet in full');
  // Dealer bust: 16 draws a king.
  t = unitTable([C(10, 's'), C(6, 'h'), C(10, 'd'), C(9, 'c'), C(13, 'h')]);
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 10); t.startRound();
  t.act(P(1), 'stand');
  assert.equal(t.chairs[0].seat.result, 'dealer-bust');
  assert.equal(t.chairs[0].seat.chips, 210);
});

test('blackjack unit: double = one card, doubled stake, then stand', () => {
  // 11 vs 17, double draws a 10 -> 21, wins double.
  let t = unitTable([C(10, 's'), C(7, 'h'), C(6, 'd'), C(5, 'c'), C(10, 'h')]);
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 20); t.startRound();
  t.act(P(1), 'double');
  let s = t.chairs[0].seat;
  assert.equal(s.hand.length, 3, 'exactly one double card');
  assert.equal(s.result, 'win');
  assert.equal(s.chips, 240, '200 - 40 doubled stake + 80 returned (stake proven doubled by the payout)');
  // Double-bust loses the doubled stake.
  t = unitTable([C(10, 's'), C(7, 'h'), C(9, 'd'), C(7, 'c'), C(13, 'h')]);
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 20); t.startRound();
  t.act(P(1), 'double');
  s = t.chairs[0].seat;
  assert.equal(s.result, 'bust');
  assert.equal(s.chips, 160, 'doubled stake lost in full');
});

test('blackjack unit: dealer natural ends the round at the deal (peek)', () => {
  const t = unitTable([C(14, 's'), C(13, 'h'), C(10, 'd'), C(10, 'c'), C(14, 'h'), C(12, 'd')]);
  unitSeat(t, 0, 1, 'A'); unitSeat(t, 1, 2, 'B');
  unitBet(t, 0, 10); unitBet(t, 1, 10);
  t.startRound();
  assert.equal(t.state, 'payout', 'no play phase against a dealer natural');
  assert.equal(t.chairs[0].seat.result, 'dealer-blackjack');
  assert.equal(t.chairs[0].seat.chips, 190, 'player 20 loses to the natural');
  assert.equal(t.chairs[1].seat.result, 'push');
  assert.equal(t.chairs[1].seat.chips, 200, 'player natural pushes');
});

test('blackjack unit: multi-seat independence + solo-seat round + conservation', () => {
  // Two seats, same dealer 17: A busts on a hit, B stands on 18 and wins.
  const t = unitTable([C(10, 's'), C(7, 'h'), C(10, 'd'), C(6, 'c'), C(9, 'h'), C(9, 'd'), C(10, 'h')]);
  unitSeat(t, 0, 1, 'A'); unitSeat(t, 1, 2, 'B');
  unitBet(t, 0, 10); unitBet(t, 1, 10);
  t.startRound();
  t.act(P(1), 'hit');
  t.act(P(2), 'stand');
  assert.equal(t.chairs[0].seat.result, 'bust');
  assert.equal(t.chairs[1].seat.result, 'win');
  const total = t.chairs.reduce((a, c) => a + (c.seat ? c.seat.chips + c.seat.bet : 0), 0);
  assert.equal(total, 400, 'chips conserved across both independent hands');
  // Solo seat: a full round completes; cleanup returns the table
  // to idle and immediately reopens the next betting window (the
  // seat still holds chips) — either resting state proves the
  // round closed cleanly.
  const t2 = unitTable([C(10, 's'), C(7, 'h'), C(10, 'd'), C(10, 'c')]);
  unitSeat(t2, 0, 1, 'Solo'); t2.maybeOpenBetting();
  assert.equal(t2.state, 'betting', 'one seat opens the betting window');
  unitBet(t2, 0, 10); t2.startRound();
  t2.act(P(1), 'stand');
  assert.equal(t2.state, 'payout');
  t2.cleanupRound();
  assert.ok(['idle', 'betting'].includes(t2.state), `round closed (state ${t2.state})`);
  assert.equal(t2.chairs[0].seat.chips, 210, '20 beat 17 for +10');
});

// ------------------------------------------------------------------ v1.6 Order 5

// v1.7.1: table cash-outs credit the avatars row with ONE atomic
// UPDATE whose .changes is verified before the seat is freed —
// the hand-placed unit seats below belong to synthetic users, so
// give those users real ledger rows or the (correct) verification
// refuses to pay out to nobody.
function ensureAvatarRow(userId, zcoins = 0) {
  const { db } = require('../src/db');
  db.prepare('INSERT OR IGNORE INTO users (id, username, pass_hash, created_at) VALUES (?, ?, ?, 0)')
    .run(userId, `unit_${userId}`, 'x');
  db.prepare('INSERT OR IGNORE INTO avatars (user_id, name, zcoins, casino_chips, created_at) VALUES (?, ?, ?, 0, 0)')
    .run(userId, `unit_${userId}`, zcoins);
}

test('blackjack unit: standing mid-round forfeits exactly the bet, seat frees at once, no settlement later', () => {
  ensureAvatarRow(1); ensureAvatarRow(2);
  const sent = [];
  const recGame = { getPlayer: () => null, send: (p, m) => sent.push(m), broadcastToMap: () => {}, savePosition: () => {} };
  const t = new bj.BlackjackTable(recGame, fakeSys, bjDef);
  // Deal order: dealer up 10♠, hole 7♥ (17); A: 10♦ 9♣ (19); B: 10♥ 8♦ (18).
  t.nextDeck = () => [C(10, 's'), C(7, 'h'), C(10, 'd'), C(9, 'c'), C(10, 'h'), C(8, 'd')].reverse();
  unitSeat(t, 0, 1, 'A'); unitSeat(t, 1, 2, 'B');
  unitBet(t, 0, 25); unitBet(t, 1, 10);
  t.startRound();
  assert.equal(t.state, 'playing');
  assert.equal(t.actionIdx, 0, 'A acts first');
  let paidOut = null;
  const orig = t.cashOutSeat.bind(t);
  t.cashOutSeat = (i) => { const s = t.chairs[i].seat; if (s) paidOut = s.chips + s.bet; return orig(i); };
  t.stand(P(1));
  assert.equal(t.chairs[0].seat, null, 'the seat frees immediately');
  assert.equal(paidOut, 175, 'stack cashed out WITHOUT the 25z bet — the bet is forfeited exactly');
  assert.ok(sent.some(m => m.type === 'notice' && /stood up mid-round — your 25z bet is forfeited/.test(m.text)),
    'the forfeit is confirmed with its amount');
  assert.equal(t.state, 'playing', 'the round continues for the remaining seats');
  assert.equal(t.actionIdx, 1, 'the turn passes to B');
  // B stands on 18, dealer stands on 17: B wins. A is nowhere in
  // the settlement — no result, no chips, no resurrection.
  t.act(P(2), 'stand');
  assert.equal(t.state, 'payout');
  assert.equal(t.chairs[1].seat.chips, 210, 'B: 18 beats 17 for +10 net of the 10z bet');
  assert.ok(!(t.lastResults || []).some(r => r.name === 'A'), 'no settlement entry for the forfeited seat');
  t.cleanupRound();
  assert.equal(t.chairs[0].seat, null, 'nothing cashes out for A at round close');
});

test('blackjack unit: disconnect mid-round == stand (forfeit), betting-window stand refunds', () => {
  ensureAvatarRow(1); ensureAvatarRow(2);
  const recGame = { getPlayer: () => null, send: () => {}, broadcastToMap: () => {}, savePosition: () => {} };
  const sys = new bj.BlackjackSystem(recGame);
  const t = new bj.BlackjackTable(recGame, sys, bjDef);
  sys.tables.set(t.id, t);
  t.nextDeck = () => [C(10, 's'), C(7, 'h'), C(10, 'd'), C(9, 'c'), C(5, 'h')].reverse();
  unitSeat(t, 0, 1, 'A'); unitBet(t, 0, 40);
  t.startRound();
  assert.equal(t.state, 'playing');
  let paidOut = null;
  const orig = t.cashOutSeat.bind(t);
  t.cashOutSeat = (i) => { const s = t.chairs[i].seat; if (s) paidOut = s.chips + s.bet; return orig(i); };
  sys.handlePlayerGone(1);
  assert.equal(t.chairs[0].seat, null, 'disconnect frees the seat at once');
  assert.equal(paidOut, 160, 'disconnect forfeits the 40z bet exactly like standing');
  // Betting window: no cards are out — the bet refunds in full.
  const t2 = new bj.BlackjackTable(recGame, fakeSys, bjDef);
  unitSeat(t2, 0, 1, 'A'); unitBet(t2, 0, 40);
  t2.state = 'betting';
  let paid2 = null;
  const orig2 = t2.cashOutSeat.bind(t2);
  t2.cashOutSeat = (i) => { const s = t2.chairs[i].seat; if (s) paid2 = s.chips + s.bet; return orig2(i); };
  t2.stand(P(1));
  assert.equal(paid2, 200, 'a betting-window stand returns the bet with the stack');
});

test('blackjack unit (v1.7.1): a failing cash-out credit restores the seat, hand and bet, and announces NO leave; the retry lands', () => {
  ensureAvatarRow(77002);
  const { db } = require('../src/db');
  db.prepare('UPDATE avatars SET zcoins = 1000, casino_chips = 200 WHERE user_id = 77002').run();
  const sent = [];
  const recGame = { getPlayer: () => null, send: (p, m) => sent.push(m), broadcastToMap: () => {}, savePosition: () => {} };
  const t = new bj.BlackjackTable(recGame, fakeSys, bjDef);
  // Dealer 10♠ 7♥ (17); player 10♦ 9♣ (19), 25z bet, action on them.
  t.nextDeck = () => [C(10, 's'), C(7, 'h'), C(10, 'd'), C(9, 'c')].reverse();
  unitSeat(t, 0, 77002, 'Fragile'); unitBet(t, 0, 25);
  t.startRound();
  assert.equal(t.state, 'playing');
  assert.equal(t.actionIdx, 0);
  // Fault injection: the shared ledger's cash-out statement throws,
  // the way the remote driver failed in production.
  const ledger = casino.getLedger();
  const realCashOut = ledger.cashOut;
  ledger.cashOut = { run: () => { throw new Error('injected driver failure'); } };
  try {
    t.stand(P(77002));
  } finally {
    ledger.cashOut = realCashOut;
  }
  const seat = t.chairs[0].seat;
  assert.ok(seat, 'the seat is KEPT when the credit fails');
  assert.equal(seat.bet, 25, 'the bet is restored — NOT forfeited by a failed cash-out');
  assert.equal(seat.chips, 175, 'the stack is restored');
  assert.equal(seat.hand.length, 2, 'the hand is restored');
  assert.ok(sent.some(m => m.type === 'notice' && /Cash-out failed/.test(m.text)), 'the player is told the cash-out failed');
  assert.ok(!sent.some(m => m.type === 'notice' && /leave the blackjack table/.test(m.text)), 'NO leave is announced for a credit that never landed');
  assert.ok(!sent.some(m => m.type === 'zcoins'), 'no balance update is sent');
  let row = db.prepare('SELECT zcoins, casino_chips FROM avatars WHERE user_id = 77002').get();
  assert.equal(row.zcoins, 1000, 'balance unchanged by the failed cash-out');
  assert.equal(row.casino_chips, 200, 'ledger mirror unchanged by the failed cash-out');
  // Retry with a healthy driver: the stand completes, the live
  // bet forfeits, and exactly the stack lands in the balance.
  sent.length = 0;
  t.stand(P(77002));
  assert.equal(t.chairs[0].seat, null, 'the retry frees the seat');
  row = db.prepare('SELECT zcoins, casino_chips FROM avatars WHERE user_id = 77002').get();
  assert.equal(row.zcoins, 1175, 'stack credited exactly once (the 25z bet stayed with the house)');
  assert.equal(row.casino_chips, 0, 'the ledger mirror cleared with the credit');
});

// ------------------------------------------------------------------ live

test('blackjack live: converted table identity + full round, stack delta == reported net', { timeout: 150000 }, async () => {
  const u = await makeUser('bj_live1');
  await toCasino(u);
  // The map data itself carries the conversion (Feature 3).
  const mapMsg = u.client.msgs.filter(m => m.type === 'map' && m.map.id === 'casino-lounge').pop();
  const tables = mapMsg.map.casino.tables;
  const bjt = tables.find(t => t.id === BJT.id);
  assert.ok(bjt, 'blackjack table present in the lounge map');
  assert.equal(bjt.game, 'blackjack');
  // v1.6 (Order 2): a SECOND table converted — the floor is now
  // 4 poker + 2 blackjack per casino (six tables total).
  assert.equal(tables.filter(t => t.game === 'poker').length, 4, 'four poker tables remain');
  assert.equal(tables.filter(t => t.game === 'blackjack').length, 2, 'two blackjack tables now');
  assert.ok(tables.some(t => t.id === 'casino-lounge-blackjack-2' && t.game === 'blackjack'),
    'blackjack-2 present in the lounge map');
  const seated = await sitBj(u);
  assert.equal(myChair(seated, u.name).chips, 200, 'direct sit buys in the 200 max stack');
  assert.equal(await balanceOf(u), 4800, 'buy-in debited exactly once');
  const payout = await playRound(u, 10);
  const mine = myChair(payout, u.name);
  const net = netOf(payout, u.name);
  assert.ok(mine.result, 'the round settled with a result');
  assert.ok(Number.isFinite(net), 'the results list carries my net');
  assert.equal(mine.chips, 200 + net, `stack delta equals the reported net (${net})`);
  assert.equal(mine.bet, 0, 'the bet is settled, not left on the felt');
  // Cash out: balance returns to 5000 + the round's net, exactly.
  u.client.send({ type: 'blackjack', action: 'stand' });
  await waitFor(() => {
    const s = latestBj(u, BJT.id);
    return s && !myChair(s, u.name) ? s : null;
  }, 10000, 'chair released after cash-out');
  assert.equal(await balanceOf(u), 5000 + net, 'balance == start + net after cash-out');
  u.client.ws.close();
});

test('blackjack live: chip conservation across three rounds', { timeout: 240000 }, async () => {
  const u = await makeUser('bj_live2');
  await toCasino(u);
  await sitBj(u);
  let netSum = 0;
  for (let r = 0; r < 3; r++) {
    const payout = await playRound(u, 10);
    const net = netOf(payout, u.name);
    assert.ok(Number.isFinite(net), `round ${r + 1} reported a net`);
    netSum += net;
  }
  u.client.send({ type: 'blackjack', action: 'stand' });
  await waitFor(() => {
    const s = latestBj(u, BJT.id);
    return s && !myChair(s, u.name) ? s : null;
  }, 10000, 'chair released');
  assert.equal(await balanceOf(u), 5000 + netSum, `three rounds conserve: nets sum to ${netSum}`);
  u.client.ws.close();
});

test('blackjack live: disconnect mid-round FORFEITS the bet — stack returns minus the bet, nothing settles later', { timeout: 150000 }, async () => {
  const u = await makeUser('bj_quit');
  await toCasino(u);
  await sitBj(u);
  // Bet 25, wait for the deal, then vanish.
  await waitFor(() => {
    const s = latestBj(u, BJT.id);
    return s && s.state === 'betting' ? s : null;
  }, 20000, 'betting window opens');
  u.client.send({ type: 'blackjack', action: 'bet', table: BJT.id, amount: 25 });
  await waitFor(() => {
    const s = latestBj(u, BJT.id);
    return s && s.state === 'playing' ? s : null;
  }, 30000, 'the round deals');
  u.client.ws.close();
  // v1.6 (Order 5): the stack (200 − 25 = 175) cashes out at
  // once; the bet is the house's. Balance: 4800 + 175 = 4975,
  // exactly — and it must NEVER move again (the v1.5 ghost rule
  // would have settled the hand and paid a variable amount).
  const final = await waitFor(async () => {
    const b = await balanceOf(u);
    return b !== 4800 ? b : null;
  }, 60000, 'stack (minus the forfeited bet) lands back in the balance');
  assert.equal(final, 4975, 'balance is start − buy-in + stack-without-bet: the 25z bet is forfeited exactly');
  await sleep(12000); // well past the round + payout window
  assert.equal(await balanceOf(u), 4975, 'no settlement arrives later — the ghost rule is retired');
});
