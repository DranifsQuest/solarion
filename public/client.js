'use strict';

/**
 * Solarion client (Phase 1).
 *
 * Renders the world ISOMETRICALLY (Coke Studios / V-ego presentation):
 * server still simulates on a plain top-down grid — projection to the
 * 2:1 isometric view happens only here, at draw time. Avatars are
 * original layered pixel sprites (see sprites.js).
 *
 * Handles: auth, WebSocket snapshots with smoothing, chat + bubbles,
 * gateway load screen, daily-bonus toast, keyboard + touch joystick.
 */

const Sprites = window.SolarionSprites;

// ------------------------------------------------------------------ state
let ws = null;
let token = localStorage.getItem('solarion_token') || null;
let me = null;
let mapDef = null;
let players = [];
let sceneFurniture = []; // Phase 4: placed studio furniture in this scene
const renderPos = new Map(); // id -> { x, y, moving }
const bubbles = new Map();   // id -> { text, until }
let keys = { up: false, down: false, left: false, right: false };
let lastSentKeys = '';
let coins = 0;

// ------------------------------------------------------------------ dom
const $ = (id) => document.getElementById(id);
const cv = $('cv');
const ctx = cv.getContext('2d');

function resize() {
  cv.width = cv.clientWidth * devicePixelRatio;
  cv.height = cv.clientHeight * devicePixelRatio;
}
addEventListener('resize', resize);

function toast(text, ms = 3600) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), ms);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function chatLine(html) {
  const log = $('chatLog');
  const d = document.createElement('div');
  d.innerHTML = html;
  log.appendChild(d);
  while (log.children.length > 80) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

// ------------------------------------------------------------------ auth
let mode = 'login';
function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-register').classList.toggle('active', m === 'register');
  $('authGo').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('authErr').textContent = '';
}
$('tab-login').onclick = () => setMode('login');
$('tab-register').onclick = () => setMode('register');

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Request failed');
  return j;
}

/**
 * Phase 6 routing: after any successful auth, an account with no
 * created character goes to the creation screen; everyone else goes
 * straight into the world.
 */
function enterWorld(avatar) {
  if (avatar && avatar.created === false && window.SolarionCreate) {
    window.SolarionCreate.show(avatar, () => connect());
  } else {
    connect();
  }
}

$('authGo').onclick = async () => {
  $('authErr').textContent = '';
  try {
    const body = { username: $('username').value.trim(), password: $('password').value };
    const r = await api('/api/' + (mode === 'register' ? 'register' : 'login'), body);
    token = r.token;
    localStorage.setItem('solarion_token', token);
    enterWorld(r.avatar);
  } catch (e) {
    $('authErr').textContent = e.message;
  }
};
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('authGo').click(); });

