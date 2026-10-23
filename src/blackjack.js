'use strict';

/**
 * Solarion — blackjack (v1.5, Zan live playtest 2026-10-22:
 * "make a couple tables black jack instead").
 *
 * One table per casino (the centre-east table of the shared floor
 * plan) plays blackjack instead of Hold'em. This module mirrors
 * src/casino.js structure and conventions on purpose: same
 * table-owned buy-in offer flow, same chips stack at the table,
 * same ledger (avatars.casino_chips mirrors stack equity via the
 * casino module's prepared statements), same seat-release laws.
 * The differences are the game itself and the seat kinds
 * ('blackjack' / 'blackjack-pending', ids `blackjack:<id>:<dir>`).
 *
 * v1 RULES (tight, deliberate — flagged for Zan in the ship report):
 *   - Server-authoritative; a fresh shuffled deck per ROUND
 *     (casino.js newDeck — same Fisher-Yates/Math.random discipline
 *     as poker), dealt: dealer up-card, dealer hole card, then two
 *     cards per betting seat in chair order.
 *   - Every seat plays its OWN hand against the dealer only.
 *   - Bets: 5z min / 100z max, placed during a 12s betting window;
 *     one bet per seat per round (no mid-window changes in v1).
 *   - Dealer peeks on a natural: dealer blackjack ends the round
 *     at the deal (player naturals push, everyone else loses).
 *   - Player natural pays 3:2 — winnings floored to whole chips
 *     (a 5z natural wins 7z), chips are integers everywhere here.
 *   - Actions: hit / stand / double. Double = exactly one more
 *     card, stake doubled, then stand (first decision only).
 *     NO split, NO insurance in v1 — deliberate scope cut.
 *   - Dealer hits until 17 and stands on ALL 17s (soft 17 stands).
 *   - Push returns the bet. Bust loses the bet at once.
 *   - Standing (or disconnecting) MID-ROUND with a live bet
 *     FORFEITS the bet to the house on the spot (v1.6, Order 5 —
 *     the standing table rule): the hand is removed, the seat
 *     frees immediately, the stack (minus the bet) cashes out,
 *     and NO settlement arrives later. This replaces the v1.5
 *     ghost-seat rule wholesale. Standing during the betting
 *     window refunds the bet (no cards are out yet); standing
 *     between rounds costs nothing.
 *
 * Client -> server:
 *   { type:'blackjack', action:'state' | 'sit' | 'stand' | 'rebuy'
 *     | 'buyin' | 'watch' | 'bet' | 'act', ... }
 * Server -> client:
 *   { type:'blackjack-state', ...public table state }
 *   { type:'blackjack-offer', ...buy-in offer }
 */

const { db } = require('./db');
const { collides } = require('./maps');
const casino = require('./casino');
const { newDeck, cardStr, BUYIN_PRESETS, CHIP_BUYIN_MIN } = casino;

const BJ_MIN_BET = 5;
const BJ_MAX_BET = 100;
const BET_SECS = 12;
const TURN_SECS = 25;
const PAYOUT_SECS = 6;
const SIT_RADIUS = 170;       // mirrors poker
const CHAIR_FACE = { N: 'down', E: 'left', S: 'up', W: 'right' };

const CQ = () => casino.getLedger();

/**
 * Blackjack hand value. Aces count 11, demoted to 1 while the hand
 * would bust. soft = an ace still counts as 11. blackjack is the
 * two-card natural only.
 */
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.r === 14) { aces++; total += 11; }
    else total += Math.min(c.r, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return {
    total, soft: aces > 0, bust: total > 21,
    blackjack: cards.length === 2 && total === 21,
  };
}

class BlackjackTable {
  constructor(game, system, def) {
    this.game = game;
    this.system = system;
    this.id = def.id;
    this.mapId = def.mapId || system.mapId;
    this.x = def.x; this.y = def.y;
    this.chairs = def.chairs.map((c) => ({ dir: c.dir, x: c.x, y: c.y, seat: null }));
    this.state = 'idle';       // idle | betting | playing | payout
    this.reservedBy = new Map();
    this.buyin = null;         // table-owned, exactly like poker
    this.deck = [];
    this.dealerHand = [];
    this.holeHidden = false;
    this.actionIdx = -1;
    this.turnDeadline = 0;
    this.stateUntil = 0;
    this.lastResults = null;   // [{ name, result, amount }] net per seat
  }

