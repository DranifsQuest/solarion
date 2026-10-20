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
 * Look panel (Phase 6): the full creation axis set, built by the
 * shared looks.js editor from GET /api/appearance — the same lists
 * the creation screen uses and the server validates against. Sent as
 * one {type:'avatar-update'}; the room sees the change via snapshots.
 */

const Studio = {
  catalog: [],
  inventory: [],
  furniture: [],
  devices: new Map(),      // Phase 8: instanceId -> resolved device payload
  channels: [],            // Phase 8: TV channel guide (server-owned)
  pendingInvite: null,     // Phase 8: { ownerId, fromName } awaiting an answer
  inviteTimer: null,
  radioKey: null,          // Phase 8: track identity the radio engine is playing
  radioTimer: null,
  radioNext: 0,
  radioUnitDur: 0,
  radioSchedule: null,
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
      devicesBox: $('studioDevices'), deviceList: $('deviceList'),
      inviteName: $('inviteName'),
      invitePrompt: $('invitePrompt'), inviteText: $('inviteText'),
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
    // Phase 8: invite any online player to YOUR room, from anywhere.
    $('inviteGo').onclick = () => {
      const name = this.el.inviteName.value.trim();
      if (name) {
        this.hooks.send({ type: 'studio-invite', username: name });
        this.el.inviteName.value = '';
      }
    };
    $('inviteAccept').onclick = () => this.answerInvite(true);
    $('inviteDecline').onclick = () => this.answerInvite(false);
    this.el.leaveBtn.onclick = () => this.hooks.send({ type: 'leave-studio' });
    $('kickBtn').onclick = () => {
      const id = Number(this.el.kickSel.value);
      if (id) this.hooks.send({ type: 'studio-kick', userId: id });
    };
    // Look panel (Phase 6: shared looks.js editor, full axis set)
    this.lookState = null;
    $('lookBtn').onclick = async () => {
      const opening = this.el.lookPanel.classList.contains('hidden');
      this.el.lookPanel.classList.toggle('hidden', !opening);
      if (!opening) return;
      const me = this.hooks.getMe();
      if (!me || !window.SolarionLooks) return;
      try {
        const options = await window.SolarionLooks.loadOptions();
        const state = { ...options.defaults[me.gender === 'F' ? 'F' : 'M'] };
        for (const k of Object.keys(state)) if (me[k] !== undefined) state[k] = me[k];
        this.lookState = state;
        const draw = () => window.SolarionLooks.drawPreview($('lookPreview'), state, 'down', 3.1, false);
        window.SolarionLooks.createEditor($('lookEditor'), options, state, draw);
        draw();
        $('lookErr').textContent = '';
      } catch (e) {
        $('lookErr').textContent = 'Could not load look options.';
      }
    };
    $('lookClose').onclick = () => this.el.lookPanel.classList.add('hidden');
    $('lookApply').onclick = () => {
      if (!this.lookState) return;
      this.hooks.send({ type: 'avatar-update', ...this.lookState });
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
      // Phase 9: the entry 'map' message is handled BEFORE the new
      // scene is applied (inStudio was still stale), so re-run the
      // radio sync now that the flag is right — a radio already
      // playing in this room must sound for the person who just
      // walked in, owner included.
      this.syncRadio();
    } else {
      this.placeInstanceId = null;
      this.devices.clear();
      this.stopRadioAudio();
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
    this.renderDevices();
  },

  // ------------------------------------------------------------ devices
  // Phase 8: TVs and radios placed in this room. Controls are shown
  // to EVERYONE in the room (owner or visitor — server-enforced the
  // same way); the state itself is server-owned and arrives via
  // studio-state / home-device messages.

  renderDevices() {
    if (!this.el || !this.el.devicesBox) return;
    const esc = this.hooks.esc;
    const devFurniture = this.inStudio
      ? this.furniture.filter(f => f.type === 'tv' || f.type === 'radio')
      : [];
    this.el.devicesBox.classList.toggle('hidden', devFurniture.length === 0);
    if (!devFurniture.length) { this.el.deviceList.innerHTML = ''; return; }
    this.el.deviceList.innerHTML = devFurniture.map(f => {
      const d = this.devices.get(f.instanceId);
      if (!d) return `<div class="qItem">${esc(f.icon || '📦')} ${esc(f.name)} <span class="pkDim">…</span></div>`;
      if (d.kind === 'tv') {
        return `<div class="qItem">📺 ${esc(f.name)} — ${d.on
          ? `<b>ON</b> · Ch ${d.channel + 1}: ${esc(d.channelName)}`
          : '<span class="pkDim">off</span>'}
          <button data-dev="${f.instanceId}" data-act="power">${d.on ? '⏻ Off' : '⏻ On'}</button>
          <button data-dev="${f.instanceId}" data-act="channel-prev">◀ Ch</button>
          <button data-dev="${f.instanceId}" data-act="channel-next">Ch ▶</button></div>`;
      }
      const trackName = d.track ? d.track.name : '(nothing)';
      const srcLabel = d.source === 'mixes' ? `🎧 ${esc(this.ownerName || 'Owner')}'s mixes` : '📚 Loop library';
      return `<div class="qItem">📻 ${esc(f.name)} — ${d.playing ? `<b>▶ Playing</b>` : '<span class="pkDim">stopped</span>'}
        <br><span class="pkDim">${srcLabel}: ${esc(trackName)}</span>
        <button data-dev="${f.instanceId}" data-act="prev">⏮</button>
        <button data-dev="${f.instanceId}" data-act="${d.playing ? 'stop' : 'play'}">${d.playing ? '⏸ Stop' : '▶ Play'}</button>
        <button data-dev="${f.instanceId}" data-act="next">⏭</button>
        <button data-dev="${f.instanceId}" data-act="source">🔀 ${d.source === 'mixes' ? 'Loops' : 'Mixes'}</button></div>`;
    }).join('');
    for (const b of this.el.deviceList.querySelectorAll('[data-dev]')) {
      b.onclick = () => this.hooks.send({
        type: 'home-device', instanceId: Number(b.dataset.dev), action: b.dataset.act,
      });
    }
  },

  setDevices(list) {
    this.devices.clear();
    for (const d of list || []) this.devices.set(d.instanceId, d);
    this.renderDevices();
    this.syncRadio();
  },

  // ------------------------------------------------------------ radio
  // Phase 8: room radio playback. The server owns state; clients
  // render audio locally over the SAME Web Audio engine the stage
  // uses (AE in mixer.js). Play starts are server-timestamped
  // (startedAt, incl. a 1.2s sync delay), so everyone in the room
  // schedules the same track from the same instant; a late joiner
  // aligns to the next loop/mix pass on that grid — approximate to
  // within one pass, exact thereafter. If several radios play at
  // once, the client sounds only the most recently started one.

  ae() {
    try { return (typeof AE !== 'undefined') ? AE : null; } catch (e) { return null; }
  },

  stopRadioAudio() {
    if (this.radioTimer) { clearInterval(this.radioTimer); this.radioTimer = null; }
    this.radioKey = null;
    this.radioSchedule = null;
    const ae = this.ae();
    if (ae) { try { ae.stop(); } catch (e) { /* engine idle */ } }
  },

  syncRadio() {
    if (!this.inStudio) { this.stopRadioAudio(); return; }
    let best = null;
    for (const d of this.devices.values()) {
      if (d.kind === 'radio' && d.playing && d.track) {
        if (!best || d.startedAt > best.startedAt) best = d;
      }
    }
    if (!best) { this.stopRadioAudio(); return; }
    const key = `${best.instanceId}|${best.source}|${best.track.kind === 'mix' ? best.track.mixId : best.track.loopId}|${best.startedAt}`;
    if (this.radioKey === key) return; // already sounding this exact play
    this.startRadio(best, key);
  },

  startRadio(dev, key) {
    const ae = this.ae();
    const mixer = window.SolarionMixer;
    if (!ae || !mixer || !ae.ensure()) { this.radioKey = null; return; }
    ae.stop();
    if (this.radioTimer) { clearInterval(this.radioTimer); this.radioTimer = null; }
    this.radioKey = key;
    const startedAtCtx = ae.ctx.currentTime + Math.max(0, (dev.startedAt - Date.now()) / 1000);
    let schedule = null;
    let unitDur = 0;
    if (dev.track.kind === 'loop') {
      const loop = mixer.loopsById.get(dev.track.loopId);
      if (!loop) { this.radioKey = null; return; }
      const RADIO_BPM = 112; // loops are bpm-agnostic patterns; radio tempo
      unitDur = loop.bars * (60 / RADIO_BPM) * 4;
      schedule = (t) => ae.playLoop(loop, t, RADIO_BPM);
    } else {
      const mix = dev.track.mix;
      if (!mix) { this.radioKey = null; return; }
      unitDur = mix.bars * 4 * (60 / mix.bpm);
      schedule = (t) => ae.playMix(mix, t);
    }
    // First pass boundary at/after now, on the startedAt grid.
    let next = startedAtCtx;
    const nowC = ae.ctx.currentTime;
    if (next < nowC - 0.05) next += Math.ceil((nowC - next) / unitDur) * unitDur;
    this.radioNext = next;
    this.radioUnitDur = unitDur;
    this.radioSchedule = schedule;
    const pump = () => {
      const a = this.ae();
      if (!a || !a.ctx || !this.radioSchedule) return;
      while (this.radioNext < a.ctx.currentTime + 1.2) {
        this.radioSchedule(this.radioNext);
        this.radioNext += this.radioUnitDur;
      }
    };
    pump();
    this.radioTimer = setInterval(pump, 400);
  },

  // ------------------------------------------------------------ invites

  answerInvite(accept) {
    const inv = this.pendingInvite;
    this.pendingInvite = null;
    if (this.inviteTimer) { clearTimeout(this.inviteTimer); this.inviteTimer = null; }
    this.el.invitePrompt.classList.add('hidden');
    if (inv) this.hooks.send({ type: 'studio-invite-response', ownerId: inv.ownerId, accept });
  },

  handle(m) {
    switch (m.type) {
      case 'avatar-updated':
        this.hooks.toast('🎨 Look saved — the new you is live.');
        this.el.lookPanel.classList.add('hidden');
        break;
      case 'map':
        // Phase 8: studio entry payloads carry device states.
        if (m.devices) this.setDevices(m.devices);
        break;
      case 'studio-state':
        this.ownerId = m.ownerId;
        this.ownerName = m.ownerName;
        this.isOwner = Boolean(m.isOwner);
        if (m.catalog) this.catalog = m.catalog;
        if (m.inventory) this.inventory = m.inventory;
        if (m.furniture) this.furniture = m.furniture;
        if (m.channels) this.channels = m.channels;
        if (m.devices) this.setDevices(m.devices);
        this.renderVisibility();
        this.render();
        break;
      case 'studio-furniture':
        this.furniture = m.furniture || [];
        // A picked-up device disappears from the furniture list —
        // drop its stale state (the server also broadcasts a null).
        for (const id of [...this.devices.keys()]) {
          if (!this.furniture.some(f => f.instanceId === id)) this.devices.delete(id);
        }
        this.renderDevices();
        this.syncRadio();
        this.render();
        break;
      case 'home-device':
        if (m.device) this.devices.set(m.device.instanceId, m.device);
        else if (Number.isInteger(m.instanceId)) this.devices.delete(m.instanceId);
        this.renderDevices();
        this.syncRadio();
        break;
      case 'studio-invite': {
        this.pendingInvite = { ownerId: m.ownerId, fromName: m.fromName };
        this.el.inviteText.textContent = `📩 ${m.fromName} invites you to their studio!`;
        this.el.invitePrompt.classList.remove('hidden');
        if (this.inviteTimer) clearTimeout(this.inviteTimer);
        const mine = this.pendingInvite;
        this.inviteTimer = setTimeout(() => {
          if (this.pendingInvite === mine) {
            this.pendingInvite = null;
            this.el.invitePrompt.classList.add('hidden');
          }
        }, (m.expiresInSec || 60) * 1000);
        break;
      }
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
