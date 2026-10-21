'use strict';

/**
 * Solarion — casino client (Phase 3, presentation rebuilt v1.1.1).
 *
 * NO SIDEBAR ANYMORE. Poker plays AT the table: community cards,
 * the pot, hole-card backs and your own cards render on the felt
 * in the world view (client.js drawFeltState reads this module's
 * table store). Slots play AT the cabinet: the reels tumble and
 * settle on the machine's glass (client.js slotDisplayReels reads
 * slotFxBySlot). What remains here is a compact bottom-centre
 * control TRAY — your cards + action buttons while you're in a
 * hand, bet/spin controls, table chat, the bar button — and the
 * centred buy-in offer that pops when you sit at a poker table.
 *
 * Join flow (v1.1.1, per-table v1.1.2): sitting at a table does
 * NOT auto-buy-in. The server snaps you into the chair and sends
 * poker-offer; the modal asks — at an EMPTY table you SET the
 * table's buy-in from preset buttons, at a SET table you join for
 * exactly the table's amount (or see the insufficient-funds state
 * and just watch). Declining always leaves you seated as a
 * spectator with no chips moved.
 */

const Casino = {
  tables: new Map(),      // tableId -> last poker-state
  myCards: {},            // tableId -> [card, card]
  mySeat: null,           // { tableId, chairIdx } derived from states
  slotBet: 10,
  slotSymbols: {},        // id -> emoji
  slotFxBySlot: new Map(), // slotId -> { reels, at } for the cabinets
  spinning: false,
  inLounge: false,
  offer: null,            // pending poker-offer payload

  attach(hooks) {
    this.hooks = hooks; // { send, toast, esc, getMe, getMapDef, getCoins }
    this.buildDom();
  },

  buildDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      tray: $('casinoTray'), trayPoker: $('trayPoker'),
      myCards: $('myCards'), actions: $('pokerActions'),
      raiseAmt: $('raiseAmt'),
      offer: $('pokerOffer'), offerText: $('offerText'), offerBuy: $('offerBuy'),
      offerChoices: $('offerChoices'),
      slotMsg: $('slotMsg'),
    };
    for (const b of document.querySelectorAll('.slotBetBtn')) {
      b.onclick = () => {
        this.slotBet = Number(b.dataset.bet);
        for (const x of document.querySelectorAll('.slotBetBtn')) x.classList.toggle('active', x === b);
      };
    }
    $('slotSpin').onclick = () => this.spin();
    $('tableChatBtn').onclick = () => {
      const inp = $('tableChatInput');
      const text = inp.value.trim();
      if (text) { this.hooks.send({ type: 'table-chat', text }); inp.value = ''; }
    };
    $('tableChatInput').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') $('tableChatBtn').click();
    });
    const drinkBtn = $('drinkBtn');
    if (drinkBtn) drinkBtn.onclick = () => this.hooks.send({ type: 'buy-drink' });
    this.el.viceInfo = $('viceInfo');
    $('pokerStand').onclick = () => this.hooks.send({ type: 'poker', action: 'stand' });
    $('pokerRebuy').onclick = () => {
      if (this.mySeat) this.hooks.send({ type: 'poker', action: 'rebuy', table: this.mySeat.tableId });
    };
    $('actFold').onclick = () => this.act('fold');
    $('actCheck').onclick = () => this.act('check');
    $('actCall').onclick = () => this.act('call');
    $('actRaise').onclick = () => this.act('raise', Number(this.el.raiseAmt.value) || 0);
    $('actAllin').onclick = () => this.act('allin');
    // The buy-in offer: accept = the server's atomic buy-in; watch =
    // stay seated as a spectator, no chips moved.
    $('offerBuy').onclick = () => {
      this.hideOffer();
      this.hooks.send({ type: 'poker', action: 'buyin' });
    };
    $('offerWatch').onclick = () => {
      this.hideOffer();
      this.hooks.send({ type: 'poker', action: 'watch' });
    };
  },

  act(actName, amount) {
    if (!this.mySeat) return;
    this.hooks.send({ type: 'poker', action: 'act', table: this.mySeat.tableId, act: actName, amount });
  },

  spin() {
    if (this.spinning) return;
    this.hooks.send({ type: 'slots', action: 'spin', bet: this.slotBet });
  },

  // ------------------------------------------------------------ lounge gate

  /** Called every animation frame from client.js with my position. */
  updatePresence(x, y, mapDef) {
    const c = mapDef && mapDef.casino;
    const inside = Boolean(c) && x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h;
    if (inside !== this.inLounge) {
      this.inLounge = inside;
      this.el.tray.classList.toggle('hidden', !inside);
      if (inside) {
        this.hooks.send({ type: 'poker', action: 'state' });
        this.hooks.send({ type: 'slots', action: 'info' });
      }
    }
  },

  onMapChanged() {
    this.inLounge = false;
    this.el.tray.classList.add('hidden');
    this.hideOffer();
    this.tables.clear();
    this.slotFxBySlot.clear();
    this.myCards = {};
    this.mySeat = null;
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
      // The table owns its buy-in — join at exactly its amount.
      if (bal >= m.amount) {
        this.el.offerText.textContent =
          `Table ${tableNo} — table buy-in: ${m.amount}z. Join for ${m.amount}z? (Your balance: ${bal}z)`;
        this.el.offerBuy.textContent = `Join — ${m.amount}z`;
      } else {
        this.el.offerText.textContent =
          `Table ${tableNo} — table buy-in: ${m.amount}z. You have ${bal}z — not enough to join, but you can watch from this chair.`;
        this.el.offerBuy.classList.add('hidden');
      }
    } else {
      // First at the table: YOU set the buy-in (presets only, and
      // only the ones your balance covers — the server re-checks).
      this.el.offerBuy.classList.add('hidden');
      const min = m.min || 50;
      let text = `You're starting Table ${tableNo} — set the buy-in. Your balance: ${bal}z.`;
      if (bal < min) text += ` You need at least ${min}z to set a buy-in — you can still just watch.`;
      this.el.offerText.textContent = text;
      const choices = Array.isArray(m.choices) && m.choices.length ? m.choices : [50, 100, 200, 500];
      for (const amt of choices) {
        const b = document.createElement('button');
        b.textContent = `${amt}z`;
        b.disabled = amt > bal;
        b.onclick = () => {
          this.hideOffer();
          this.hooks.send({ type: 'poker', action: 'buyin', amount: amt });
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

  // ------------------------------------------------------------ rendering

  render() {
    const esc = this.hooks.esc;
    const me = this.hooks.getMe();
    this.mySeat = null;
    for (const st of this.tables.values()) {
      const seatedIdx = me ? st.chairs.findIndex((c) => c.name === me.name) : -1;
      if (seatedIdx >= 0) this.mySeat = { tableId: st.id, chairIdx: seatedIdx };
    }
    // The tray's poker section exists only while you hold chips at
    // a table; the felt itself carries the shared table state.
    this.el.trayPoker.classList.toggle('hidden', !this.mySeat);
    if (this.mySeat) this.hideOffer(); // bought in — question answered
    const mine = this.mySeat && this.myCards[this.mySeat.tableId];
    const st = this.mySeat ? this.tables.get(this.mySeat.tableId) : null;
    const buyinNote = st && st.buyin ? `Table buy-in ${st.buyin}z · ` : '';
    this.el.myCards.innerHTML = this.mySeat
      ? buyinNote + (mine ? `Your cards: ${mine.map((c) => `<span class="card mine">${esc(c)}</span>`).join(' ')}` : 'Seated — good luck!')
      : '';
    const myTurn = Boolean(st && st.chairs[this.mySeat.chairIdx] && st.chairs[this.mySeat.chairIdx].acting);
    this.el.actions.classList.toggle('hidden', !this.mySeat);
    for (const id of ['actFold', 'actCheck', 'actCall', 'actRaise', 'actAllin']) {
      document.getElementById(id).disabled = !myTurn;
    }
    if (st && myTurn) {
      document.getElementById('actCall').textContent = st.toCall > 0 ? `Call ${st.toCall}z` : 'Call';
      document.getElementById('actCheck').disabled = st.toCall > 0;
    }
  },

  // ------------------------------------------------------------ messages

  handle(m) {
    switch (m.type) {
      case 'poker-state':
        this.tables.set(m.id, m);
        this.render();
        break;
      case 'poker-cards':
        this.myCards[m.table] = m.cards;
        this.render();
        break;
      case 'poker-offer':
        this.showOffer(m);
        break;
      case 'slot-info':
        this.slotSymbols = {};
        for (const s of m.symbols || []) this.slotSymbols[s.id] = s.emoji;
        this.setJackpot(m.jackpotPool);
        break;
      case 'jackpot':
        this.setJackpot(m.pool);
        break;
      case 'slot-fx':
        // A cabinet in the room is spinning (maybe mine): the world
        // renderer tumbles its glass, then settles on these reels.
        if (m.slot) this.slotFxBySlot.set(m.slot, { reels: m.reels || [], at: Date.now() });
        break;
      case 'slot-result':
        this.onSlotResult(m);
        break;
      case 'table-chat':
        // Table-scoped chat lands in the main chat log with a table
        // tag — only players at/near the table receive it.
        if (typeof chatLine === 'function') {
          chatLine(`<span class="dim">🎰 Table ${this.hooks.esc(String(m.tableId).split('-').pop())} ·</span> <b>${this.hooks.esc(m.name)}:</b> ${this.hooks.esc(m.text)}`);
        }
        break;
      case 'vice-state':
        // Drink/puff tally for the tray's bar section.
        if (this.el.viceInfo) {
          const bits = [];
          if (m.drinks) bits.push(`🍸 × ${m.drinks}${m.passedOut ? ' — OUT COLD' : ''}`);
          if (m.puffs) bits.push(`💨 × ${m.puffs}${m.hippy ? ' — 🌈 HIPPY' : ''}`);
          this.el.viceInfo.textContent = bits.length
            ? bits.join(' · ')
            : 'Stand at the bar and order. 10 drinks = lights out!';
        }
        break;
      default:
        break;
    }
  },

  onSlotResult(m) {
    // My cabinet animates in the world (the slot-fx broadcast covers
    // it — the server sends it to the room, me included). The tray
    // just reports the outcome once the reels have settled.
    this.spinning = true;
    if (Number.isFinite(m.jackpotPool)) this.setJackpot(m.jackpotPool);
    this.el.slotMsg.textContent = '🎰 The reels are spinning…';
    setTimeout(() => {
      this.spinning = false;
      this.el.slotMsg.textContent = m.jackpotWin > 0
        ? `☀️☀️☀️ THREE SUNS — THE JACKPOT! You win ${m.jackpotWin}z!!`
        : m.win > 0
          ? `🎉 You win ${m.win}z! (bet ${m.bet}z)`
          : `No win — bet ${m.bet}z. Balance ${m.zcoins}z`;
      if (m.win >= m.bet * 4 && m.win > 0) this.hooks.toast(`🎰 JACKPOT! +${m.win}z on the slots!`);
    }, 780);
  },

  setJackpot(pool) {
    const el = document.getElementById('slotJackpot');
    if (el && Number.isFinite(pool)) el.textContent = `💰 JACKPOT (both casinos): ${pool}z — three ☀️ take it all!`;
  },
};

window.SolarionCasino = Casino;

// casino.js loads LAST (after client.js and mixer.js), so this is the
// one reliable place to wire the UI modules. client.js's own attach
// block runs before mixer.js/casino.js exist, so it can never fire —
// this also repairs that latent Phase 2 wiring gap (guarded, attach
// exactly once). Hooks reference client.js's top-level bindings
// (send / me / mapDef are script globals shared across classic scripts).
/* global send, toast, esc, me, mapDef */
(function boot() {
  const hooks = {
    send: (m) => send(m),
    toast: (t, ms) => toast(t, ms),
    esc: (s) => esc(s),
    getMe: () => me,
    getMapDef: () => mapDef,
  };
  if (window.SolarionMixer && !window.SolarionMixer.hooks) window.SolarionMixer.attach(hooks);
  window.SolarionCasino.attach(hooks);
})();
