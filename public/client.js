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
let sceneDevices = {};   // Phase 8: instanceId -> TV/radio state in this scene
const renderPos = new Map(); // id -> { x, y, moving }
const bubbles = new Map();   // id -> { text, until }
let keys = { up: false, down: false, left: false, right: false };
let lastSentKeys = '';
let coins = 0;
let dayCycle = null; // Phase 9: { periodMs, anchor } — world clock
let lastDarkness = -1;

/** Phase within the world clock: 0.0 = sunrise, 0.5 = sunset. */
function dayPhase() {
  if (!dayCycle) return 0.25;
  return (((Date.now() - dayCycle.anchor) % dayCycle.periodMs) + dayCycle.periodMs) % dayCycle.periodMs / dayCycle.periodMs;
}

/** Phase 9: 0 (full day) → ~0.42 (deep night) from the world clock. */
function darknessNow() {
  const ph = dayPhase();
  if (ph < 0.46 || ph > 0.97) return 0;                    // day (soft edges)
  if (ph < 0.54) return (ph - 0.46) / 0.08 * 0.42;         // dusk falls
  if (ph < 0.90) return 0.42;                              // night
  return Math.max(0, 0.42 * (1 - (ph - 0.90) / 0.07));     // dawn
}

/**
 * Cozy pass (Zan's standing aesthetic — warm, golden, welcoming):
 * a golden-hour wash that peaks at sunrise and sunset and fades as
 * full day / full night take over. Pure client-side tint.
 */
function goldenNow() {
  const ph = dayPhase();
  const edge = Math.min(Math.abs(ph - 0.5), Math.min(ph, 1 - ph)); // 0 at rise/set
  return Math.max(0, 1 - edge / 0.09) * 0.13;
}
let camState = { x: 0, y: 0, init: false, map: null }; // Phase 9 eased camera
let curArea = null; // Phase 9: named-area nameplate state

/** Current eased camera top-left (projected px). Used by draw + input. */
function cameraPos() {
  return { x: camState.x, y: camState.y };
}

/** Phase 9: raise the place nameplate when entering a named area. */
function checkArea() {
  if (!me || !mapDef || !mapDef.areas) return;
  const myPub = players.find(p => p.id === me.id);
  if (!myPub) return;
  const a = mapDef.areas.find(r => myPub.x >= r.x && myPub.x < r.x + r.w && myPub.y >= r.y && myPub.y < r.y + r.h);
  const name = a ? a.name : null;
  if (name && name !== curArea) {
    curArea = name;
    const el = $('areaPlate');
    el.textContent = name;
    el.classList.remove('hidden');
    el.classList.remove('show');
    void el.offsetWidth; // restart the fade animation
    el.classList.add('show');
    clearTimeout(checkArea._t);
    checkArea._t = setTimeout(() => el.classList.add('hidden'), 2800);
  } else if (!name) {
    curArea = null;
  }
}

// ------------------------------------------------------------------ doors (Phase 10)
// REAL doors, not warp pads: every door renders as a framed wooden
// door that SWINGS OPEN as anyone approaches (with a soft creak) and
// closes behind them. The scene transfer still triggers server-side
// on the door tile — the opening door + stepping into the darkened
// threshold + the warm load screen mask the swap, and on arrival the
// destination's door starts open and swings shut behind you.
const doorAnims = new Map(); // "x,y" -> { open: 0..1, near: bool }
let lastDoorTick = 0;
const INTERIOR_IDS = new Set(['casino-lounge', 'neon-casino', 'gateway-cafe', 'hookah-lounge']);

function doorKeyOf(d) { return `${d.x},${d.y}`; }

/** All renderable doors in the current scene (incl. a home's own door). */
function currentDoors() {
  if (!mapDef) return [];
  const list = [...(mapDef.doors || [])];
  if (mapDef.studio && mapDef.studio.door) {
    list.push({ ...mapDef.studio.door, label: mapDef.name, home: true });
  }
  return list;
}

/** Advance door swing animations; returns [{ d, open }] for the draw pass. */
function tickDoors() {
  const nowMs = performance.now();
  const dt = Math.min(0.06, lastDoorTick ? (nowMs - lastDoorTick) / 1000 : 0.016);
  lastDoorTick = nowMs;
  const out = [];
  for (const d of currentDoors()) {
    const key = doorKeyOf(d);
    let st = doorAnims.get(key);
    if (!st) { st = { open: 0, near: false }; doorAnims.set(key, st); }
    const dcx = d.x + d.w / 2, dcy = d.y + d.h / 2;
    let near = false;
    for (const rp of renderPos.values()) {
      if (Math.hypot(rp.x - dcx, rp.y - dcy) < 62) { near = true; break; }
    }
    let myDist = 1e9;
    const mine = me ? renderPos.get(me.id) : null;
    if (mine) myDist = Math.hypot(mine.x - dcx, mine.y - dcy);
    if (near && !st.near && myDist < 340 && window.SolarionSfx) {
      window.SolarionSfx.play('door');
    }
    st.near = near;
    const target = near ? 1 : 0;
    const step = dt * 2.4; // a swing takes ~0.45s
    st.open += Math.max(-step, Math.min(step, target - st.open));
    out.push({ d, open: st.open });
  }
  return out;
}

