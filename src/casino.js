'use strict';

/**
 * Solarion — casino (Phase 3, soul doc §9 items 12 & 19: social-game
 * primitives — rooms are machines, players invent games around them).
 *
 * Server-authoritative Texas Hold'em poker (2 tables x 4 chairs in the
 * Solstice Bay Casino Lounge) with server-computed side pots, plus a
 * slot machine. Ported from the triple-validated Kingdom of Goleon
 * tavern engine — the card evaluator, betting-round state machine and
 * slot math are preserved VERBATIM; only the currency layer changed
 * (copper -> z coins, mirrored to avatars.casino_chips so a crash can
 * never duplicate or destroy chips).
 *
 * Currency safety model:
 *   - Every z-coin debit is an atomic `UPDATE ... WHERE zcoins >= n`
 *     (or a BEGIN IMMEDIATE transaction); a failed guard means "not
 *     enough funds", never a negative balance.
 *   - Table equity (chips + street bet + committed) is mirrored to
 *     avatars.casino_chips on every mutation. On login, any stranded
 *     chips (crash mid-hand) are refunded to zcoins exactly once.
 *   - Node's single thread + synchronous node:sqlite calls mean each
 *     message handler runs to completion with no interleaving; the
 *     WHERE-guards additionally close the double-sit / double-spin
 *     race even across two racing sockets.
 *
 * Client -> server:
 *   { type:'poker', action:'state' }                       table states
 *   { type:'poker', action:'sit', table, chair }            buy in & sit
 *   { type:'poker', action:'stand' }                        fold + cash out
 *   { type:'poker', action:'rebuy' }                        top up to max
 *   { type:'poker', action:'act', act, amount }             fold|check|call|raise|allin
 *   { type:'slots', action:'info' }                         paytable
 *   { type:'slots', action:'spin', bet }                    spin (5|10|25)
 * Server -> client:
 *   { type:'poker-state', ...public table state }
 *   { type:'poker-cards', cards:['A♠','T♦'] }                private hole cards
 *   { type:'slot-result', reels, win, bet, zcoins }
 *   { type:'slot-info', ... }  { type:'zcoins', zcoins } (balance updates)
 */

const { db } = require('./db');

// ------------------------------------------------------------------ cards
// (ported verbatim from the validated Goleon engine — do not "improve")
const SUITS = ['s', 'h', 'd', 'c'];
const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };

function newDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardStr(c) {
  const r = c.r === 14 ? 'A' : c.r === 13 ? 'K' : c.r === 12 ? 'Q' : c.r === 11 ? 'J' : String(c.r);
  return r + SUIT_GLYPH[c.s];
}

function straightHigh(ranks) {
  const set = new Set(ranks);
  if (set.has(14)) set.add(1);
  for (let h = 14; h >= 5; h--) {
    let ok = true;
    for (let k = 0; k < 5; k++) if (!set.has(h - k)) { ok = false; break; }
    if (ok) return h;
  }
  return 0;
}

// Returns [category, ...tiebreakers]; category 8 = straight flush ... 0 = high card.
function evaluate7(cards) {
  const rankCount = new Array(15).fill(0);
  const suitRanks = [[], [], [], []];
  const suitIdx = { s: 0, h: 1, d: 2, c: 3 };
  for (const c of cards) { rankCount[c.r]++; suitRanks[suitIdx[c.s]].push(c.r); }
  let flushRanks = null;
  for (let s = 0; s < 4; s++) if (suitRanks[s].length >= 5) flushRanks = suitRanks[s].slice().sort((a, b) => b - a);
  if (flushRanks) {
    const h = straightHigh(flushRanks);
    if (h) return [8, h];
  }
  let quad = 0;
  for (let r = 14; r >= 2; r--) if (rankCount[r] === 4) quad = r;
  if (quad) {
    let k = 0;
    for (let r = 14; r >= 2; r--) if (r !== quad && rankCount[r] > 0) { k = r; break; }
    return [7, quad, k];
  }
  const trips = [], pairs = [];
  for (let r = 14; r >= 2; r--) {
    if (rankCount[r] === 3) trips.push(r);
    else if (rankCount[r] === 2) pairs.push(r);
  }
  if (trips.length) {
    const p = trips.length > 1 ? trips[1] : (pairs[0] || 0);
    if (p) return [6, trips[0], p];
  }
  if (flushRanks) return [5, ...flushRanks.slice(0, 5)];
  const sh = straightHigh(cards.map((c) => c.r));
  if (sh) return [4, sh];
  if (trips.length) {
    const ks = [];
    for (let r = 14; r >= 2 && ks.length < 2; r--) if (r !== trips[0] && rankCount[r] > 0) ks.push(r);
    return [3, trips[0], ...ks];
  }
  if (pairs.length >= 2) {
    let k = 0;
    for (let r = 14; r >= 2; r--) if (r !== pairs[0] && r !== pairs[1] && rankCount[r] > 0) { k = r; break; }
    return [2, pairs[0], pairs[1], k];
  }
  if (pairs.length === 1) {
    const ks = [];
    for (let r = 14; r >= 2 && ks.length < 3; r--) if (r !== pairs[0] && rankCount[r] > 0) ks.push(r);
    return [1, pairs[0], ...ks];
  }
  const ks = [];
  for (let r = 14; r >= 2 && ks.length < 5; r--) if (rankCount[r] > 0) ks.push(r);
  return [0, ...ks];
}

