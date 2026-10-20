'use strict';

/**
 * Solarion — casino client (Phase 3): Casino Lounge UI.
 *
 * A dark infostand panel (soul doc §2/§7: chunky pixel buttons, dark
 * panels) that appears only while your avatar is inside the lounge.
 * Poker: seat yourself at a table, see community cards + pot, your
 * hole cards arrive privately from the server (poker-cards), and the
 * act buttons are enabled only when the server says it's your turn —
 * the server re-validates everything anyway. Slots: pick a wager,
 * hit SPIN, reels tumble and settle on the server's result.
 */

const Casino = {
  tables: new Map(),      // tableId -> last poker-state
  myCards: {},            // tableId -> [card, card]
  mySeat: null,           // { tableId, chairIdx } derived from states
  slotBet: 10,
  slotSymbols: {},        // id -> emoji
  spinning: false,
  inLounge: false,

  attach(hooks) {
    this.hooks = hooks; // { send, toast, esc, getMe, getMapDef, getCoins }
    this.buildDom();
  },

  buildDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      panel: $('casinoPanel'), tables: $('casinoTables'),
      slotReels: $('slotReels'), slotMsg: $('slotMsg'),
      myCards: $('myCards'), actions: $('pokerActions'),
      raiseAmt: $('raiseAmt'),
    };
    for (const b of document.querySelectorAll('.slotBetBtn')) {
      b.onclick = () => {
        this.slotBet = Number(b.dataset.bet);
        for (const x of document.querySelectorAll('.slotBetBtn')) x.classList.toggle('active', x === b);
      };
    }
    $('slotSpin').onclick = () => this.spin();
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
      this.el.panel.classList.toggle('hidden', !inside);
      if (inside) {
        const title = document.getElementById('casinoTitle');
        if (title) title.textContent = `🎰 ${(c.label || 'CASINO').toUpperCase()}`;
      }
      if (inside) {
        this.hooks.send({ type: 'poker', action: 'state' });
        this.hooks.send({ type: 'slots', action: 'info' });
      }
    }
  },

  onMapChanged() {
    this.inLounge = false;
    this.el.panel.classList.add('hidden');
    this.tables.clear();
    this.myCards = {};
    this.mySeat = null;
  },

  // ------------------------------------------------------------ rendering

  render() {
    const esc = this.hooks.esc;
    const me = this.hooks.getMe();
    this.mySeat = null;
    let html = '';
    for (const st of this.tables.values()) {
      const seatedIdx = me ? st.chairs.findIndex((c) => c.name === me.name) : -1;
      if (seatedIdx >= 0) this.mySeat = { tableId: st.id, chairIdx: seatedIdx };
      html += `<div class="pkTable"><div class="pkHead">♠ TABLE ${esc(st.id.split('-').pop())} — ${esc(st.state)}` +
        (st.pot ? ` · POT ${st.pot}z` : '') +
        (st.countdown ? ` · starts in ${st.countdown}s` : '') + `</div>`;
      html += `<div class="pkComm">${st.community.length ? st.community.map((c) => `<span class="card">${esc(c)}</span>`).join(' ') : '<span class="pkDim">no cards yet</span>'}</div>`;
      html += '<div class="pkChairs">';
      st.chairs.forEach((c, i) => {
        if (c.name) {
          html += `<div class="pkChair ${c.acting ? 'acting' : ''} ${i === seatedIdx ? 'mine' : ''}">` +
            `${c.dealer ? '🔘 ' : ''}<b>${esc(c.name)}</b> ${c.chips}z` +
            (c.bet ? ` · bet ${c.bet}z` : '') + (c.folded ? ' · folded' : '') + (c.allIn ? ' · ALL-IN' : '') + '</div>';
        } else if (!this.mySeat) {
          html += `<button class="pkSit" data-table="${esc(st.id)}" data-chair="${esc(c.dir)}">Sit ${esc(c.dir)} — buy in 50–200z</button>`;
        } else {
          html += '<div class="pkChair pkDim">empty</div>';
        }
      });
      html += '</div>';
      if (st.winners) {
        html += `<div class="pkWin">${st.winners.map((w) => `🏆 ${esc(w.name)} won ${w.amount}z (${esc(w.hand || '')})`).join('<br>')}</div>`;
      }
      if (st.reveal) {
        html += `<div class="pkDim">${st.reveal.map((r) => `${esc(r.name)}: ${esc(r.cards.join(' '))}`).join(' · ')}</div>`;
      }
      html += '</div>';
    }
    this.el.tables.innerHTML = html || '<div class="pkDim">Walk into the Casino Lounge…</div>';
    for (const b of this.el.tables.querySelectorAll('.pkSit')) {
      b.onclick = () => this.hooks.send({ type: 'poker', action: 'sit', table: b.dataset.table, chair: b.dataset.chair });
    }
    // my hole cards + action bar
    const mine = this.mySeat && this.myCards[this.mySeat.tableId];
    this.el.myCards.innerHTML = this.mySeat
      ? (mine ? `Your cards: ${mine.map((c) => `<span class="card mine">${esc(c)}</span>`).join(' ')}` : 'Seated — good luck!')
      : '';
    const st = this.mySeat ? this.tables.get(this.mySeat.tableId) : null;
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
        if (this.inLounge) this.render();
        break;
      case 'poker-cards':
        this.myCards[m.table] = m.cards;
        if (this.inLounge) this.render();
        break;
      case 'slot-info':
        this.slotSymbols = {};
        for (const s of m.symbols || []) this.slotSymbols[s.id] = s.emoji;
        if (!this._reelsInit) { this._reelsInit = true; this.setReels(['sun', 'zcoin', 'palm']); }
        break;
      case 'slot-result':
        this.animateReels(m);
        break;
      case 'vice-state':
        // Phase B amendment: drink/puff tally for the bar box.
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

  setReels(ids) {
    this.el.slotReels.innerHTML = ids.map((id) =>
      `<span class="reel">${this.slotSymbols[id] || '❓'}</span>`).join('');
  },

  animateReels(m) {
    // Tumble random emoji, then settle on the server's reels.
    this.spinning = true;
    const ids = Object.keys(this.slotSymbols);
    const faces = ids.length ? ids : ['sun', 'zcoin', 'palm'];
    let ticks = 0;
    const iv = setInterval(() => {
      ticks++;
      this.setReels([0, 1, 2].map(() => faces[Math.floor(Math.random() * faces.length)]));
      if (ticks >= 8) {
        clearInterval(iv);
        this.setReels(m.reels);
        this.spinning = false;
        this.el.slotMsg.textContent = m.win > 0
          ? `🎉 You win ${m.win}z! (bet ${m.bet}z)`
          : `No win — bet ${m.bet}z. Balance ${m.zcoins}z`;
        if (m.win >= m.bet * 4 && m.win > 0) this.hooks.toast(`🎰 JACKPOT! +${m.win}z on the slots!`);
      }
    }, 70);
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