  nextDeck() { return newDeck(); } // unit tests rig this

  findSeat(userId) {
    for (let i = 0; i < this.chairs.length; i++) {
      const s = this.chairs[i].seat;
      if (s && s.userId === userId) return { seat: s, idx: i };
    }
    return null;
  }

  /** Total table equity of a seat (stack + unsettled bet). */
  seatTotal(seat) { return seat.chips + seat.bet; }

  persistSeat(seat) {
    try { CQ().setCasinoChips.run(this.seatTotal(seat), seat.userId); } catch (e) { /* ledger best-effort */ }
  }

  zcoinsOf(userId) {
    const r = CQ().zOf.get(userId);
    return r ? r.zcoins : 0;
  }

  nearTable(p) {
    return Math.hypot(p.x - this.x, p.y - this.y) <= SIT_RADIUS;
  }

  tell(userId, text) {
    const p = this.game.getPlayer(userId);
    if (p) this.game.send(p, { type: 'notice', text });
  }

  // ------------------------------------------------------------ broadcast
  publicState() {
    const now = Date.now();
    const up = this.dealerHand.length ? handValue([this.dealerHand[0]]) : null;
    return {
      type: 'blackjack-state', id: this.id, game: 'blackjack', state: this.state,
      tableX: Math.round(this.x), tableY: Math.round(this.y),
      chairs: this.chairs.map((c, i) => {
        const s = c.seat;
        return {
          dir: c.dir, x: Math.round(c.x), y: Math.round(c.y),
          name: s ? s.name : null, chips: s ? s.chips : 0, bet: s ? s.bet : 0,
          hand: s ? s.hand.map(cardStr) : [],
          handTotal: s && s.hand.length ? handValue(s.hand).total : null,
          doubled: !!(s && s.doubled),
          acting: this.state === 'playing' && this.actionIdx === i,
          result: s ? s.result : null,
          sittingOut: !!(s && !s.bet && s.chips < BJ_MIN_BET),
        };
      }),
      dealer: {
        cards: this.dealerHand.map((c, ix) => (this.holeHidden && ix === 1 ? null : cardStr(c))),
        total: this.dealerHand.length
          ? (this.holeHidden ? (up ? up.total : null) : handValue(this.dealerHand).total)
          : null,
      },
      countdown: this.state === 'betting' ? Math.max(0, Math.ceil((this.stateUntil - now) / 1000)) : 0,
      results: this.lastResults,
      buyin: this.buyin,
      buyinMin: CHIP_BUYIN_MIN, buyinMax: BUYIN_PRESETS[BUYIN_PRESETS.length - 1],
      minBet: BJ_MIN_BET, maxBet: BJ_MAX_BET,
    };
  }

  broadcast() {
    this.game.broadcastToMap(this.mapId, this.publicState());
  }