function cmpHands(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const HAND_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

// ------------------------------------------------------------------ poker
const CHIP_BUYIN_MIN = 50;    // z coins
const CHIP_BUYIN_MAX = 200;   // z coins
const SB = 2, BB = 5;
const TURN_SECS = 25;
const START_COUNTDOWN_SECS = 6;
const SHOWDOWN_SECS = 6;
const SIT_RADIUS = 170;       // px from table centre: must be this close to sit/act
const CHAIR_FACE = { N: 'down', E: 'left', S: 'up', W: 'right' }; // chair side -> facing (toward the table)

class PokerTable {
  constructor(game, casino, def) {
    this.game = game;
    this.casino = casino;
    this.id = def.id;
    // Phase B amendment: TWO casino scenes exist; each table knows
    // its own scene so broadcasts and sit checks stay lounge-local.
    this.mapId = def.mapId || casino.mapId;
    this.x = def.x; this.y = def.y;
    // def.chairs: [{ dir, x, y }] — absolute px, from the map casino def.
    this.chairs = def.chairs.map((c) => ({
      dir: c.dir, x: c.x, y: c.y, seat: null,
    }));
    this.state = 'idle';
    this.community = [];
    this.deck = [];
    this.dealerChair = -1;
    this.actionChair = -1;
    this.actionStart = 0;
    this.turnDeadline = 0;
    this.currentBet = 0;
    this.minRaise = BB;
    this.acted = new Set();
    this.stateUntil = 0;
    this.lastWinners = null;
    this.reveal = null;
  }

  seatAt(i) { return this.chairs[i].seat; }

  findSeat(userId) {
    for (let i = 0; i < this.chairs.length; i++) {
      const s = this.chairs[i].seat;
      if (s && s.userId === userId) return { seat: s, idx: i };
    }
    return null;
  }

  eligibleCount() {
    return this.chairs.filter((c) => c.seat && !c.seat.sittingOut && c.seat.chips > 0).length;
  }

  // Total table equity of a seat (chips + street bet + committed) — the
  // value mirrored to the DB ledger (avatars.casino_chips).
  seatTotal(seat) { return seat.chips + seat.bet + seat.committed; }

  persistSeat(seat) {
    try { CQ.setCasinoChips.run(this.seatTotal(seat), seat.userId); } catch (e) { /* ledger best-effort */ }
  }

  potTotal() {
    let t = 0;
    for (const c of this.chairs) {
      const s = c.seat;
      if (s) t += s.bet + s.committed;
    }
    return t;
  }

  playerOf(seat) {
    return seat ? this.game.getPlayer(seat.userId) : null;
  }

  tell(userId, text) {
    const p = this.game.getPlayer(userId);
    if (p) this.game.send(p, { type: 'notice', text });
  }

  // ------------------------------------------------------------ broadcast
  publicState() {
    const now = Date.now();
    return {
      type: 'poker-state', id: this.id, state: this.state,
      tableX: Math.round(this.x), tableY: Math.round(this.y),
      chairs: this.chairs.map((c, i) => {
        const s = c.seat;
        return {
          dir: c.dir, x: Math.round(c.x), y: Math.round(c.y),
          name: s ? s.name : null, chips: s ? s.chips : 0, bet: s ? s.bet : 0,
          folded: !!(s && s.folded), allIn: !!(s && s.allIn),
          dealer: this.dealerChair === i, acting: this.actionChair === i,
          cards: (s && s.inHand && !s.folded) ? 2 : 0,
          sittingOut: !!(s && s.sittingOut),
        };
      }),
      community: this.community.map(cardStr),
      pot: this.potTotal(),
      currentBet: this.currentBet, minRaise: this.minRaise,
      toCall: this.actionChair >= 0 && this.chairs[this.actionChair].seat
        ? Math.max(0, this.currentBet - this.chairs[this.actionChair].seat.bet) : 0,
      countdown: this.state === 'countdown' ? Math.max(0, Math.ceil((this.stateUntil - now) / 1000)) : 0,
      winners: this.lastWinners, reveal: this.reveal,
      buyinMin: CHIP_BUYIN_MIN, buyinMax: CHIP_BUYIN_MAX, blinds: [SB, BB],
    };
  }

  /** Table state goes to everyone in the table's own casino scene. */
  broadcast() {
    const st = this.publicState();
    this.game.broadcastToMap(this.mapId, st);
  }

  sendHoleCards() {
    for (const c of this.chairs) {
      const s = c.seat;
      if (s && s.inHand && s.hole.length === 2) {
        const p = this.game.getPlayer(s.userId);
        if (p) this.game.send(p, { type: 'poker-cards', table: this.id, cards: s.hole.map(cardStr) });
      }
    }
  }

  nearTable(p) {
    return Math.hypot(p.x - this.x, p.y - this.y) <= SIT_RADIUS;
  }

  // ------------------------------------------------------------------ sit
  sit(p, dir) {
    if (p.mapId !== this.mapId) { this.game.send(p, { type: 'notice', text: 'The poker tables are in a casino lounge.' }); return; }
    if (!this.nearTable(p)) { this.game.send(p, { type: 'notice', text: 'Walk up to the table to sit down.' }); return; }
    if (this.casino.findSeatByUser(p.userId)) { this.game.send(p, { type: 'notice', text: 'You are already seated at a table.' }); return; }
    // Phase 5: chair must be a known chair string — no probing other shapes.
    if (typeof dir !== 'string' || dir.length > 8) { this.game.send(p, { type: 'notice', text: 'No such chair.' }); return; }
    const i = this.chairs.findIndex((c) => c.dir === dir);
    if (i < 0) { this.game.send(p, { type: 'notice', text: 'No such chair.' }); return; }
    if (this.chairs[i].seat) { this.game.send(p, { type: 'notice', text: 'That chair is taken.' }); return; }
    // Atomic debit: exactly one of two racing sit requests can win.
    const buyin = Math.min(this.zcoinsOf(p.userId), CHIP_BUYIN_MAX);
    if (buyin < CHIP_BUYIN_MIN) {
      this.game.send(p, { type: 'notice', text: `You need at least ${CHIP_BUYIN_MIN}z to buy in.` });
      return;
    }
    const debited = CQ.debit.run(buyin, p.userId, buyin);
    if (debited.changes !== 1) {
      this.game.send(p, { type: 'notice', text: `You need at least ${CHIP_BUYIN_MIN}z to buy in.` });
      return;
    }
    const seat = {
      userId: p.userId, name: p.name,
      chips: buyin, bet: 0, committed: 0, hole: [],
      inHand: false, folded: false, allIn: false,
      sittingOut: this.state !== 'idle' && this.state !== 'countdown' && this.state !== 'done',
    };
    this.chairs[i].seat = seat;
    this.persistSeat(seat);
    // Snap the avatar into the chair; movement is locked while seated
    // (server drops input for seated players) until they stand.
    // Phase B: a poker chair is also a SITTING seat — the snapshot
    // seated pose faces the table (chair N sits north, faces south).
    p.x = this.chairs[i].x; p.y = this.chairs[i].y; p.keys = {};
    p.seated = { id: `poker:${this.id}:${dir}`, dir: CHAIR_FACE[dir], kind: 'poker' };
    this.game.savePosition(p);
    this.game.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(p.userId) });
    this.game.send(p, { type: 'notice', text: `You sit at the ${dir} chair with ${buyin}z in chips.` });
    this.broadcast();
  }

  /** Cash out a seat: uncommitted chips return to zcoins, ledger cleared. */
  stand(p, silent) {
    const found = this.findSeat(p.userId);
    if (!found) return false;
    const { seat, idx } = found;
    // Leaving mid-hand folds; chips already committed stay in the pot.
    if (seat.inHand && !seat.folded) seat.folded = true;
    const refund = seat.chips;
    this.chairs[idx].seat = null;
    if (p && p.seated && p.seated.kind === 'poker') {
      p.seated = null;
      if (!silent) this.game.send(p, { type: 'sit-state', seated: false });
    }
    try {
      db.exec('BEGIN IMMEDIATE');
      CQ.addZ.run(refund, seat.userId);
      CQ.setCasinoChips.run(0, seat.userId);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    }
    if (!silent) {
      this.game.send(p, { type: 'notice', text: `You stand. ${refund}z cashed out.` });
      this.game.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(seat.userId) });
    }
    this.afterSeatChange();
    return true;
  }

  rebuy(p) {
    const found = this.findSeat(p.userId);
    if (!found) { this.game.send(p, { type: 'notice', text: 'You are not seated.' }); return; }
    if (!this.nearTable(p)) { this.game.send(p, { type: 'notice', text: 'Walk up to the table first.' }); return; }
    if (this.inHandState()) { this.game.send(p, { type: 'notice', text: 'Wait for the hand to finish to rebuy.' }); return; }
    const { seat } = found;
    if (seat.chips >= CHIP_BUYIN_MAX) { this.game.send(p, { type: 'notice', text: 'Your stack is already at the maximum.' }); return; }
    const want = CHIP_BUYIN_MAX - seat.chips;
    const have = this.zcoinsOf(p.userId);
    const amount = Math.min(have, want);
    if (amount <= 0) { this.game.send(p, { type: 'notice', text: 'Not enough z coins to rebuy.' }); return; }
    const debited = CQ.debit.run(amount, p.userId, amount);
    if (debited.changes !== 1) { this.game.send(p, { type: 'notice', text: 'Not enough z coins to rebuy.' }); return; }
    seat.chips += amount;
    if (seat.sittingOut && seat.chips > 0) seat.sittingOut = false;
    this.persistSeat(seat);
    this.game.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(p.userId) });
    this.game.send(p, { type: 'notice', text: `Rebuy: +${amount}z in chips.` });
    this.broadcast();
  }

  zcoinsOf(userId) {
    const r = CQ.zOf.get(userId);
    return r ? r.zcoins : 0;
  }

  inHandState() {
    return ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(this.state);
  }

  afterSeatChange() {
    // If a hand is running and only one player remains un-folded, award it.
    if (this.inHandState()) this.checkHandEnd();
    this.broadcast();
  }

  // -------------------------------------------------------------- dealing
  nextOccupied(from, eligibleOnly) {
    for (let k = 1; k <= this.chairs.length; k++) {
      const i = (from + k) % this.chairs.length;
      const s = this.chairs[i].seat;
      if (!s) continue;
      if (eligibleOnly && (s.sittingOut || s.chips <= 0)) continue;
      return i;
    }
    return -1;
  }

  startHand() {
    const now = Date.now();
    if (this.eligibleCount() < 2) { this.state = 'idle'; this.broadcast(); return; }
    this.dealerChair = this.nextOccupied(this.dealerChair, true);
    this.deck = newDeck();
    this.community = [];
    this.lastWinners = null;
    this.reveal = null;
    this.currentBet = BB;
    this.minRaise = BB;
    this.acted = new Set();
    for (const c of this.chairs) {
      const s = c.seat;
      if (!s || s.sittingOut || s.chips <= 0) { if (s) s.sittingOut = true; continue; }
      s.inHand = true; s.folded = false; s.allIn = false;
      s.bet = 0; s.committed = 0;
      s.hole = [this.deck.pop(), this.deck.pop()];
    }
    // Blinds.
    const sbI = this.nextOccupied(this.dealerChair, false);
    let bbI = this.nextOccupied(sbI, false);
    if (bbI === sbI) bbI = sbI; // heads-up: dealer is SB, other is BB
    this.postBlind(sbI, SB);
    this.postBlind(bbI, BB);
    this.state = 'preflop';
    this.actionChair = this.nextActive(bbI);
    this.actionStart = now;
    this.turnDeadline = now + TURN_SECS * 1000;
    this.sendHoleCards();
    this.broadcast();
  }

  postBlind(i, amt) {
    const s = this.chairs[i].seat;
    if (!s || !s.inHand) return;
    const take = Math.min(amt, s.chips);
    s.chips -= take; s.bet += take; s.committed += take;
    if (s.chips === 0) s.allIn = true;
    this.persistSeat(s);
  }

  nextActive(from) {
    for (let k = 1; k <= this.chairs.length; k++) {
      const i = (from + k) % this.chairs.length;
      const s = this.chairs[i].seat;
      if (s && s.inHand && !s.folded && !s.allIn) return i;
    }
    return -1;
  }

  activeSeats() {
    const out = [];
    for (let i = 0; i < this.chairs.length; i++) {
      const s = this.chairs[i].seat;
      if (s && s.inHand && !s.folded && !s.allIn) out.push({ s, i });
    }
    return out;
  }

  nonFolded() {
    const out = [];
    for (let i = 0; i < this.chairs.length; i++) {
      const s = this.chairs[i].seat;
      if (s && s.inHand && !s.folded) out.push({ s, i });
    }
    return out;
  }

  // ---------------------------------------------------------------- actions
  act(p, action, amount) {
    const found = this.findSeat(p.userId);
    if (!found) { this.game.send(p, { type: 'notice', text: 'You are not seated.' }); return; }
    if (!this.nearTable(p)) { this.game.send(p, { type: 'notice', text: 'Walk up to the table first.' }); return; }
    const { seat: s, idx: i } = found;
    if (!this.inHandState()) { this.game.send(p, { type: 'notice', text: 'No hand in progress.' }); return; }
    if (i !== this.actionChair) { this.game.send(p, { type: 'notice', text: 'Not your turn.' }); return; }
    if (!s.inHand || s.folded || s.allIn) return;
    const toCall = Math.max(0, this.currentBet - s.bet);
    const prevBet = this.currentBet;

    if (action === 'fold') {
      s.folded = true;
      this.game.send(p, { type: 'notice', text: 'You fold.' });
    } else if (action === 'check') {
      if (toCall > 0) { this.game.send(p, { type: 'notice', text: `You must call ${toCall}z or fold.` }); return; }
    } else if (action === 'call') {
      const amt = Math.min(toCall, s.chips);
      this.applyBet(s, amt);
      this.game.send(p, { type: 'notice', text: amt >= toCall ? `You call ${amt}z.` : `All in for ${amt}z.` });
    } else if (action === 'raise') {
      // Phase 5: amount must be a finite number before it becomes money.
      const amtNum = typeof amount === 'number' ? amount : Number(amount);
      const target = Number.isFinite(amtNum) ? Math.round(amtNum) : 0; // total street bet
      if (target <= this.currentBet) { this.game.send(p, { type: 'notice', text: 'Raise must exceed the current bet.' }); return; }
      const need = target - s.bet;
      if (need > s.chips) { this.game.send(p, { type: 'notice', text: 'Not enough chips.' }); return; }
      const isAllIn = need === s.chips;
      if (!isAllIn && target < this.currentBet + this.minRaise) {
        this.game.send(p, { type: 'notice', text: `Minimum raise to ${this.currentBet + this.minRaise}z.` });
        return;
      }
      this.applyBet(s, need);
      if (target > prevBet && (isAllIn ? need >= this.minRaise : true)) {
        // Full raise reopens action.
        this.currentBet = target;
        if (!isAllIn || need >= this.minRaise) this.minRaise = Math.max(BB, target - prevBet);
        this.acted = new Set([i]);
      } else if (target > prevBet) {
        this.currentBet = target; // short all-in: does not reopen
      }
      this.game.send(p, { type: 'notice', text: isAllIn ? `All in — ${target}z total.` : `You raise to ${target}z.` });
    } else if (action === 'allin') {
      const before = s.bet;
      this.applyBet(s, s.chips);
      if (s.bet > prevBet) {
        const raiseSize = s.bet - prevBet;
        this.currentBet = s.bet;
        if (raiseSize >= this.minRaise) { this.minRaise = raiseSize; this.acted = new Set([i]); }
      }
      this.game.send(p, { type: 'notice', text: `All in for ${s.bet}z total (was ${before}z).` });
    } else {
      this.game.send(p, { type: 'notice', text: 'Unknown action.' }); return;
    }

    if (action !== 'fold') this.acted.add(i);
    this.actionStart = Date.now();
    this.turnDeadline = this.actionStart + TURN_SECS * 1000;
    this.checkHandEnd();
    this.broadcast();
  }

  applyBet(s, amt) {
    amt = Math.min(amt, s.chips);
    s.chips -= amt; s.bet += amt; s.committed += amt;
    if (s.chips === 0) s.allIn = true;
    this.persistSeat(s);
  }

  autoAct() {
    // Turn timer expired: check when free, otherwise fold.
    const i = this.actionChair;
    if (i < 0) return;
    const s = this.chairs[i].seat;
    if (!s || !s.inHand || s.folded || s.allIn) { this.advanceOrEnd(); return; }
    const toCall = Math.max(0, this.currentBet - s.bet);
    if (toCall === 0) {
      this.acted.add(i);
      this.tell(s.userId, 'You checked (auto).');
    } else {
      s.folded = true;
      this.tell(s.userId, 'You folded (auto — turn timer).');
    }
    this.actionStart = Date.now();
    this.turnDeadline = this.actionStart + TURN_SECS * 1000;
    this.checkHandEnd();
    this.broadcast();
  }

  bettingComplete() {
    const act = this.activeSeats();
    if (!act.length) return true;
    for (const { s, i } of act) {
      if (!this.acted.has(i) || s.bet !== this.currentBet) return false;
    }
    return true;
  }

  advanceOrEnd() {
    const nxt = this.nextActive(this.actionChair);
    this.actionChair = nxt;
    this.actionStart = Date.now();
    this.turnDeadline = this.actionStart + TURN_SECS * 1000;
  }

  checkHandEnd() {
    if (!this.inHandState()) return;
    const nf = this.nonFolded();
    if (nf.length === 1) { this.awardUncontested(nf[0].s); return; }
    if (nf.length === 0) { this.abortHand(); return; }
    if (this.bettingComplete()) { this.nextStreet(); return; }
    this.advanceOrEnd();
  }

  nextStreet() {
    // Move street bets into committed totals.
    for (const c of this.chairs) {
      const s = c.seat;
      if (s && s.inHand) { s.bet = 0; }
    }
    this.currentBet = 0;
    this.minRaise = BB;
    this.acted = new Set();
    if (this.state === 'preflop') {
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.state = 'flop';
    } else if (this.state === 'flop') {
      this.community.push(this.deck.pop());
      this.state = 'turn';
    } else if (this.state === 'turn') {
      this.community.push(this.deck.pop());
      this.state = 'river';
    } else {
      this.showdown();
      return;
    }
    // First to act: first active seat after the dealer.
    this.actionChair = this.nextActive(this.dealerChair);
    this.actionStart = Date.now();
    this.turnDeadline = this.actionStart + TURN_SECS * 1000;
    // Everyone all-in: no more betting possible — pause briefly, then continue.
    if (this.activeSeats().length <= 1 && this.nonFolded().length >= 2) {
      this.turnDeadline = this.actionStart + 1500;
    }
    this.broadcast();
  }

  awardUncontested(seat) {
    const pot = this.potTotal();
    seat.chips += pot;
    this.persistSeat(seat);
    this.lastWinners = [{ name: seat.name, amount: pot, hand: 'Everyone folded' }];
    this.reveal = null;
    this.finishHand();
  }

  abortHand() {
    // Should not happen; refund committed chips pro-rata to be safe.
    for (const c of this.chairs) {
      const s = c.seat;
      if (s && (s.committed > 0 || s.bet > 0)) {
        s.chips += s.bet + s.committed;
        s.bet = 0; s.committed = 0;
        this.persistSeat(s);
      }
    }
    this.lastWinners = [];
    this.finishHand();
  }

  buildPots() {
    const seats = this.chairs.map((c) => c.seat).filter((s) => s && s.inHand && s.committed > 0);
    const levels = [...new Set(seats.map((s) => s.committed))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const L of levels) {
      let amount = 0;
      const eligible = [];
      for (const s of seats) {
        // FIX (Phase 3 port audit): the Goleon original lacked the
        // Math.max(0, ...) clamp — for a seat committed BELOW this
        // level, min(committed, L) - prev goes negative once a middle
        // level exists, silently shrinking the top pot and destroying
        // chips (reproduced: 100/50/20 stacks paid out 140 of 170).
        // With <=2 distinct levels it never bites, which is how it
        // survived Goleon's validation. The clamp restores the
        // intended ladder: each level's slice of each stack.
        amount += Math.max(0, Math.min(s.committed, L) - prev);
        if (s.committed >= L && !s.folded) eligible.push(s);
      }
      if (amount > 0) pots.push({ amount, eligible });
      prev = L;
    }
    return pots;
  }

  showdown() {
    this.state = 'showdown';
    const pots = this.buildPots();
    const scores = new Map();
    for (const c of this.chairs) {
      const s = c.seat;
      if (s && s.inHand && !s.folded) scores.set(s, evaluate7([...s.hole, ...this.community]));
    }
    const winners = [];
    // Award remainder chips to winners closest left of the dealer.
    const order = [];
    for (let k = 1; k <= this.chairs.length; k++) {
      const s = this.chairs[(this.dealerChair + k) % this.chairs.length].seat;
      if (s) order.push(s);
    }
    for (const pot of pots) {
      let best = null;
      for (const s of pot.eligible) {
        const sc = scores.get(s);
        if (!best || cmpHands(sc, best.score) > 0) best = { score: sc, holders: [s] };
        else if (cmpHands(sc, best.score) === 0) best.holders.push(s);
      }
      if (!best) continue;
      const share = Math.floor(pot.amount / best.holders.length);
      let rem = pot.amount - share * best.holders.length;
      const ranked = best.holders.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
      for (const s of ranked) {
        let w = share + (rem > 0 ? 1 : 0);
        if (rem > 0) rem--;
        s.chips += w;
        this.persistSeat(s);
        const handName = HAND_NAMES[best.score[0]];
        const ex = winners.find((x) => x.name === s.name);
        if (ex) ex.amount += w;
        else winners.push({ name: s.name, amount: w, hand: handName });
      }
    }
    this.lastWinners = winners;
    this.reveal = [];
    for (const c of this.chairs) {
      const s = c.seat;
      if (s && s.inHand && !s.folded) this.reveal.push({ name: s.name, cards: s.hole.map(cardStr) });
    }
    this.finishHand();
  }

  finishHand() {
    this.state = 'done';
    this.stateUntil = Date.now() + SHOWDOWN_SECS * 1000;
    this.actionChair = -1;
    this.broadcast();
  }

  cleanupHand() {
    for (const c of this.chairs) {
      const s = c.seat;
      if (!s) continue;
      s.inHand = false; s.folded = false; s.allIn = false;
      s.bet = 0; s.committed = 0; s.hole = [];
      if (s.chips <= 0) s.sittingOut = true;
    }
    this.community = [];
    this.lastWinners = null;
    this.reveal = null;
    this.state = 'idle';
    this.broadcast();
  }

  // ------------------------------------------------------------------ tick
  tick(now) {
    if (this.state === 'idle') {
      if (this.eligibleCount() >= 2) {
        this.state = 'countdown';
        this.stateUntil = now + START_COUNTDOWN_SECS * 1000;
        this.broadcast();
      }
    } else if (this.state === 'countdown') {
      if (this.eligibleCount() < 2) { this.state = 'idle'; this.broadcast(); }
      else if (now >= this.stateUntil) this.startHand();
    } else if (this.state === 'done') {
      if (now >= this.stateUntil) this.cleanupHand();
    } else if (this.inHandState()) {
      if (this.actionChair < 0) { this.checkHandEnd(); return; }
      if (now >= this.turnDeadline) this.autoAct();
    }
  }
}

