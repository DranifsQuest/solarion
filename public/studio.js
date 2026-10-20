'use strict';

/**
 * Solarion — studio + look client (Phase 4).
 *
 * Studio panel: enter your own studio, visit another player's by
 * username, leave, and — as owner in your own studio — buy from the
 * catalog, place/pick up furniture (click a tile to place the selected
 * item; right-click a placed item to pick it up), and kick visitors.
 * All rules are enforced server-side; this panel only sends intents.
 *
 * Look panel: hair style + hair/shirt/pants colors, sent as one
 * {type:'avatar-update'} — the server validates against the same sets
 * registration uses and the room sees the change via snapshots.
 */

const Studio = {
  catalog: [],
  inventory: [],
  furniture: [],
  ownerId: null,
  ownerName: null,
  isOwner: false,
  inStudio: false,
  panelOpen: false,
  placeInstanceId: null,   // inventory item armed for tile-click placement

  attach(hooks) {
    this.hooks = hooks; // { send, toast, esc, getMe, getMapDef }
    this.buildDom();
  },

  buildDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      panel: $('studioPanel'), title: $('studioTitle'),
      furnList: $('studioFurnList'), ownerBox: $('studioOwner'),
      catalog: $('catalogList'), inventory: $('inventoryList'),
      visitName: $('visitName'), kickSel: $('kickSel'),
      leaveBtn: $('leaveStudio'),
      lookPanel: $('lookPanel'),
    };
    $('studioBtn').onclick = () => {
      this.panelOpen = !this.panelOpen;
      this.renderVisibility();
      if (this.panelOpen && !this.inStudio) this.hooks.toast('Enter your studio, or type a username to visit theirs.');
    };
    $('enterMyStudio').onclick = () => {
      const me = this.hooks.getMe();
      if (me) this.hooks.send({ type: 'enter-studio', owner: me.name });
    };
    $('visitGo').onclick = () => {
      const name = this.el.visitName.value.trim();
      if (name) this.hooks.send({ type: 'enter-studio', owner: name });
    };
    this.el.leaveBtn.onclick = () => this.hooks.send({ type: 'leave-studio' });
    $('kickBtn').onclick = () => {
      const id = Number(this.el.kickSel.value);
      if (id) this.hooks.send({ type: 'studio-kick', userId: id });
    };
    // Look panel
    $('lookBtn').onclick = () => {
      const me = this.hooks.getMe();
      if (me) {
        $('lookHairStyle').value = me.hair_style || 'short';
        $('lookHairColor').value = me.hair_color || '#3a2a1c';
        $('lookShirt').value = me.body_color || '#3aa7e0';
        $('lookPants').value = me.accent_color || '#2b3a55';
      }
      this.el.lookPanel.classList.toggle('hidden');
    };
    $('lookClose').onclick = () => this.el.lookPanel.classList.add('hidden');
    $('lookApply').onclick = () => {
      this.hooks.send({
        type: 'avatar-update',
        hair_style: $('lookHairStyle').value,
        hair_color: $('lookHairColor').value,
        body_color: $('lookShirt').value,
        accent_color: $('lookPants').value,
      });
    };
    // Tile-click placement + right-click pickup on the world canvas.
    const cv = $('cv');
    cv.addEventListener('click', (e) => {
      if (this.placeInstanceId == null) return;
      const tile = this.eventTile(e);
      if (tile) {
        this.hooks.send({ type: 'studio-place', instanceItemId: this.placeInstanceId, x: tile.x, y: tile.y, rot: 0 });
        this.placeInstanceId = null;
        this.render();
      }
    });
    cv.addEventListener('contextmenu', (e) => {
      if (!this.inStudio || !this.isOwner) return;
      const tile = this.eventTile(e);
      if (!tile) return;
      const f = this.furniture.find(i => i.x === tile.x && i.y === tile.y);
      if (f) {
        e.preventDefault();
        this.hooks.send({ type: 'studio-pickup', instanceItemId: f.instanceId });
      }
    });
  },

  /**
   * Screen event -> world tile, inverting the client's isometric
   * projection (client.js: sx=(x-y)*Z, sy=(x+y)*Z*0.5, Z=0.72,
   * camera centred on my smoothed render position).
   */
  eventTile(e) {
    const cv = document.getElementById('cv');
    const rect = cv.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (cv.width / rect.width);
    const py = (e.clientY - rect.top) * (cv.height / rect.height);
    /* global renderPos, me */
    const myRp = (typeof renderPos !== 'undefined' && typeof me !== 'undefined' && me) ? renderPos.get(me.id) : null;
    if (!myRp) return null;
    const Z = 0.72;
    const camX = (myRp.x - myRp.y) * Z - cv.width / 2;
    const camY = (myRp.x + myRp.y) * Z * 0.5 - cv.height / 2;
    const sx = px + camX, sy = py + camY;
    const a = sx / Z, b = sy / (Z * 0.5);
    const wx = (a + b) / 2, wy = (b - a) / 2;
    const TS = (this.hooks.getMapDef() || { tileSize: 32 }).tileSize;
    return { x: Math.floor(wx / TS), y: Math.floor(wy / TS) };
  },

  renderVisibility() {
    this.el.panel.classList.toggle('hidden', !(this.inStudio || this.panelOpen));
    this.el.leaveBtn.classList.toggle('hidden', !this.inStudio);
  },

  onMapChanged(mapDef) {
    this.inStudio = Boolean(mapDef && mapDef.studio);
    if (this.inStudio) {
      this.ownerId = mapDef.studio.ownerId;
      this.ownerName = mapDef.studio.ownerName;
      const me = this.hooks.getMe();
      this.isOwner = Boolean(me && me.id === this.ownerId);
    } else {
      this.placeInstanceId = null;
    }
    this.renderVisibility();
    this.render();
  },

  render() {
    if (!this.el || !this.el.panel) return;
    const esc = this.hooks.esc;
    const me = this.hooks.getMe();
    this.el.title.textContent = this.inStudio
      ? (this.isOwner ? 'Your studio — make it yours.' : `Visiting ${this.ownerName}'s studio.`)
      : 'Your private room — decorate it, invite people over.';
    this.el.furnList.innerHTML = this.furniture.length
      ? `<div class="pkDim">${this.furniture.length} item(s) placed here</div>` +
        this.furniture.map(f => `<div class="qItem">${esc(f.icon || '📦')} ${esc(f.name)} <span class="pkDim">@ ${f.x},${f.y}</span></div>`).join('')
      : '<div class="pkDim">No furniture placed yet.</div>';
    this.el.ownerBox.classList.toggle('hidden', !(this.inStudio && this.isOwner));
    if (this.inStudio && this.isOwner) {
      this.el.catalog.innerHTML = this.catalog.map(c =>
        `<button class="pkSit" data-buy="${esc(c.id)}">${esc(c.icon || '📦')} ${esc(c.name)} — ${c.price}z</button>`).join('') ||
        '<div class="pkDim">Catalog loading…</div>';
      for (const b of this.el.catalog.querySelectorAll('[data-buy]')) {
        b.onclick = () => this.hooks.send({ type: 'studio-buy', itemId: b.dataset.buy });
      }
      this.el.inventory.innerHTML = this.inventory.map(i => {
        const armed = this.placeInstanceId === i.instanceId;
        return `<div class="qItem">${esc(i.icon || '📦')} ${esc(i.name)} ` +
          (i.placed
            ? `<span class="pkDim">@ ${i.x},${i.y}</span> <button data-move="${i.instanceId}">${armed ? 'Click a tile…' : 'Move'}</button> <button data-pickup="${i.instanceId}">Pick up</button>`
            : `<button data-place="${i.instanceId}">${armed ? 'Click a tile…' : 'Place'}</button>`) +
          '</div>';
      }).join('') || '<div class="pkDim">Nothing yet — buy something above.</div>';
      for (const b of this.el.inventory.querySelectorAll('[data-place],[data-move]')) {
        b.onclick = () => {
          this.placeInstanceId = Number(b.dataset.place || b.dataset.move);
          this.hooks.toast('Click a floor tile in your studio to place it.');
          this.render();
        };
      }
      for (const b of this.el.inventory.querySelectorAll('[data-pickup]')) {
        b.onclick = () => this.hooks.send({ type: 'studio-pickup', instanceItemId: Number(b.dataset.pickup) });
      }
      // kick list = other occupants of this studio (from snapshots)
      /* global players */
      const others = (typeof players !== 'undefined' ? players : []).filter(p => !me || p.id !== me.id);
      this.el.kickSel.innerHTML = others.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') ||
        '<option value="">— no visitors —</option>';
    }
  },

  handle(m) {
    switch (m.type) {
      case 'studio-state':
        this.ownerId = m.ownerId;
        this.ownerName = m.ownerName;
        this.isOwner = Boolean(m.isOwner);
        if (m.catalog) this.catalog = m.catalog;
        if (m.inventory) this.inventory = m.inventory;
        if (m.furniture) this.furniture = m.furniture;
        this.renderVisibility();
        this.render();
        break;
      case 'studio-furniture':
        this.furniture = m.furniture || [];
        this.render();
        break;
      case 'snapshot':
        if (this.inStudio && this.isOwner) this.render(); // keep kick list fresh
        break;
      default:
        break;
    }
  },
};

window.SolarionStudio = Studio;

// studio.js loads LAST, so wire it here (same pattern as casino.js).
/* global send, toast, esc, me, mapDef */
(function boot() {
  window.SolarionStudio.attach({
    send: (m) => send(m),
    toast: (t, ms) => toast(t, ms),
    esc: (s) => esc(s),
    getMe: () => me,
    getMapDef: () => mapDef,
  });
})();
