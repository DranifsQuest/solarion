'use strict';

/**
 * Solarion — blackjack client (v1.5).
 *
 * Mirrors public/casino.js patterns: a table-state store the
 * world renderer reads (client.js drawBlackjackState draws the
 * dealer row + per-seat hands on the blue felt), a compact tray
 * section (bet buttons during the betting window, Hit / Stand /
 * Double on your turn, rebuy + stand/cash-out), and the centred
 * buy-in offer that pops when you sit at a blackjack table.
 *
 * The tray section shows only while you HOLD a blackjack seat;
 * the shared #casinoTray shell itself is lounge-gated by the
 * casino module's presence tracking (blackjack tables live in
 * the same lounges).
 */

const Blackjack = {
  tables: new Map(),      // tableId -> last blackjack-state
  mySeat: null,           // { tableId, chairIdx } derived from states
  offer: null,            // pending blackjack-offer payload

  attach(hooks) {
    this.hooks = hooks; // { send, toast, esc, getMe, getMapDef, getCoins }
    this.buildDom();
  },

  buildDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      tray: $('trayBlackjack'), info: $('bjInfo'),
      betRow: $('bjBetRow'), actions: $('bjActions'),
      offer: $('bjOffer'), offerText: $('bjOfferText'),
      offerBuy: $('bjOfferBuy'), offerChoices: $('bjOfferChoices'),
    };
    for (const b of document.querySelectorAll('.bjBetBtn')) {
      b.onclick = () => {
        if (this.mySeat) this.hooks.send({ type: 'blackjack', action: 'bet', table: this.mySeat.tableId, amount: Number(b.dataset.bet) });
      };
    }
    $('bjHit').onclick = () => this.act('hit');
    $('bjStandBtn').onclick = () => this.act('stand');
    $('bjDouble').onclick = () => this.act('double');
    $('bjRebuy').onclick = () => {
      if (this.mySeat) this.hooks.send({ type: 'blackjack', action: 'rebuy', table: this.mySeat.tableId });
    };
    $('bjLeave').onclick = () => this.hooks.send({ type: 'blackjack', action: 'stand' });
    $('bjOfferBuy').onclick = () => {
      this.hideOffer();
      this.hooks.send({ type: 'blackjack', action: 'buyin' });
    };
    $('bjOfferWatch').onclick = () => {
      this.hideOffer();
      this.hooks.send({ type: 'blackjack', action: 'watch' });
    };
  },

  act(actName) {
    if (!this.mySeat) return;
    this.hooks.send({ type: 'blackjack', action: 'act', table: this.mySeat.tableId, act: actName });
  },

  // ------------------------------------------------------------ the offer

  showOffer(m) {
    this.offer = m;
    const tableNo = String(m.table || '').split('-').pop();
    const bal = Number.isFinite(m.balance) ? m.balance : 0;
    this.el.offerChoices.innerHTML = '';
    this.el.offerChoices.classList.add('hidden');
    this.el.offerBuy.classList.remove('hidden');
    this.el.offerBuy.disabled = false;
    if (m.established) {
      if (bal >= m.amount) {
        this.el.offerText.textContent =
          `Blackjack table ${tableNo} — table buy-in: ${m.amount}z. Join for ${m.amount}z? (Your balance: ${bal}z)`;
        this.el.offerBuy.textContent = `Join — ${m.amount}z`;
      } else {
        this.el.offerText.textContent =
          `Blackjack table ${tableNo} — table buy-in: ${m.amount}z. You have ${bal}z — not enough to join, but you can watch from this chair.`;
        this.el.offerBuy.classList.add('hidden');
      }
    } else {
      this.el.offerBuy.classList.add('hidden');
      const min = m.min || 50;
      let text = `You're starting the blackjack table — set the buy-in. Your balance: ${bal}z. Bets ${m.minBet || 5}–${m.maxBet || 100}z per hand.`;
      if (bal < min) text += ` You need at least ${min}z to set a buy-in — you can still just watch.`;
      this.el.offerText.textContent = text;
      const choices = Array.isArray(m.choices) && m.choices.length ? m.choices : [50, 100, 200, 500];
      for (const amt of choices) {
        const b = document.createElement('button');
        b.textContent = `${amt}z`;
        b.disabled = amt > bal;
        b.onclick = () => {
          this.hideOffer();
          this.hooks.send({ type: 'blackjack', action: 'buyin', amount: amt });
        };
        this.el.offerChoices.appendChild(b);
      }
      this.el.offerChoices.classList.remove('hidden');
    }
    this.el.offer.classList.remove('hidden');
  },

  hideOffer() {
    this.offer = null;
    if (this.el && this.el.offer) this.el.offer.classList.add('hidden');
    if (this.el && this.el.offerChoices) {
      this.el.offerChoices.innerHTML = '';
      this.el.offerChoices.classList.add('hidden');
    }
  },

  onMapChanged() {
    this.tables.clear();
    this.mySeat = null;
    this.hideOffer();
    if (this.el && this.el.tray) this.el.tray.classList.add('hidden');
  },

  // ------------------------------------------------------------ rendering

  render() {
    const me = this.hooks.getMe();
    this.mySeat = null;
    for (const st of this.tables.values()) {
      const idx = me ? st.chairs.findIndex((c) => c.name === me.name) : -1;
      if (idx >= 0) this.mySeat = { tableId: st.id, chairIdx: idx };
    }
    const seated = Boolean(this.mySeat);
    this.el.tray.classList.toggle('hidden', !seated);
    if (!seated) return;
    if (this.offer) this.hideOffer(); // bought in — question answered
    const st = this.tables.get(this.mySeat.tableId);
    const mine = st.chairs[this.mySeat.chairIdx];
    const buyinNote = st.buyin ? `Table buy-in ${st.buyin}z · ` : '';
    const myNet = () => {
      const r = (st.results || []).find((x) => x.name === (this.hooks.getMe() || {}).name);
      return r ? r.amount : 0;
    };
    let info = '';
    if (st.state === 'betting') {
      info = mine.bet
        ? `${buyinNote}Bet in: ${mine.bet}z — cards on the way. Stack ${mine.chips}z`
        : `${buyinNote}Place your bet (${st.minBet}–${st.maxBet}z)! Stack ${mine.chips}z`;
    } else if (st.state === 'playing') {
      const dv = st.dealer.cards && st.dealer.cards[0];
      info = mine.acting
        ? `${buyinNote}Your ${mine.handTotal} vs dealer ${dv || '?'} — hit, stand${mine.hand.length === 2 ? ' or double' : ''}.`
        : `${buyinNote}Hand in play — dealer shows ${dv || '?'}. Your stack ${mine.chips}z`;
    } else if (st.state === 'payout') {
      const label = {
        blackjack: '★ BLACKJACK!', win: 'You win!', 'dealer-bust': 'Dealer busts — you win!',
        push: 'Push — bet returned.', bust: 'Bust.', lose: 'Dealer wins this one.', 'dealer-blackjack': 'Dealer has blackjack.',
      }[mine.result] || 'Round over.';
      const net = myNet();
      info = mine.result
        ? `${buyinNote}${label} ${net ? `(${net > 0 ? '+' : ''}${net}z)` : ''} Stack ${mine.chips}z`
        : `${buyinNote}Round over — next betting window soon. Stack ${mine.chips}z`;
    } else {
      info = `${buyinNote}Blackjack — betting opens in a moment. Stack ${mine.chips}z`;
    }
    this.el.info.textContent = info;
    // Bet buttons: only during the window, only before my bet,
    // only amounts my remaining stack covers.
    const canBet = st.state === 'betting' && !mine.bet;
    this.el.betRow.classList.toggle('hidden', !canBet && st.state !== 'betting');
    for (const b of document.querySelectorAll('.bjBetBtn')) {
      b.disabled = !canBet || Number(b.dataset.bet) > mine.chips;
    }
    this.el.actions.classList.toggle('hidden', false);
    const myTurn = Boolean(mine.acting);
    document.getElementById('bjHit').disabled = !myTurn;
    document.getElementById('bjStandBtn').disabled = !myTurn;
    document.getElementById('bjDouble').disabled =
      !(myTurn && mine.hand.length === 2 && mine.chips >= mine.bet);
  },

  // ------------------------------------------------------------ messages

  handle(m) {
    switch (m.type) {
      case 'blackjack-state':
        this.tables.set(m.id, m);
        this.render();
        break;
      case 'blackjack-offer':
        this.showOffer(m);
        break;
      default:
        break;
    }
  },
};

window.SolarionBlackjack = Blackjack;

// blackjack.js loads right after casino.js; the casino boot block
// has already run, so attach here with the same shared hooks.
/* global send, toast, esc, me, mapDef */
(function bootBlackjack() {
  if (!window.SolarionBlackjack || window.SolarionBlackjack.hooks) return;
  window.SolarionBlackjack.attach({
    send: (m) => send(m),
    toast: (t, ms) => toast(t, ms),
    esc: (s) => esc(s),
    getMe: () => me,
    getMapDef: () => mapDef,
  });
})();