// ------------------------------------------------------------------ slots
// Solarion-themed symbols. Pair (any two matching) pays 2x; three of a
// kind pays pay3x. Weights and multipliers are IDENTICAL to the
// validated Goleon paytable (only names/emoji changed), so the
// theoretical RTP is unchanged: ~0.967, re-verified by simulation in
// Phase 3 (see test/casino.test.js + the RTP report).
const SLOT_SYMBOLS = [
  { id: 'sun',   name: 'Solarion Sun', w: 2, pay3: 50, emoji: '☀️' },
  { id: 'zcoin', name: 'Z Coin',       w: 3, pay3: 20, emoji: '🪙' },
  { id: 'palm',  name: 'Palm',         w: 4, pay3: 12, emoji: '🌴' },
  { id: 'dice',  name: 'Dice',         w: 5, pay3: 8,  emoji: '🎲' },
  { id: 'wave',  name: 'Wave',         w: 6, pay3: 5,  emoji: '🌊' },
  { id: 'star',  name: 'Star',         w: 7, pay3: 4,  emoji: '⭐' },
  { id: 'shell', name: 'Shell',        w: 8, pay3: 3,  emoji: '🐚' },
];
const SLOT_BETS = [5, 10, 25];
const SLOT_PAIR_PAY = 2;
const SLOT_COOLDOWN_MS = 1200;
const SLOT_TOTAL_W = SLOT_SYMBOLS.reduce((a, s) => a + s.w, 0);