// ------------------------------------------------------------------ net
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    handle(m);
  };
  ws.onclose = (ev) => {
    // 4403 = the server requires a created character first: route
    // back through the creation screen instead of reconnect-looping.
    if (ev && ev.code === 4403) {
      api('/api/me', { token }).then((r) => enterWorld(r.avatar)).catch(() => {});
      return;
    }
    if ($('game').classList.contains('hidden')) return;
    setTimeout(() => { if (!ws || ws.readyState !== 1) connect(); }, 2000);
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function showGame() {
  $('auth').classList.add('hidden');
  $('game').classList.remove('hidden');
  resize();
}

// ------------------------------------------------------------------ transfers
// Phase B: EVERY scene transfer runs a fixed ~3s load screen. The
// server switches the scene immediately and locks movement for the
// same window (transferMs in the map message); the client applies
// the new map at once (hidden behind the screen) and only lifts the
// screen when BOTH the window has elapsed AND the new scene's first
// full snapshot has arrived — the player appears already placed.
let transfer = null; // { startedAt, ms, snapshotSeen }

function beginTransfer(m) {
  transfer = { startedAt: performance.now(), ms: m.transferMs || 3000, snapshotSeen: false };
  keys = { up: false, down: false, left: false, right: false };
  lastSentKeys = JSON.stringify(keys);
  send({ type: 'input', keys });
  $('loadText').textContent = `Traveling to ${m.map.name}…`;
  $('loadScreen').classList.remove('hidden');
  sceneFurniture = m.furniture || (m.studio && m.studio.furniture) || [];
  setMap(m.map, m.you, m.chat || []);
  players = m.players;
  chatLine(`<span class="sys">You arrived in ${esc(m.map.name)}.</span>`);
  // Fallback: never trap the player behind the screen if snapshots stall.
  const mine = transfer;
  setTimeout(() => { if (transfer === mine) finishTransfer(); }, transfer.ms + 5000);
}

function finishTransfer() {
  transfer = null;
  $('loadScreen').classList.add('hidden');
}

setInterval(() => {
  if (transfer && transfer.snapshotSeen && performance.now() - transfer.startedAt >= transfer.ms) {
    finishTransfer();
  }
}, 100);

function setMap(m, you, chat) {
  mapDef = m;
  $('mapName').textContent = m.name;
  if (window.SolarionMixer) window.SolarionMixer.onMapChanged(m);
  if (window.SolarionCasino) window.SolarionCasino.onMapChanged(m);
  if (window.SolarionStudio) window.SolarionStudio.onMapChanged(m);
  renderPos.clear();
  for (const c of chat || []) chatLine(`<span class="who">${esc(c.from)}:</span> ${esc(c.text)}`);
  if (you) {
    me = { ...me, ...you };
    renderPos.set(me.id, { x: you.x, y: you.y, moving: false });
  }
}

function handle(m) {
  if (window.SolarionMixer) window.SolarionMixer.handle(m);
  if (window.SolarionCasino) window.SolarionCasino.handle(m);
  if (window.SolarionStudio) window.SolarionStudio.handle(m);
  switch (m.type) {
    case 'hello': {
      me = { ...m.you };
      coins = m.zcoins;
      $('coins').textContent = coins;
      players = m.players;
      sceneFurniture = m.furniture || [];
      showGame();
      setMap(m.map, m.you, m.chat);
      chatLine(`<span class="sys">Welcome to ${esc(m.map.name)}.</span>`);
      if (m.bonusGranted) toast('☀️ Daily bonus: +100 z coins!');
      break;
    }
    case 'snapshot': {
      players = m.players;
      if (transfer) transfer.snapshotSeen = true;
      for (const p of players) {
        if (!renderPos.has(p.id)) renderPos.set(p.id, { x: p.x, y: p.y, moving: false });
      }
      const alive = new Set(players.map(p => p.id));
      for (const id of [...renderPos.keys()]) if (!alive.has(id)) renderPos.delete(id);
      break;
    }
    case 'map': {
      beginTransfer(m);
      break;
    }
    case 'sit-state': {
      $('sitBtn').textContent = m.seated ? '🧍 Stand' : '🪑 Sit';
      break;
    }
    case 'studio-furniture': {
      sceneFurniture = m.furniture || [];
      break;
    }
    case 'avatar-updated': {
      if (m.you) me = { ...me, ...m.you };
      break;
    }
    case 'chat': {
      chatLine(m.sing
        ? `<span class="who">🎤 ${esc(m.from)}:</span> <span class="sing">${esc(m.text)}</span>`
        : `<span class="who">${esc(m.from)}:</span> ${esc(m.text)}`);
      bubbles.set(m.fromId, { text: m.text, until: Date.now() + 5000 });
      break;
    }
    case 'zcoins': {
      coins = m.zcoins;
      $('coins').textContent = coins;
      break;
    }
    case 'notice':
      chatLine(`<span class="sys">${esc(m.text)}</span>`);
      toast(m.text, 2600);
      break;
  }
}

// ------------------------------------------------------------------ input
const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};
addEventListener('keydown', (e) => {
  if (document.activeElement === $('chatInput')) return;
  if (transfer) return; // input locked behind the load screen
  if (e.code === 'KeyE') { send({ type: 'interact' }); return; }
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
});
addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k) keys[k] = false;
});
setInterval(() => {
  if (transfer) return; // input locked during transfer
  const s = JSON.stringify(keys);
  if (s !== lastSentKeys) { lastSentKeys = s; send({ type: 'input', keys }); }
}, 50);