  // ------------------------------------------------------------------ sit
  /** The atomic buy-in — same table-owned model as poker (v1.1.2). */
  sit(p, dir, opts = {}) {
    if (p.mapId !== this.mapId) { this.game.send(p, { type: 'notice', text: 'The blackjack table is in a casino lounge.' }); return { ok: false, reason: 'guard' }; }
    if (!this.nearTable(p)) { this.game.send(p, { type: 'notice', text: 'Walk up to the table to sit down.' }); return { ok: false, reason: 'guard' }; }
    if (this.system.findSeatByUser(p.userId) || this.gameCasinoSeated(p)) { this.game.send(p, { type: 'notice', text: 'You are already seated at a table.' }); return { ok: false, reason: 'guard' }; }
    if (typeof dir !== 'string' || dir.length > 8) { this.game.send(p, { type: 'notice', text: 'No such chair.' }); return { ok: false, reason: 'guard' }; }
    const i = this.chairs.findIndex((c) => c.dir === dir);
    if (i < 0) { this.game.send(p, { type: 'notice', text: 'No such chair.' }); return { ok: false, reason: 'guard' }; }
    if (this.chairs[i].seat) { this.game.send(p, { type: 'notice', text: 'That chair is taken.' }); return { ok: false, reason: 'guard' }; }
    if (this.reservedBy.has(i) && this.reservedBy.get(i) !== p.userId) { this.game.send(p, { type: 'notice', text: 'That chair is taken.' }); return { ok: false, reason: 'guard' }; }
    const balance = this.zcoinsOf(p.userId);
    let amount;
    let settingTable = false;
    if (this.buyin !== null) {
      amount = this.buyin;
      if (balance < amount) {
        this.game.send(p, { type: 'notice', text: `This table's buy-in is ${amount}z — you have ${balance}z.` });
        return { ok: false, reason: 'funds' };
      }
    } else if (opts.viaOffer) {
      const raw = typeof opts.choice === 'number' ? opts.choice : Number(opts.choice);
      const choice = Number.isFinite(raw) ? Math.round(raw) : NaN;
      if (Number.isNaN(choice)) return { ok: false, reason: 'stale' };
      if (!BUYIN_PRESETS.includes(choice)) {
        this.game.send(p, { type: 'notice', text: `Pick a buy-in: ${BUYIN_PRESETS.map((n) => `${n}z`).join(' / ')}.` });
        return { ok: false, reason: 'choice' };
      }
      if (choice > balance) {
        this.game.send(p, { type: 'notice', text: `That buy-in is ${choice}z — you have ${balance}z.` });
        return { ok: false, reason: 'funds' };
      }
      amount = choice;
      settingTable = true;
    } else {
      amount = Math.min(balance, casino.CHIP_BUYIN_MAX);
      if (amount < CHIP_BUYIN_MIN) {
        this.game.send(p, { type: 'notice', text: `You need at least ${CHIP_BUYIN_MIN}z to buy in.` });
        return { ok: false, reason: 'funds' };
      }
      settingTable = true;
    }
    const debited = CQ().debit.run(amount, p.userId, amount);
    if (debited.changes !== 1) {
      this.game.send(p, { type: 'notice', text: 'Not enough z coins to buy in.' });
      return { ok: false, reason: 'funds' };
    }
    if (settingTable) this.buyin = amount;
    const seat = {
      userId: p.userId, name: p.name,
      chips: amount, buyin: amount, bet: 0,
      hand: [], doubled: false, done: false, result: null,
    };
    this.chairs[i].seat = seat;
    this.reservedBy.delete(i);
    if (p.bjPending && p.bjPending.tableId === this.id) p.bjPending = null;
    this.persistSeat(seat);
    p.x = this.chairs[i].x; p.y = this.chairs[i].y; p.keys = {};
    p.seated = { id: `blackjack:${this.id}:${dir}`, dir: CHAIR_FACE[dir], kind: 'blackjack' };
    this.game.savePosition(p);
    this.game.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(p.userId) });
    this.game.send(p, { type: 'notice', text: `You sit at the blackjack table's ${dir} chair with ${amount}z in chips.` });
    if (settingTable && opts.viaOffer) {
      this.game.send(p, { type: 'notice', text: `You set this table's buy-in at ${amount}z.` });
    }
    this.maybeOpenBetting();
    this.broadcast();
    return { ok: true, amount };
  }

  /** True if the player already holds chips at a POKER table. */
  gameCasinoSeated(p) {
    // The casino system owns poker seats; holding chips at both
    // games at once would split the shared ledger mirror, so the
    // two systems refuse each other's seated players.
    return Boolean(this.system.pokerSeated && this.system.pokerSeated(p.userId));
  }

  /**
   * Leave the table. v1.6 (Order 5): mid-round with a live bet,
   * the bet is FORFEITED to the house on the spot — hand removed,
   * seat freed immediately, stack (without the bet) cashed out,
   * no settlement later. During the betting window the bet was
   * never at risk and refunds with the stack.
   */
  stand(p, silent) {
    const found = this.findSeat(p.userId);
    if (!found) return false;
    const { seat, idx } = found;
    if (p && p.seated && p.seated.kind === 'blackjack') {
      p.seated = null;
      if (!silent) this.game.send(p, { type: 'sit-state', seated: false });
      if (!silent) this.system.stepOffChair(p, this);
    }
    const liveBet = seat.bet > 0 && this.state === 'playing';
    if (liveBet) {
      const forfeited = seat.bet;
      const wasAction = this.actionIdx === idx;
      seat.bet = 0;
      seat.hand = [];
      seat.result = null;
      this.cashOutSeat(idx); // stack only — the bet stays with the house
      if (!silent && p) {
        this.game.send(p, { type: 'notice', text: `You stood up mid-round — your ${forfeited}z bet is forfeited.` });
        this.game.send(p, { type: 'notice', text: 'You leave the blackjack table.' });
        this.game.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(seat.userId) });
      }
      if (wasAction) { this.actionIdx = idx; this.advance(); }
      this.afterSeatChange();
      return true;
    }
    if (seat.bet > 0) { seat.chips += seat.bet; seat.bet = 0; } // betting window: bet was never at risk
    this.cashOutSeat(idx);
    if (!silent && p) {
      this.game.send(p, { type: 'notice', text: 'You leave the blackjack table.' });
      this.game.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(seat.userId) });
    }
    this.afterSeatChange();
    return true;
  }

  /** Pay a seat's stack back to zcoins and free the chair. */
  cashOutSeat(idx) {
    const seat = this.chairs[idx].seat;
    if (!seat) return 0;
    const refund = seat.chips + seat.bet;
    this.chairs[idx].seat = null;
    try {
      db.exec('BEGIN IMMEDIATE');
      CQ().addZ.run(refund, seat.userId);
      CQ().setCasinoChips.run(0, seat.userId);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    }
    return refund;
  }

  rebuy(p) {
    const found = this.findSeat(p.userId);
    if (!found) { this.game.send(p, { type: 'notice', text: 'You are not seated.' }); return; }
    if (!this.nearTable(p)) { this.game.send(p, { type: 'notice', text: 'Walk up to the table first.' }); return; }
    if (this.state === 'playing' || this.state === 'payout') { this.game.send(p, { type: 'notice', text: 'Wait for the round to finish to rebuy.' }); return; }
    const { seat } = found;
    const target = this.buyin ?? seat.buyin ?? casino.CHIP_BUYIN_MAX;
    if (seat.chips >= target) { this.game.send(p, { type: 'notice', text: `Your stack is already at the table buy-in (${target}z).` }); return; }
    const want = target - seat.chips;
    const have = this.zcoinsOf(p.userId);
    const amount = Math.min(have, want);
    if (amount <= 0) { this.game.send(p, { type: 'notice', text: 'Not enough z coins to rebuy.' }); return; }
    const debited = CQ().debit.run(amount, p.userId, amount);
    if (debited.changes !== 1) { this.game.send(p, { type: 'notice', text: 'Not enough z coins to rebuy.' }); return; }
    seat.chips += amount;
    this.persistSeat(seat);
    this.game.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(p.userId) });
    this.game.send(p, { type: 'notice', text: `Rebuy: +${amount}z in chips.` });
    this.maybeOpenBetting();
    this.broadcast();
  }

  afterSeatChange() {
    if (this.buyin !== null && !this.chairs.some((c) => c.seat)) this.buyin = null;
    this.maybeOpenBetting();
    this.broadcast();
  }

  // ---------------------------------------------------------------- rounds
  bettors() {
    const out = [];
    for (let i = 0; i < this.chairs.length; i++) {
      const s = this.chairs[i].seat;
      if (s && s.bet > 0) out.push({ s, i });
    }
    return out;
  }

  maybeOpenBetting() {
    if (this.state !== 'idle') return;
    if (this.chairs.some((c) => c.seat && c.seat.chips >= BJ_MIN_BET)) {
      this.state = 'betting';
      this.stateUntil = Date.now() + BET_SECS * 1000;
      this.lastResults = null;
      for (const c of this.chairs) {
        if (c.seat) { c.seat.hand = []; c.seat.result = null; c.seat.doubled = false; c.seat.done = false; }
      }
      this.dealerHand = [];
      this.holeHidden = false;
    }
  }

  placeBet(p, amount) {
    const found = this.findSeat(p.userId);
    if (!found) { this.game.send(p, { type: 'notice', text: 'You are not seated.' }); return; }
    if (!this.nearTable(p)) { this.game.send(p, { type: 'notice', text: 'Walk up to the table first.' }); return; }
    if (this.state !== 'betting') { this.game.send(p, { type: 'notice', text: 'Betting is closed for this round.' }); return; }
    const { seat } = found;
    if (seat.bet > 0) { this.game.send(p, { type: 'notice', text: 'Your bet is already down for this round.' }); return; }
    const amtNum = typeof amount === 'number' ? amount : Number(amount);
    const amt = Number.isFinite(amtNum) ? Math.round(amtNum) : 0;
    if (amt < BJ_MIN_BET || amt > BJ_MAX_BET) {
      this.game.send(p, { type: 'notice', text: `Bets run ${BJ_MIN_BET}z to ${BJ_MAX_BET}z here.` });
      return;
    }
    if (amt > seat.chips) { this.game.send(p, { type: 'notice', text: 'Not enough chips for that bet.' }); return; }
    seat.chips -= amt;
    seat.bet = amt;
    this.persistSeat(seat);
    this.game.send(p, { type: 'notice', text: `Bet down: ${amt}z.` });
    this.broadcast();
  }

  startRound() {
    const players = this.bettors();
    if (!players.length) { this.state = 'idle'; this.broadcast(); return; }
    this.deck = this.nextDeck();
    this.dealerHand = [this.deck.pop(), this.deck.pop()]; // [0] up, [1] hole
    this.holeHidden = true;
    for (const { s } of players) {
      s.hand = [this.deck.pop(), this.deck.pop()];
      s.doubled = false;
      s.result = null;
      // Naturals have no decision to make.
      s.done = handValue(s.hand).blackjack;
    }
    // Dealer peek: a dealer natural ends the round at the deal.
    if (handValue(this.dealerHand).blackjack) {
      this.holeHidden = false;
      this.settle();
      this.state = 'payout';
      this.stateUntil = Date.now() + PAYOUT_SECS * 1000;
      this.broadcast();
      return;
    }
    this.state = 'playing';
    this.actionIdx = -1;
    this.advance();
    this.broadcast();
  }

  advance() {
    const players = this.bettors();
    let next = -1;
    for (const { i } of players) {
      if (i > this.actionIdx) {
        const s = this.chairs[i].seat;
        if (s && !s.done) { next = i; break; }
      }
    }
    if (next < 0) { this.dealerPlay(); return; }
    this.actionIdx = next;
    this.turnDeadline = Date.now() + TURN_SECS * 1000;
  }

  act(p, action) {
    const found = this.findSeat(p.userId);
    if (!found) { this.game.send(p, { type: 'notice', text: 'You are not seated.' }); return; }
    if (this.state !== 'playing') { this.game.send(p, { type: 'notice', text: 'No round in play.' }); return; }
    const { seat: s, idx: i } = found;
    if (i !== this.actionIdx || s.done || !s.bet) { this.game.send(p, { type: 'notice', text: 'Not your turn.' }); return; }
    if (action === 'hit') {
      s.hand.push(this.deck.pop());
      const v = handValue(s.hand);
      if (v.total >= 21) s.done = true; // bust or 21: no more decisions
      this.game.send(p, { type: 'notice', text: `You hit — ${v.total}${v.bust ? ' (bust)' : ''}.` });
    } else if (action === 'stand') {
      s.done = true;
      this.game.send(p, { type: 'notice', text: `You stand on ${handValue(s.hand).total}.` });
    } else if (action === 'double') {
      if (s.hand.length !== 2) { this.game.send(p, { type: 'notice', text: 'You can only double on your first two cards.' }); return; }
      if (s.chips < s.bet) { this.game.send(p, { type: 'notice', text: 'Not enough chips to double.' }); return; }
      s.chips -= s.bet;
      s.bet *= 2;
      s.doubled = true;
      s.hand.push(this.deck.pop());
      s.done = true;
      this.persistSeat(s);
      this.game.send(p, { type: 'notice', text: `Doubled — one card, ${handValue(s.hand).total}.` });
    } else {
      this.game.send(p, { type: 'notice', text: 'Unknown action.' });
      return;
    }
    if (!s.done) this.turnDeadline = Date.now() + TURN_SECS * 1000; // each decision gets its own clock
    this.broadcast();
    if (s.done) this.advanceFrom(i);
  }

  /** After the seat at i finishes, move on (or close the round). */
  advanceFrom(i) {
    this.actionIdx = i;
    this.advance();
    this.broadcast();
  }

  autoAct() {
    if (this.actionIdx < 0) return;
    const s = this.chairs[this.actionIdx].seat;
    if (!s || s.done) { this.advance(); this.broadcast(); return; }
    s.done = true; // stand on the timer
    this.tell(s.userId, 'You stand (auto — turn timer).');
    this.advanceFrom(this.actionIdx);
  }

  dealerPlay() {
    this.holeHidden = false;
    // The dealer draws only if someone can still win or push —
    // but drawing is harmless theatre otherwise; standard play:
    // hit until 17, stand on all 17s.
    const anyLive = this.bettors().some(({ s }) => !handValue(s.hand).bust && !handValue(s.hand).blackjack);
    if (anyLive) {
      while (handValue(this.dealerHand).total < 17) this.dealerHand.push(this.deck.pop());
    }
    this.settle();
    this.state = 'payout';
    this.actionIdx = -1;
    this.stateUntil = Date.now() + PAYOUT_SECS * 1000;
  }

  /**
   * Settle every bettor's hand against the dealer's final hand.
   * Money moves ONLY here (and at bet/double): a bet is returned
   * with its winnings, returned alone on a push, or kept on a
   * loss — results record the NET per seat for the state payload.
   */
  settle() {
    const dv = handValue(this.dealerHand);
    const results = [];
    for (const { s } of this.bettors()) {
      const bet = s.bet;
      const v = handValue(s.hand);
      let ret = 0, result;
      if (v.bust) { result = 'bust'; ret = 0; }
      else if (dv.blackjack && !v.blackjack) { result = 'dealer-blackjack'; ret = 0; }
      else if (v.blackjack && dv.blackjack) { result = 'push'; ret = bet; }
      else if (v.blackjack) { result = 'blackjack'; ret = bet + Math.floor(bet * 3 / 2); }
      else if (dv.bust) { result = 'dealer-bust'; ret = bet * 2; }
      else if (v.total > dv.total) { result = 'win'; ret = bet * 2; }
      else if (v.total < dv.total) { result = 'lose'; ret = 0; }
      else { result = 'push'; ret = bet; }
      s.chips += ret;
      s.bet = 0;
      s.result = result;
      this.persistSeat(s);
      results.push({ name: s.name, result, amount: ret - bet });
    }
    this.lastResults = results;
  }

  cleanupRound() {
    for (let i = 0; i < this.chairs.length; i++) {
      const s = this.chairs[i].seat;
      if (!s) continue;
      s.hand = []; s.bet = 0; s.doubled = false; s.done = false; s.result = null;
      // v1.6: no ghost seats remain to cash out — a mid-round
      // leaver's stack was already paid (minus the forfeited bet)
      // by stand()/handlePlayerGone at the moment they left.
    }
    this.dealerHand = [];
    this.holeHidden = false;
    this.lastResults = null;
    this.state = 'idle';
    if (this.buyin !== null && !this.chairs.some((c) => c.seat)) this.buyin = null;
    this.maybeOpenBetting();
    this.broadcast();
  }

  tick(now) {
    if (this.state === 'betting') {
      if (now >= this.stateUntil) this.startRound();
    } else if (this.state === 'playing') {
      if (this.actionIdx < 0) { this.advance(); this.broadcast(); }
      else if (now >= this.turnDeadline) this.autoAct();
    } else if (this.state === 'payout') {
      if (now >= this.stateUntil) this.cleanupRound();
    } else if (this.state === 'idle') {
      this.maybeOpenBetting();
      if (this.state === 'betting') this.broadcast();
    }
  }
}