function drawDoor(d, open) {
  const [cx, cy] = proj(d.x + d.w / 2, d.y + d.h / 2);
  const doorW = Math.max(d.w, 32) * ZOOM * 0.68;
  const doorH = 47;
  const top = cy - doorH;
  // welcome mat in front of the threshold
  diamond(cx, cy + 9, doorW * 0.62, doorW * 0.3, '#9c4034');
  diamond(cx, cy + 9, doorW * 0.42, doorW * 0.2, '#c96f4a');
  // darkened interior behind the leaf — you step INTO somewhere
  ctx.fillStyle = '#140b06';
  ctx.fillRect(cx - doorW / 2, top + 3, doorW, doorH - 3);
  // the swinging leaf: hinged on the left post, foreshortens open
  const leafW = doorW * Math.max(0.07, Math.cos(open * 1.25));
  const shade = 1 - open * 0.25;
  ctx.fillStyle = `rgb(${Math.round(138 * shade)},${Math.round(90 * shade)},${Math.round(43 * shade)})`;
  ctx.fillRect(cx - doorW / 2, top + 3, leafW, doorH - 3);
  ctx.strokeStyle = 'rgba(46,29,16,.8)';
  ctx.lineWidth = 1.5;
  if (leafW > 9) {
    ctx.strokeRect(cx - doorW / 2 + 3.5, top + 8, leafW - 7, doorH * 0.34);
    ctx.strokeRect(cx - doorW / 2 + 3.5, top + doorH * 0.56, leafW - 7, doorH * 0.28);
  }
  if (leafW > 13) { // brass knob rides the leaf's free edge
    ctx.beginPath(); ctx.arc(cx - doorW / 2 + leafW - 5, top + doorH * 0.52, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd23f'; ctx.fill();
  }
  // frame: posts + lintel in warm dark wood
  ctx.fillStyle = '#4a3423';
  ctx.fillRect(cx - doorW / 2 - 5, top, 5, doorH);
  ctx.fillRect(cx + doorW / 2, top, 5, doorH);
  ctx.fillRect(cx - doorW / 2 - 5, top - 6, doorW + 10, 6);
  // a little lamp beside a home's door
  if (d.home) {
    ctx.beginPath(); ctx.arc(cx + doorW / 2 + 10, top + 9, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffca7a'; ctx.fill();
    ctx.strokeStyle = '#4a3423'; ctx.lineWidth = 1; ctx.stroke();
  }
  // the name over the lintel — a welcome sign, not a HUD tag
  ctx.font = 'bold 12px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff6e6';
  ctx.strokeStyle = 'rgba(30,18,8,.75)';
  ctx.lineWidth = 3;
  const label = d.home ? `🏠 ${d.label}` : d.label;
  ctx.strokeText(label, cx, top - 12);
  ctx.fillText(label, cx, top - 12);
}

// ------------------------------------------------------------------ warm props (Phase 10)
function drawHearthAt(x, y, seed) {
  const t = Date.now();
  diamond(x, y + 2, 40, 15, '#5a4636'); // stone base
  ctx.fillStyle = '#6e4a3a';
  ctx.fillRect(x - 18, y - 32, 36, 30); // brick body
  ctx.fillStyle = '#54382a';
  ctx.fillRect(x - 18, y - 32, 36, 5);  // mantel
  ctx.fillStyle = '#ffd9a0';
  ctx.fillRect(x - 18, y - 27, 36, 2);
  ctx.fillStyle = '#160b06';
  ctx.fillRect(x - 10, y - 22, 20, 20); // firebox
  ctx.fillStyle = '#3a2415';
  ctx.fillRect(x - 8, y - 6, 16, 3);    // logs
  ctx.fillRect(x - 6, y - 9, 13, 3);
  const tongue = (i, w, h, col) => {
    const fx = x + Math.sin(t / 130 + seed * 3 + i * 2.2) * 1.6;
    const fh = h * (0.85 + 0.3 * Math.abs(Math.sin(t / 170 + seed + i * 1.7)));
    ctx.beginPath();
    ctx.ellipse(fx, y - 4 - fh / 2, w, fh / 2, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  };
  tongue(0, 7.5, 17, 'rgba(255,110,26,.9)');
  tongue(1, 5, 13, 'rgba(255,176,66,.95)');
  tongue(2, 2.8, 9, 'rgba(255,233,163,1)');
}

function drawStringLights(x, y, seed) {
  const x0 = x - 34, x1 = x + 34, topY = y - 30;
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const tt = i / 12;
    pts.push([x0 + (x1 - x0) * tt, topY + Math.sin(tt * Math.PI) * 9]);
  }
  ctx.strokeStyle = 'rgba(30,20,12,.85)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  pts.forEach(([px2, py2], i) => { if (i === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2); });
  ctx.stroke();
  const cols = ['#ffd9a0', '#ffb84d', '#ff9d7a', '#ffe9a3'];
  const night = darknessNow() > 0.03;
  for (let i = 1; i < 12; i++) {
    const [bx, by] = pts[i];
    ctx.beginPath(); ctx.arc(bx, by + 2.5, night ? 3 : 2.4, 0, Math.PI * 2);
    ctx.fillStyle = cols[(i + seed) % cols.length];
    ctx.globalAlpha = night ? 1 : 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawLampAt(x, y, lantern) {
  ctx.strokeStyle = '#2e2019';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 24); ctx.stroke();
  if (lantern) {
    ctx.fillStyle = '#3a2a1c';
    ctx.fillRect(x - 4.5, y - 31, 9, 10);
    ctx.fillStyle = '#ffca7a';
    ctx.fillRect(x - 2.8, y - 29, 5.6, 6);
  } else {
    ctx.beginPath(); ctx.arc(x, y - 27, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffe9a3'; ctx.fill();
    ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 1.2; ctx.stroke();
  }
}

function drawProp(pr) {
  const [px2, py2] = proj(pr.x, pr.y);
  switch (pr.kind) {
    case 'rug':
      diamond(px2, py2, 34, 15, '#9c4034');
      diamond(px2, py2, 22, 9.5, '#d9a05a');
      break;
    case 'lamp': drawLampAt(px2, py2, false); break;
    case 'lantern': drawLampAt(px2, py2, true); break;
    case 'stringlights': drawStringLights(px2, py2, Math.round(pr.x / 32) % 4); break;
    case 'hearth': drawHearthAt(px2, py2, (pr.x + pr.y) % 7); break;
    case 'fountain': drawFountainAt(px2, py2); break;
    case 'lighthouse': drawLighthouseAt(px2, py2); break;
    case 'neonsign': drawNeonSignAt(px2, py2); break;
    case 'forge': drawForgeAt(px2, py2, (pr.x + pr.y) % 7); break;
    case 'icesculpt': drawIceSculptAt(px2, py2); break;
    case 'greattree': drawGreatTreeAt(px2, py2); break;
    case 'stall': drawStallAt(px2, py2, (pr.x + pr.y) % 5); break;
    case 'flowers': {
      const cols = ['#ff8fab', '#ffd23f', '#fff6e6', '#c77dff'];
      const seed = Math.round(pr.x + pr.y);
      for (let i = 0; i < 7; i++) {
        const a = ((seed * 31 + i * 47) % 17) - 8, b = ((seed * 17 + i * 29) % 9) - 4;
        ctx.beginPath(); ctx.arc(px2 + a, py2 + b * 0.5 + 2, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(46,110,52,.55)'; ctx.fill();
        ctx.beginPath(); ctx.arc(px2 + a, py2 + b * 0.5, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = cols[(seed + i) % 4]; ctx.fill();
      }
      break;
    }
    default: break;
  }
}

// ------------------------------------------------------------------ Lane C world art: heroes
function drawFountainAt(x, y) {
  diamond(x, y + 3, 46, 17, '#7e8fa3');        // basin base
  diamond(x, y, 44, 16, '#aebdd0');            // basin rim
  diamond(x, y - 2, 36, 12, '#3f9fd8');        // the water
  ctx.fillStyle = '#93a7bd';
  ctx.fillRect(x - 3, y - 26, 6, 22);          // stem
  diamond(x, y - 26, 20, 7, '#aebdd0');        // upper bowl
  diamond(x, y - 28, 14, 5, '#3f9fd8');
  ctx.fillStyle = '#c8d6e4';
  ctx.fillRect(x - 1.5, y - 37, 3, 9);         // spire
  const t = Date.now() / 300;                  // falling droplets
  ctx.fillStyle = 'rgba(190,235,255,.85)';
  for (let i = 0; i < 6; i++) {
    const ph = ((t * 0.7 + i * 0.37) % 1);
    const a = (i / 6) * Math.PI * 2 + 0.4;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * 13 * ph, y - 34 + ph * ph * 17, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawLighthouseAt(x, y) {
  ctx.beginPath(); ctx.ellipse(x, y + 3, 16, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fill();
  ctx.fillStyle = '#e8e4da'; ctx.fillRect(x - 13, y - 30, 26, 30);
  ctx.fillStyle = '#c23b2e'; ctx.fillRect(x - 11, y - 52, 22, 22);
  ctx.fillStyle = '#e8e4da'; ctx.fillRect(x - 9, y - 70, 18, 18);
  ctx.fillStyle = '#2e2019'; ctx.fillRect(x - 11, y - 78, 22, 8);  // gallery
  const pulse = 0.72 + 0.28 * Math.sin(Date.now() / 500);
  ctx.fillStyle = `rgba(255,220,130,${pulse})`;
  ctx.fillRect(x - 5, y - 76, 10, 6);                              // the lamp
  ctx.beginPath();
  ctx.moveTo(x - 12, y - 78); ctx.lineTo(x + 12, y - 78); ctx.lineTo(x, y - 90);
  ctx.closePath(); ctx.fillStyle = '#7a2a20'; ctx.fill();          // cap
  ctx.fillStyle = '#3a2a1c'; ctx.fillRect(x - 3, y - 12, 6, 12);   // door
  ctx.fillStyle = '#33475e'; ctx.fillRect(x - 2.5, y - 44, 5, 6);  // window
}

function drawNeonSignAt(x, y) {
  ctx.fillStyle = '#241a30';
  ctx.fillRect(x - 3, y - 34, 6, 34);                              // pole
  const flick = Math.sin(Date.now() / 90 + x) > -0.92 ? 1 : 0.35;  // neon buzz
  const bx = x - 24, by = y - 94, bw = 48, bh = 60;
  ctx.fillStyle = '#160a24';
  ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 7); ctx.fill();
  ctx.strokeStyle = '#ff2e88'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(bx + 2, by + 2, bw - 4, bh - 4, 6); ctx.stroke();
  // border bulbs chasing pink / cyan
  const chase = Math.floor(Date.now() / 280);
  const bulb = (bx2, by2, i) => {
    ctx.beginPath(); ctx.arc(bx2, by2, 2, 0, Math.PI * 2);
    ctx.fillStyle = (i + chase) % 2 ? '#ff2e88' : '#37e0ff';
    ctx.globalAlpha = flick; ctx.fill(); ctx.globalAlpha = 1;
  };
  let bi = 0;
  for (let i = 0; i < 5; i++) { bulb(bx + 6 + i * 9, by + 5, bi++); bulb(bx + 6 + i * 9, by + bh - 5, bi++); }
  for (let i = 1; i < 4; i++) { bulb(bx + 5, by + i * 14, bi++); bulb(bx + bw - 5, by + i * 14, bi++); }
  ctx.font = 'bold 13px system-ui';
  ctx.textAlign = 'center';
  ctx.globalAlpha = flick;
  'NEON'.split('').forEach((chL, i) => {
    ctx.fillStyle = i % 2 ? '#37e0ff' : '#ff5da2';
    ctx.fillText(chL, x, by + 20 + i * 12.5);
  });
  ctx.globalAlpha = 1;
}

function drawForgeAt(x, y, seed) {
  const t = Date.now();
  diamond(x, y + 2, 30, 11, '#5a4636');                            // stone base
  ctx.fillStyle = '#6e4a3a'; ctx.fillRect(x - 15, y - 30, 30, 30); // forge body
  ctx.fillStyle = '#54382a'; ctx.fillRect(x - 15, y - 30, 30, 4);  // cap slab
  ctx.fillStyle = '#4a3428'; ctx.fillRect(x + 6, y - 54, 9, 25);   // chimney
  ctx.fillStyle = '#160b06'; ctx.fillRect(x - 10, y - 20, 20, 14);// firebox
  const tongue = (i, w, h, col) => {
    const fx = x + Math.sin(t / 130 + seed * 3 + i * 2.2) * 1.4;
    const fh = h * (0.85 + 0.3 * Math.abs(Math.sin(t / 170 + seed + i * 1.7)));
    ctx.beginPath();
    ctx.ellipse(fx, y - 7 - fh / 2, w, fh / 2, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  };
  tongue(0, 6.5, 13, 'rgba(255,110,26,.9)');
  tongue(1, 4.2, 10, 'rgba(255,176,66,.95)');
  tongue(2, 2.2, 7, 'rgba(255,233,163,1)');
  ctx.fillStyle = '#2b2f36';                                       // anvil
  ctx.fillRect(x - 22, y - 4, 13, 4);
  ctx.fillRect(x - 18, y - 8, 5, 5);
  for (let i = 0; i < 3; i++) {                                    // chimney sparks
    const ph = ((t / 1300) + i * 0.37 + seed * 0.13) % 1;
    ctx.beginPath();
    ctx.arc(x + 10 + Math.sin(ph * 6 + seed) * 3, y - 56 - ph * 16, 1.3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,170,60,${0.8 * (1 - ph)})`;
    ctx.fill();
  }
}

function drawIceSculptAt(x, y) {
  diamond(x, y + 2, 26, 9, '#bcd9ea');                             // snowy plinth
  ctx.globalAlpha = 0.82;
  poly([[x - 13, y - 4], [x + 1, y - 38], [x + 5, y - 4]], 'rgba(165,220,250,.85)');
  poly([[x - 3, y - 4], [x + 10, y - 28], [x + 15, y - 4]], 'rgba(140,205,245,.85)');
  poly([[x - 8, y - 4], [x - 5, y - 22], [x + 1, y - 4]], 'rgba(200,238,255,.9)');
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(x - 4, y - 8); ctx.lineTo(x, y - 30); ctx.stroke();
  const tw = 0.5 + 0.5 * Math.sin(Date.now() / 340 + x);            // sparkles
  ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.45 * tw})`;
  ctx.fillRect(x - 2, y - 40, 2, 2);
  ctx.fillRect(x + 9, y - 18, 2, 2);
  ctx.fillRect(x - 11, y - 14, 2, 2);
}

function drawGreatTreeAt(x, y) {
  ctx.beginPath(); ctx.ellipse(x, y + 3, 18, 6.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.20)'; ctx.fill();
  ctx.beginPath();                                                 // tapered trunk
  ctx.moveTo(x - 7, y + 2); ctx.lineTo(x - 3, y - 34);
  ctx.lineTo(x + 3, y - 34); ctx.lineTo(x + 7, y + 2);
  ctx.closePath(); ctx.fillStyle = '#5d4030'; ctx.fill();
  ctx.strokeStyle = '#5d4030'; ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(x, y - 30); ctx.lineTo(x - 17, y - 45);
  ctx.moveTo(x, y - 32); ctx.lineTo(x + 17, y - 47);
  ctx.stroke();
  const blob = (bx, by, r, col) => { ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); };
  blob(x, y - 54, 27, '#26552a');
  blob(x - 21, y - 43, 18, '#2c6e33');
  blob(x + 21, y - 45, 19, '#2f7a3d');
  blob(x - 9, y - 64, 18, '#358547');
  blob(x + 12, y - 66, 15, '#43a355');
  ctx.fillStyle = 'rgba(255,233,163,.85)';                         // hanging lights
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(x - 18 + i * 9, y - 36 - ((i * 7) % 9), 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStallAt(x, y, seed) {
  ctx.fillStyle = '#7a5230'; ctx.fillRect(x - 16, y - 8, 32, 9);   // counter
  ctx.fillStyle = '#5d3d22'; ctx.fillRect(x - 16, y + 1, 32, 3);
  const goods = ['#e2543e', '#ffd23f', '#7ac74f', '#ff8fab', '#37e0ff'];
  for (let i = 0; i < 4; i++) {                                    // wares
    ctx.beginPath();
    ctx.arc(x - 11 + i * 7.4, y - 9.5, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = goods[(seed + i) % goods.length]; ctx.fill();
  }
  ctx.strokeStyle = '#4a3423'; ctx.lineWidth = 2.2;                // awning posts
  ctx.beginPath();
  ctx.moveTo(x - 15, y - 8); ctx.lineTo(x - 15, y - 27);
  ctx.moveTo(x + 15, y - 8); ctx.lineTo(x + 15, y - 27);
  ctx.stroke();
  poly([[x - 19, y - 21], [x, y - 31], [x + 19, y - 21], [x + 14, y - 15], [x, y - 23], [x - 14, y - 15]], '#c23b2e');
  poly([[x - 12, y - 19.4], [x, y - 26.4], [x + 12, y - 19.4], [x + 8, y - 15.6], [x, y - 21.4], [x - 8, y - 15.6]], '#e8e4da');
}

// ------------------------------------------------------------------ Lane C buildings (facades)
const BUILDING_STYLES = {
  cafe:   { wall: '#e6cf9f', wallDark: '#c9ad76', roof: '#9c4a2f', trim: '#6e3423', chimney: true },
  casino: { wall: '#4b3573', wallDark: '#392659', roof: '#2c1b47', trim: '#ffd23f' },
  neon:   { wall: '#3d1545', wallDark: '#2c0f33', roof: '#1c0a24', trim: '#ff2e88' },
  hookah: { wall: '#d9a86c', wallDark: '#bb874c', roof: '#7a3b1e', trim: '#5d2c14', chimney: true },
  home:   { wall: '#e0cba3', wallDark: '#c2a678', roof: '#7a4030', trim: '#54382a', chimney: true },
};

function drawChimneyAt(x, y) {
  ctx.fillStyle = '#7a5a48';
  ctx.fillRect(x - 3.5, y - 10, 7, 10);
  ctx.fillStyle = '#5d4436';
  ctx.fillRect(x - 4.5, y - 12, 9, 2.6);
  const t = Date.now() / 900;
  for (let i = 0; i < 2; i++) {
    const ph = ((t + i * 0.5) % 1);
    ctx.beginPath();
    ctx.arc(x + Math.sin(ph * 4 + x) * 2.5, y - 14 - ph * 12, 2 + ph * 2.6, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(235,230,225,${0.4 * (1 - ph)})`;
    ctx.fill();
  }
}

function drawBuildingWindows(A, B, n, H, seed) {
  const night = darknessNow() > 0.03;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const gx = A[0] + (B[0] - A[0]) * t;
    const gy = A[1] + (B[1] - A[1]) * t - H * 0.52;
    const lit = !night || ((i * 7 + seed) % 4 !== 0);
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(gx - 4.5, gy - 6, 9, 12);
    ctx.fillStyle = lit ? (night ? '#ffd9a0' : '#8fb8d8') : '#1c2735';
    ctx.fillRect(gx - 3, gy - 4.5, 6, 9);
    ctx.strokeStyle = 'rgba(58,42,26,.7)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(gx, gy - 4.5); ctx.lineTo(gx, gy + 4.5); ctx.stroke();
  }
}

function drawBuilding(b) {
  const TS = mapDef.tileSize || 32;
  const st = BUILDING_STYLES[b.style] || BUILDING_STYLES.home;
  const x0 = b.tx * TS, y0 = b.ty * TS, x1 = (b.tx + b.tw) * TS, y1 = (b.ty + b.th) * TS;
  const H = (b.style === 'casino' || b.style === 'neon') ? 54 : 44;
  const NW = proj(x0, y0), NE = proj(x1, y0), SE = proj(x1, y1), SW = proj(x0, y1);
  const up = (p, h) => [p[0], p[1] - h];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  poly([NW, NE, [SE[0], SE[1] + 4], [SW[0], SW[1] + 4]], 'rgba(0,0,0,.14)'); // ground shadow
  poly([up(SE, H), up(NE, H), NE, SE], st.wallDark);   // east face
  poly([up(SW, H), up(SE, H), SE, SW], st.wall);       // south face
  ctx.strokeStyle = st.trim; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(...up(SW, H)); ctx.lineTo(...up(SE, H)); ctx.lineTo(...up(NE, H));
  ctx.stroke();
  drawBuildingWindows(SW, SE, Math.max(2, Math.round(b.tw / 2)), H, b.tx * 3 + 1);
  drawBuildingWindows(SE, NE, Math.max(2, Math.round(b.th / 2)), H, b.ty * 5 + 2);
  // pitched roof, ridge along the long axis
  const roofH = 22;
  const NWt = up(NW, H), NEt = up(NE, H), SEt = up(SE, H), SWt = up(SW, H);
  const roofDark = shade(st.roof, -16);
  if (b.tw >= b.th) {
    const rW = up(mid(NWt, SWt), roofH), rE = up(mid(NEt, SEt), roofH);
    poly([NWt, SWt, rW], st.wall);
    poly([NEt, SEt, rE], st.wallDark);
    poly([NWt, NEt, rE, rW], roofDark);
    poly([SWt, SEt, rE, rW], st.roof);
    if (st.chimney) drawChimneyAt(rW[0] + (rE[0] - rW[0]) * 0.3, rW[1] + (rE[1] - rW[1]) * 0.3 + 7);
  } else {
    const rN = up(mid(NWt, NEt), roofH), rS = up(mid(SWt, SEt), roofH);
    poly([NWt, NEt, rN], st.wall);
    poly([SWt, SEt, rS], st.wall);
    poly([NWt, SWt, rS, rN], roofDark);
    poly([NEt, SEt, rS, rN], st.roof);
    if (st.chimney) drawChimneyAt(rN[0] + (rS[0] - rN[0]) * 0.3, rN[1] + (rS[1] - rN[1]) * 0.3 + 7);
  }
}

// ------------------------------------------------------------------ Lane C gatehouses
const gateAnims = new Map();
let lastGateTick = 0;

function gatehouseGeom(g) {
  const TS = mapDef.tileSize || 32;
  const tx = Math.round(g.x / TS), ty = Math.round(g.y / TS);
  const north = g.dir !== 'S';
  return {
    rectCx: g.x + g.w / 2,
    mouthY: north ? g.y + g.h + TS : g.y - TS,
    passageY: north ? g.y + g.h + TS / 2 : g.y - TS / 2,
    towerBaseY: north ? g.y + TS : g.y,
    towerLx: (tx - 1) * TS + TS / 2,
    towerRx: (tx + 2) * TS + TS / 2,
  };
}

/** Advance gatehouse door swings (same feel as the Phase 10 doors). */
function tickGatehouses() {
  const nowMs = performance.now();
  const dt = Math.min(0.06, lastGateTick ? (nowMs - lastGateTick) / 1000 : 0.016);
  lastGateTick = nowMs;
  const out = [];
  for (const g of mapDef.gateways || []) {
    const key = `gw:${mapDef.id}:${g.target}`;
    let st = gateAnims.get(key);
    if (!st) { st = { open: 0, near: false }; gateAnims.set(key, st); }
    const gm = gatehouseGeom(g);
    let near = false;
    for (const rp of renderPos.values()) {
      if (Math.hypot(rp.x - gm.rectCx, rp.y - gm.mouthY) < 74) { near = true; break; }
    }
    let myDist = 1e9;
    const mine = me ? renderPos.get(me.id) : null;
    if (mine) myDist = Math.hypot(mine.x - gm.rectCx, mine.y - gm.mouthY);
    if (near && !st.near && myDist < 340 && window.SolarionSfx) {
      window.SolarionSfx.play('door');
    }
    st.near = near;
    const target = near ? 1 : 0;
    const step = dt * 2.4;
    st.open += Math.max(-step, Math.min(step, target - st.open));
    out.push({ g, open: st.open, gm });
  }
  return out;
}

function drawGateTower(sx, sy) {
  const hw = 23, hh = 11.5, H = 58;
  poly([[sx - hw, sy - H], [sx, sy + hh - H], [sx, sy + hh], [sx - hw, sy]], '#4c3a2b');
  poly([[sx, sy + hh - H], [sx + hw, sy - H], [sx + hw, sy], [sx, sy + hh]], '#5d4936');
  diamond(sx, sy - H, hw, hh, '#6e573f');
  poly([[sx - hw * 0.7, sy - H], [sx, sy - H - 1], [sx, sy - H - 16]], '#68402c');
  poly([[sx, sy - H - 1], [sx + hw * 0.7, sy - H], [sx, sy - H - 16]], '#7a4030');
  ctx.fillStyle = '#3a2a1c';
  ctx.fillRect(sx - 1, sy - H - 19, 2, 4);
  ctx.beginPath(); ctx.arc(sx, sy - H - 21, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd23f'; ctx.fill();
  // a lit lantern window on the shaft
  ctx.fillStyle = '#ffca7a';
  ctx.fillRect(sx - 2.5, sy - H + 14, 5, 7);
  ctx.strokeStyle = '#2e2019'; ctx.lineWidth = 1;
  ctx.strokeRect(sx - 2.5, sy - H + 14, 5, 7);
}

function drawGateLeaf(hx, hy, vx, vy, frac, open, wood) {  const c = Math.max(0.07, Math.cos(open * 1.25));
  const ex = hx + vx * frac * c, ey = hy + vy * frac * c - open * 5;
  poly([[hx, hy], [ex, ey], [ex, ey - 40], [hx, hy - 40]], wood);
  ctx.strokeStyle = 'rgba(46,29,16,.8)'; ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(hx, hy); ctx.lineTo(ex, ey); ctx.lineTo(ex, ey - 40); ctx.lineTo(hx, hy - 40);
  ctx.closePath(); ctx.stroke();
  if (Math.abs(ex - hx) > 10) {
    ctx.strokeStyle = 'rgba(46,29,16,.55)'; ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(hx, ex) + 3.5, Math.min(hy, ey) - 33, Math.abs(ex - hx) - 7, 14);
    ctx.beginPath();
    ctx.arc(ex - Math.sign(vx || 1) * 4, ey - 19, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd23f'; ctx.fill();
  }
}

function drawGatehouse(g, open, gm) {
  const TS = mapDef.tileSize || 32;
  const hw = TS * ZOOM, hh = TS * ZOOM * 0.5;
  // passage floor: stone slabs between the mouth and the threshold
  for (const off of [-TS / 2, TS / 2]) {
    const [fx, fy] = proj(gm.rectCx + off, gm.passageY);
    diamond(fx, fy, hw, hh, '#57493a');
    diamond(fx, fy, hw * 0.78, hh * 0.78, '#66584a');
  }
  // the threshold itself: dark stone step with a warm gold inlay —
  // the transfer fires HERE, at the inner end of the passage
  for (const off of [-TS / 2, TS / 2]) {
    const [fx, fy] = proj(gm.rectCx + off, g.y + g.h / 2);
    diamond(fx, fy, hw, hh, '#3e3226');
  }
  const [tlx, tly] = proj(g.x + 2, g.y + g.h / 2);
  const [trx, try2] = proj(g.x + g.w - 2, g.y + g.h / 2);
  ctx.strokeStyle = 'rgba(255,210,63,.5)'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(tlx, tly); ctx.lineTo(trx, try2); ctx.stroke();
  // towers on the flank columns
  const [lx, ly] = proj(gm.towerLx, gm.towerBaseY);
  const [rx, ry] = proj(gm.towerRx, gm.towerBaseY);
  drawGateTower(lx, ly);
  drawGateTower(rx, ry);
  // lintel beam between the tower tops, lantern hung beneath
  const topL = [lx + 10, ly - 56], topR = [rx - 10, ry - 56];
  poly([[topL[0], topL[1] - 7], [topR[0], topR[1] - 7], [topR[0], topR[1] + 7], [topL[0], topL[1] + 7]], '#4a3423');
  const midX = (topL[0] + topR[0]) / 2, midY = (topL[1] + topR[1]) / 2;
  ctx.beginPath(); ctx.arc(midX, midY + 12, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffca7a'; ctx.fill();
  ctx.strokeStyle = '#2e2019'; ctx.lineWidth = 1; ctx.stroke();
  // the destination sign over the lintel
  ctx.font = 'bold 12.5px system-ui';
  ctx.textAlign = 'center';
  const label = g.label + (g.active ? '' : ' (soon)');
  const tw = ctx.measureText(label).width + 16;
  ctx.fillStyle = '#2e2019';
  ctx.beginPath(); ctx.roundRect(midX - tw / 2, midY - 21, tw, 15, 3); ctx.fill();
  ctx.fillStyle = '#ffe9a3';
  ctx.fillText(label, midX, midY - 9.5);
  // welcome mat, then the big double doors at the mouth
  const [mcx, mcy] = proj(gm.rectCx, gm.mouthY);
  diamond(mcx, mcy + 6, 30, 10, '#9c4034');
  diamond(mcx, mcy + 6, 20, 6.5, '#c96f4a');
  const L = proj(g.x + 3, gm.mouthY), R = proj(g.x + g.w - 3, gm.mouthY);
  const vx = R[0] - L[0], vy = R[1] - L[1];
  drawGateLeaf(L[0], L[1], vx, vy, 0.5, open, '#8a5a2b');
  drawGateLeaf(R[0], R[1], -vx, -vy, 0.5, open, '#7d5227');
}

// ------------------------------------------------------------------ Lane C slot cabinets
// Per the Gasoline Alley pinball row: a chunky cabinet, an angled
// glass front with visible reels, a lit marquee, side art. Pure
// rendering — machine positions, stools and all slot math are
// untouched (the interactive reels live in the casino panel).
const SLOT_REELS = [
  ['7', '7', '7'], ['☀', '☀', '🍒'], ['🍒', '🔔', '💎'],
  ['💎', '7', '☀'], ['🔔', '🍒', '🔔'], ['🍒', '🍒', '7'],
];
function drawSlotCabinet(sx, sy, idx, facing) {
  const sgn = facing === 'W' ? -1 : 1; // east-wall machines present their other cheek
  ctx.beginPath(); ctx.ellipse(sx, sy + 3, 18, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fill();
  // chunky body with a two-tone cabinet paint job
  const grad = ctx.createLinearGradient(sx, sy - 52, sx, sy + 2);
  grad.addColorStop(0, '#3d2560');
  grad.addColorStop(1, '#221338');
  ctx.fillStyle = grad;
  ctx.fillRect(sx - 15, sy - 52, 30, 54);
  ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.2;
  ctx.strokeRect(sx - 15, sy - 52, 30, 54);
  // side art panel (Gasoline Alley cheek art): magenta slash + sun
  poly([
    [sx + sgn * 15, sy - 44], [sx + sgn * 21, sy - 38],
    [sx + sgn * 21, sy + 2], [sx + sgn * 15, sy + 2],
  ], '#8e1e63');
  ctx.beginPath();
  ctx.arc(sx + sgn * 17.6, sy - 18, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd23f'; ctx.fill();
  // lit marquee: gold band, chasing bulbs, the word SLOTS
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(sx - 15, sy - 52, 30, 11);
  ctx.fillStyle = '#171126';
  ctx.font = 'bold 7.5px system-ui'; ctx.textAlign = 'center';
  ctx.fillText('S L O T S', sx, sy - 44.2);
  const chase = Math.floor(Date.now() / 280) + idx;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.arc(sx - 12 + i * 6, sy - 49.5, 1.3, 0, Math.PI * 2);
    ctx.fillStyle = (i + chase) % 2 ? '#fff3b0' : '#ff9d00';
    ctx.fill();
  }
  // angled glass playfield with three visible reels
  poly([
    [sx - 12, sy - 37], [sx + 12, sy - 37],
    [sx + 14, sy - 16], [sx - 14, sy - 16],
  ], 'rgba(16,12,34,.94)');
  const reels = SLOT_REELS[idx % SLOT_REELS.length];
  ctx.font = '9px system-ui'; ctx.textAlign = 'center';
  [-8, 0, 8].forEach((off, i) => {
    ctx.fillStyle = '#f5f0e6';
    ctx.fillRect(sx + off - 3.6, sy - 34, 7.2, 12);
    ctx.fillStyle = '#333';
    ctx.fillText(reels[i], sx + off, sy - 24.5);
  });
  // glass shine streak
  poly([
    [sx - sgn * 9, sy - 37], [sx - sgn * 3, sy - 37],
    [sx - sgn * 8, sy - 16], [sx - sgn * 12, sy - 16],
  ], 'rgba(255,255,255,.13)');
  // button deck + coin tray
  ctx.fillStyle = '#171126';
  ctx.fillRect(sx - 14, sy - 13, 28, 8);
  ctx.beginPath(); ctx.arc(sx - 6, sy - 9, 1.9, 0, Math.PI * 2);
  ctx.fillStyle = '#e2543e'; ctx.fill();
  ctx.beginPath(); ctx.arc(sx + 6, sy - 9, 1.9, 0, Math.PI * 2);
  ctx.fillStyle = '#7ac74f'; ctx.fill();
  ctx.fillStyle = '#0d0a18';
  ctx.fillRect(sx - 8, sy - 3.5, 16, 4);
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(sx - 8, sy - 3.5, 16, 1);
}

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
// Phase 9 — the wake screen: progress + rotating tips while the
// world loads or the connection heals. Never a dead page.
const WAKE_TIPS = [
  '💿 Burn a mix to a CD before you perform — no CD, no stage.',
  '🏆 25 lifetime thumbs-ups on one mix earns a Gold Record for your wall. 100 earns Platinum.',
  '🍸 The first drink of the day at any bartender is free — and the house tips you 10z.',
  '🎰 The slots jackpot is shared by BOTH casinos. Three suns take it all.',
  '🧭 The Navigator (top bar) shows every place, how busy it is, and where your friends are.',
  '🏠 Expand your home: Studio → Loft → Penthouse. Your furniture keeps its spot.',
  '☀️ Logging in daily pays 100z. Performing pays 5z per thumbs-up.',
  '🕺 Emotes live on the right edge. Dancing works anywhere. Especially the stage.',
  '📻 A home radio plays your own mixes — everyone in the room hears them, you included.',
  '🗺️ Click or tap anywhere to walk there. The 🏃 button runs.',
];
const Wake = {
  tipIdx: 0,
  timer: null,
  show(label) {
    const el = $('wakeScreen');
    el.classList.remove('hidden');
    el.style.display = 'flex';
    if (label) $('wakeStatus').textContent = label;
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.tipIdx = (this.tipIdx + 1) % WAKE_TIPS.length;
        $('wakeTip').textContent = WAKE_TIPS[this.tipIdx];
      }, 4200);
      $('wakeTip').textContent = WAKE_TIPS[this.tipIdx];
    }
  },
  progress(pct, label) {
    $('wakeBar').style.width = `${pct}%`;
    if (label) $('wakeStatus').textContent = label;
  },
  hide() {
    const el = $('wakeScreen');
    el.style.display = 'none';
    el.classList.add('hidden');
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  },
};
window.SolarionWake = Wake;

function connect() {
  Wake.show('Connecting to Solarion…');
  Wake.progress(35);
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onopen = () => Wake.progress(55, 'Connected — loading the world…');
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.type === 'hello') Wake.progress(80, 'Almost there…');
    if (m.type === 'snapshot' || m.type === 'map') { Wake.progress(100); setTimeout(() => Wake.hide(), 250); }
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
    Wake.show('Connection lost — reconnecting…');
    Wake.progress(30);
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
  transfer = {
    startedAt: performance.now(), ms: m.transferMs || 3000, snapshotSeen: false,
    interior: Boolean(m.map.studio) || INTERIOR_IDS.has(m.map.id),
  };
  keys = { up: false, down: false, left: false, right: false };
  lastSentKeys = JSON.stringify(wireKeys());
  send({ type: 'input', keys: wireKeys() });
  // Phase 10: the load screen is a doorway now — warm wood, a lamp,
  // and the destination's name like a welcome sign over the lintel.
  $('loadText').textContent = `🚪 ${m.map.name}`;
  const sub = $('loadSub');
  if (sub) sub.textContent = m.map.studio ? 'welcome in — make yourself at home' : 'come on in — the fire’s lit…';
  $('loadScreen').classList.remove('hidden');
  sceneFurniture = m.furniture || (m.studio && m.studio.furniture) || [];
  sceneDevices = {};
  for (const d of m.devices || []) sceneDevices[d.instanceId] = d;
  setMap(m.map, m.you, m.chat || []);
  // You arrive THROUGH the new scene's door: it starts open and
  // swings shut behind you as you walk away from it.
  doorAnims.clear();
  let bestD = null, bestDist = 90;
  for (const d of currentDoors()) {
    const dist = Math.hypot(d.x + d.w / 2 - m.you.x, d.y + d.h / 2 - m.you.y);
    if (dist < bestDist) { bestDist = dist; bestD = d; }
  }
  if (bestD) doorAnims.set(doorKeyOf(bestD), { open: 1, near: true });
  players = m.players;
  chatLine(`<span class="sys">You arrived in ${esc(m.map.name)}.</span>`);
  // Fallback: never trap the player behind the screen if snapshots stall.
  const mine = transfer;
  setTimeout(() => { if (transfer === mine) finishTransfer(); }, transfer.ms + 5000);
}

function finishTransfer() {
  const wasInterior = transfer && transfer.interior;
  transfer = null;
  $('loadScreen').classList.add('hidden');
  // Phase 10: stepping through a door gets the door sound; gateway
  // arches keep their chime.
  if (window.SolarionSfx) window.SolarionSfx.play(wasInterior ? 'door' : 'chime');
}

setInterval(() => {
  if (transfer && transfer.snapshotSeen && performance.now() - transfer.startedAt >= transfer.ms) {
    finishTransfer();
  }
}, 100);

function setMap(m, you, chat) {
  mapDef = m;
  curArea = null;
  camState.init = false;
  if (window.SolarionSfx) window.SolarionSfx.ambience(m.id, Boolean(m.casino));
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
  if (window.SolarionSocial) window.SolarionSocial.handle(m);
  switch (m.type) {
    case 'hello': {
      me = { ...m.you };
      coins = m.zcoins;
      if (m.dayCycle) dayCycle = m.dayCycle;
      $('coins').textContent = coins;
      players = m.players;
      sceneFurniture = m.furniture || [];
      sceneDevices = {};
      showGame();
      setMap(m.map, m.you, m.chat);
      chatLine(`<span class="sys">Welcome to ${esc(m.map.name)}.</span>`);
      if (m.bonusGranted) toast('☀️ Daily bonus: +100 z coins!');
      break;
    }
    case 'snapshot': {
      players = m.players;
      checkArea();
      if (transfer) transfer.snapshotSeen = true;
      for (const p of players) {
        if (!renderPos.has(p.id)) renderPos.set(p.id, { x: p.x, y: p.y, moving: false });
      }
      const alive = new Set(players.map(p => p.id));
      for (const id of [...renderPos.keys()]) if (!alive.has(id)) renderPos.delete(id);
      break;
    }
    case 'map': {
      if (m.dayCycle) dayCycle = m.dayCycle;
      beginTransfer(m);
      break;
    }
    case 'sit-state': {
      $('sitBtn').textContent = m.seated ? '🧍 Stand' : '🪑 Sit';
      break;
    }
    case 'studio-furniture': {
      sceneFurniture = m.furniture || [];
      for (const id of Object.keys(sceneDevices)) {
        if (!sceneFurniture.some(f => f.instanceId === Number(id))) delete sceneDevices[id];
      }
      break;
    }
    case 'studio-state': {
      if (m.devices) {
        sceneDevices = {};
        for (const d of m.devices) sceneDevices[d.instanceId] = d;
      }
      break;
    }
    case 'home-device': {
      if (m.device) sceneDevices[m.device.instanceId] = m.device;
      else if (Number.isInteger(m.instanceId)) delete sceneDevices[m.instanceId];
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
// `keys` holds SCREEN-space intent — the directions the player
// actually pressed (keyboard and touch joystick both write here).
// The wire carries WORLD-axis keys for the server's walker, so every
// send converts through the inverse iso projection
// (SolarionInput.screenToWorldKeys in input-guard.js): pressing
// "up" moves the avatar up the SCREEN, not up a world diagonal.
function wireKeys() {
  return (window.SolarionInput && window.SolarionInput.screenToWorldKeys)
    ? window.SolarionInput.screenToWorldKeys(keys)
    : keys;
}
const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};
addEventListener('keydown', (e) => {
  // Typing into ANY text-entry element (login/register, creation
  // name, chat, raise amount, selects…) is never game input: don't
  // swallow the keystroke, don't move, don't interact. (Phase B fix)
  if (window.SolarionInput && window.SolarionInput.isTextEntryTarget(e.target)) return;
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
  const wk = wireKeys();
  const s = JSON.stringify(wk);
  if (s !== lastSentKeys) { lastSentKeys = s; send({ type: 'input', keys: wk }); }
}, 50);

$('sitBtn').onclick = () => { if (!transfer) send({ type: 'interact' }); };

// ------------------------------------------------------------------
// Phase 9 — click/tap-to-move + run toggle. A click (or phone tap)
// on the world canvas sends ONE {type:'move-to'} intent; the server
// routes and walks there (src/pathfind.js). Clicks are ignored while
// a studio placement is armed (studio.js owns those clicks), during
// transfers, and when they land on another player (profile card,
// item 7) rather than the ground.
/** Invert the iso projection for a pointer event → world px point. */
function screenToWorld(e) {
  const rect = cv.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (cv.width / rect.width);
  const py = (e.clientY - rect.top) * (cv.height / rect.height);
  const myRp = me ? renderPos.get(me.id) : null;
  if (!myRp) return null;
  const cam = cameraPos();
  const sx = px + cam.x, sy = py + cam.y;
  const a = sx / ZOOM, b = sy / (ZOOM * 0.5);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

cv.addEventListener('click', (e) => {
  if (transfer || !me || !mapDef) return;
  if (window.SolarionStudio && window.SolarionStudio.placeInstanceId != null) return;
  const w = screenToWorld(e);
  if (!w) return;
  // A click ON a player opens their profile (item 7), not a walk.
  if (window.SolarionSocial && window.SolarionSocial.tryProfileAt(w)) return;
  send({ type: 'move-to', x: Math.round(w.x), y: Math.round(w.y) });
});

let runOn = false;
$('runBtn').onclick = () => {
  runOn = !runOn;
  $('runBtn').classList.toggle('active', runOn);
  $('runBtn').textContent = runOn ? '🏃 Running' : '🚶 Walk';
  send({ type: 'run', on: runOn });
};
$('chatBtn').onclick = () => { $('chatInput').focus(); };

// Phase 9 — sound settings + UI click sounds + door chime.
$('soundBtn').onclick = () => {
  const p = $('soundPanel');
  p.classList.toggle('hidden');
  if (window.SolarionSfx) {
    $('volSlider').value = String(Math.round(window.SolarionSfx.volume * 100));
    $('muteBtn').textContent = window.SolarionSfx.muted ? 'Unmute' : 'Mute';
  }
};
$('volSlider').oninput = () => { if (window.SolarionSfx) window.SolarionSfx.setVolume(Number($('volSlider').value) / 100); };
$('muteBtn').onclick = () => {
  if (!window.SolarionSfx) return;
  const muted = window.SolarionSfx.toggleMute();
  $('muteBtn').textContent = muted ? 'Unmute' : 'Mute';
};
document.addEventListener('click', (e) => {
  if (e.target && e.target.tagName === 'BUTTON' && window.SolarionSfx) window.SolarionSfx.play('click');
});

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
const CHAR_SCALE = 1.5; // playtest: characters draw 1.5x in-world (draw-time only — sprite generation, collision and the creation preview are untouched)
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

function diamondPath(cx, cy, hw, hh) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
}

function diamond(cx, cy, hw, hh, fill) {
  diamondPath(cx, cy, hw, hh);
  ctx.fillStyle = fill;
  ctx.fill();
}

function poly(points, fill) {
  ctx.beginPath();
  points.forEach(([x, y], i) => { if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * Lane C: tiles hidden under a building facade or a gatehouse's
 * flank towers — those passes draw the structure instead of cubes.
 * Cached per scene.
 */
let _skipCache = { map: null, set: new Set() };
function tileSkipSet() {
  if (_skipCache.map === mapDef) return _skipCache.set;
  const set = new Set();
  const TS = mapDef.tileSize || 32;
  for (const b of mapDef.buildings || []) {
    for (let ty = b.ty; ty < b.ty + b.th; ty++) {
      for (let tx = b.tx; tx < b.tx + b.tw; tx++) set.add(tx + ',' + ty);
    }
  }
  for (const g of mapDef.gateways || []) {
    const tx = Math.round(g.x / TS), ty = Math.round(g.y / TS);
    const rows = g.dir === 'S' ? [ty, ty - 1] : [ty, ty + 1];
    for (const ry of rows) { set.add((tx - 1) + ',' + ry); set.add((tx + 2) + ',' + ry); }
  }
  _skipCache = { map: mapDef, set };
  return set;
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
  if (ch === '%') { // water — Phase 9: animated shimmer
    diamond(cx, cy, hw, hh, (tx + ty) % 2 ? '#2f8fb8' : '#2b84ad');
    const t = performance.now() / 620 + tx * 0.9 + ty * 0.6;
    ctx.strokeStyle = `rgba(255,255,255,${0.10 + 0.08 * Math.sin(t)})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const off = Math.sin(t * 0.7) * hw * 0.18;
    ctx.moveTo(cx - hw * 0.5 + off, cy - 1);
    ctx.quadraticCurveTo(cx + off, cy - hh * 0.42, cx + hw * 0.5 + off, cy - 1);
    ctx.stroke();
    return;
  }
  if (ch === 's' || ch === 'p' || ch === 'b') {
    // Lane C textured ground: stone plaza, dirt path, boardwalk —
    // zoned floors so no city is one flat colour any more.
    const alt = (tx + ty) % 2;
    if (ch === 's') {
      diamond(cx, cy, hw, hh, shade(mapDef.floor.startsWith('#') ? mapDef.floor : '#888888', alt ? 16 : 24));
      diamondPath(cx, cy, hw, hh);
      ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.10)';
      ctx.beginPath();
      ctx.moveTo(cx - hw, cy); ctx.lineTo(cx + hw, cy);
      ctx.moveTo(cx, cy - hh); ctx.lineTo(cx, cy + hh);
      ctx.stroke();
    } else if (ch === 'p') {
      diamond(cx, cy, hw, hh, shade(mapDef.floor.startsWith('#') ? mapDef.floor : '#888888', alt ? -16 : -24));
      const seed = (tx * 31 + ty * 17) % 5;
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      ctx.beginPath(); ctx.arc(cx - 6 + seed * 2, cy + 1, 1.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 5 - seed, cy - 2, 1.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.beginPath(); ctx.arc(cx + 1, cy + 3, 1.3, 0, Math.PI * 2); ctx.fill();
    } else { // 'b' boardwalk planks
      diamond(cx, cy, hw, hh, alt ? '#a9763f' : '#9c6d39');
      diamondPath(cx, cy, hw, hh);
      ctx.save(); ctx.clip();
      ctx.strokeStyle = 'rgba(70,42,16,.5)'; ctx.lineWidth = 1.2;
      for (const o of [-0.45, 0, 0.45]) {
        ctx.beginPath();
        ctx.moveTo(cx - hw, cy - hh * 0.2 + o * hh * 1.6);
        ctx.lineTo(cx + hw, cy + hh * 0.8 + o * hh * 1.6);
        ctx.stroke();
      }
      ctx.restore();
      diamondPath(cx, cy, hw, hh);
      ctx.strokeStyle = 'rgba(70,42,16,.35)'; ctx.lineWidth = 1; ctx.stroke();
    }
    return;
  }
  if (ch === 'T') { // Lane C tree: trunk + layered canopy (solid)
    diamond(cx, cy, hw, hh, (tx + ty) % 2 ? mapDef.floor : mapDef.floorAlt);
    ctx.beginPath(); ctx.ellipse(cx, cy + 3, 12, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fill();
    ctx.fillStyle = '#6e4a2c';
    ctx.fillRect(cx - 2.6, cy - 9, 5.2, 11);
    const v = ((tx * 7 + ty * 13) % 3) - 1;
    const blob = (bx, by, r, col) => { ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); };
    blob(cx + v * 2, cy - 24, 15, '#2c6e33');
    blob(cx - 10, cy - 17, 10, '#2f7a3d');
    blob(cx + 10, cy - 17, 10, '#358547');
    blob(cx + v, cy - 28, 8, '#43a355');
    return;
  }
  if (ch === 'P') { // Lane C planter: low box, shrubs, flowers (solid)
    diamond(cx, cy, hw, hh, (tx + ty) % 2 ? mapDef.floor : mapDef.floorAlt);
    diamond(cx, cy - 1, 20, 8.5, '#7a4a30');
    diamond(cx, cy - 6, 18, 7.5, '#4a3520');
    const blob = (bx, by, r, col) => { ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); };
    blob(cx - 7, cy - 11, 5.5, '#2f7a3d');
    blob(cx + 6, cy - 12, 6, '#358547');
    blob(cx, cy - 14, 5, '#2c6e33');
    const cols = ['#ff8fab', '#ffd23f', '#fff6e6', '#c77dff'];
    const seed = tx * 3 + ty * 5;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(cx - 8 + ((seed + i * 6) % 17), cy - 13 - ((seed + i * 3) % 4), 1.7, 0, Math.PI * 2);
      ctx.fillStyle = cols[(seed + i) % 4]; ctx.fill();
    }
    return;
  }
  if (ch === 'R') { // Lane C rock: boulders tinted from the map's wall colour (solid)
    diamond(cx, cy, hw, hh, (tx + ty) % 2 ? mapDef.floor : mapDef.floorAlt);
    const wallHex = mapDef.wall.startsWith('#') ? mapDef.wall : '#6b5138';
    ctx.beginPath(); ctx.ellipse(cx, cy + 3, 14, 5.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.fill();
    const rock = (bx, by, rx, ry, col) => { ctx.beginPath(); ctx.ellipse(bx, by, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); };
    rock(cx - 6, cy - 2, 10, 6.5, shade(wallHex, 26));
    rock(cx + 7, cy - 3, 8.5, 5.5, shade(wallHex, 44));
    rock(cx + 1, cy - 7, 6.5, 4.5, shade(wallHex, 62));
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.arc(cx - 1, cy - 8, 4.5, Math.PI * 1.15, Math.PI * 1.7); ctx.stroke();
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

// ------------------------------------------------------------------ TVs
// Phase 8: a placed TV draws as a small cabinet with a live screen.
// The screen content is 100% procedural canvas art (original fake
// shows — no footage, no assets), animated off Date.now() so every
// client in the room sees roughly the same frame of the same show.
// Channel id + on/off come from the server-owned device state.
function drawTelevision(f, fx, fy) {
  const dev = sceneDevices[f.instanceId];
  const on = Boolean(dev && dev.on);
  // cabinet: base block + body + screen
  diamond(fx, fy - 2, 20, 9, f.accent || '#3f475c');
  ctx.fillStyle = f.color || '#59637a';
  ctx.fillRect(fx - 19, fy - 30, 38, 24);
  ctx.strokeStyle = 'rgba(0,0,0,.45)';
  ctx.lineWidth = 1;
  ctx.strokeRect(fx - 19, fy - 30, 38, 24);
  if (f.itemId === 'tube-tv') { // rabbit-ear antennae on the tube set
    ctx.strokeStyle = '#c8ccd4';
    ctx.beginPath();
    ctx.moveTo(fx - 4, fy - 30); ctx.lineTo(fx - 13, fy - 40);
    ctx.moveTo(fx + 4, fy - 30); ctx.lineTo(fx + 13, fy - 40);
    ctx.stroke();
  }
  const sx = fx - 15, sy = fy - 27, sw = 30, sh = 18;
  if (!on) {
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath();
    ctx.moveTo(sx + 4, sy + sh - 3); ctx.lineTo(sx + 13, sy + 3);
    ctx.stroke();
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx, sy, sw, sh);
  ctx.clip();
  drawTvScene(dev.channelId, sx, sy, sw, sh, Date.now());
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  ctx.strokeRect(sx, sy, sw, sh);
}

function drawTvScene(channelId, x, y, w, h, t) {
  const cx = x + w / 2, cy = y + h / 2;
  if (channelId === 'news') {
    ctx.fillStyle = '#1d4ed8'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#93c5fd'; ctx.fillRect(x + w * 0.58, y + 2, w * 0.38, h * 0.52);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 3; i++) ctx.fillRect(x + w * 0.62, y + 4 + i * 3, w * 0.3, 1.2);
    // the anchor: head + suit
    ctx.fillStyle = '#f1c27d';
    ctx.beginPath(); ctx.arc(x + w * 0.3, y + h * 0.42, 3.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1f2937'; ctx.fillRect(x + w * 0.3 - 5, y + h * 0.62, 10, h * 0.3);
    // scrolling ticker
    ctx.fillStyle = '#dc2626'; ctx.fillRect(x, y + h - 4.5, w, 4.5);
    ctx.fillStyle = '#fff';
    const off = (t / 60) % (w + 24);
    for (let i = 0; i < 3; i++) ctx.fillRect(x + w - off + i * 9, y + h - 3.2, 5, 1.6);
    // blinking LIVE dot
    if (Math.floor(t / 600) % 2 === 0) {
      ctx.fillStyle = '#ef4444';
      ctx.beginPath(); ctx.arc(x + w - 3, y + 3, 1.6, 0, Math.PI * 2); ctx.fill();
    }
  } else if (channelId === 'soap') {
    ctx.fillStyle = '#6d4c41'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#8d6e63'; ctx.fillRect(x, y + h * 0.55, w, h * 0.45);
    // two faces in profile, mid-argument (they bob at each other)
    const bobA = Math.sin(t / 300) * 0.8, bobB = Math.cos(t / 340) * 0.8;
    ctx.fillStyle = '#f1c27d';
    ctx.beginPath(); ctx.arc(x + w * 0.32, cy - 1 + bobA, 3.6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w * 0.68, cy - 1 + bobB, 3.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3e2723';
    ctx.beginPath(); ctx.arc(x + w * 0.32, cy - 3.4 + bobA, 3.8, Math.PI, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath(); ctx.arc(x + w * 0.68, cy - 3.4 + bobB, 3.8, Math.PI, Math.PI * 2); ctx.fill();
    // dialogue caption, cycling every 3s
    const lines = ['How could you, Brad?', 'The baby is YOURS.', 'We sail at dawn…', 'I never stopped…'];
    ctx.fillStyle = 'rgba(0,0,0,.78)'; ctx.fillRect(x, y + h - 6, w, 6);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 4.6px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(lines[Math.floor(t / 3000) % lines.length], cx, y + h - 1.6);
  } else if (channelId === 'cooking') {
    ctx.fillStyle = '#f59e0b'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#fbbf24'; ctx.fillRect(x, y, w, h * 0.45);
    // the pan, with dinner bobbing in it
    ctx.fillStyle = '#1f2937';
    ctx.beginPath(); ctx.ellipse(cx, y + h * 0.72, 9, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(cx + 8, y + h * 0.72 - 1, 6, 2);
    ctx.fillStyle = '#ef4444';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(cx - 4 + i * 4, y + h * 0.72 - 1.6 - Math.abs(Math.sin(t / 260 + i)) * 1.8, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // steam curls
    ctx.strokeStyle = 'rgba(255,255,255,.75)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const ph = ((t / 1300) + i * 0.5) % 1;
      ctx.globalAlpha = 0.7 * (1 - ph);
      ctx.beginPath();
      ctx.arc(cx - 3 + i * 6 + Math.sin(ph * 6) * 1.2, y + h * 0.6 - ph * 7, 1.6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else if (channelId === 'weather') {
    ctx.fillStyle = '#38bdf8'; ctx.fillRect(x, y, w, h);
    // sun with slow-spinning rays
    ctx.strokeStyle = '#fde047';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 6; i++) {
      const a = (t / 2400) + (i * Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(x + 7 + Math.cos(a) * 4.4, y + 6 + Math.sin(a) * 4.4);
      ctx.lineTo(x + 7 + Math.cos(a) * 6.4, y + 6 + Math.sin(a) * 6.4);
      ctx.stroke();
    }
    ctx.fillStyle = '#fde047';
    ctx.beginPath(); ctx.arc(x + 7, y + 6, 3.4, 0, Math.PI * 2); ctx.fill();
    // drifting cloud
    const cloudX = x + ((t / 90) % (w + 18)) - 9;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    ctx.beginPath();
    ctx.ellipse(cloudX, y + 6, 5, 2.4, 0, 0, Math.PI * 2);
    ctx.ellipse(cloudX + 3.4, y + 7.4, 3.6, 1.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = 'bold 8px system-ui';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText('24°', x + w - 13, y + h - 2.5);
  } else if (channelId === 'cartoon') {
    ctx.fillStyle = '#0f172a'; ctx.fillRect(x, y, w, h);
    // starfield (fixed pseudo-random dots)
    ctx.fillStyle = '#e2e8f0';
    for (let i = 0; i < 9; i++) {
      const px = x + ((i * 37) % 28) + 1, py = y + ((i * 23) % 15) + 1;
      ctx.fillRect(px, py, 1, 1);
    }
    // Captain Comet streaks across, looping
    const kx = x + ((t / 26) % (w + 16)) - 8;
    const ky = cy + Math.sin(t / 300) * 3;
    const grad = ctx.createLinearGradient(kx - 9, ky, kx, ky);
    grad.addColorStop(0, 'rgba(255,210,63,0)');
    grad.addColorStop(1, 'rgba(255,210,63,.85)');
    ctx.fillStyle = grad;
    ctx.fillRect(kx - 9, ky - 1, 9, 2);
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath(); ctx.arc(kx, ky, 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e5639e';
    ctx.beginPath(); ctx.arc(x + w - 5, y + h - 4, 3, 0, Math.PI * 2); ctx.fill();
  } else { // static
    ctx.fillStyle = '#111'; ctx.fillRect(x, y, w, h);
    for (let i = 0; i < 46; i++) {
      const g = Math.floor(Math.random() * 200) + 30;
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(x + Math.random() * w, y + Math.random() * h, 1.6, 1.6);
    }
  }
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
  // Phase 9 — eased camera with movement lookahead: the camera
  // glides toward (my projected position + a nudge in the facing
  // direction) instead of hard-locking, so big-map walking feels
  // like travelling, not dragging a window.
  if (!camState.init || mapDef !== camState.map) {
    camState = { x: fcx - W / 2, y: fcy - H / 2, init: true, map: mapDef };
  } else if (myRp) {
    const myPub = players.find(p => me && p.id === me.id);
    const look = { down: [0, 20], up: [0, -20], left: [-26, 10], right: [26, 10] }[myPub ? myPub.dir : 'down'] || [0, 0];
    const tx = fcx - W / 2 + (myRp.moving ? look[0] : 0);
    const ty = fcy - H / 2 + (myRp.moving ? look[1] : 0);
    camState.x += (tx - camState.x) * 0.09;
    camState.y += (ty - camState.y) * 0.09;
  }
  const camX = camState.x, camY = camState.y;

  ctx.save();
  ctx.translate(-camX, -camY);

  // floor + blocks in diagonal (painter) order. Lane C: tiles under
  // a building facade or a gatehouse tower are skipped — those
  // passes draw the real structure instead of per-tile cubes.
  const TS = mapDef.tileSize;
  const skipTiles = tileSkipSet();
  for (let s = 0; s <= mapDef.w + mapDef.h - 2; s++) {
    for (let tx = Math.max(0, s - (mapDef.h - 1)); tx <= Math.min(mapDef.w, s); tx++) {
      const ty = s - tx;
      if (ty < 0 || ty >= mapDef.h || tx >= mapDef.w) continue;
      if (skipTiles.has(tx + ',' + ty)) continue;
      drawTile(mapDef.rows[ty][tx], tx, ty);
    }
  }

  // Lane C: building facades — ONE quality building per enterable
  // place (pitched roof, glowing windows, real door in front).
  for (const b of mapDef.buildings || []) drawBuilding(b);

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
    cz.slots.forEach((s, idx) => {
      const [sx2, sy2] = proj(s.x, s.y);
      // Lane C: arcade cabinets. Facing comes from the stool spot
      // in the data: north row stools sit south of the machine,
      // east-wall stools sit west of it.
      drawSlotCabinet(sx2, sy2, idx, s.ix < s.x - 4 ? 'W' : 'S');
    });
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

  // studio furniture (Phase 4 + 8): colored iso blocks with the
  // item's icon glyph — drawn from the server's placed-furniture
  // list for THIS scene (studio instance) only. Phase 8: rugs draw
  // FIRST and flat (they're floor decor — under furniture and feet),
  // TVs get a live screen (see drawTvScreen), and a playing radio
  // floats music notes.
  const furnSorted = [...sceneFurniture].sort((a, b) => (a.type === 'rug' ? 0 : 1) - (b.type === 'rug' ? 0 : 1));
  for (const f of furnSorted) {
    const TS3 = mapDef.tileSize;
    const [fx, fy] = proj((f.x + 0.5) * TS3, (f.y + 0.5) * TS3);
    ctx.save();
    if (f.type === 'rug') {
      diamond(fx, fy, TS3 * ZOOM * 0.98, TS3 * ZOOM * 0.49, f.color || '#888');
      diamond(fx, fy, TS3 * ZOOM * 0.6, TS3 * ZOOM * 0.3, f.accent || '#555');
      ctx.restore();
      continue;
    }
    if (f.type === 'tv') {
      drawTelevision(f, fx, fy);
      ctx.restore();
      continue;
    }
    // Phase 10: the warm furniture — a lit hearth, a swag of string
    // lights, a porch lantern (all three join the night-glow pass).
    if (f.type === 'hearth') {
      drawHearthAt(fx, fy + 1, f.instanceId % 7);
      ctx.restore();
      continue;
    }
    if (f.type === 'lights') {
      drawStringLights(fx, fy + 6, f.instanceId % 4);
      ctx.restore();
      continue;
    }
    if (f.type === 'lantern') {
      drawLampAt(fx, fy + 2, true);
      ctx.restore();
      continue;
    }
    diamond(fx, fy - 3, TS3 * ZOOM * 0.92, TS3 * ZOOM * 0.46, f.color || '#888');
    ctx.font = '15px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(f.icon || '📦', fx, fy - 2);
    if (f.type === 'radio') {
      const dev = sceneDevices[f.instanceId];
      if (dev && dev.playing) {
        const nowR = Date.now();
        ctx.font = '11px system-ui';
        ctx.fillStyle = '#ffd23f';
        for (let i = 0; i < 2; i++) {
          const ph = ((nowR / 1400) + i * 0.5 + (f.instanceId % 5) * 0.17) % 1;
          ctx.globalAlpha = 0.85 * (1 - ph * 0.5);
          ctx.fillText(i ? '♫' : '♪', fx + Math.sin(ph * 5 + f.instanceId) * 6, fy - 16 - ph * 20);
        }
        ctx.globalAlpha = 1;
      }
    }
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
      // Lane C booth seating: a diner bench with a backrest on the
      // outer side and a wood table toward the facing dir — paired
      // café seats ring their table booth-style, like poker chairs.
      const off = { down: [0, 15], up: [0, -15], left: [-17, 7], right: [17, 7] }[s.dir] || [0, 15];
      diamond(sx3 - off[0] * 0.55, sy3 - off[1] * 0.55 - 2, 26, 8, '#7e2f3c'); // backrest
      diamond(sx3, sy3, 27, 9, '#b03a48');                                     // bench cushion
      diamond(sx3, sy3 - 3, 27, 7, '#c4505f');
      ctx.beginPath(); ctx.ellipse(sx3 + off[0], sy3 + off[1], 12, 6, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#caa06a'; ctx.fill();
      ctx.strokeStyle = '#7a5a2b'; ctx.lineWidth = 1; ctx.stroke();
    } else if (s.kind === 'hookah') {
      // Lane C: low booth benches flanking the station's low table.
      diamond(sx3, sy3, 30, 10, '#5d3450');
      diamond(sx3, sy3 - 4, 30, 7, '#7a4666');
    } else { // chair
      diamond(sx3, sy3, 12, 6, '#6e4a26');
      diamond(sx3, sy3 - 4, 12, 5, '#8a5a2b');
    }
  }

  // Lane C: gateHOUSES, not pads — stone towers, a signed lintel,
  // lanterns, and big double doors that swing open on approach.
  // The transfer still fires server-side at the inner threshold
  // (the gateway rect), masked by the swing + the warm load screen.
  for (const { g, open, gm } of tickGatehouses()) drawGatehouse(g, open, gm);

  // warm map dressing (Phase 10): hearths, lamps, lanterns, string
  // lights and nook rugs baked into the map data.
  for (const pr of mapDef.props || []) drawProp(pr);

  // doors (Phase 10): REAL doors — framed, swinging, named. They
  // open as anyone approaches and close behind them; the transfer
  // itself still fires server-side on the door tile, masked by the
  // swing + the warm load screen.
  for (const { d, open } of tickDoors()) drawDoor(d, open);

  // entities, depth-sorted by x+y
  const now = Date.now();
  const sorted = [...players].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  for (const p of sorted) {
    const rp = renderPos.get(p.id);
    if (!rp) continue;
    const [sx, sy] = proj(rp.x, rp.y);
    let bob = rp.moving ? Math.abs(Math.sin(now / 110 + p.id)) * 3 : 0;
    // Phase 9: dancing is a whole-body bounce (anywhere, anytime).
    if (p.emote === 'dance') bob += Math.abs(Math.sin(now / 130 + p.id * 1.3)) * 6;

    // soft ground shadow (scales with the character footprint)
    ctx.beginPath();
    ctx.ellipse(sx, sy, 13 * CHAR_SCALE, 6 * CHAR_SCALE, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    ctx.fill();

    const dirKey = p.dir === 'up' ? 'up' : p.dir === 'down' ? 'down' : 'side';
    // Phase 6: the snapshot player IS the full appearance object —
    // pass it straight to the sprite renderer. Phase B: seated
    // players get the seated leg variant and sit a touch lower.
    const spr = Sprites.makeSprite(p, dirKey, p.seated ? { seated: true } : undefined);
    const sw = spr.width, sh = spr.height;
    // Lane B playtest: the on-screen size is CHAR_SCALE x the sprite
    // canvas. The feet stay anchored (drawImage bottom sits at the
    // same +4 as before), and every head-anchored overlay below uses
    // dh so nameplates, bubbles and glyphs ride the taller sprite.
    const dw = sw * CHAR_SCALE, dh = sh * CHAR_SCALE;
    // Phase B amendment — drunk sway (render-side mirror of the
    // server wobble) and the passed-out fallen pose.
    const sway = (!p.fallen && p.drinks >= 2)
      ? Math.sin(now / 280 + p.id * 2.1) * Math.min(5, p.drinks * 0.7)
      : 0;
    ctx.save();
    if (p.fallen) {
      ctx.translate(sx, sy - 3);
      ctx.rotate(-1.45); // flat on the floor, visible to everyone
      ctx.drawImage(spr, -dw / 2, -dh + 8, dw, dh);
    } else {
      ctx.translate(sx + sway, sy - bob + (p.seated ? 3 : 0));
      if (p.dir === 'right') ctx.scale(-1, 1); // side sprite faces left natively; flip for right
      ctx.drawImage(spr, -dw / 2, -dh + 4, dw, dh);
    }
    ctx.restore();

    // performer holds the mic (soul doc §9.3)
    if (p.performing) {
      ctx.font = '15px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('🎤', sx + 13 * CHAR_SCALE, sy - 12 * CHAR_SCALE - bob);
    }

    // Phase B amendment — drink bubbles float up around drinkers
    // (everyone sees them), and hippies get their peace sign.
    if (p.drinks > 0 && !p.fallen) {
      for (let i = 0; i < 3; i++) {
        const ph = ((now / 950) + i * 0.33 + (p.id % 7) * 0.13) % 1;
        const bx = sx + Math.sin(ph * 4 + p.id + i * 2) * 9 * CHAR_SCALE;
        const by = sy - dh - 2 - ph * 26;
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
      ctx.fillText('☮️', sx, sy - dh - 20 - bob);
    }

    // Phase 9 — emote glyph floats beside the name while it lasts.
    if (p.emote) {
      const glyph = { wave: '👋', dance: '🎵', laugh: '😂', thumbsup: '👍' }[p.emote];
      if (glyph) {
        ctx.font = '15px system-ui';
        ctx.textAlign = 'center';
        const wob = p.emote === 'wave' ? Math.sin(now / 90 + p.id) * 3 : 0;
        ctx.fillText(glyph, sx + 16 + wob, sy - dh - 8 - bob);
      }
    }

    // name
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.lineWidth = 3;
    ctx.strokeText(p.name, sx, sy - dh - 6 - bob);
    ctx.fillText(p.name, sx, sy - dh - 6 - bob);

    // speech bubble (Phase 9: fades out over its last 900ms)
    const b = bubbles.get(p.id);
    if (b && b.until > now) {
      const remain = b.until - now;
      const alpha = Math.min(1, remain / 900);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = '12px system-ui';
      const text = b.text.slice(0, 30);
      const w = Math.min(ctx.measureText(text).width + 16, 200);
      const bx = sx - w / 2, by = sy - dh - 40 - bob;
      ctx.fillStyle = 'rgba(255,255,255,.96)';
      ctx.beginPath();
      ctx.roundRect(bx, by, w, 24, 8);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sx - 5, by + 24); ctx.lineTo(sx + 5, by + 24); ctx.lineTo(sx, by + 31);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#1a2238';
      ctx.fillText(text, sx, by + 16);
      ctx.restore();
    }
  }

  // Phase 9 — day/night: lay the darkness over the world, then let
  // the lamps punch back through it (arches, doors, stage rig).
  // Cozy pass: the night tint is warm plum, not cold navy, and
  // golden hour washes the world amber at sunrise/sunset.
  const dark = darknessNow();
  const gold = goldenNow();
  if (dark > 0.01 || gold > 0.005) {
    if (dark > 0.01) {
      ctx.fillStyle = `rgba(32,18,36,${dark})`;
      ctx.fillRect(camX, camY, W, H);
    }
    if (gold > 0.005) {
      ctx.fillStyle = `rgba(255,146,60,${gold})`;
      ctx.fillRect(camX, camY, W, H);
    }
  }
  if (dark > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = (wx, wy, r, a) => {
      const [gx, gy] = proj(wx, wy);
      const g = ctx.createRadialGradient(gx, gy, 2, gx, gy, r);
      g.addColorStop(0, `rgba(255,205,110,${a})`);
      g.addColorStop(1, 'rgba(255,205,110,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(gx, gy, r, 0, Math.PI * 2);
      ctx.fill();
    };
    for (const gwd of mapDef.gateways || []) glow(gwd.x + gwd.w / 2, gwd.y + gwd.h / 2, 90, 0.30);
    for (const d of mapDef.doors || []) glow(d.x + d.w / 2, d.y + d.h / 2, 70, 0.26);
    if (mapDef.stage) glow(mapDef.stage.x + mapDef.stage.w / 2, mapDef.stage.y + mapDef.stage.h / 2, 130, 0.18);
    // Phase 10: hearths, lamps, lanterns and string lights — in the
    // map dressing, in placed home furniture, and beside a home's
    // own door — all punch warm holes in the night.
    for (const pr of mapDef.props || []) {
      if (pr.kind === 'hearth') glow(pr.x, pr.y - 12, 95, 0.30);
      else if (pr.kind === 'lamp' || pr.kind === 'lantern' || pr.kind === 'stringlights') glow(pr.x, pr.y - 14, 62, 0.24);
      // Lane C heroes that burn at night: the lighthouse lamp, the
      // great NEON sign, the forge's embers. (Equal x/y offsets
      // project to straight screen-up, onto the drawn light source.)
      else if (pr.kind === 'lighthouse') glow(pr.x - 100, pr.y - 100, 115, 0.34);
      else if (pr.kind === 'neonsign') glow(pr.x - 88, pr.y - 88, 95, 0.22);
      else if (pr.kind === 'forge') glow(pr.x, pr.y - 14, 70, 0.26);
    }
    // Lane C: slot marquees hum in the dark, and lit facade windows
    // warm the street in front of every real building.
    if (mapDef.casino) {
      for (const s of mapDef.casino.slots) glow(s.x - 64, s.y - 64, 52, 0.15);
    }
    const TSb = mapDef.tileSize || 32;
    for (const b of mapDef.buildings || []) {
      glow((b.tx + b.tw / 2) * TSb, (b.ty + b.th) * TSb - 6, 85, 0.13);
    }
    if (mapDef.studio && mapDef.studio.door) {
      const sd = mapDef.studio.door;
      glow(sd.x + sd.w / 2, sd.y, 80, 0.30);
    }
    const TSg = mapDef.tileSize || 32;
    for (const f of sceneFurniture) {
      if (f.type === 'hearth') glow((f.x + 0.5) * TSg, (f.y + 0.5) * TSg - 10, 90, 0.30);
      else if (f.type === 'lamp' || f.type === 'lantern' || f.type === 'lights') {
        glow((f.x + 0.5) * TSg, (f.y + 0.5) * TSg - 12, 60, 0.22);
      }
    }
    ctx.restore();
  }

  // Phase 10: the crackle follows the fire — café and hookah-lounge
  // hearths are always lit; in a home, a placed fireplace lights it.
  if (window.SolarionSfx) {
    const hearthHere = mapDef.id === 'gateway-cafe' || mapDef.id === 'hookah-lounge'
      || Boolean(mapDef.studio && sceneFurniture.some(f => f.type === 'hearth'));
    window.SolarionSfx.setHearth(hearthHere);
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
  Wake.show('Waking the world…');
  Wake.progress(15);
  api('/api/me', { token })
    .then((r) => enterWorld(r.avatar))
    .catch(() => { localStorage.removeItem('solarion_token'); token = null; Wake.hide(); });
} else {
  Wake.hide(); // fresh visit: the auth card is the front door
}
setMode('login');

// ------------------------------------------------------------------
// Phase 9 — audio unlock (audibility hardening). Browsers create an
// AudioContext SUSPENDED when it is born outside a user gesture —
// and performance-start / home-device arrive over the WebSocket, not
// from a click — so scheduled playback could be silently swallowed
// for everyone in the room, the performer included. Any gesture
// anywhere unlocks/resumes the shared engine, after which every
// scheduled performance and radio track actually sounds.
for (const evName of ['pointerdown', 'keydown', 'touchstart']) {
  addEventListener(evName, () => {
    if (window.SolarionMixer) { /* AE lives in mixer.js */ }
    try { if (typeof AE !== 'undefined' && AE.ensure()) AE.ctx.resume(); } catch (e) { /* no audio */ }
    if (window.SolarionSfx) window.SolarionSfx.unlock();
  }, { passive: true });
}