$('sitBtn').onclick = () => { if (!transfer) send({ type: 'interact' }); };

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('chatInput').value.trim();
  if (v) send({ type: 'chat', text: v });
  $('chatInput').value = '';
  $('chatInput').blur();
});

// touch joystick
(() => {
  const joy = $('joystick'), stick = $('stick');
  let active = false;
  const setFromEvent = (e) => {
    if (transfer) return; // input locked behind the load screen
    const r = joy.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const t = e.touches[0];
    const dx = t.clientX - cx, dy = t.clientY - cy;
    const len = Math.hypot(dx, dy) || 1;
    const cl = Math.min(len, 34);
    stick.style.transform = `translate(${(dx / len) * cl}px, ${(dy / len) * cl}px)`;
    keys.left = dx < -12; keys.right = dx > 12; keys.up = dy < -12; keys.down = dy > 12;
  };
  joy.addEventListener('touchstart', (e) => { active = true; setFromEvent(e); e.preventDefault(); }, { passive: false });
  joy.addEventListener('touchmove', (e) => { if (active) setFromEvent(e); e.preventDefault(); }, { passive: false });
  const end = () => { active = false; stick.style.transform = ''; keys = { up: false, down: false, left: false, right: false }; };
  joy.addEventListener('touchend', end);
  joy.addEventListener('touchcancel', end);
})();

// ------------------------------------------------------------------ iso render
// Projection: world px (x, y) -> screen px. 2:1 diamonds, Coke-style.
const ZOOM = 0.72;
const WALL_H = 20; // screen px of wall extrusion
function proj(x, y) {
  return [(x - y) * ZOOM, (x + y) * ZOOM * 0.5];
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return `rgb(${r},${g},${b})`;
}

function diamond(cx, cy, hw, hh, fill) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function drawTile(ch, tx, ty) {
  const TS = mapDef.tileSize;
  const [cx, cy] = proj((tx + 0.5) * TS, (ty + 0.5) * TS);
  const hw = TS * ZOOM, hh = TS * ZOOM * 0.5;
  if (ch === '.') {
    diamond(cx, cy, hw, hh, (tx + ty) % 2 ? mapDef.floor : mapDef.floorAlt);
    return;
  }
  if (ch === 'C') { // Casino Lounge indoor floor — dark club checkerboard
    const cz = mapDef.casino || { floor: '#3a2350', floorAlt: '#432a5c' };
    diamond(cx, cy, hw, hh, (tx + ty) % 2 ? cz.floor : cz.floorAlt);
    return;
  }
  if (ch === 'W') { // Casino Lounge wall — deep purple frame with gold trim
    ctx.beginPath();
    ctx.moveTo(cx - hw, cy - WALL_H); ctx.lineTo(cx, cy + hh - WALL_H);
    ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy);
    ctx.closePath(); ctx.fillStyle = '#1d102e'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy + hh - WALL_H); ctx.lineTo(cx + hw, cy - WALL_H);
    ctx.lineTo(cx + hw, cy); ctx.lineTo(cx, cy + hh);
    ctx.closePath(); ctx.fillStyle = '#241533'; ctx.fill();
    diamond(cx, cy - WALL_H, hw, hh, '#4a2f6e');
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - WALL_H - hh); ctx.lineTo(cx + hw, cy - WALL_H);
    ctx.lineTo(cx, cy - WALL_H + hh); ctx.lineTo(cx - hw, cy - WALL_H);
    ctx.closePath(); ctx.stroke();
    return;
  }
  if (ch === '%') { // water
    diamond(cx, cy, hw, hh, (tx + ty) % 2 ? '#2f8fb8' : '#2b84ad');
    return;
  }
  // solid block ('#' wall, '|' stall/tree) drawn as an extruded cube
  const top = ch === '|' ? '#a5713a' : shade(mapDef.wall.startsWith('#') ? mapDef.wall : '#22304a', 46);
  const base = ch === '|' ? '#8a5a2b' : mapDef.wall;
  const left = shade(base.startsWith('#') ? base : '#22304a', -14);
  // left face
  ctx.beginPath();
  ctx.moveTo(cx - hw, cy - WALL_H);
  ctx.lineTo(cx, cy + hh - WALL_H);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath(); ctx.fillStyle = left; ctx.fill();
  // right face
  ctx.beginPath();
  ctx.moveTo(cx, cy + hh - WALL_H);
  ctx.lineTo(cx + hw, cy - WALL_H);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.closePath(); ctx.fillStyle = base.startsWith('#') ? base : '#22304a'; ctx.fill();
  // top face
  diamond(cx, cy - WALL_H, hw, hh, top);
}

