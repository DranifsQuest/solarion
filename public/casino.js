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
  context: null,          // v1.2: 'poker' | 'slots' | 'bar' | null (Item F2)
  mySlotId: null,         // the machine whose stool I occupy
  guiOpen: false,         // v1.2: the slot GUI window (Item H)
  guiDismissed: false,    // closed with X — stays shut for this sit
  guiAnimating: false,
  lastReels: null,        // last server symbols shown on the GUI

  attach(hooks) {
    this.hooks = hooks; // { send, toast, esc, getMe, getMapDef, getCoins }
    this.buildDom();
  },

  buildDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      tray: $('casinoTray'), trayPoker: $('trayPoker'),
      traySlots: $('traySlots'), trayChat: $('trayChat'), trayBar: $('trayBar'),
      myCards: $('myCards'), actions: $('pokerActions'),
      raiseAmt: $('raiseAmt'),
      offer: $('pokerOffer'), offerText: $('offerText'), offerBuy: $('offerBuy'),
      offerChoices: $('offerChoices'),
      slotMsg: $('slotMsg'),
      gui: $('slotGui'), guiSpin: $('slotGuiSpin'), guiMsg: $('slotGuiMsg'),
      guiBalance: $('slotGuiBalance'), guiJackpot: $('slotGuiJackpot'),
      reelStrips: [$('reelStrip0'), $('reelStrip1'), $('reelStrip2')],
    };
    for (const b of document.querySelectorAll('.slotBetBtn')) {
      b.onclick = () => this.setBet(Number(b.dataset.bet));
    }
    for (const b of document.querySelectorAll('.guiBetBtn')) {
      b.onclick = () => this.setBet(Number(b.dataset.bet));
    }
    $('slotSpin').onclick = () => this.spin();
    if (this.el.guiSpin) this.el.guiSpin.onclick = () => this.spin();
    const guiClose = $('slotGuiClose');
    if (guiClose) guiClose.onclick = () => { this.guiDismissed = true; this.closeGui(); this.applyContext(); };
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

  /** One bet state for both the tray buttons and the GUI buttons. */
  setBet(n) {
    this.slotBet = n;
    for (const x of document.querySelectorAll('.slotBetBtn,.guiBetBtn')) {
      x.classList.toggle('active', Number(x.dataset.bet) === n);
    }
  },

  spin() {
    if (this.spinning) return;
    this.spinning = true;
    if (this.el.guiSpin) this.el.guiSpin.disabled = true;
    // Safety: if the server never answers, don't wedge the button.
    setTimeout(() => { if (this.spinning && !this.guiAnimating) { this.spinning = false; if (this.el.guiSpin) this.el.guiSpin.disabled = false; } }, 3500);
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
    if (inside) this.updateContext(x, y, mapDef);
    else if (this.context !== null) { this.context = null; this.applyContext(); }
  },

  /**
   * v1.2 (Item F2/G): the tray context — exactly one section family
   * at a time. Poker (with table chat) only while seated at a poker
   * table; slots only while seated at a slot stool; the bar only
   * while at the bar (seated on a bar stool or standing at the
   * counter spot). Derived fresh each frame from my seat + position
   * against the map's own machine/stool/bar data — no hardcoded
   * directions or rooms.
   */
  updateContext(x, y, mapDef) {
    const cz = mapDef && mapDef.casino;
    if (!cz) return;
    const me = this.hooks.getMe();
    let ctx = null;
    let slotId = null;
    if (this.mySeat) {
      ctx = 'poker';
    } else if (me && me.seated) {
      for (const s of cz.slots || []) {
        if (Math.hypot(x - s.ix, y - s.iy) < 26) { ctx = 'slots'; slotId = s.id; break; }
      }
      if (!ctx) {
        const slotSeatIds = new Set((cz.slots || []).map(s => s.seatId));
        for (const st of mapDef.seats || []) {
          if (st.kind !== 'stool' || slotSeatIds.has(st.id)) continue;
          if (Math.hypot(x - st.x, y - st.y) < 26) { ctx = 'bar'; break; }
        }
      }
    }
    if (!ctx && cz.bar && Math.hypot(x - cz.bar.x, y - cz.bar.y) < 62) ctx = 'bar';
    if (ctx !== this.context || slotId !== this.mySlotId) {
      this.context = ctx;
      this.mySlotId = slotId;
      if (ctx !== 'slots') { this.guiDismissed = false; this.closeGui(); }
      this.applyContext();
      if (ctx === 'slots' && !this.guiDismissed) this.openGui();
    }
  },

  /** Show exactly the tray sections for the current context. */
  applyContext() {
    const ctx = this.context;
    this.el.trayPoker.classList.toggle('hidden', ctx !== 'poker');
    this.el.trayChat.classList.toggle('hidden', ctx !== 'poker');
    this.el.trayBar.classList.toggle('hidden', ctx !== 'bar');
    // While the slot GUI is open it owns bet + SPIN (Item H).
    this.el.traySlots.classList.toggle('hidden', !(ctx === 'slots' && !this.guiOpen));
  },

  onMapChanged() {
    this.inLounge = false;
    this.context = null;
    this.mySlotId = null;
    this.guiDismissed = false;
    this.closeGui();
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

  // ------------------------------------------------------------ slot GUI (Item H)

  /** The seated player's own cabinet window. Opens on the sit,
   *  stays while seated; X dismisses it for this sit; standing
   *  closes it. The in-world glass (slot-fx) is for spectators. */
  openGui() {
    if (!this.el.gui || this.guiOpen) return;
    this.guiOpen = true;
    this.el.gui.classList.remove('hidden');
    const ids = Object.keys(this.slotSymbols);
    const show = this.lastReels && this.lastReels.length === 3 ? this.lastReels : ids.slice(0, 3);
    this.setReelsIdle(show.length === 3 ? show : ['sun', 'zcoin', 'star']);
    this.syncGuiBalance();
    this.applyContext(); // tray slots defer to the GUI
  },

  closeGui() {
    if (!this.guiOpen) return;
    this.guiOpen = false;
    this.guiAnimating = false;
    if (this.el.gui) this.el.gui.classList.add('hidden');
  },

  syncGuiBalance() {
    const c = document.getElementById('coins');
    if (c && this.el.guiBalance) this.el.guiBalance.textContent = c.textContent;
  },

  setReelsIdle(ids) {
    ids.forEach((id, r) => {
      const strip = this.el.reelStrips[r];
      if (!strip) return;
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0)';
      strip.innerHTML = `<div class="reelSym">${this.slotSymbols[id] || '⭐'}</div>`;
      strip.parentElement.classList.remove('win', 'jackpot');
    });
  },

  /**
   * Animate the GUI reels onto the server's result: each reel's
   * strip tumbles (blur while fast) and settles LEFT to RIGHT with
   * a small overshoot bounce, landing exactly on slot-result.reels
   * (the planner in slotreels.js owns that contract). Win readout,
   * payout and jackpot state land when the last reel stops.
   */
  animateGuiReels(m) {
    const SR = window.SolarionSlotReels;
    const ids = Object.keys(this.slotSymbols);
    if (!SR || !Array.isArray(m.reels) || m.reels.length !== 3 || ids.length < 2) {
      this.finishGuiResult(m);
      return;
    }
    this.guiAnimating = true;
    const plan = SR.planReels(m.reels, ids);
    const SYM_H = 64;
    this.el.guiMsg.textContent = '🎰 The reels are spinning…';
    plan.forEach((reel, r) => {
      const strip = this.el.reelStrips[r];
      strip.parentElement.classList.remove('win', 'jackpot');
      strip.innerHTML = reel.strip.map(id => `<div class="reelSym">${this.slotSymbols[id] || '⭐'}</div>`).join('');
      strip.style.transition = 'none';
      strip.style.transform = 'translateY(0)';
      strip.classList.add('spinning');
      // Force layout, then run the tumble to the final symbol.
      void strip.offsetHeight;
      strip.style.transition = `transform ${reel.settleMs}ms cubic-bezier(.15,.6,.25,1.04)`;
      strip.style.transform = `translateY(${-reel.finalIndex * SYM_H}px)`;
      setTimeout(() => strip.classList.remove('spinning'), reel.settleMs);
    });
    const total = Math.max(...plan.map(p => p.settleMs));
    setTimeout(() => {
      this.guiAnimating = false;
      const mask = SR.matchMask(m.reels);
      const jp = SR.isJackpot(m.reels);
      mask.forEach((on, r) => {
        if (on) this.el.reelStrips[r].parentElement.classList.add(jp ? 'jackpot' : 'win');
      });
      this.finishGuiResult(m);
    }, total + 60);
  },

  /** Reels settled: the win/loss readout + balance + jackpot land. */
  finishGuiResult(m) {
    this.spinning = false;
    if (this.el.guiSpin) this.el.guiSpin.disabled = false;
    this.lastReels = Array.isArray(m.reels) ? m.reels.slice() : this.lastReels;
    if (Number.isFinite(m.zcoins) && this.el.guiBalance) this.el.guiBalance.textContent = String(m.zcoins);
    this.el.guiMsg.textContent = m.jackpotWin > 0
      ? `☀️☀️☀️ THREE SUNS — THE JACKPOT! You win ${m.jackpotWin}z!!`
      : m.win > 0
        ? `🎉 You win ${m.win}z! (bet ${m.bet}z)`
        : `No win — bet ${m.bet}z.`;
    if (m.win >= m.bet * 4 && m.win > 0) this.hooks.toast(`🎰 JACKPOT! +${m.win}z on the slots!`);
    // Keep the tray line in sync for if the GUI gets dismissed.
    this.el.slotMsg.textContent = this.el.guiMsg.textContent;
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
    // v1.2: tray sections are context-owned (applyContext); a fresh
    // seat at a table promotes the context immediately.
    if (this.mySeat && this.context !== 'poker') { this.context = 'poker'; this.applyContext(); }
    if (this.mySeat) this.hideOffer(); // bought in — question answered
    const mine = this.mySeat && this.myCards[this.mySeat.tableId];
    const st = this.mySeat ? this.tables.get(this.mySeat.tableId) : null;
    const buyinNote = st && st.buyin ? `Table buy-in ${st.buyin}z · ` : '';
    // v1.6 (Order 5): the standing table rule, stated while it
    // can still cost you — a live hand you're dealt into forfeits
    // its committed chips if you stand.
    const myChair = st && this.mySeat ? st.chairs[this.mySeat.chairIdx] : null;
    const inLiveHand = Boolean(st && myChair && myChair.cards > 0 && !myChair.folded
      && ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(st.state));
    this.el.myCards.innerHTML = this.mySeat
      ? buyinNote + (mine ? `Your cards: ${mine.map((c) => `<span class="card mine">${esc(c)}</span>`).join(' ')}` : 'Seated — good luck!')
        + (inLiveHand ? ' · ⚠ Standing now forfeits your wager.' : '')
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
    // The room still watches my cabinet's glass (slot-fx). For ME:
    // with the Item H GUI open, its reels tumble and settle on the
    // server symbols and the readout lands at the settle; without
    // it (dismissed), the compact tray reports as before.
    if (Number.isFinite(m.jackpotPool)) this.setJackpot(m.jackpotPool);
    if (this.guiOpen) { this.animateGuiReels(m); return; }
    this.spinning = true;
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
    if (!Number.isFinite(pool)) return;
    const text = `💰 JACKPOT (both casinos): ${pool}z — three ☀️ take it all!`;
    const el = document.getElementById('slotJackpot');
    if (el) el.textContent = text;
    if (this.el && this.el.guiJackpot) this.el.guiJackpot.textContent = text;
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
