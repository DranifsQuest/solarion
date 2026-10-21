'use strict';

/**
 * Solarion — social client (Phase 9): the Navigator, the friends
 * panel, profile cards, and the emote bar.
 *
 * Navigator (🧭): every public place with live occupant counts and
 * a 6-dot fullness scale (soul doc §2), which friends are where, and
 * the open homes of people online. Travel rides the server's scene
 * switch — the 3s load screen included.
 *
 * Friends (👥): requests (with accept/decline), the accepted list
 * with live locations, and Join — travel to a friend's scene.
 *
 * Profiles: clicking a player in the world fetches their card —
 * look preview, their mix titles, and wired actions (Visit Home /
 * Invite / Add Friend / Join).
 *
 * Emotes: the floating bar sends wave/dance/laugh/thumbs-up; the
 * poses render from the snapshot's emote field in client.js.
 */

const Social = {
  friends: { friends: [], incoming: [], outgoing: [] },
  nav: null,
  profile: null,

  attach(hooks) {
    this.hooks = hooks; // { send, toast, esc, getMe }
    this.buildDom();
  },

  buildDom() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      navPanel: $('navPanel'), navList: $('navList'), navHomes: $('navHomes'),
      friendsPanel: $('friendsPanel'), friendList: $('friendList'),
      friendIncoming: $('friendIncoming'), friendAdd: $('friendAddName'),
      profileCard: $('profileCard'), profileBody: $('profileBody'),
    };
    $('navBtn').onclick = () => {
      const opening = this.el.navPanel.classList.contains('hidden');
      this.el.navPanel.classList.toggle('hidden', !opening);
      this.el.friendsPanel.classList.add('hidden');
      if (opening) this.hooks.send({ type: 'navigator' });
    };
    $('friendsBtn').onclick = () => {
      const opening = this.el.friendsPanel.classList.contains('hidden');
      this.el.friendsPanel.classList.toggle('hidden', !opening);
      this.el.navPanel.classList.add('hidden');
      if (opening) this.hooks.send({ type: 'friend-list' });
    };
    $('friendAddGo').onclick = () => {
      const name = this.el.friendAdd.value.trim();
      if (name) {
        this.hooks.send({ type: 'friend-request', username: name });
        this.el.friendAdd.value = '';
      }
    };
    for (const b of document.querySelectorAll('#emoteBar button')) {
      b.onclick = () => this.hooks.send({ type: 'emote', emote: b.dataset.emote });
    }
  },

  // ---------------------------------------------------------- navigator

  renderNav() {
    if (!this.nav) return;
    const esc = this.hooks.esc;
    const dots = (n) => '●'.repeat(n) + '○'.repeat(6 - n);
    this.el.navList.innerHTML = this.nav.places.map(pl => `
      <div class="navRow">
        <span>${pl.kind === 'casino' ? '🎰' : pl.kind === 'hub' ? '⛩️' : pl.kind === 'interior' ? '🚪' : '🏙️'}</span>
        <span><b>${esc(pl.name)}</b><br><span class="fullDots">${dots(pl.fullness)}</span>
        <span class="pkDim">${pl.count} here${pl.friends.length ? ` · 👥 ${pl.friends.map(esc).join(', ')}` : ''}</span></span>
        ${pl.here ? '<span class="pkDim">you are here</span>' : `<button data-nav="${esc(pl.id)}">Travel</button>`}
      </div>`).join('');
    for (const b of this.el.navList.querySelectorAll('[data-nav]')) {
      b.onclick = () => {
        this.hooks.send({ type: 'navigate', mapId: b.dataset.nav });
        this.el.navPanel.classList.add('hidden');
      };
    }
    this.el.navHomes.innerHTML = this.nav.homes.length ? this.nav.homes.map(h => `
      <div class="navRow">
        <span>🏠</span>
        <span><b>${esc(h.ownerName)}'s Home</b><br><span class="pkDim">${h.count} inside${h.mine ? ' · yours' : ''}</span></span>
        ${h.here ? '<span class="pkDim">you are here</span>' : `<button data-home="${h.ownerId}">Enter</button>`}
      </div>`).join('') : '<div class="pkDim">No open homes right now.</div>';
    for (const b of this.el.navHomes.querySelectorAll('[data-home]')) {
      b.onclick = () => {
        this.hooks.send({ type: 'navigate-home', ownerId: Number(b.dataset.home) });
        this.el.navPanel.classList.add('hidden');
      };
    }
  },

  // ---------------------------------------------------------- friends

  renderFriends() {
    const esc = this.hooks.esc;
    const f = this.friends;
    this.el.friendIncoming.innerHTML = f.incoming.length ? f.incoming.map(u => `
      <div class="friendRow"><span>📩 <b>${esc(u.name)}</b> wants to be friends</span>
        <button data-accept="${u.id}">Accept</button><button data-decline="${u.id}">Decline</button></div>`).join('')
      : '';
    for (const b of this.el.friendIncoming.querySelectorAll('[data-accept]')) {
      b.onclick = () => this.hooks.send({ type: 'friend-respond', userId: Number(b.dataset.accept), accept: true });
    }
    for (const b of this.el.friendIncoming.querySelectorAll('[data-decline]')) {
      b.onclick = () => this.hooks.send({ type: 'friend-respond', userId: Number(b.dataset.decline), accept: false });
    }
    const rows = f.friends.map(u => `
      <div class="friendRow">
        <span>${u.online ? '🟢' : '⚪'} <b>${esc(u.name)}</b>${u.online ? `<br><span class="pkDim">${esc(u.mapName || '')}</span>` : ''}</span>
        ${u.online ? `<button data-join="${u.id}">Join</button>` : ''}
        <button data-remove="${u.id}">Remove</button>
      </div>`).join('');
    const out = f.outgoing.map(u => `
      <div class="friendRow"><span>⏳ <b>${esc(u.name)}</b> <span class="pkDim">request sent</span></span></div>`).join('');
    this.el.friendList.innerHTML = (rows + out) || '<div class="pkDim">No friends yet — add someone by username!</div>';
    for (const b of this.el.friendList.querySelectorAll('[data-join]')) {
      b.onclick = () => {
        this.hooks.send({ type: 'join-friend', userId: Number(b.dataset.join) });
        this.el.friendsPanel.classList.add('hidden');
      };
    }
    for (const b of this.el.friendList.querySelectorAll('[data-remove]')) {
      b.onclick = () => this.hooks.send({ type: 'friend-remove', userId: Number(b.dataset.remove) });
    }
  },

  // ---------------------------------------------------------- profiles

  /** World click hit-test: a player near the point → profile. */
  tryProfileAt(w) {
    const me = this.hooks.getMe();
    /* global players, renderPos */
    const list = (typeof players !== 'undefined') ? players : [];
    let best = null, bestD = 34;
    for (const p of list) {
      if (me && p.id === me.id) continue;
      if (p.npc) continue; // locals are scenery, not profiles
      const rp = (typeof renderPos !== 'undefined') ? renderPos.get(p.id) : null;
      const px = rp ? rp.x : p.x, py = rp ? rp.y : p.y;
      const d = Math.hypot(px - w.x, py - w.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return false;
    this.hooks.send({ type: 'profile', userId: best.id });
    return true;
  },

  renderProfile() {
    const pr = this.profile;
    if (!pr) { this.el.profileCard.classList.add('hidden'); return; }
    const esc = this.hooks.esc;
    const me = this.hooks.getMe();
    const isSelf = me && me.id === pr.id;
    let actions = '';
    if (!isSelf) {
      if (pr.friendStatus === 'friends') actions += `<button data-act="join">📍 Join</button>`;
      else if (pr.friendStatus === 'none') actions += `<button data-act="friend">👥 Add Friend</button>`;
      else if (pr.friendStatus === 'pending-in') actions += `<button data-act="accept">🤝 Accept Request</button>`;
      else if (pr.friendStatus === 'pending-out') actions += `<span class="pkDim">request sent</span>`;
      actions += `<button data-act="visit">🏠 Visit Home</button>`;
      actions += `<button data-act="invite">📩 Invite</button>`;
    }
    this.el.profileBody.innerHTML = `
      <canvas id="profileCanvas" width="120" height="125"></canvas>
      <div style="font-size:17px;font-weight:800">${esc(pr.name)}</div>
      <div class="pkDim">${pr.online ? `🟢 in ${esc(pr.mapName || '')}` : '⚪ offline'}${pr.homeLocked ? ' · 🔒 home locked' : ''}</div>
      <div style="margin-top:6px;text-align:left">
        <div class="pkDim">🎵 Their mixes</div>
        ${pr.mixes.length ? pr.mixes.map(m => `<div class="qItem">💿 ${esc(m.name)}</div>`).join('') : '<div class="pkDim">No saved mixes yet.</div>'}
      </div>
      <div class="pfRow">${actions}<button data-act="close">Close</button></div>`;
    this.el.profileCard.classList.remove('hidden');
    const spr = window.SolarionSprites.makeSprite(pr.look, 'down');
    const c = document.getElementById('profileCanvas');
    const cx2 = c.getContext('2d');
    cx2.clearRect(0, 0, c.width, c.height);
    cx2.imageSmoothingEnabled = false;
    const scale = Math.min((c.width - 10) / spr.width, (c.height - 10) / spr.height);
    cx2.drawImage(spr, (c.width - spr.width * scale) / 2, (c.height - spr.height * scale) / 2, spr.width * scale, spr.height * scale);
    for (const b of this.el.profileBody.querySelectorAll('[data-act]')) {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'close') { this.el.profileCard.classList.add('hidden'); return; }
        if (act === 'friend') this.hooks.send({ type: 'friend-request', userId: pr.id });
        if (act === 'accept') this.hooks.send({ type: 'friend-respond', userId: pr.id, accept: true });
        if (act === 'join') { this.hooks.send({ type: 'join-friend', userId: pr.id }); this.el.profileCard.classList.add('hidden'); }
        if (act === 'visit') { this.hooks.send({ type: 'enter-studio', owner: pr.username }); this.el.profileCard.classList.add('hidden'); }
        if (act === 'invite') this.hooks.send({ type: 'studio-invite', username: pr.username });
      };
    }
  },

  // ---------------------------------------------------------- messages

  handle(m) {
    switch (m.type) {
      case 'friends':
        this.friends = { friends: m.friends || [], incoming: m.incoming || [], outgoing: m.outgoing || [] };
        this.renderFriends();
        break;
      case 'friend-request':
        this.hooks.toast(`👥 ${m.fromName} sent you a friend request!`, 5000);
        this.hooks.send({ type: 'friend-list' });
        break;
      case 'navigator':
        this.nav = m;
        this.renderNav();
        break;
      case 'profile':
        this.profile = m.profile;
        this.renderProfile();
        break;
      default:
        break;
    }
  },
};

window.SolarionSocial = Social;

// social.js loads last; wire it here (same pattern as studio.js).
/* global send, toast, esc, me */
(function boot() {
  window.SolarionSocial.attach({
    send: (m) => send(m),
    toast: (t, ms) => toast(t, ms),
    esc: (s) => esc(s),
    getMe: () => me,
  });
})();