function draw() {
  requestAnimationFrame(draw);
  if (!mapDef) return;
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#0b0e18';
  ctx.fillRect(0, 0, W, H);

  // Phase B amendment — my own vice haze, rendered client-side from
  // my server-tracked counts: drinks blur the world (progressively),
  // puffs cycle the hue and saturate (the trip). Fallen = fade out.
  {
    const fx = [];
    if (me && me.drinks > 0) fx.push(`blur(${Math.min(2.4, me.drinks * 0.3).toFixed(2)}px)`);
    if (me && me.puffs > 0) {
      fx.push(`hue-rotate(${Math.round((Date.now() / (60 - Math.min(45, me.puffs * 4)) + me.puffs * 40) % 360)}deg)`);
      fx.push(`saturate(${(1 + me.puffs * 0.14).toFixed(2)})`);
    }
    if (me && me.fallen) fx.push('brightness(0.55)');
    cv.style.filter = fx.join(' ');
  }

  // smooth positions + movement flags
  for (const p of players) {
    const rp = renderPos.get(p.id);
    if (!rp) continue;
    const dx = p.x - rp.x, dy = p.y - rp.y;
    rp.moving = Math.abs(dx) + Math.abs(dy) > 1.2;
    rp.x += dx * 0.35;
    rp.y += dy * 0.35;
  }

  const myRp = me ? renderPos.get(me.id) : null;
  const [fcx, fcy] = myRp ? proj(myRp.x, myRp.y) : [0, 0];
  const camX = fcx - W / 2, camY = fcy - H / 2;

  ctx.save();
  ctx.translate(-camX, -camY);

  // floor + blocks in diagonal (painter) order
  const TS = mapDef.tileSize;
  for (let s = 0; s <= mapDef.w + mapDef.h - 2; s++) {
    for (let tx = Math.max(0, s - (mapDef.h - 1)); tx <= Math.min(mapDef.w, s); tx++) {
      const ty = s - tx;
      if (ty < 0 || ty >= mapDef.h || tx >= mapDef.w) continue;
      drawTile(mapDef.rows[ty][tx], tx, ty);
    }
  }

  // stage platform + speakers (speakers pulse while a set is live)
  if (mapDef.stage) {
    const st = mapDef.stage;
    const TS2 = mapDef.tileSize;
    for (let ty = Math.floor(st.y / TS2); ty < Math.ceil((st.y + st.h) / TS2); ty++) {
      for (let tx = Math.floor(st.x / TS2); tx < Math.ceil((st.x + st.w) / TS2); tx++) {
        const [cx2, cy2] = proj((tx + 0.5) * TS2, (ty + 0.5) * TS2);
        diamond(cx2, cy2 - 5, TS2 * ZOOM, TS2 * ZOOM * 0.5, (tx + ty) % 2 ? '#7a5230' : '#835a34');
      }
    }
    const perf = window.SolarionMixer && window.SolarionMixer.perf;
    const live = perf && perf.active;
    const pulse = live ? 1 + Math.abs(Math.sin(Date.now() / 130)) * 0.22 : 1;
    for (const sp of st.speakers) {
      const [sx2, sy2] = proj(sp.x, sp.y);
      ctx.save();
      ctx.translate(sx2, sy2 - 14);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = '#14100c';
      ctx.fillRect(-11, -16, 22, 32);
      ctx.fillStyle = live ? '#ffd23f' : '#4a4038';
      ctx.beginPath(); ctx.arc(0, -6, 6.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0, 8, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  // casino lounge furniture: poker tables, chairs, slot machines,
  // plus the doorway label (same treatment as gateway labels)
  if (mapDef.casino) {
    const cz = mapDef.casino;
    for (const s of cz.slots) {
      const [sx2, sy2] = proj(s.x, s.y);
      ctx.fillStyle = '#171126';
      ctx.fillRect(sx2 - 13, sy2 - 30, 26, 34);
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(sx2 - 10, sy2 - 27, 20, 13);
      ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillStyle = '#171126';
      ctx.fillText('7·7·7', sx2, sy2 - 16);
      ctx.fillStyle = '#ff5d8f';
      ctx.beginPath(); ctx.arc(sx2, sy2 - 32, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    for (const t of cz.tables) {
      for (const ch2 of t.chairs) {
        const [chx, chy] = proj(ch2.x, ch2.y);
        ctx.beginPath(); ctx.ellipse(chx, chy, 10, 5.5, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#6e1f2a'; ctx.fill();
        ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 1; ctx.stroke();
      }
      const [tx2, ty2] = proj(t.x, t.y);
      ctx.beginPath(); ctx.ellipse(tx2, ty2, 44, 23, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#7a5a2b'; ctx.fill();
      ctx.beginPath(); ctx.ellipse(tx2, ty2 - 2, 38, 19, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#14663c'; ctx.fill();
      ctx.font = '13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('♠ ♥ ♦ ♣', tx2, ty2 + 3);
    }
    // Phase B amendment — the bar: counter frontage + the bartender
    // NPC behind it (a fixed-look layered sprite + name).
    if (cz.bartender) {
      const bt = cz.bartender;
      const [bx, by] = proj(bt.x, bt.y);
      const bspr = Sprites.makeSprite(bt.look, 'down');
      ctx.drawImage(bspr, bx - bspr.width / 2, by - bspr.height + 4);
      ctx.font = 'bold 11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd9a0';
      ctx.strokeStyle = 'rgba(0,0,0,.65)';
      ctx.lineWidth = 3;
      ctx.strokeText(`🍸 ${bt.name}`, bx, by - bspr.height - 4);
      ctx.fillText(`🍸 ${bt.name}`, bx, by - bspr.height - 4);
    }
    // (the way out is drawn by the generic doors pass below)
    // tell the casino panel whether we're inside the lounge
    if (window.SolarionCasino && myRp) window.SolarionCasino.updatePresence(myRp.x, myRp.y, mapDef);
  }

  // hookah stations (Phase B amendment): a brass hookah on a low
  // table with lazy smoke curls, one per station.
  for (const h of mapDef.hookahs || []) {
    const [hx, hy] = proj(h.x, h.y);
    diamond(hx, hy, 20, 9, '#5d4037');
    ctx.fillStyle = '#c99700';
    ctx.beginPath(); ctx.ellipse(hx, hy - 8, 5, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(hx - 1, hy - 20, 2, 12);
    ctx.fillStyle = '#8e24aa';
    ctx.beginPath(); ctx.arc(hx, hy - 23, 3.4, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 3; i++) {
      const ph = ((Date.now() / 1600) + i * 0.37 + (h.x % 5) * 0.11) % 1;
      ctx.beginPath();
      ctx.arc(hx + Math.sin(ph * 5 + h.y) * 5, hy - 28 - ph * 22, 2 + ph * 3.4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(216,196,255,${0.4 * (1 - ph)})`;
      ctx.fill();
    }
  }

  // studio furniture (Phase 4): simple colored iso blocks with the
  // item's icon glyph — drawn from the server's placed-furniture list
  // for THIS scene (studio instance) only.
  for (const f of sceneFurniture) {
    const TS3 = mapDef.tileSize;
    const [fx, fy] = proj((f.x + 0.5) * TS3, (f.y + 0.5) * TS3);
    ctx.save();
    if (f.rot) { /* rotation is data in v1; glyph orientation is fixed */ }
    diamond(fx, fy - 3, TS3 * ZOOM * 0.92, TS3 * ZOOM * 0.46, f.color || '#888');
    ctx.font = '15px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(f.icon || '📦', fx, fy - 2);
    ctx.restore();
  }

  // sittable furniture (Phase B): benches, chairs, sofas, café
  // tables baked into the map data. The avatar sprite carries the
  // seated pose; these props are what everyone sees them sit ON.
  for (const s of mapDef.seats || []) {
    const [sx3, sy3] = proj(s.x, s.y);
    if (s.kind === 'bench') {
      diamond(sx3, sy3, 30, 10, '#8a5a2b');
      diamond(sx3, sy3 - 5, 30, 6, '#a5713a');
    } else if (s.kind === 'sofa') {
      diamond(sx3, sy3, 34, 13, '#7a3b4f');
      diamond(sx3, sy3 - 5, 34, 9, '#93536b');
    } else if (s.kind === 'cafe') {
      diamond(sx3, sy3, 11, 5.5, '#6e4a26'); // the chair
      const off = { down: [0, 15], up: [0, -15], left: [-17, 7], right: [17, 7] }[s.dir] || [0, 15];
      ctx.beginPath(); ctx.ellipse(sx3 + off[0], sy3 + off[1], 11, 5.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#e8e4da'; ctx.fill();
      ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 1; ctx.stroke();
    } else { // chair
      diamond(sx3, sy3, 12, 6, '#6e4a26');
      diamond(sx3, sy3 - 4, 12, 5, '#8a5a2b');
    }
  }

  // gateway pads
  for (const g of mapDef.gateways) {
    const [cx, cy] = proj(g.x + g.w / 2, g.y + g.h / 2);
    diamond(cx, cy, g.w * ZOOM * 0.72, g.w * ZOOM * 0.36, g.active ? '#ffd23f' : '#59637a');
    ctx.font = 'bold 13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = g.active ? '#1a2238' : '#dfe6f5';
    ctx.fillText(g.active ? '⛩' : '🔒', cx, cy + 4);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = 3;
    const label = g.label + (g.active ? '' : ' (soon)');
    ctx.strokeText(label, cx, cy - g.w * ZOOM * 0.36 - 6);
    ctx.fillText(label, cx, cy - g.w * ZOOM * 0.36 - 6);
  }

  // doors (Phase B): interior sub-areas — the Casino Lounge door in
  // Solstice Bay, the Gateway Café, and the doors back out of both.
  for (const d of mapDef.doors || []) {
    const [cx, cy] = proj(d.x + d.w / 2, d.y + d.h / 2);
    const hw2 = Math.max(d.w, 32) * ZOOM * 0.62;
    diamond(cx, cy, hw2, hw2 * 0.5, '#8a5a2b');
    diamond(cx, cy - 2, hw2 * 0.78, hw2 * 0.39, '#c89b62');
    ctx.font = 'bold 13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff8ec';
    ctx.fillText('🚪', cx, cy + 3);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = 3;
    ctx.strokeText(d.label, cx, cy - hw2 * 0.5 - 8);
    ctx.fillText(d.label, cx, cy - hw2 * 0.5 - 8);
  }

  // entities, depth-sorted by x+y
  const now = Date.now();
  const sorted = [...players].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  for (const p of sorted) {
    const rp = renderPos.get(p.id);
    if (!rp) continue;
    const [sx, sy] = proj(rp.x, rp.y);
    const bob = rp.moving ? Math.abs(Math.sin(now / 110 + p.id)) * 3 : 0;

    // soft ground shadow
    ctx.beginPath();
    ctx.ellipse(sx, sy, 13, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.fill();

    const dirKey = p.dir === 'up' ? 'up' : p.dir === 'down' ? 'down' : 'side';
    // Phase 6: the snapshot player IS the full appearance object —
    // pass it straight to the sprite renderer. Phase B: seated
    // players get the seated leg variant and sit a touch lower.
    const spr = Sprites.makeSprite(p, dirKey, p.seated ? { seated: true } : undefined);
    const sw = spr.width, sh = spr.height;
    // Phase B amendment — drunk sway (render-side mirror of the
    // server wobble) and the passed-out fallen pose.
    const sway = (!p.fallen && p.drinks >= 2)
      ? Math.sin(now / 280 + p.id * 2.1) * Math.min(5, p.drinks * 0.7)
      : 0;
    ctx.save();
    if (p.fallen) {
      ctx.translate(sx, sy - 3);
      ctx.rotate(-1.45); // flat on the floor, visible to everyone
      ctx.drawImage(spr, -sw / 2, -sh + 8);
    } else {
      ctx.translate(sx + sway, sy - bob + (p.seated ? 3 : 0));
      if (p.dir === 'right') ctx.scale(-1, 1); // side sprite faces left natively; flip for right
      ctx.drawImage(spr, -sw / 2, -sh + 4);
    }
    ctx.restore();

    // performer holds the mic (soul doc §9.3)
    if (p.performing) {
      ctx.font = '15px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('🎤', sx + 13, sy - 12 - bob);
    }

    // Phase B amendment — drink bubbles float up around drinkers
    // (everyone sees them), and hippies get their peace sign.
    if (p.drinks > 0 && !p.fallen) {
      for (let i = 0; i < 3; i++) {
        const ph = ((now / 950) + i * 0.33 + (p.id % 7) * 0.13) % 1;
        const bx = sx + Math.sin(ph * 4 + p.id + i * 2) * 9;
        const by = sy - sh - 2 - ph * 26;
        ctx.beginPath();
        ctx.arc(bx, by, 1.8 + ph * 2.6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(180,220,255,${0.75 * (1 - ph * 0.6)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (p.hippy) {
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('☮️', sx, sy - sh - 20 - bob);
    }

    // name
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.lineWidth = 3;
    ctx.strokeText(p.name, sx, sy - sh - 6 - bob);
    ctx.fillText(p.name, sx, sy - sh - 6 - bob);

    // speech bubble
    const b = bubbles.get(p.id);
    if (b && b.until > now) {
      ctx.font = '12px system-ui';
      const text = b.text.slice(0, 30);
      const w = Math.min(ctx.measureText(text).width + 16, 200);
      const bx = sx - w / 2, by = sy - sh - 40 - bob;
      ctx.fillStyle = 'rgba(255,255,255,.96)';
      ctx.beginPath();
      ctx.roundRect(bx, by, w, 24, 8);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sx - 5, by + 24); ctx.lineTo(sx + 5, by + 24); ctx.lineTo(sx, by + 31);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1a2238';
      ctx.fillText(text, sx, by + 16);
    }
  }
  ctx.restore();
}
requestAnimationFrame(draw);

// wire the Phase 2 mixer/stage module into this client's transport
if (window.SolarionMixer) {
  window.SolarionMixer.attach({
    send,
    toast,
    esc,
    getMe: () => me,
    getMapDef: () => mapDef,
  });
}

// resume an existing session on load
if (token) {
  api('/api/me', { token })
    .then((r) => enterWorld(r.avatar))
    .catch(() => { localStorage.removeItem('solarion_token'); token = null; });
}
setMode('login');
