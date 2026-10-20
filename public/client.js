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
  $('avatarForm').classList.toggle('show', m === 'register');
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

$('authGo').onclick = async () => {
  $('authErr').textContent = '';
  try {
    const body = { username: $('username').value.trim(), password: $('password').value };
    if (mode === 'register') {
      body.shirt = $('shirtColor').value;
      body.pants = $('pantsColor').value;
      body.hair_color = $('hairColor').value;
      body.hair_style = $('hairStyle').value;
      const skin = document.querySelector('input[name=skin]:checked');
      body.skin_tone = skin ? skin.value : '#f1c27d';
    }
    const r = await api('/api/' + (mode === 'register' ? 'register' : 'login'), body);
    token = r.token;
    localStorage.setItem('solarion_token', token);
    connect();
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
  ws.onclose = () => {
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

function setMap(m, you, chat) {
  mapDef = m;
  $('mapName').textContent = m.name;
  renderPos.clear();
  for (const c of chat || []) chatLine(`<span class="who">${esc(c.from)}:</span> ${esc(c.text)}`);
  if (you) {
    me = { ...me, ...you };
    renderPos.set(me.id, { x: you.x, y: you.y, moving: false });
  }
}

function handle(m) {
  switch (m.type) {
    case 'hello': {
      me = { ...m.you };
      coins = m.zcoins;
      $('coins').textContent = coins;
      players = m.players;
      showGame();
      setMap(m.map, m.you, m.chat);
      chatLine(`<span class="sys">Welcome to ${esc(m.map.name)}.</span>`);
      if (m.bonusGranted) toast('☀️ Daily bonus: +100 z coins!');
      break;
    }
    case 'snapshot': {
      players = m.players;
      for (const p of players) {
        if (!renderPos.has(p.id)) renderPos.set(p.id, { x: p.x, y: p.y, moving: false });
      }
      const alive = new Set(players.map(p => p.id));
      for (const id of [...renderPos.keys()]) if (!alive.has(id)) renderPos.delete(id);
      break;
    }
    case 'map': {
      $('loadText').textContent = `Traveling to ${m.map.name}…`;
      $('loadScreen').classList.remove('hidden');
      setTimeout(() => {
        setMap(m.map, m.you, m.chat || []);
        players = m.players;
        chatLine(`<span class="sys">You arrived in ${esc(m.map.name)}.</span>`);
        $('loadScreen').classList.add('hidden');
      }, 650);
      break;
    }
    case 'chat': {
      chatLine(`<span class="who">${esc(m.from)}:</span> ${esc(m.text)}`);
      bubbles.set(m.fromId, { text: m.text, until: Date.now() + 5000 });
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
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
});
addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k) keys[k] = false;
});
setInterval(() => {
  const s = JSON.stringify(keys);
  if (s !== lastSentKeys) { lastSentKeys = s; send({ type: 'input', keys }); }
}, 50);

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
    const spr = Sprites.makeSprite({ skin_tone: p.skin_tone, hair_style: p.hair_style, hair_color: p.hair_color, shirt: p.body_color, pants: p.accent_color }, dirKey);
    const sw = spr.width, sh = spr.height;
    ctx.save();
    ctx.translate(sx, sy - bob);
    if (p.dir === 'right') ctx.scale(-1, 1); // side sprite faces left natively; flip for right
    ctx.drawImage(spr, -sw / 2, -sh + 4);
    ctx.restore();

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

// resume an existing session on load
if (token) {
  api('/api/me', { token })
    .then(() => connect())
    .catch(() => { localStorage.removeItem('solarion_token'); token = null; });
}
setMode('login');