function slotRoll() {
  let r = Math.random() * SLOT_TOTAL_W;
  for (const s of SLOT_SYMBOLS) { r -= s.w; if (r < 0) return s; }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

function slotPayout(reels, bet) {
  const [a, b, c] = reels;
  if (a.id === b.id && b.id === c.id) return bet * a.pay3;
  if (a.id === b.id || b.id === c.id || a.id === c.id) return bet * SLOT_PAIR_PAY;
  return 0;
}

/** Theoretical RTP from the paytable (cross-check for the simulation). */
function theoreticalRTP() {
  let ev = 0;
  for (const s of SLOT_SYMBOLS) {
    const p = s.w / SLOT_TOTAL_W;
    ev += p * p * p * s.pay3;                       // three of a kind
    ev += 3 * p * p * (1 - p) * SLOT_PAIR_PAY;       // exactly one pair
  }
  return ev;
}

// ------------------------------------------------------------------ ledger
// avatars.casino_chips mirrors live table equity (crash-safety). The
// column is added idempotently here so db.js schema stays untouched.

let CQ = null;

function initLedger() {
  if (CQ) return;
  const cols = db.prepare("PRAGMA table_info(avatars)").all();
  if (!cols.some((c) => c.name === 'casino_chips')) {
    db.exec('ALTER TABLE avatars ADD COLUMN casino_chips INTEGER NOT NULL DEFAULT 0');
  }
  CQ = {
    // Atomic debit: changes === 1 iff the balance covered the amount.
    debit: db.prepare('UPDATE avatars SET zcoins = zcoins - ? WHERE user_id = ? AND zcoins >= ?'),
    addZ: db.prepare('UPDATE avatars SET zcoins = zcoins + ? WHERE user_id = ?'),
    zOf: db.prepare('SELECT zcoins FROM avatars WHERE user_id = ?'),
    setCasinoChips: db.prepare('UPDATE avatars SET casino_chips = ? WHERE user_id = ?'),
    getCasinoChips: db.prepare('SELECT casino_chips FROM avatars WHERE user_id = ?'),
    clearCasinoChips: db.prepare('UPDATE avatars SET zcoins = zcoins + casino_chips, casino_chips = 0 WHERE user_id = ? AND casino_chips > 0'),
  };
}

// ------------------------------------------------------------------ system

const TICK_MS = 500;

class CasinoSystem {
  constructor(game) {
    this.game = game;
    this.mapId = 'casino-lounge'; // first lounge (back-compat default)
    this.tables = new Map();   // id -> PokerTable, across ALL lounges
    this.lounges = new Map();  // scene id -> { mapId, tables: [], slots: [] }
    this.slotCd = new Map();   // userId -> timestamp (spin cooldown)
    this.timer = null;
  }

  /**
   * Register tables + slots from every map that defines a casino.
   * Phase B amendment: exactly two casino scenes (Solstice Bay's
   * Casino Lounge + the Neon Casino), each an independent lounge.
   */
  initFromMaps(MAPS) {
    for (const map of Object.values(MAPS)) {
      if (!map.casino) continue;
      const mapId = map.casino.mapId || map.id;
      if (!this.lounges.size) this.mapId = mapId;
      const lounge = { mapId, tables: [], slots: (map.casino.slots || []).map((s) => ({ ...s })) };
      for (const t of map.casino.tables) {
        const table = new PokerTable(this.game, this, { ...t, mapId });
        this.tables.set(t.id, table);
        lounge.tables.push(table);
      }
      this.lounges.set(mapId, lounge);
    }
  }

  /** The lounge a player is standing in, or null. */
  loungeFor(p) {
    return this.lounges.get(p.mapId) || null;
  }

  start() {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const t of this.tables.values()) t.tick(now);
    }, TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tableById(id) { return this.tables.get(id) || null; }

  findSeatByUser(userId) {
    for (const t of this.tables.values()) {
      const f = t.findSeat(userId);
      if (f) return { table: t, ...f };
    }
    return null;
  }

  isSeated(userId) { return Boolean(this.findSeatByUser(userId)); }

  tableFor(p) {
    // Resolve within the player's own lounge by proximity, so a
    // player near table 2 doesn't accidentally sit at table 1.
    const lounge = this.loungeFor(p);
    const pool = lounge ? lounge.tables : [...this.tables.values()];
    let best = null, bestD = Infinity;
    for (const t of pool) {
      const d = Math.hypot(p.x - t.x, p.y - t.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  zcoinsOf(userId) {
    const r = CQ.zOf.get(userId);
    return r ? r.zcoins : 0;
  }

  // ------------------------------------------------------------ messages

  handlePoker(p, msg) {
    const action = msg.action;
    // Phase 5: action must be one of the known strings; anything else is dropped.
    if (typeof action !== 'string' || !['state', 'sit', 'stand', 'rebuy', 'act'].includes(action)) {
      this.game.send(p, { type: 'notice', text: 'Unknown poker action.' });
      return;
    }
    if (action === 'state') {
      const lounge = this.loungeFor(p);
      const pool = lounge ? lounge.tables : this.tables.values();
      for (const t of pool) this.game.send(p, t.publicState());
      return;
    }
    const table = (typeof msg.table === 'string' && this.tableById(msg.table)) || this.tableFor(p);
    if (!table) { this.game.send(p, { type: 'notice', text: 'No poker table here.' }); return; }
    if (action === 'sit') { table.sit(p, msg.chair); return; }
    if (action === 'stand') { table.stand(p); return; }
    if (action === 'rebuy') { table.rebuy(p); return; }
    if (action === 'act') { table.act(p, msg.act, msg.amount); return; }
    this.game.send(p, { type: 'notice', text: 'Unknown poker action.' });
  }

  handleSlots(p, msg) {
    const action = msg.action;
    if (action === 'info') { this.game.send(p, this.slotInfo()); return; }
    if (action !== 'spin') return;
    const now = Date.now();
    // Phase 5: bet must coerce to a finite number first, then match the
    // allowlist exactly — objects/arrays/NaN can never become a wager.
    const betNum = typeof msg.bet === 'number' ? msg.bet : Number(msg.bet);
    const bet = Number.isFinite(betNum) ? Math.round(betNum) : 0;
    if (!SLOT_BETS.includes(bet)) {
      this.game.send(p, { type: 'notice', text: 'Choose a wager: 5, 10, or 25 z.' });
      return;
    }
    const lounge = this.loungeFor(p);
    if (!lounge) {
      this.game.send(p, { type: 'notice', text: 'The slot machines are in the Casino Lounge.' });
      return;
    }
    // Phase B amendment: you play slots SITTING on the machine's own
    // stool in the slots section (separate from the poker floor).
    const slot = p.seated
      ? lounge.slots.find((s) => s.seatId === p.seated.id)
      : null;
    if (!slot || Math.hypot(p.x - slot.ix, p.y - slot.iy) > 40) {
      this.game.send(p, { type: 'notice', text: 'Take a seat at a slot machine to play.' });
      return;
    }
    if (now < (this.slotCd.get(p.userId) || 0)) return; // silent rate-limit
    // Atomic debit: the WHERE guard makes "bet > balance" impossible,
    // even across two racing spin requests.
    const debited = CQ.debit.run(bet, p.userId, bet);
    if (debited.changes !== 1) {
      this.game.send(p, { type: 'notice', text: 'Not enough z coins for that wager.' });
      return;
    }
    this.slotCd.set(p.userId, now + SLOT_COOLDOWN_MS);
    const reels = [slotRoll(), slotRoll(), slotRoll()];
    const win = slotPayout(reels, bet);
    if (win > 0) CQ.addZ.run(win, p.userId);
    const zcoins = this.zcoinsOf(p.userId);
    this.game.send(p, {
      type: 'slot-result',
      reels: reels.map((s) => s.id),
      emoji: reels.map((s) => s.emoji),
      win, bet, zcoins,
    });
    this.game.send(p, { type: 'zcoins', zcoins });
  }

  slotInfo() {
    return {
      type: 'slot-info',
      bets: SLOT_BETS,
      symbols: SLOT_SYMBOLS.map((s) => ({ id: s.id, name: s.name, pay3: s.pay3, emoji: s.emoji })),
      pairPay: SLOT_PAIR_PAY,
      cooldownMs: SLOT_COOLDOWN_MS,
      rtp: Math.round(theoreticalRTP() * 1000) / 1000,
    };
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Player disconnected or changed map: fold any live hand, cash out
   * uncommitted chips to zcoins, clear the seat. No stuck chips, no
   * phantom seats — committed pot chips stay in the pot by design.
   */
  handlePlayerGone(userId) {
    const gp = this.game.getPlayer(userId);
    if (gp && gp.seated && gp.seated.kind === 'poker') gp.seated = null;
    for (const t of this.tables.values()) {
      const found = t.findSeat(userId);
      if (!found) continue;
      const { seat, idx } = found;
      if (seat.inHand && !seat.folded) seat.folded = true;
      const refund = seat.chips;
      t.chairs[idx].seat = null;
      try {
        db.exec('BEGIN IMMEDIATE');
        CQ.addZ.run(refund, userId);
        CQ.setCasinoChips.run(0, userId);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
      }
      t.afterSeatChange();
    }
    this.slotCd.delete(userId);
  }

  /** Crash recovery: refund stranded table equity exactly once at login. */
  recoverStrandedChips(userId) {
    try {
      const r = CQ.clearCasinoChips.run(userId);
      return r.changes === 1;
    } catch (e) { return false; }
  }

  strandedChipsOf(userId) {
    try {
      const r = CQ.getCasinoChips.get(userId);
      return r ? r.casino_chips : 0;
    } catch (e) { return 0; }
  }

  /** Send table states + hole cards to a player entering a casino scene. */
  syncPlayer(p) {
    const lounge = this.loungeFor(p);
    if (!lounge) return;
    for (const t of lounge.tables) {
      this.game.send(p, t.publicState());
      const found = t.findSeat(p.userId);
      if (found && found.seat.inHand && found.seat.hole.length === 2) {
        this.game.send(p, { type: 'poker-cards', table: t.id, cards: found.seat.hole.map(cardStr) });
      }
    }
    this.game.send(p, this.slotInfo());
  }
}

module.exports = {
  CasinoSystem, PokerTable, initLedger,
  evaluate7, cmpHands, cardStr, newDeck,
  slotRoll, slotPayout, theoreticalRTP,
  SLOT_SYMBOLS, SLOT_BETS, SLOT_PAIR_PAY, SLOT_COOLDOWN_MS,
  CHIP_BUYIN_MIN, CHIP_BUYIN_MAX, SB, BB, SIT_RADIUS,
  HAND_NAMES,
};