// ------------------------------------------------------------------ system

const TICK_MS = 500;

class BlackjackSystem {
  constructor(game) {
    this.game = game;
    this.mapId = 'casino-lounge';
    this.tables = new Map();
    this.lounges = new Map();
    this.timer = null;
    // Wired by server.js: lets sit() refuse players who already
    // hold chips at a poker table (one ledger mirror, one stack).
    this.pokerSeated = null;
  }

  initFromMaps(MAPS) {
    for (const map of Object.values(MAPS)) {
      if (!map.casino) continue;
      const mapId = map.casino.mapId || map.id;
      const lounge = { mapId, tables: [] };
      for (const t of map.casino.tables) {
        if (t.game !== 'blackjack') continue;
        const table = new BlackjackTable(this.game, this, { ...t, mapId });
        this.tables.set(t.id, table);
        lounge.tables.push(table);
      }
      if (lounge.tables.length) this.lounges.set(mapId, lounge);
    }
  }

  loungeFor(p) { return this.lounges.get(p.mapId) || null; }

  start() {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const t of this.tables.values()) t.tick(now);
    }, TICK_MS);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  tableById(id) { return this.tables.get(id) || null; }

  findSeatByUser(userId) {
    for (const t of this.tables.values()) {
      const f = t.findSeat(userId);
      if (f) return { table: t, ...f };
    }
    return null;
  }

  isSeated(userId) { return Boolean(this.findSeatByUser(userId)); }

  /** Nearest blackjack table to the player (for E-key dispatch). */
  nearestTable(p) {
    const lounge = this.loungeFor(p);
    if (!lounge) return null;
    let best = null, bestD = Infinity;
    for (const t of lounge.tables) {
      const d = Math.hypot(p.x - t.x, p.y - t.y);
      if (d < bestD) { bestD = d; best = t; }
    }
    return best ? { table: best, dist: bestD } : null;
  }

  zcoinsOf(userId) {
    const r = CQ().zOf.get(userId);
    return r ? r.zcoins : 0;
  }

  // ------------------------------------------------- v1.1.1-style join flow
  offerPayload(p, table, dir) {
    const balance = this.zcoinsOf(p.userId);
    return {
      type: 'blackjack-offer', game: 'blackjack', table: table.id, chair: dir,
      established: table.buyin !== null,
      amount: table.buyin,
      choices: BUYIN_PRESETS.slice(),
      balance,
      canAfford: table.buyin !== null ? balance >= table.buyin : balance >= CHIP_BUYIN_MIN,
      min: CHIP_BUYIN_MIN, max: BUYIN_PRESETS[BUYIN_PRESETS.length - 1],
      minBet: BJ_MIN_BET, maxBet: BJ_MAX_BET,
    };
  }

  sendOffer(p, table, dir) {
    this.game.send(p, this.offerPayload(p, table, dir));
  }

  offerSeat(p) {
    const lounge = this.loungeFor(p);
    if (!lounge) return false;
    const near = this.nearestTable(p);
    if (!near || !near.table.nearTable(p)) return false;
    const table = near.table;
    if (this.findSeatByUser(p.userId)) return false;
    let best = -1, bestD = Infinity;
    table.chairs.forEach((c, i) => {
      if (c.seat || table.reservedBy.has(i)) return;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) { this.game.send(p, { type: 'notice', text: 'Every chair at this table is taken.' }); return true; }
    const chair = table.chairs[best];
    table.reservedBy.set(best, p.userId);
    p.bjPending = { tableId: table.id, dir: chair.dir };
    p.x = chair.x; p.y = chair.y; p.keys = {};
    p.seated = { id: `blackjack:${table.id}:${chair.dir}`, dir: CHAIR_FACE[chair.dir], kind: 'blackjack-pending' };
    this.game.savePosition(p);
    this.game.send(p, { type: 'sit-state', seated: true });
    this.sendOffer(p, table, chair.dir);
    return true;
  }

  acceptBuyin(p, choice) {
    const pend = p.bjPending;
    if (!pend) { this.game.send(p, { type: 'notice', text: 'No buy-in waiting — sit at the blackjack table first (E).' }); return; }
    const table = this.tableById(pend.tableId);
    if (!table) { p.bjPending = null; return; }
    const r = table.sit(p, pend.dir, { viaOffer: true, choice });
    if (!r.ok) {
      if (r.reason === 'stale') {
        this.game.send(p, { type: 'notice', text: 'That table emptied — you\'re setting the buy-in now.' });
      }
      if (p.bjPending) this.sendOffer(p, table, pend.dir);
    }
  }

  watchTable(p) {
    if (!p.bjPending) return;
    this.game.send(p, { type: 'notice', text: 'You watch the blackjack table from the chair — no chips down. Press E to stand.' });
  }

  clearPending(p) {
    const pend = p && p.bjPending;
    if (!pend) return;
    const table = this.tableById(pend.tableId);
    if (table) {
      for (const [i, uid] of table.reservedBy) if (uid === p.userId) table.reservedBy.delete(i);
    }
    p.bjPending = null;
  }

  /** Seat-release hook — same contract as the casino's (v1.3.1). */
  releaseSeatStand(p, seat, viaMovement) {
    if (!seat) return true;
    if (seat.kind === 'blackjack') {
      if (viaMovement) return false;
      const table = this.tableById(String(seat.id).split(':')[1]);
      if (table) table.stand(p);
      return true;
    }
    if (seat.kind === 'blackjack-pending') {
      const pend = p.bjPending;
      this.clearPending(p);
      if (pend) {
        const table = this.tableById(pend.tableId);
        if (table) this.stepOffChair(p, table);
      }
      return true;
    }
    return true;
  }

  stepOffChair(p, table) {
    const dx = p.x - table.x, dy = p.y - table.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const map = this.game.sceneFor(p.mapId);
    for (const d of [36, 28, 20, 12]) {
      const nx = p.x + ux * d, ny = p.y + uy * d;
      if (!map || !collides(map, nx, ny, 12)) {
        p.x = nx; p.y = ny;
        this.game.savePosition(p);
        return;
      }
    }
  }

  // ------------------------------------------------------------ messages
  handleBlackjack(p, msg) {
    const action = msg.action;
    if (typeof action !== 'string' || !['state', 'sit', 'stand', 'rebuy', 'buyin', 'watch', 'bet', 'act'].includes(action)) {
      this.game.send(p, { type: 'notice', text: 'Unknown blackjack action.' });
      return;
    }
    if (action === 'state') {
      const lounge = this.loungeFor(p);
      const pool = lounge ? lounge.tables : this.tables.values();
      for (const t of pool) this.game.send(p, t.publicState());
      return;
    }
    if (action === 'buyin') { this.acceptBuyin(p, msg.amount); return; }
    if (action === 'watch') { this.watchTable(p); return; }
    const table = (typeof msg.table === 'string' && this.tableById(msg.table)) || (this.nearestTable(p) || {}).table;
    if (!table) { this.game.send(p, { type: 'notice', text: 'No blackjack table here.' }); return; }
    if (action === 'sit') { table.sit(p, msg.chair); return; }
    if (action === 'stand') {
      if (!table.stand(p) && p.bjPending && p.bjPending.tableId === table.id) {
        this.clearPending(p);
        if (p.seated && p.seated.kind === 'blackjack-pending') {
          p.seated = null;
          this.game.send(p, { type: 'sit-state', seated: false });
        }
        this.stepOffChair(p, table);
        this.game.send(p, { type: 'notice', text: 'You stand and give up the chair.' });
      }
      return;
    }
    if (action === 'rebuy') { table.rebuy(p); return; }
    if (action === 'bet') { table.placeBet(p, msg.amount); return; }
    if (action === 'act') { table.act(p, msg.act); return; }
    this.game.send(p, { type: 'notice', text: 'Unknown blackjack action.' });
  }

  // ------------------------------------------------------------ lifecycle
  handlePlayerGone(userId) {
    const gp = this.game.getPlayer(userId);
    if (gp && gp.seated && gp.seated.kind === 'blackjack') gp.seated = null;
    if (gp) this.clearPending(gp);
    for (const t of this.tables.values()) {
      for (const [i, uid] of t.reservedBy) if (uid === userId) t.reservedBy.delete(i);
    }
    for (const t of this.tables.values()) {
      const found = t.findSeat(userId);
      if (!found) continue;
      const { seat, idx } = found;
      // v1.6 (Order 5): disconnect == stand. A live bet mid-round
      // is forfeited to the house and the stack (minus the bet)
      // cashes out NOW — the v1.5 ghost settlement is retired.
      const liveBet = seat.bet > 0 && t.state === 'playing';
      if (liveBet) {
        const wasAction = t.actionIdx === idx;
        seat.bet = 0;
        seat.hand = [];
        seat.result = null;
        t.cashOutSeat(idx);
        if (wasAction) { t.actionIdx = idx; t.advance(); }
        t.afterSeatChange();
      } else {
        if (seat.bet > 0) { seat.chips += seat.bet; seat.bet = 0; }
        t.cashOutSeat(idx);
        t.afterSeatChange();
      }
    }
  }

  syncPlayer(p) {
    const lounge = this.loungeFor(p);
    if (!lounge) return;
    for (const t of lounge.tables) this.game.send(p, t.publicState());
  }
}

module.exports = {
  BlackjackSystem, BlackjackTable, handValue,
  BJ_MIN_BET, BJ_MAX_BET, BET_SECS, TURN_SECS, PAYOUT_SECS,
};
