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
const castFx = new Map();    // v1.2: playerId -> { landX, landY, ice, at } for cast animation
let keys = { up: false, down: false, left: false, right: false };
let lastSentKeys = '';
let coins = 0;
let dayCycle = null; // Phase 9: { periodMs, anchor } — world clock
let season = null; // Seasonal themes: 'halloween' | 'christmas' | null, server-owned (src/seasons.js)
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
  // Hearth v3 (v1.2.3, Item 6 — Zan: "fireplaces need to be big"):
  // a proper CHIMNEY BREAST about three tiles across — a broad
  // stone hearth floor, a wide brick body with a breast column
  // rising above a deep mantel shelf, a LARGE firebox with big
  // flames, and a glow pool that spills well into the room. The
  // fireplace is the room's anchor; it should read from across
  // the room, not as a little stove in the corner. (The night
  // pass adds its own wide glow: see the hearth entries below.)
  const t = Date.now();
  diamond(x, y + 6, 106, 38, '#4c3a2c'); // stone hearth floor (outer)
  diamond(x, y + 3, 94, 32, '#5a4636');   // stone hearth floor (inner)
  // warm glow pool on the floor in front of the fire
  const grd = ctx.createRadialGradient(x, y + 10, 8, x, y + 10, 112);
  grd.addColorStop(0, 'rgba(255,150,50,.22)');
  grd.addColorStop(1, 'rgba(255,150,50,0)');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.ellipse(x, y + 10, 112, 46, 0, 0, Math.PI * 2); ctx.fill();
  // the chimney breast: a narrower brick column rising above the
  // mantel, so the fireplace has height as well as width
  ctx.fillStyle = '#654631';
  ctx.fillRect(x - 30, y - 94, 60, 42);
  ctx.fillStyle = 'rgba(0,0,0,.18)';    // breast brick courses
  for (let i = 0; i < 4; i++) ctx.fillRect(x - 30, y - 86 + i * 10, 60, 1.6);
  ctx.fillStyle = '#6e4a3a';
  ctx.fillRect(x - 47, y - 54, 94, 52); // brick body
  ctx.fillStyle = 'rgba(0,0,0,.18)';    // brick courses
  for (let i = 0; i < 5; i++) ctx.fillRect(x - 47, y - 45 + i * 10, 94, 1.6);
  ctx.fillStyle = '#54382a';
  ctx.fillRect(x - 53, y - 61, 106, 8); // mantel shelf
  ctx.fillStyle = '#ffd9a0';
  ctx.fillRect(x - 53, y - 54, 106, 2); // mantel's warm trim line
  ctx.fillStyle = '#160b06';
  ctx.fillRect(x - 27, y - 47, 54, 45); // firebox — big enough to sit by
  ctx.fillStyle = '#3a2415';
  ctx.fillRect(x - 19, y - 13, 38, 6);  // logs
  ctx.fillRect(x - 14, y - 20, 29, 6);
  const tongue = (i, w, h, col) => {
    const fx = x + Math.sin(t / 130 + seed * 3 + i * 2.2) * 2.2;
    const fh = h * (0.85 + 0.3 * Math.abs(Math.sin(t / 170 + seed + i * 1.7)));
    ctx.beginPath();
    ctx.ellipse(fx, y - 7 - fh / 2, w, fh / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  };
  tongue(0, 18, 42, 'rgba(255,110,26,.9)');
  tongue(1, 12.5, 33, 'rgba(255,176,66,.95)');
  tongue(2, 7, 24, 'rgba(255,233,163,1)');
}

function drawStringLights(x, y, seed, cols) {
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
  const palette = cols || ['#ffd9a0', '#ffb84d', '#ff9d7a', '#ffe9a3'];
  const night = darknessNow() > 0.03;
  for (let i = 1; i < 12; i++) {
    const [bx, by] = pts[i];
    ctx.beginPath(); ctx.arc(bx, by + 2.5, night ? 3 : 2.4, 0, Math.PI * 2);
    ctx.fillStyle = palette[(i + seed) % palette.length];
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

// ------------------------------------------------------------------
// Seasonal props (server-driven overlay, src/seasons.js): Halloween
// (Oct) and Christmas (Dec). Same canvas vocabulary as the warm
// props — shapes, no assets. Lit faces join the night-glow pass.
function drawPumpkinAt(x, y, lit, s = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath(); ctx.ellipse(0, 3, 13, 4.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fill();
  // ribbed body: three overlapping ellipses read as pumpkin lobes
  ctx.fillStyle = '#c85f16';
  ctx.beginPath(); ctx.ellipse(-6, -3, 6.5, 7.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(6, -3, 6.5, 7.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e8721e';
  ctx.beginPath(); ctx.ellipse(0, -3.5, 7.5, 8.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(120,50,5,.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(0, -3.5, 3.6, 8.3, 0, 0, Math.PI * 2); ctx.stroke();
  // stem
  ctx.fillStyle = '#5d7d43';
  ctx.fillRect(-1.6, -14.5, 3.4, 4.5);
  if (lit) {
    // carved face, lit from inside — flickers a touch off the clock
    const fl = 0.85 + 0.15 * Math.sin(Date.now() / 140 + x * 0.7);
    ctx.fillStyle = `rgba(255,214,110,${fl})`;
    ctx.beginPath(); // left eye
    ctx.moveTo(-6.5, -7); ctx.lineTo(-2.5, -7); ctx.lineTo(-4.5, -3.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); // right eye
    ctx.moveTo(2.5, -7); ctx.lineTo(6.5, -7); ctx.lineTo(4.5, -3.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); // grin
    ctx.moveTo(-6, 0.5); ctx.lineTo(-2.5, 2.6); ctx.lineTo(0, 0.8);
    ctx.lineTo(2.5, 2.6); ctx.lineTo(6, 0.5); ctx.lineTo(4, 4); ctx.lineTo(-4, 4);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawPumpkinStackAt(x, y) {
  // The Gateway centerpiece: a composed pyramid, jack on top.
  drawPumpkinAt(x - 11, y, false, 0.95);
  drawPumpkinAt(x + 11, y, false, 0.95);
  drawPumpkinAt(x, y - 13, true, 1.05);
}

function drawCobwebAt(x, y) {
  // A web fanning from the point's top-left — corners and eaves.
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = 'rgba(235,240,248,.55)';
  ctx.lineWidth = 1;
  const R = 26;
  const spokes = [0, Math.PI / 6, Math.PI / 3, Math.PI / 2];
  for (const a of spokes) {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx.stroke();
  }
  for (const rr of [9, 16, 23]) {
    ctx.beginPath();
    for (let i = 0; i < spokes.length; i++) {
      const a = spokes[i];
      const sag = rr * 0.16;
      const px2 = Math.cos(a) * rr, py2 = Math.sin(a) * rr + (i > 0 && i < spokes.length - 1 ? sag : 0);
      if (i === 0) ctx.moveTo(px2, py2); else ctx.lineTo(px2, py2);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawWreathAt(x, y) {
  ctx.save();
  ctx.translate(x, y - 12);
  ctx.beginPath(); ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
  ctx.strokeStyle = '#2c6e33'; ctx.lineWidth = 5.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(67,163,85,.8)'; ctx.lineWidth = 2; ctx.stroke();
  const berries = [[-6, -5], [5, -7], [8, 3], [-8, 3], [0, 9], [3, -1]];
  ctx.fillStyle = '#d93a2b';
  for (const [bx, by] of berries) {
    ctx.beginPath(); ctx.arc(bx, by, 1.7, 0, Math.PI * 2); ctx.fill();
  }
  // a little gold bow at the base
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(-4.5, 5.5); ctx.lineTo(-4.5, 12); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 9); ctx.lineTo(4.5, 5.5); ctx.lineTo(4.5, 12); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawGiftPileAt(x, y) {
  // A deliberate little arrangement: two boxes down, one up top,
  // each ribboned — NOT scatter (v1.2 Item Q's lesson).
  ctx.beginPath(); ctx.ellipse(x, y + 3, 17, 5.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.20)'; ctx.fill();
  const gift = (gx, gy, w, h, body, ribbon) => {
    ctx.fillStyle = body;
    ctx.fillRect(gx - w / 2, gy - h, w, h);
    ctx.fillStyle = ribbon;
    ctx.fillRect(gx - 1.6, gy - h, 3.2, h);
    ctx.fillRect(gx - w / 2, gy - h - 2.2, w, 3);
    ctx.fillStyle = ribbon;
    ctx.beginPath(); ctx.ellipse(gx - 2.6, gy - h - 3.4, 2.6, 1.6, -0.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(gx + 2.6, gy - h - 3.4, 2.6, 1.6, 0.5, 0, Math.PI * 2); ctx.fill();
  };
  gift(x - 8, y + 2, 15, 10, '#b03030', '#ffd23f');
  gift(x + 8, y + 2, 13, 8, '#2c6e33', '#ffe9a3');
  gift(x, y - 8, 11, 8, '#31579e', '#ff8fab');
}

function drawSnowmanAt(x, y) {
  ctx.beginPath(); ctx.ellipse(x, y + 3, 13, 4.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(20,40,70,.20)'; ctx.fill();
  const ball = (bx, by, r) => {
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = '#f4f9ff'; ctx.fill();
    ctx.strokeStyle = 'rgba(140,180,220,.6)'; ctx.lineWidth = 1; ctx.stroke();
  };
  ball(x, y - 4, 9.5);
  ball(x, y - 17, 7);
  ball(x, y - 28, 5.4);
  // stick arms
  ctx.strokeStyle = '#6e4a2c'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(x - 6, y - 18); ctx.lineTo(x - 14, y - 24); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 6, y - 18); ctx.lineTo(x + 14, y - 25); ctx.stroke();
  // coal eyes + carrot nose + buttons
  ctx.fillStyle = '#20242c';
  ctx.beginPath(); ctx.arc(x - 1.9, y - 29, 0.9, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + 1.9, y - 29, 0.9, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 17, 1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x, y - 12, 1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e8721e';
  ctx.beginPath(); ctx.moveTo(x + 1, y - 27.5); ctx.lineTo(x + 8, y - 26); ctx.lineTo(x + 1, y - 25); ctx.closePath(); ctx.fill();
  // scarf
  ctx.fillStyle = '#b03030';
  ctx.fillRect(x - 5, y - 24.5, 10, 2.8);
  ctx.fillRect(x + 2.5, y - 24, 3, 6);
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
    case 'table': drawTableAt(px2, py2); break;
    case 'volleyball': drawVolleyballAt(px2, py2); break;
    case 'umbrella': drawUmbrellaAt(px2, py2); break;
    case 'stall': drawStallAt(px2, py2, (pr.x + pr.y) % 5); break;
    case 'pumpkin': drawPumpkinAt(px2, py2, false); break;
    case 'jackolantern': drawPumpkinAt(px2, py2, true); break;
    case 'pumpkinstack': drawPumpkinStackAt(px2, py2); break;
    case 'cobweb': drawCobwebAt(px2 - 13, py2 - 26); break;
    case 'wreath': drawWreathAt(px2, py2); break;
    case 'giftpile': drawGiftPileAt(px2, py2); break;
    case 'snowman': drawSnowmanAt(px2, py2); break;
    case 'holidaylights': drawStringLights(px2, py2, Math.round(pr.x / 32) % 4,
      ['#ff5a4d', '#57d95d', '#ffd23f', '#5ab0ff', '#ff8fab']); break;
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
    ctx.ellipse(fx, y - 7 - fh / 2, w, fh / 2, 0, 0, Math.PI * 2);
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

/** v1.2 (Item L): a beach volleyball net — two poles, a sagging
 *  net, and the ball resting in the sand beside it. One prop,
 *  drawn wide across its tile. Decorative only. */
function drawVolleyballAt(x, y) {
  ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - 30, y + 4); ctx.lineTo(x - 30, y - 30);
  ctx.moveTo(x + 30, y + 4); ctx.lineTo(x + 30, y - 30);
  ctx.stroke();
  // the net: a light grid with a gentle sag
  ctx.strokeStyle = 'rgba(245,240,230,.85)'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4, sag = Math.sin(t * Math.PI) * 3;
    ctx.beginPath(); ctx.moveTo(x - 30 + t * 60, y - 30 + sag); ctx.lineTo(x - 30 + t * 60, y - 16 + sag); ctx.stroke();
  }
  for (let j = 0; j <= 2; j++) {
    ctx.beginPath();
    ctx.moveTo(x - 30, y - 30 + j * 7);
    ctx.quadraticCurveTo(x, y - 30 + j * 7 + 3, x + 30, y - 30 + j * 7);
    ctx.stroke();
  }
  ctx.strokeStyle = '#e2543e'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x - 30, y - 30); ctx.quadraticCurveTo(x, y - 27, x + 30, y - 30); ctx.stroke();
  // the ball, resting by the east pole
  ctx.beginPath(); ctx.arc(x + 22, y + 6, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#f5f0e6'; ctx.fill();
  ctx.strokeStyle = '#e2543e'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(x + 22, y + 6, 5, -0.6, 1.1); ctx.stroke();
}

/** v1.2 (Item L) + v1.3.1 (Item 13): a beach umbrella — pole and
 *  a BIG scalloped canopy in warm coral. The towel is no longer
 *  part of the prop: it's a real SEAT beside the pole now (drawn
 *  in the seat pass), sized so a character actually fits on it. */
function drawUmbrellaAt(x, y) {
  ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, y + 8); ctx.lineTo(x - 4, y - 34); ctx.stroke();
  // canopy: a wide shallow dome of alternating coral/cream panels
  ctx.beginPath();
  ctx.moveTo(x - 40, y - 31);
  ctx.quadraticCurveTo(x - 4, y - 56, x + 32, y - 31);
  ctx.quadraticCurveTo(x + 20, y - 26, x + 10, y - 30);
  ctx.quadraticCurveTo(x - 4, y - 26, x - 18, y - 30);
  ctx.quadraticCurveTo(x - 30, y - 26, x - 40, y - 31);
  ctx.closePath();
  ctx.fillStyle = '#e86a5a'; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 18, y - 30);
  ctx.quadraticCurveTo(x - 4, y - 47, x + 10, y - 30);
  ctx.quadraticCurveTo(x - 4, y - 27, x - 18, y - 30);
  ctx.closePath();
  ctx.fillStyle = '#f5e8d2'; ctx.fill();
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.arc(x - 4, y - 47, 3, 0, Math.PI * 2); ctx.fill();
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
  club:   { wall: '#5a2547', wallDark: '#46203a', roof: '#2c1030', trim: '#ff5da2' },
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
  const H = (b.style === 'casino' || b.style === 'neon' || b.style === 'club') ? 54 : 44;
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
  // Christmas: snow settles on the roof — a soft cap over the
  // sun-facing slope and a bright line along the ridge.
  if (season === 'christmas' && mapDef.id !== 'frosthaven') {
    if (b.tw >= b.th) {
      const rW = up(mid(NWt, SWt), roofH), rE = up(mid(NEt, SEt), roofH);
      poly([SWt, SEt, rE, rW], 'rgba(244,249,255,.22)');
      ctx.strokeStyle = 'rgba(244,249,255,.8)'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(...rW); ctx.lineTo(...rE); ctx.stroke();
    } else {
      const rN = up(mid(NWt, NEt), roofH), rS = up(mid(SWt, SEt), roofH);
      poly([NEt, SEt, rS, rN], 'rgba(244,249,255,.22)');
      ctx.strokeStyle = 'rgba(244,249,255,.8)'; ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(...rN); ctx.lineTo(...rS); ctx.stroke();
    }
  }
  // Club Mirage (v1.4): the neon sign — a marquee ABOVE the front
  // door (centred on the door, its board clear of the 47px leaf):
  // a dark board, a buzzing pink border, the name in pink/cyan.
  if (b.style === 'club') {
    let scx = (SW[0] + SE[0]) / 2, scy = (SW[1] + SE[1]) / 2 - H * 0.58;
    const dr = (mapDef.doors || []).find(d2 => d2.label === 'Club Mirage'); // clientMap strips door.target — label is the key that survives
    if (dr) {
      const [dcx, dcy] = proj(dr.x + dr.w / 2, dr.y + dr.h / 2);
      scx = dcx; scy = dcy - 47 - 34 - 17; // leaf top + clear air (the leaf paints over the board if they touch — parent review 2026-10-22), half the board
    }
    const flick = Math.sin(Date.now() / 90 + b.tx) > -0.92 ? 1 : 0.35;
    if (darknessNow() > 0.03) { // the sign throws a warm pink pool after dark
      const grd = ctx.createRadialGradient(scx, scy, 6, scx, scy, 130);
      grd.addColorStop(0, 'rgba(255,93,162,.20)');
      grd.addColorStop(1, 'rgba(255,93,162,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(scx, scy, 130, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#160a24';
    ctx.beginPath(); ctx.roundRect(scx - 86, scy - 17, 172, 34, 8); ctx.fill();
    ctx.strokeStyle = '#ff2e88'; ctx.lineWidth = 2;
    ctx.globalAlpha = flick;
    ctx.beginPath(); ctx.roundRect(scx - 83, scy - 14, 166, 28, 7); ctx.stroke();
    ctx.globalAlpha = 1;
    const chase = Math.floor(Date.now() / 280);
    for (let i = 0; i < 9; i++) {
      const bx2 = scx - 72 + i * 18;
      for (const by2 of [scy - 12, scy + 12]) {
        ctx.beginPath(); ctx.arc(bx2, by2, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = (i + chase) % 2 ? '#ff2e88' : '#37e0ff';
        ctx.globalAlpha = flick; ctx.fill(); ctx.globalAlpha = 1;
      }
    }
    ctx.font = 'bold 17px system-ui';
    ctx.textAlign = 'center';
    ctx.globalAlpha = flick;
    const word = 'CLUB MIRAGE';
    const widths = [...word].map(chL => ctx.measureText(chL).width);
    let lx = scx - widths.reduce((a, w) => a + w, 0) / 2;
    [...word].forEach((chL, i) => {
      ctx.fillStyle = i % 2 ? '#37e0ff' : '#ff5da2';
      ctx.fillText(chL, lx + widths[i] / 2, scy + 6);
      lx += widths[i];
    });
    ctx.globalAlpha = 1;
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


// ------------------------------------------------------------------ v1.1.1: cards ON the felt
// The hand renders in the world now (no sidebar): community cards
// and the pot on the felt, hole-card backs in front of live seats,
// your own hole cards face-up at your chair, bets as gold text on
// the felt path, showdown reveals face-up. State comes straight
// from the casino client's poker-state store.
// A card face at an explicit size. The mini (12x16) is the
// original hole-card rendering; v1.5 adds BIG faces for the
// community board (Feature 1: "on screen kinda like the slot
// machines" — the slot glass draws ~42px faces; the board cards
// are drawn at a fixed screen size like all furniture art, so
// they stay readable while the world scales at ZOOM 0.72).
function drawCardFace(x, y, w, h, text, isBack) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  const r = Math.min(4, w * 0.18);
  if (ctx.roundRect) ctx.roundRect(-w / 2, -h / 2, w, h, r); else ctx.rect(-w / 2, -h / 2, w, h);
  if (isBack) {
    ctx.fillStyle = '#7a1f2b'; ctx.fill();
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,210,63,.45)'; ctx.lineWidth = 0.8;
    ctx.strokeRect(-w / 2 + 2.5, -h / 2 + 2.5, w - 5, h - 5);
  } else {
    ctx.fillStyle = '#f5f0e6'; ctx.fill();
    ctx.strokeStyle = 'rgba(20,10,30,.6)'; ctx.lineWidth = 0.9; ctx.stroke();
    const t = String(text || '');
    const suit = t.slice(-1);
    const rank = t.slice(0, -1) || t;
    const red = /[♥♦]/.test(suit);
    ctx.textAlign = 'center';
    ctx.fillStyle = red ? '#c22f3d' : '#23202b';
    if (w >= 20) {
      // Big face: rank over suit, like a real card corner blown up.
      ctx.font = `bold ${Math.round(h * 0.38)}px system-ui`;
      ctx.fillText(rank, 0, -h * 0.02);
      ctx.font = `${Math.round(h * 0.36)}px system-ui`;
      ctx.fillText(suit, 0, h * 0.36);
    } else {
      ctx.font = `bold ${(t || '').length > 2 ? 6.5 : 8.5}px system-ui`;
      ctx.fillText(t || '', 0, 3.2);
    }
  }
  ctx.restore();
}

function drawMiniCard(x, y, text, isBack) {
  drawCardFace(x, y, 12, 16, text, isBack);
}

function drawFeltState(t, tx2, ty2) {
  const C = window.SolarionCasino;
  const st = C && C.tables ? C.tables.get(t.id) : null;
  if (!st) { ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillText('♠ ♥ ♦ ♣', tx2, ty2 + 3); return; }
  const comm = st.community || [];
  // The board itself (plaque + community cards + pot + winners)
  // is drawn by drawBoardOverlay AFTER the entity pass — a
  // seated player's tall sprite otherwise buries the first board
  // cards (proven in the v1.5 playtest captures). Here in the
  // furniture pass we only mark an idle table's felt.
  const handLive = ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(st.state);
  if (!comm.length && !handLive) { ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillText('♠ ♥ ♦ ♣', tx2, ty2 + 3); }
  (t.chairs || []).forEach((ch3, ci) => {
    const cst = st.chairs && st.chairs[ci];
    if (!cst || !cst.name) return;
    const [cx9, cy9] = proj(ch3.x, ch3.y);
    if (cst.acting) {
      ctx.beginPath(); ctx.ellipse(cx9, cy9, 19, 10, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,210,63,.9)'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.font = '8.5px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,233,168,.85)';
    if (Number.isFinite(cst.chips)) ctx.fillText(`${cst.chips}z`, cx9, cy9 + 18);
    const mx = cx9 + (tx2 - cx9) * 0.42, my = cy9 + (ty2 - cy9) * 0.42;
    if (cst.bet) {
      ctx.font = 'bold 9px system-ui'; ctx.fillStyle = '#ffe9a8';
      ctx.fillText(`${cst.bet}z`, mx, my - 10);
    }
    const handLive = st.state !== 'idle' && st.state !== 'countdown' && st.state !== 'done';
    const rev = (st.reveal || []).find((r) => r.name === cst.name);
    const isMine = C.mySeat && C.mySeat.tableId === t.id && C.mySeat.chairIdx === ci;
    const cards = rev ? rev.cards : (isMine ? (C.myCards[t.id] || null) : null);
    if (cards && cards.length) {
      cards.forEach((card, i) => drawMiniCard(mx + (i - 0.5) * 13.5, my + 2, card, false));
    } else if (handLive && !cst.folded) {
      drawMiniCard(mx - 7, my + 2, null, true);
      drawMiniCard(mx + 7, my + 2, null, true);
    }
  });
}

// v1.5 (Feature 1): THE BOARD ON THE TABLE — post-entity overlay.
// The community cards rendered BIG on the felt, slot-glass style,
// on a dark plaque with a brass rim so they read at play zoom for
// players AND spectators. Fixed screen size (like all furniture
// art): the plaque deliberately spills past the little felt oval.
// Drawn AFTER the entity pass on purpose: characters are 1.5x and
// a south sitter's sprite reaches back over the felt — in the
// furniture pass it buried the first two board cards (v1.5
// playtest capture, casino-lounge sit-board). During a live hand
// the undealt slots show face-down backs, so the board visibly
// fills in street by street; preflop = five backs.
function drawBoardOverlay(t, tx2, ty2) {
  const C = window.SolarionCasino;
  const st = C && C.tables ? C.tables.get(t.id) : null;
  if (!st) return;
  const comm = st.community || [];
  const handLive = ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(st.state);
  if (!comm.length && !handLive) return;
  const bw = 24.5; // card pitch; cards are 22x31
  ctx.save();
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(tx2 - 63, ty2 - 14, 126, 38, 7); else ctx.rect(tx2 - 63, ty2 - 14, 126, 38);
  ctx.fillStyle = '#20242e'; ctx.fill();
  ctx.strokeStyle = '#c99700'; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.restore();
  for (let i = 0; i < 5; i++) {
    const cxB = tx2 + (i - 2) * bw;
    if (i < comm.length) drawCardFace(cxB, ty2 + 5, 22, 31, comm[i], false);
    else drawCardFace(cxB, ty2 + 5, 22, 31, null, true);
  }
  ctx.textAlign = 'center';
  if (st.pot) {
    ctx.font = 'bold 10.5px system-ui'; ctx.fillStyle = '#ffd23f';
    ctx.fillText(st.solo && st.houseMatch ? `POT ${st.pot}z · house matched ${st.houseMatch}z 🏠` : `POT ${st.pot}z`, tx2, ty2 - 21);
  }
  if (st.winners && st.winners.length) {
    ctx.font = 'bold 10px system-ui'; ctx.fillStyle = '#8dff9a';
    ctx.fillText(`🏆 ${st.winners.map((w) => `${w.name} +${w.amount}z`).join(' · ')}`, tx2, ty2 - 33);
  }
}

// v1.5 (Feature 3): blackjack ON the table — dealer row across
// the far edge of the felt, each seat's hand in front of its
// chair, bets and results as felt text. Same fixed-screen-size
// card language as the poker board, a touch smaller (hands are
// per-seat, not shared). State: SolarionBlackjack's store, in
// the server's blackjack-state shape (chairs carry hand /
// handTotal / bet / result; nets live in the table-level
// results list; the dealer's hole card arrives as null).
const BJ_RESULT_LABEL = {
  blackjack: ['★ BLACKJACK!', '#8dff9a'], win: ['WIN', '#8dff9a'], 'dealer-bust': ['DEALER BUSTS', '#8dff9a'],
  push: ['PUSH', '#ffe9a8'], bust: ['BUST', '#ff9a8d'], lose: ['LOSE', '#ff9a8d'], 'dealer-blackjack': ['DEALER BJ', '#ff9a8d'],
};
function drawBlackjackState(t, tx2, ty2) {
  const B = window.SolarionBlackjack;
  const st = B && B.tables ? B.tables.get(t.id) : null;
  ctx.textAlign = 'center';
  if (!st || (st.state === 'idle' && !(st.chairs || []).some((c) => c.name))) {
    ctx.font = 'bold 11px system-ui'; ctx.fillStyle = '#ffd23f';
    ctx.fillText('B L A C K J A C K', tx2, ty2 - 1);
    ctx.font = '8.5px system-ui'; ctx.fillStyle = 'rgba(255,233,168,.8)';
    ctx.fillText('pays 3 : 2', tx2, ty2 + 11);
    return;
  }
  // Dealer row (far edge). A null card is the face-down hole card.
  const dc = (st.dealer && st.dealer.cards) || [];
  dc.forEach((card, i) => {
    drawCardFace(tx2 + (i - (dc.length - 1) / 2) * 20, ty2 - 9, 18, 25, card, card === null);
  });
  if (dc.length) {
    // Label UNDER the row: beside it, a far-side sitter's sprite
    // clips the text (v1.5 playtest capture).
    ctx.font = 'bold 8.5px system-ui'; ctx.fillStyle = '#ffe9a8';
    const hidden = dc.includes(null);
    const label = hidden ? `DEALER SHOWS ${dc[0]}` : `DEALER ${st.dealer.total}`;
    ctx.fillText(label, tx2, ty2 + 19);
  }
  if (st.state === 'betting') {
    ctx.font = 'bold 9.5px system-ui'; ctx.fillStyle = '#ffd23f';
    ctx.fillText('PLACE YOUR BETS', tx2, ty2 + 16);
  }
  const netOf = (name) => {
    const r = (st.results || []).find((x) => x.name === name);
    return r ? r.amount : 0;
  };
  (t.chairs || []).forEach((ch3, ci) => {
    const cst = st.chairs && st.chairs[ci];
    if (!cst || !cst.name) return;
    const [cx9, cy9] = proj(ch3.x, ch3.y);
    if (cst.acting) {
      ctx.beginPath(); ctx.ellipse(cx9, cy9, 19, 10, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,210,63,.9)'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.font = '8.5px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,233,168,.85)';
    if (Number.isFinite(cst.chips)) ctx.fillText(`${cst.chips}z`, cx9, cy9 + 18);
    const mx = cx9 + (tx2 - cx9) * 0.42, my = cy9 + (ty2 - cy9) * 0.42;
    if (cst.bet) {
      ctx.font = 'bold 9px system-ui'; ctx.fillStyle = '#ffe9a8';
      ctx.fillText(`bet ${cst.bet}z`, mx, my - 14);
    }
    const hand = cst.hand || [];
    hand.forEach((card, i) => drawCardFace(mx + (i - (hand.length - 1) / 2) * 19, my + 3, 18, 25, card, false));
    if (hand.length && cst.handTotal != null) {
      ctx.font = 'bold 9px system-ui'; ctx.fillStyle = cst.handTotal > 21 ? '#ff9a8d' : '#f5f0e6';
      ctx.fillText(`${cst.handTotal}`, mx, my + 23);
    }
    if (st.state === 'payout' && cst.result && BJ_RESULT_LABEL[cst.result]) {
      const [label, color] = BJ_RESULT_LABEL[cst.result];
      const net = netOf(cst.name);
      ctx.font = 'bold 9.5px system-ui'; ctx.fillStyle = color;
      ctx.fillText(net ? `${label} ${net > 0 ? '+' : ''}${net}z` : label, mx, my - 24);
    }
  });
}

// Reels for a cabinet: while a spin resolves, the faces tumble;
// then they settle on the server's result and stay there. With no
// spin yet, the classic decorative faces.
function slotDisplayReels(machineId, idx) {
  const C = window.SolarionCasino;
  const fx = C && C.slotFxBySlot ? C.slotFxBySlot.get(machineId) : null;
  if (fx && C.slotSymbols) {
    const age = Date.now() - fx.at;
    if (age >= 750) return fx.reels.map((id) => C.slotSymbols[id] || '❓');
    const faces = Object.keys(C.slotSymbols);
    if (faces.length) {
      const tick = Math.floor(age / 70);
      return [0, 1, 2].map((i) => C.slotSymbols[faces[(tick * (3 + i * 2) + i * 5 + idx) % faces.length]] || '❓');
    }
  }
  return SLOT_REELS[idx % SLOT_REELS.length];
}

// ------------------------------------------------------------------ Lane C slot cabinets
// Per the Gasoline Alley pinball row: a chunky cabinet, an angled
// glass front with visible reels, a lit marquee, side art. Pure
// rendering — machine positions, stools and all slot math are
// untouched (v1.1.1: the reels animate on this cabinet in-world).
const SLOT_REELS = [
  ['7', '7', '7'], ['☀', '☀', '🍒'], ['🍒', '🔔', '💎'],
  ['💎', '7', '☀'], ['🔔', '🍒', '🔔'], ['🍒', '🍒', '7'],
];
function drawSlotCabinet(sx, sy, idx, facing, machineId) {
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
  const reels = slotDisplayReels(machineId, idx);
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
  if ('season' in m) season = m.season;
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
  if (window.SolarionZoneMusic) window.SolarionZoneMusic.setMap(m.id, Boolean(m.casino));
  $('mapName').textContent = m.name;
  if (window.SolarionMixer) window.SolarionMixer.onMapChanged(m);
  if (window.SolarionCasino) window.SolarionCasino.onMapChanged(m);
  if (window.SolarionBlackjack) window.SolarionBlackjack.onMapChanged(m);
  if (window.SolarionStudio) window.SolarionStudio.onMapChanged(m);
  renderPos.clear();
  for (const c of chat || []) chatLine(`<span class="who">${esc(c.from)}:</span> ${esc(c.text)}`);
  if (you) {
    me = { ...me, ...you };
    renderPos.set(me.id, { x: you.x, y: you.y, moving: false });
  }
}

// v1.1: when my latest drink / puff landed (client-observed from
// snapshots) — drives the haze fade across the 30s vice window.
const myViceAt = { drinks: 0, puffs: 0 };

function handle(m) {
  if (window.SolarionMixer) window.SolarionMixer.handle(m);
  if (window.SolarionCasino) window.SolarionCasino.handle(m);
  if (window.SolarionBlackjack) window.SolarionBlackjack.handle(m);
  if (window.SolarionStudio) window.SolarionStudio.handle(m);
  if (window.SolarionSocial) window.SolarionSocial.handle(m);
  switch (m.type) {
    case 'hello': {
      me = { ...m.you };
      coins = m.zcoins;
      if (m.dayCycle) dayCycle = m.dayCycle;
      if ('season' in m) season = m.season;
      $('coins').textContent = coins;
      players = m.players;
      sceneFurniture = m.furniture || [];
      sceneDevices = {};
      showGame();
      setMap(m.map, m.you, m.chat);
      // Playtest Gate (test-mode payloads only): pose a dancer's
      // flourish so the club's ringside capture catches it.
      if (m.playtest && m.playtest.clubFlourish) {
        clubFlourishFx.set(m.playtest.clubFlourish.dancer, { at: Date.now(), amount: 25, from: 'Playtest' });
      }
      chatLine(`<span class="sys">Welcome to ${esc(m.map.name)}.</span>`);
      if (m.bonusGranted) {
        toast(m.bonusAmount >= 5000
          ? '🎉 Welcome bonus: +5,000 z coins!'
          : '☀️ Daily bonus: +100 z coins!');
      }
      if (me.drinks > 0) myViceAt.drinks = Date.now();
      if (me.puffs > 0) myViceAt.puffs = Date.now();
      break;
    }
    case 'dancer-flourish': {
      // v1.4 (Club Mirage): a tip landed — the dancer twirls (the
      // draw pass animates her from this state) and the room hears.
      clubFlourishFx.set(m.dancer, { at: Date.now(), amount: m.amount, from: m.from });
      chatLine(`<span class="sys">💃 ${esc(m.from)} tipped ${esc(m.name)} ${esc(String(m.amount))}z!</span>`);
      break;
    }
    case 'vice-state': {
      // The club tray's drink tally (the casino tray has its own,
      // fed through SolarionCasino.handle above).
      const cvi = $('clubViceInfo');
      if (cvi) {
        const bits = [];
        if (m.drinks) bits.push(`🍸 × ${m.drinks}${m.passedOut ? ' — OUT COLD' : ''}`);
        if (m.puffs) bits.push(`💨 × ${m.puffs}${m.hippy ? ' — 🌈 HIPPY' : ''}`);
        cvi.textContent = bits.length
          ? bits.join(' · ')
          : 'Mira pours at the bar — first drink of the day is on the house.';
      }
      break;
    }
    case 'fish-cast': {
      // v1.2 (Item O): a cast just started somewhere in the room —
      // clients animate the rod + line arcing out to the landing.
      castFx.set(m.playerId, { landX: m.landX, landY: m.landY, ice: !!m.ice, at: Date.now() });
      break;
    }
    case 'snapshot': {
      players = m.players;
      // v1.1 (Items 11/12 — the in-zone haze bug): `me` used to be
      // refreshed ONLY on hello / map loads, so everything the
      // canvas reads from `me` — the drunk haze, the psychedelic
      // haze, fallen/hippy — went stale until a zone change, while
      // the vice BUBBLES (drawn from this snapshot list) updated
      // live. Merge my own snapshot entry into `me` every tick, and
      // timestamp each fresh drink/puff landing so the hazes can
      // fade across the server's 30s window.
      if (me) {
        const mine = m.players.find(p => p.id === me.id);
        if (mine) {
          if ((mine.drinks || 0) > (me.drinks || 0)) myViceAt.drinks = Date.now();
          if ((mine.puffs || 0) > (me.puffs || 0)) myViceAt.puffs = Date.now();
          me = { ...me, ...mine };
          if (me.drinks > 0 && !myViceAt.drinks) myViceAt.drinks = Date.now();
          if (me.puffs > 0 && !myViceAt.puffs) myViceAt.puffs = Date.now();
        }
      }
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
  // v1.1 chat contract (Item 15): Enter with the chat box inactive
  // activates it. (Enter while it IS active submits the form — the
  // form handler sends and blurs, handing keys back to movement.)
  if (e.code === 'Enter') {
    const inGame = !$('game').classList.contains('hidden');
    if (inGame && window.SolarionInput && window.SolarionInput.enterAction(document.activeElement === $('chatInput')) === 'focus') {
      e.preventDefault();
      $('chatInput').focus();
    }
    return;
  }
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
$('fishHint').onclick = () => { if (!transfer) send({ type: 'interact' }); };
// v1.4 (Club Mirage): the club tray — drinks ride the shared bar
// message; dancer tips go to the nearest stage (server resolves).
{
  const cdb = $('clubDrinkBtn');
  if (cdb) cdb.onclick = () => send({ type: 'buy-drink' });
  for (const b of document.querySelectorAll('.clubTipBtn')) {
    b.onclick = () => send({ type: 'tip-dancer', amount: Number(b.dataset.amt) });
  }
}

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
  if (window.SolarionZoneMusic) {
    $('musicToggleBtn').textContent = window.SolarionZoneMusic.enabled ? '🎵 Music: On' : '🎵 Music: Off';
  }
};
$('volSlider').oninput = () => { if (window.SolarionSfx) window.SolarionSfx.setVolume(Number($('volSlider').value) / 100); };
$('muteBtn').onclick = () => {
  if (!window.SolarionSfx) return;
  const muted = window.SolarionSfx.toggleMute();
  $('muteBtn').textContent = muted ? 'Unmute' : 'Mute';
};
// v1.1: the zone-music toggle (music only; volume/mute untouched).
$('musicToggleBtn').onclick = () => {
  if (!window.SolarionZoneMusic) return;
  const on = window.SolarionZoneMusic.setEnabled(!window.SolarionZoneMusic.enabled);
  $('musicToggleBtn').textContent = on ? '🎵 Music: On' : '🎵 Music: Off';
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

/**
 * Christmas: a light dusting of snow on open ground in the
 * non-snow zones (Frosthaven is already snow; interiors and
 * player homes stay swept). Deterministic per tile so it never
 * shimmers between frames.
 */
function snowDust(cx, cy, tx, ty) {
  if (season !== 'christmas' || !mapDef) return;
  if (mapDef.id === 'frosthaven' || mapDef.studio || INTERIOR_IDS.has(mapDef.id)) return;
  // A scattered hash, not a rhythm: ~1 tile in 4 gets a patch, and
  // patch size/placement vary so the eye reads weather, not print.
  const h = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
  if (h % 11 > 2) return;
  const dx = (h % 13) - 6, r = 5.5 + (h % 5);
  ctx.fillStyle = 'rgba(244,249,255,.11)';
  ctx.beginPath(); ctx.ellipse(cx + dx, cy + (h % 5) - 2, r, r * 0.38, 0.3, 0, Math.PI * 2); ctx.fill();
}

function drawTile(ch, tx, ty) {
  const TS = mapDef.tileSize;
  const [cx, cy] = proj((tx + 0.5) * TS, (ty + 0.5) * TS);
  const hw = TS * ZOOM, hh = TS * ZOOM * 0.5;
  if (ch === '.') {
    diamond(cx, cy, hw, hh, (tx + ty) % 2 ? mapDef.floor : mapDef.floorAlt);
    snowDust(cx, cy, tx, ty);
    return;
  }
  if (ch === 'C') { // Casino Lounge indoor floor — dark club checkerboard
    // v1.4: Club Mirage's dance floor uses the same checker in the
    // club's own warm plum (its floor colors ride the map payload).
    const cz = mapDef.casino || (mapDef.club ? { floor: mapDef.floor, floorAlt: mapDef.floorAlt } : { floor: '#3a2350', floorAlt: '#432a5c' });
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
  if (ch === 'B') { // v1.4.1 (seat audit): a BAR COUNTER — floor-level
    // furniture, not a wall. A flat warm-wood top (lifted just 4px,
    // like a tabletop) over a short dark skirt, with a brass rail
    // along the front edge. The old extruded-cube counters ('W'/'#')
    // raised their top face 20px — exactly bar-stool cushion height
    // in screen space — so every stool one tile away read as a chair
    // ON the bar. Flat counters keep stools tucked AT the bar.
    diamond(cx, cy - 4, hw, hh, '#a5713a');                    // the top
    diamond(cx, cy - 4, hw * 0.82, hh * 0.82, '#b98a4e');     // worn sheen
    // front skirt: the top's two south edges dropped 10px
    ctx.beginPath();
    ctx.moveTo(cx - hw, cy - 4); ctx.lineTo(cx, cy + hh - 4);
    ctx.lineTo(cx, cy + hh + 6); ctx.lineTo(cx - hw, cy + 6);
    ctx.closePath(); ctx.fillStyle = '#2e1c11'; ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx, cy + hh - 4); ctx.lineTo(cx + hw, cy - 4);
    ctx.lineTo(cx + hw, cy + 6); ctx.lineTo(cx, cy + hh + 6);
    ctx.closePath(); ctx.fillStyle = '#3a2417'; ctx.fill();
    // brass rail along the front lip
    ctx.strokeStyle = 'rgba(255,210,63,.6)'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - hw, cy - 4); ctx.lineTo(cx, cy + hh - 4); ctx.lineTo(cx + hw, cy - 4);
    ctx.stroke();
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
    snowDust(cx, cy, tx, ty);
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
    // Seasonal themes: the trees dress up with everyone else —
    // Halloween hangs tiny pumpkin lights in the canopy, Christmas
    // strings coloured bulbs + ornaments and caps it with snow.
    if (season === 'halloween' || season === 'christmas') {
      const seed = tx * 7 + ty * 13;
      const cols = season === 'halloween'
        ? ['#ff9d2e', '#ffb84d', '#ff7b1c']
        : ['#ff5a4d', '#57d95d', '#ffd23f', '#5ab0ff', '#ff8fab'];
      for (let i = 0; i < 5; i++) {
        const dx = ((seed * (i + 3) * 11) % 21) - 10;
        const dy = -14 - ((seed * (i + 5) * 7) % 15);
        ctx.beginPath(); ctx.arc(cx + dx, cy + dy, season === 'halloween' ? 1.9 : 2.1, 0, Math.PI * 2);
        ctx.fillStyle = cols[(seed + i) % cols.length];
        ctx.globalAlpha = 0.95; ctx.fill(); ctx.globalAlpha = 1;
      }
      if (season === 'christmas') {
        ctx.beginPath(); ctx.ellipse(cx + v, cy - 31, 7.5, 3.2, 0, Math.PI, Math.PI * 2);
        ctx.fillStyle = 'rgba(244,249,255,.85)'; ctx.fill();
      }
    }
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

// ------------------------------------------------------------------
// v1.1 furniture art (Items 2/3): chairs and tables drawn at
// CHARACTER scale. A chair is a silhouette — legs, a seat cushion,
// and a slatted BACKREST on the side away from its facing — never
// the old 12px diamond "dot". Warm wood throughout (Phase 10).
const CHAIR_FRAME = '#8a5a2b', CHAIR_DARK = '#5a3d1f', CHAIR_SLAT = '#a5713a';
const CHAIR_CUSH = '#c96f4a', CHAIR_CUSH_D = '#9c4f30', CHAIR_CUSH_L = '#e08a5f';

// A ladder back whose BASE sits at baseY, rising `rise` px. With
// panel=true the slat field gets a warm translucent fill first so
// the back reads as one solid piece, not floating lines. Shared by
// drawChairAt and the deferred near-back pass (v1.2.2 Item 3).
function chairLadderBack(x, baseY, rise, panel) {
  if (panel) {
    ctx.beginPath();
    ctx.moveTo(x - 13, baseY); ctx.lineTo(x - 14, baseY - rise);
    ctx.lineTo(x + 14, baseY - rise); ctx.lineTo(x + 13, baseY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(138,90,43,.38)'; ctx.fill();
  }
  ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 3.6;
  ctx.beginPath();
  ctx.moveTo(x - 12, baseY); ctx.lineTo(x - 13, baseY - rise + 5);
  ctx.moveTo(x + 12, baseY); ctx.lineTo(x + 13, baseY - rise + 5);
  ctx.stroke();
  ctx.strokeStyle = CHAIR_SLAT; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - 12.6, baseY - rise * 0.45); ctx.lineTo(x + 12.6, baseY - rise * 0.45);
  ctx.moveTo(x - 12.9, baseY - rise * 0.72); ctx.lineTo(x + 12.9, baseY - rise * 0.72);
  ctx.stroke();
  ctx.fillStyle = CHAIR_FRAME;
  ctx.fillRect(x - 15, baseY - rise, 30, 6); // top rail
  ctx.fillStyle = 'rgba(255,220,150,.35)';
  ctx.fillRect(x - 15, baseY - rise, 30, 2);
}

// The near-side back of an 'up'-facing chair, drawn ALONE — the
// entity pass replays it OVER a seated player (v1.2.2 Item 3: the
// seat pass runs before players, so a sitter's sprite swallowed
// this panel whole and occupied slot seats read backless).
function drawChairBackNear(x, y) {
  chairLadderBack(x, y + 8, 28, true);
}

// v1.2.2 (Item 3): the projected [x, y] of the deferred near-side
// back for the seat player `p` occupies — or null when that seat
// has no near-side back to replay (far-side/side backs are drawn
// in the seat pass and peek out from behind the sitter as-is).
// Covers all three seat families: baked map seats, casino poker
// chairs (id poker:<tableId>:<NESW>), and placed studio seating
// (id furn:<instanceId>).
function deferredSeatBackPos(p) {
  if (!p.seatId || !mapDef) return null;
  const id = p.seatId;
  if (id.startsWith('poker:')) {
    const parts = id.split(':');
    const cz = mapDef.casino;
    const t = cz && cz.tables.find(t2 => t2.id === parts[1]);
    const ch = t && t.chairs.find(c => c.dir === parts[2]);
    if (!ch) return null;
    const [tx2, ty2] = proj(t.x, t.y);
    const [chx, chy] = proj(ch.x, ch.y);
    const face = Math.abs(chx - tx2) > Math.abs(chy - ty2)
      ? (chx > tx2 ? 'left' : 'right') : (chy > ty2 ? 'up' : 'down');
    return face === 'up' ? [chx, chy] : null;
  }
  if (id.startsWith('furn:')) {
    const f = sceneFurniture.find(f2 => `furn:${f2.instanceId}` === id);
    if (!f || f.type !== 'seating') return null;
    const dir = ['down', 'left', 'up', 'right'][f.rot & 3] || 'down';
    if (dir !== 'up') return null;
    const TS3 = mapDef.tileSize;
    const [fx, fy] = proj((f.x + 0.5) * TS3, (f.y + 0.5) * TS3);
    return [fx, fy + 2];
  }
  const s = (mapDef.seats || []).find(s2 => s2.id === id);
  if (!s || (s.kind !== 'chair' && s.kind !== 'stool' && s.kind !== 'audience') || s.dir !== 'up') return null;
  const pp = proj(s.x, s.y);
  return [pp[0], pp[1], s.kind]; // v1.5.1: kind rides along so the entity pass replays the right back
}

function drawChairAt(x, y, dir, opts) {
  // Chair art v4 (v1.2.2, Items 1/3): EVERY facing visibly has a
  // BACK, and the cushion has THICKNESS (a skirt under the pad) so
  // a chair reads as furniture, never a floor decal with a stick.
  //   down (back on the far side): back first, cushion over its base.
  //   up   (back on the near side): cushion first, then a SOLID
  //        back panel over the cushion's near edge — UNLESS
  //        opts.deferNearBack (an occupied seat: the entity pass
  //        redraws the panel over the sitter via drawChairBackNear,
  //        or the sitter's sprite buries it — the v3 hole).
  //   left/right: an ISO-TRUE panel now — its base follows the
  //        seat diamond's back diagonal (N corner -> side corner)
  //        and it rises vertically from that edge. v3 drew a thin
  //        vertical ladder mid-cushion, which at play zoom read as
  //        a stray peg next to a floor pad (the "jumble of chairs").
  // Same footprint/anchor as v2/v3 (seat centre at x,y) — seats and
  // sitters keep their spots.
  const deferNearBack = Boolean(opts && opts.deferNearBack);
  ctx.beginPath(); ctx.ellipse(x, y + 10, 20, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fill();
  const legs = () => {
    ctx.strokeStyle = CHAIR_DARK; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 11, y + 2); ctx.lineTo(x - 12, y + 10);
    ctx.moveTo(x + 11, y + 2); ctx.lineTo(x + 12, y + 10);
    ctx.stroke();
  };
  const cushion = () => {
    diamond(x, y + 3.5, 30, 12, CHAIR_CUSH_D); // skirt: the pad's thickness
    diamond(x, y, 30, 12, CHAIR_CUSH);         // the pad itself
    diamond(x, y - 2, 23, 8.5, CHAIR_CUSH_L);  // padded top catching light
  };
  if (dir === 'left' || dir === 'right') {
    const s = dir === 'left' ? 1 : -1; // facing left -> back on the east edge
    legs();
    cushion();
    // Iso panel ON the cushion's back diagonal (v1.3.1): v4's
    // panel floated ~12px past the cushion's side corner and 5px
    // above its N corner, so a side chair read as a floor pad with
    // a stray ladder beside it — the "chairs just sittin there"
    // and slot-stool-slab complaints. The panel now spans the
    // cushion's TRUE back edge (N corner -> side corner), with
    // thicker posts/rails so it reads as a chair BACK, and a short
    // cheek return along the far diagonal suggests the wrap.
    const ax = x - s * 1, ay = y - 7;
    const bx = x + s * 15, by = y - 1;
    const RISE = 28;
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.lineTo(bx, by - RISE); ctx.lineTo(ax, ay - RISE);
    ctx.closePath();
    ctx.fillStyle = 'rgba(138,90,43,.5)'; ctx.fill();
    ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.moveTo(ax, ay + 1); ctx.lineTo(ax, ay - RISE + 4);
    ctx.moveTo(bx, by + 1); ctx.lineTo(bx, by - RISE + 4);
    ctx.stroke();
    ctx.strokeStyle = CHAIR_SLAT; ctx.lineWidth = 3.4;
    for (const t of [0.45, 0.72]) {
      ctx.beginPath();
      ctx.moveTo(ax, ay - RISE * t); ctx.lineTo(bx, by - RISE * t);
      ctx.stroke();
    }
    ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(ax, ay - RISE); ctx.lineTo(bx, by - RISE);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,220,150,.35)'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ax, ay - RISE - 2.5); ctx.lineTo(bx, by - RISE - 2.5);
    ctx.stroke();
    // cheek return: a short rail from the N-corner post toward
    // the opposite corner, half height — the back's wrap.
    ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(ax, ay - RISE * 0.55); ctx.lineTo(ax - s * 11, ay - RISE * 0.55 + 3);
    ctx.stroke();
    return;
  }
  if (dir === 'up') {
    // Back on the NEAR side: cushion first, panel over its edge.
    legs();
    cushion();
    if (!deferNearBack) chairLadderBack(x, y + 8, 28, true);
    return;
  }
  // 'down' (and default): back on the far side, cushion over base.
  chairLadderBack(x, y - 6, 27, true);
  legs();
  cushion();
}

// ------------------------------------------------------------------
// v1.5.1: the AUDIENCE chair (kind 'audience' — stage seating
// blocks only). Zan circled the venue rows for the tenth time:
// from behind, drawChairAt's panel-filled ladder back + the wide
// cushion merged into a solid slab — "old chair models", crates
// on red pads. The table chairs are APPROVED and untouched; the
// audience chair is a sibling, not a restyle: same cushion, same
// wood palette, same footprint/anchor — but its back is a real
// OPEN ladder: two posts, two slats with REAL GAPS the floor
// shows through, and an arched top rail. No translucent panel
// fill anywhere, and four legs reach the floor, so a block of
// twenty reads as twenty chairs. (The Playtest Gate's back
// windows sample the post strips — the gaps are by design and
// are not what the check measures; a backless audience chair
// still fails it.)
function audienceBack(x, baseY, rise) {
  const top = baseY - rise;
  ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x - 13, baseY); ctx.lineTo(x - 13, top + 5);
  ctx.moveTo(x + 13, baseY); ctx.lineTo(x + 13, top + 5);
  ctx.stroke();
  ctx.strokeStyle = CHAIR_SLAT; ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(x - 13, baseY - rise * 0.38); ctx.lineTo(x + 13, baseY - rise * 0.38);
  ctx.moveTo(x - 13, baseY - rise * 0.66); ctx.lineTo(x + 13, baseY - rise * 0.66);
  ctx.stroke();
  // arched top rail — the shaped silhouette a box can't fake
  ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x - 14, top + 6);
  ctx.quadraticCurveTo(x, top - 5, x + 14, top + 6);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,220,150,.35)'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - 13, top + 4);
  ctx.quadraticCurveTo(x, top - 6.5, x + 13, top + 4);
  ctx.stroke();
}

// The near-side audience back, replayed alone over a sitter by
// the entity pass (the drawChairBackNear contract, audience art).
function drawAudienceBackNear(x, y) {
  audienceBack(x, y + 8, 27);
}

function drawAudienceChairAt(x, y, dir, opts) {
  const deferNearBack = Boolean(opts && opts.deferNearBack);
  ctx.beginPath(); ctx.ellipse(x, y + 10, 20, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fill();
  const legs = () => {
    ctx.strokeStyle = CHAIR_DARK; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 11, y + 2); ctx.lineTo(x - 12, y + 10);
    ctx.moveTo(x + 11, y + 2); ctx.lineTo(x + 12, y + 10);
    ctx.stroke();
  };
  const cushion = () => {
    diamond(x, y + 3.5, 30, 12, CHAIR_CUSH_D); // skirt: the pad's thickness
    diamond(x, y, 30, 12, CHAIR_CUSH);         // the pad itself
    diamond(x, y - 2, 23, 8.5, CHAIR_CUSH_L);  // padded top catching light
  };
  if (dir === 'left' || dir === 'right') {
    // Iso side panel on the cushion's back diagonal — same
    // geometry as the table chair's (v1.3.1), but OPEN: slats
    // with real gaps, no panel fill.
    const s = dir === 'left' ? 1 : -1; // facing left -> back on the east edge
    legs();
    cushion();
    const ax = x - s * 1, ay = y - 7;
    const bx = x + s * 15, by = y - 1;
    const RISE = 28;
    ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 4.2;
    ctx.beginPath();
    ctx.moveTo(ax, ay + 1); ctx.lineTo(ax, ay - RISE + 4);
    ctx.moveTo(bx, by + 1); ctx.lineTo(bx, by - RISE + 4);
    ctx.stroke();
    ctx.strokeStyle = CHAIR_SLAT; ctx.lineWidth = 3.4;
    for (const t of [0.38, 0.66]) {
      ctx.beginPath();
      ctx.moveTo(ax, ay - RISE * t); ctx.lineTo(bx, by - RISE * t);
      ctx.stroke();
    }
    ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(ax, ay - RISE); ctx.lineTo(bx, by - RISE);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,220,150,.35)'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ax, ay - RISE - 2.5); ctx.lineTo(bx, by - RISE - 2.5);
    ctx.stroke();
    ctx.strokeStyle = CHAIR_FRAME; ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(ax, ay - RISE * 0.55); ctx.lineTo(ax - s * 11, ay - RISE * 0.55 + 3);
    ctx.stroke();
    return;
  }
  if (dir === 'up') {
    // Back on the NEAR side: legs + cushion first, open back
    // over the cushion's near edge (deferred when occupied).
    legs();
    cushion();
    if (!deferNearBack) audienceBack(x, y + 8, 27);
    return;
  }
  // 'down' (and default): open back on the far side.
  audienceBack(x, y - 5, 27);
  legs();
  cushion();
}

/** v1.3.1: a proper little SOFA — skirted base, deep cushion,
 *  an upholstered back on the side opposite the sitter's facing,
 *  and arms at both ends. The old two-diamond hint read as a
 *  cushion blob (and for side facings, an unanchored smear). */
function drawSofaAt(x, y, dir) {
  ctx.beginPath(); ctx.ellipse(x, y + 11, 25, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.30)'; ctx.fill();
  const BODY = '#7a3b4f', BODY_L = '#93536b', TOP = '#9c5a72', ARM = '#6d3447';
  const backAt = (bx, by, w) => {
    diamond(bx, by, w, 11, BODY);
    diamond(bx, by - 3, w, 10, BODY_L);
  };
  if (dir === 'down') backAt(x, y - 10, 42);
  if (dir === 'left') backAt(x + 13, y - 3, 22);
  if (dir === 'right') backAt(x - 13, y - 3, 22);
  diamond(x, y + 5, 40, 14, BODY);        // skirted base
  diamond(x, y + 1, 40, 13, BODY_L);      // deep cushion
  diamond(x, y - 1, 31, 9, TOP);          // cushion top catching light
  diamond(x - 20, y - 2, 10, 8, ARM);     // arms
  diamond(x + 20, y - 2, 10, 8, ARM);
  if (dir === 'up') backAt(x, y + 9, 42); // near-side back over the cushion edge
}

/** v1.3.1 (Item 13): a beach towel you can LIE on — a big striped
 *  diamond, long axis along the shore, sized for a 1.5x character. */
function drawTowelAt(x, y) {
  ctx.beginPath(); ctx.ellipse(x, y + 6, 31, 10, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fill();
  diamond(x, y, 58, 25, '#37b6d9');
  diamond(x, y, 47, 20, '#f5f0e6');
  diamond(x, y, 35, 14, '#e86a5a');
  diamond(x, y, 21, 8, '#f5f0e6');
}

// (v1.2 Item O: the static pole-stand art retired with the stands
// themselves — the rod now appears in the caster's hand instead.)

// ------------------------------------------------------------------ fish (v1.1.1)
// Ten species, one shared little-fish silhouette; colour + markings
// carry the variety. Used for catch hold-ups and ambient pond leaps.
const FISH_IDS = ['minnow', 'bluegill', 'sunfish', 'perch', 'trout', 'bass', 'catfish', 'koi', 'golden-carp', 'moonfish'];
const FISH_ART = {
  minnow: { body: '#b8c4cc', fin: '#7e8a93' },
  bluegill: { body: '#5b84c4', fin: '#e8a33d' },
  sunfish: { body: '#e8a33d', fin: '#c45b2d' },
  perch: { body: '#a8b45b', fin: '#5d7031', stripes: true },
  trout: { body: '#c48a5b', fin: '#8a5a2b', spots: true },
  bass: { body: '#5d7d43', fin: '#3d5527' },
  catfish: { body: '#6b7d8c', fin: '#46545f', whiskers: true },
  koi: { body: '#f0e6da', fin: '#e86a2d', patches: true },
  'golden-carp': { body: '#f2c230', fin: '#c99700' },
  moonfish: { body: '#a8c8e8', fin: '#5b84c4', glow: true },
};
function drawFishShape(x, y, id, s = 1, wiggle = 0) {
  const a = FISH_ART[id] || FISH_ART.minnow;
  ctx.save(); ctx.translate(x, y); ctx.rotate(wiggle); ctx.scale(s, s);
  if (a.glow) {
    ctx.beginPath(); ctx.ellipse(0, 0, 21, 12, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(168,200,232,.35)'; ctx.fill();
  }
  ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(-20, -7); ctx.lineTo(-20, 7); ctx.closePath();
  ctx.fillStyle = a.fin; ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, 0, 15, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = a.body; ctx.fill();
  if (a.stripes) {
    ctx.fillStyle = 'rgba(40,50,20,.45)';
    for (const dx of [-6, 0, 6]) ctx.fillRect(dx - 1.4, -6.3, 2.8, 12.6);
  }
  if (a.spots) {
    ctx.fillStyle = 'rgba(90,40,20,.5)';
    for (const [dx, dy] of [[-7, -2], [-1, 2], [5, -3], [9, 1]]) {
      ctx.beginPath(); ctx.arc(dx, dy, 1.3, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (a.patches) {
    ctx.fillStyle = '#e86a2d';
    ctx.beginPath(); ctx.ellipse(-4, -2, 5.5, 3.6, 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6, 2, 4, 2.8, 0.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.beginPath(); ctx.moveTo(-3, -7); ctx.lineTo(3, -11); ctx.lineTo(7, -7); ctx.closePath();
  ctx.fillStyle = a.fin; ctx.fill();
  if (a.whiskers) {
    ctx.strokeStyle = a.fin; ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(13, 2); ctx.quadraticCurveTo(19, 4, 22, 2);
    ctx.moveTo(13, 3.4); ctx.quadraticCurveTo(19, 6, 21, 5);
    ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(9.5, -1.5, 1.7, 0, 0, Math.PI * 2); ctx.fillStyle = '#10151f'; ctx.fill();
  ctx.restore();
}

/** Ambient pond leaps (v1.1.1): on fishing maps, a little fish
 *  arcs out of a random pond tile every few seconds, splash rings
 *  at entry and exit. Client-only ambience — no server traffic. */
const pondLeaps = [];
let leapState = { mapId: null, tiles: [], nextAt: 0 };
function tickPondLeaps(now) {
  // v1.2: leaps belong to OPEN fishable water — a frozen pond's
  // fish stay under the ice.
  if (!mapDef || !mapDef.fishable || mapDef.frozen || !mapDef.rows) return;
  if (leapState.mapId !== mapDef.id) {
    const tiles = [];
    mapDef.rows.forEach((row, ty) => {
      [...row].forEach((ch, tx) => { if (ch === '%') tiles.push([tx * 32 + 16, ty * 32 + 16]); });
    });
    leapState = { mapId: mapDef.id, tiles, nextAt: now + 1200 };
  }
  if (now >= leapState.nextAt && leapState.tiles.length) {
    const [wx, wy] = leapState.tiles[Math.floor(Math.random() * leapState.tiles.length)];
    pondLeaps.push({ x: wx, y: wy, at: now, fish: FISH_IDS[(wx * 7 + wy * 13) % FISH_IDS.length] });
    leapState.nextAt = now + 2200 + Math.random() * 2600;
  }
  for (let i = pondLeaps.length - 1; i >= 0; i--) {
    const L = pondLeaps[i];
    const t = (now - L.at) / 750;
    if (t >= 1) { pondLeaps.splice(i, 1); continue; }
    const [lx, ly] = proj(L.x + t * 14, L.y);
    if (t < 0.3 || t > 0.7) {
      const rt = t < 0.3 ? t / 0.3 : (t - 0.7) / 0.3;
      ctx.beginPath(); ctx.ellipse(lx, ly, 4 + rt * 8, (4 + rt * 8) * 0.42, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(210,240,255,${0.65 * (1 - rt)})`; ctx.lineWidth = 1.2; ctx.stroke();
    }
    drawFishShape(lx, ly - Math.sin(t * Math.PI) * 26, L.fish, 0.8, (t - 0.5) * 1.6);
  }
}

/** A round café/home table on a pedestal, wide enough to sit AT. */
function drawTableAt(x, y) {
  ctx.fillStyle = '#5a3d1f';
  ctx.beginPath(); ctx.ellipse(x, y + 9, 7, 3.6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillRect(x - 2.5, y - 2, 5, 11);
  ctx.beginPath(); ctx.ellipse(x, y - 3, 32, 16, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#8a5a2b'; ctx.fill();
  ctx.beginPath(); ctx.ellipse(x, y - 5, 32, 16, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#caa06a'; ctx.fill();
  ctx.strokeStyle = '#7a5a2b'; ctx.lineWidth = 1.2; ctx.stroke();
}

// v1.2.3 (Item 1 — Zan: "my legs should be under the table"): a
// player seated at a TABLE seat (a chair one tile from a round
// table — the café's and terrace's baked tables, or a placed
// table piece in a home) gets two things: a small PULL-IN toward
// the table when their sprite is projected, and the table's
// FRONT replayed over their lap after the sprite (see
// drawTableFrontAt) — so the lower body tucks under the tabletop
// instead of painting over it. Poker felts render their own way
// and are untouched: their seats are not 'chair' map seats.
function tableSeatInfo(p) {
  if (!p.seatId || !mapDef) return null;
  const TS = mapDef.tileSize || 32;
  let sx2, sy2, tx2, ty2;
  if (p.seatId.startsWith('furn:')) {
    const f = sceneFurniture.find(f2 => `furn:${f2.instanceId}` === p.seatId);
    if (!f || f.type !== 'seating') return null;
    const t = sceneFurniture.find(f2 => f2.type === 'table'
      && Math.max(Math.abs(f2.x - f.x), Math.abs(f2.y - f.y)) === 1);
    if (!t) return null;
    sx2 = (f.x + 0.5) * TS; sy2 = (f.y + 0.5) * TS;
    tx2 = (t.x + 0.5) * TS; ty2 = (t.y + 0.5) * TS;
  } else {
    const s = (mapDef.seats || []).find(s2 => s2.id === p.seatId);
    if (!s || s.kind !== 'chair') return null;
    const t = (mapDef.props || []).find(pr => pr.kind === 'table'
      && Math.abs(pr.x - s.x) <= TS * 1.75 && Math.abs(pr.y - s.y) <= TS * 1.75
      && (pr.x !== s.x || pr.y !== s.y));
    if (!t) return null;
    sx2 = s.x; sy2 = s.y; tx2 = t.x; ty2 = t.y;
  }
  // v1.3.1 (Item 1): table chairs sit 50px out now (a visible gap),
  // so the pull-in is gentler (4px) — just enough to tuck the
  // sitter's lap under the replayed table front.
  const pull = [Math.sign(tx2 - sx2) * 4, Math.sign(ty2 - sy2) * 4];
  const [px3, py3] = proj(tx2, ty2);
  return { pull, tx: px3, ty: py3 };
}

// The table's front band (near rim + pedestal front), replayed
// over a seated player: the part of the table the camera sees in
// front of the sitter's legs.
function drawTableFrontAt(x, y) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x - 36, y - 7, 72, 22); ctx.clip();
  drawTableAt(x, y);
  ctx.restore();
}

// v1.1 stage pyrotechnics: bounded spark particles, spawned on the
// performing mix's bar grid at the platform's front corners.
const pyro = [];
let pyroBar = -1;
function spawnPyro(wx, wy) {
  const [sx, sy] = proj(wx, wy);
  const cols = ['#ffd23f', '#fff3c4', '#ff9d5c', '#ff6b81'];
  for (let i = 0; i < 22 && pyro.length < 260; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
    const sp = 1.4 + Math.random() * 2.4;
    pyro.push({
      x: sx, y: sy - 8, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 1, decay: 0.014 + Math.random() * 0.012,
      col: cols[(Math.random() * cols.length) | 0], r: 1.4 + Math.random() * 1.8,
    });
  }
}

// ------------------------------------------------------------------
// Club Mirage (v1.4): the go-go bar's fixtures — three little
// stages with poles, the dancers (NPC fixtures dancing on loop,
// like the bartenders they are data, never players), sweeping
// spotlights, and Mira at the bar. A tip lands as a
// 'dancer-flourish' broadcast; the flourish (twirl + hearts) is
// animated here from that one event.
const clubFlourishFx = new Map(); // dancerId -> { at, amount, from }
const FLOURISH_MS = 2600;

function drawClubPass(now) {
  const cl = mapDef.club;
  const TS = mapDef.tileSize || 32;
  const dark = darknessNow();
  cl.stages.forEach((stg, i) => {
    // the platform: raised warm-wood diamonds with a pink lip
    for (let ty = Math.floor(stg.y / TS); ty < Math.ceil((stg.y + stg.h) / TS); ty++) {
      for (let tx = Math.floor(stg.x / TS); tx < Math.ceil((stg.x + stg.w) / TS); tx++) {
        const [px2, py2] = proj((tx + 0.5) * TS, (ty + 0.5) * TS);
        diamond(px2, py2 - 5, TS * ZOOM, TS * ZOOM * 0.5, (tx + ty) % 2 ? '#6e3a2e' : '#774233');
      }
    }
    const lipA = proj(stg.x + 2, stg.y + stg.h - 2), lipB = proj(stg.x + stg.w - 2, stg.y + stg.h - 2);
    ctx.strokeStyle = 'rgba(255,93,162,.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(lipA[0], lipA[1] - 4); ctx.lineTo(lipB[0], lipB[1] - 4); ctx.stroke();
    // sweeping spotlights: two warm beams (amber + pink) crossing
    // the platform, in the stage washes' 'lighter' language
    const [ccx, ccy] = proj(stg.x + stg.w / 2, stg.y + stg.h / 2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const boost = 0.5 + dark;
    for (let beam = 0; beam < 2; beam++) {
      const srcX = ccx + (beam ? 70 : -70), srcY = ccy - 120;
      const tgtX = ccx + Math.sin(now / 1050 + i * 2.1 + beam * 2.6) * 62;
      const tgtY = ccy + 6;
      const col = beam ? '255,190,90' : '255,110,170';
      const a = 0.13 * boost;
      const grd = ctx.createLinearGradient(srcX, srcY, tgtX, tgtY);
      grd.addColorStop(0, `rgba(${col},${(a * 0.4).toFixed(3)})`);
      grd.addColorStop(1, `rgba(${col},${a.toFixed(3)})`);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(srcX, srcY);
      ctx.lineTo(tgtX - 30, tgtY);
      ctx.lineTo(tgtX + 30, tgtY);
      ctx.closePath(); ctx.fill();
      const wash = ctx.createRadialGradient(tgtX, tgtY, 4, tgtX, tgtY, 74);
      wash.addColorStop(0, `rgba(${col},${(a * 0.9).toFixed(3)})`);
      wash.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = wash;
      ctx.beginPath(); ctx.arc(tgtX, tgtY, 74, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // the pole: brass with a bright edge, behind the dancer
    const [plx, ply] = proj(stg.pole.x, stg.pole.y);
    ctx.strokeStyle = '#8a6a1f'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(plx, ply - 2); ctx.lineTo(plx, ply - 62); ctx.stroke();
    ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(plx - 0.8, ply - 2); ctx.lineTo(plx - 0.8, ply - 62); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(plx, ply, 7, 3, 0, 0, Math.PI * 2); ctx.fillStyle = '#c99700'; ctx.fill();
    // the dancer, dancing on loop (the dance emote's bounce
    // rhythm + a slow sway); a tip makes her twirl
    const d = stg.dancer;
    const fx = clubFlourishFx.get(d.id);
    const ft = fx ? (now - fx.at) / FLOURISH_MS : 1;
    const flourishing = ft >= 0 && ft < 1;
    if (fx && !flourishing) clubFlourishFx.delete(d.id);
    const bob = Math.abs(Math.sin(now / (flourishing ? 90 : 165) + i * 1.7)) * (flourishing ? 6 : 3.5);
    const sway = Math.sin(now / 430 + i * 2.3) * 2.5;
    const [dx, dy] = proj(d.x, d.y);
    const spr = Sprites.makeSprite(d.look, 'down');
    ctx.save();
    ctx.translate(dx + sway, dy - bob);
    if (flourishing) {
      const sx = Math.cos(ft * Math.PI * 6);
      ctx.scale(Math.sign(sx) * Math.max(0.25, Math.abs(sx)) || 1, 1);
    }
    ctx.drawImage(spr, -spr.width / 2, -spr.height + 4);
    ctx.restore();
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = flourishing ? '#ffd76a' : '#ffc7de';
    ctx.strokeStyle = 'rgba(0,0,0,.65)';
    ctx.lineWidth = 3;
    const label = `💃 ${d.name}`;
    ctx.strokeText(label, dx, dy - spr.height - 8 - bob);
    ctx.fillText(label, dx, dy - spr.height - 8 - bob);
    if (flourishing) {
      ctx.font = '13px system-ui';
      for (let hI = 0; hI < 5; hI++) {
        const ph = (ft * 1.4 + hI * 0.19) % 1;
        const hx = dx + Math.sin(ph * 5 + hI * 2.4) * 14;
        const hy = dy - 46 - ph * 34;
        ctx.globalAlpha = 0.9 * (1 - ph);
        ctx.fillText(hI % 2 ? '💖' : '✨', hx, hy);
      }
      ctx.globalAlpha = 1;
    }
  });
  // the bar: Mira behind the counter (drawn like the casino
  // bartenders — a fixed-look layered sprite + name)
  if (cl.bartender) {
    const bt = cl.bartender;
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
}

function draw() {
  requestAnimationFrame(draw);
  if (!mapDef) return;
  // v1.4: the club tray lives only inside Club Mirage.
  const clubTrayEl = $('clubTray');
  if (clubTrayEl) clubTrayEl.classList.toggle('hidden', !mapDef.club);
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#0b0e18';
  ctx.fillRect(0, 0, W, H);

  // Phase B amendment — my own vice hazes, rendered from my live
  // server-tracked state (kept fresh in-zone by the snapshot merge
  // in handle()). v1.1: both hazes live in the 30s window from the
  // last drink/puff and FADE OUT across its final seconds — drinks
  // blur the world; puffs run an unmistakably psychedelic treatment
  // (fast hue cycle + saturation swell, including the hippy trip,
  // when the count itself has burned off). Fallen = fade out.
  {
    const fx = [];
    const IG = window.SolarionInput;
    const nowF = Date.now();
    const fade = (at) => (IG && at ? IG.viceFade(nowF - at) : 1);
    if (me && me.drinks > 0) {
      const f = fade(myViceAt.drinks);
      if (f > 0) fx.push(`blur(${(Math.min(2.4, me.drinks * 0.3) * f).toFixed(2)}px)`);
    }
    const trip = me ? (me.puffs > 0 ? me.puffs : (me.hippy ? 6 : 0)) : 0;
    if (me && trip > 0) {
      const f = fade(myViceAt.puffs);
      if (f > 0) {
        fx.push(`hue-rotate(${Math.round((nowF / (60 - Math.min(45, trip * 4)) + trip * 40) % 360)}deg)`);
        fx.push(`saturate(${(1 + trip * 0.14 * f).toFixed(2)})`);
      }
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

  // v1.2.2 (Item 3): which seats are occupied this frame — an
  // occupied 'up' chair/stool defers its near-side back to the
  // entity pass (drawn over its sitter); see drawChairAt.
  const occupiedSeatIds = new Set();
  for (const p of players) if (p.seated && p.seatId) occupiedSeatIds.add(p.seatId);

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
    // v1.1: the PIT — a roped standing floor on the audience side —
    // and the stage BACKDROP (posts + draped swag) on the back edge.
    if (st.pit) {
      const pit = st.pit;
      const south = pit.y > st.y, west = pit.x < st.x;
      for (let ty = Math.floor(pit.y / TS2); ty < Math.ceil((pit.y + pit.h) / TS2); ty++) {
        for (let tx = Math.floor(pit.x / TS2); tx < Math.ceil((pit.x + pit.w) / TS2); tx++) {
          const [px2, py2] = proj((tx + 0.5) * TS2, (ty + 0.5) * TS2);
          diamond(px2, py2, TS2 * ZOOM, TS2 * ZOOM * 0.5, (tx + ty) % 2 ? '#3d2440' : '#34203a');
        }
      }
      // gold trim along the platform's front lip
      const lip = [];
      if (west) { for (let i = 0; i <= 3; i++) lip.push(proj(st.x + 2, st.y + (st.h / 3) * i)); }
      else if (south) { for (let i = 0; i <= 10; i++) lip.push(proj(st.x + (st.w / 10) * i, st.y + st.h - 2)); }
      else { for (let i = 0; i <= 10; i++) lip.push(proj(st.x + (st.w / 10) * i, st.y + 2)); }
      ctx.strokeStyle = 'rgba(255,210,63,.55)'; ctx.lineWidth = 2;
      ctx.beginPath();
      lip.forEach(([lx, ly], i) => { if (i === 0) ctx.moveTo(lx, ly - 4); else ctx.lineTo(lx, ly - 4); });
      ctx.stroke();
      // rope line along the pit's far edge: brass posts + sagging rope
      const edge = [];
      if (west) { for (let i = 0; i <= 3; i++) edge.push([pit.x + 4, pit.y + (pit.h / 3) * i]); }
      else if (south) { for (let i = 0; i <= 5; i++) edge.push([pit.x + (pit.w / 5) * i, pit.y + pit.h - 4]); }
      else { for (let i = 0; i <= 5; i++) edge.push([pit.x + (pit.w / 5) * i, pit.y + 4]); }
      const pts = edge.map(([wx, wy]) => proj(wx, wy));
      ctx.strokeStyle = '#b03a48'; ctx.lineWidth = 2.4;
      ctx.beginPath();
      pts.forEach(([rx, ry], i) => {
        if (i === 0) ctx.moveTo(rx, ry - 12);
        else { const [qx, qy] = pts[i - 1]; ctx.quadraticCurveTo((qx + rx) / 2, Math.max(qy, ry) - 3, rx, ry - 12); }
      });
      ctx.stroke();
      for (const [rx, ry] of pts) {
        ctx.fillStyle = '#c99700';
        ctx.fillRect(rx - 1.6, ry - 15, 3.2, 15);
        ctx.beginPath(); ctx.arc(rx, ry - 16, 2.6, 0, Math.PI * 2); ctx.fill();
      }
      // backdrop posts + swag along the back edge
      let b1, b2;
      if (west) { b1 = [st.x + st.w - 8, st.y + 14]; b2 = [st.x + st.w - 8, st.y + st.h - 14]; }
      else if (south) { b1 = [st.x + 14, st.y + 8]; b2 = [st.x + st.w - 14, st.y + 8]; }
      else { b1 = [st.x + 14, st.y + st.h - 8]; b2 = [st.x + st.w - 14, st.y + st.h - 8]; }
      const ba = proj(b1[0], b1[1]), bb = proj(b2[0], b2[1]);
      ctx.strokeStyle = '#4a2c17'; ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(ba[0], ba[1]); ctx.lineTo(ba[0], ba[1] - 56);
      ctx.moveTo(bb[0], bb[1]); ctx.lineTo(bb[0], bb[1] - 56);
      ctx.stroke();
      ctx.strokeStyle = '#b03a48'; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ba[0], ba[1] - 56);
      ctx.quadraticCurveTo((ba[0] + bb[0]) / 2, Math.max(ba[1], bb[1]) - 28, bb[0], bb[1] - 56);
      ctx.stroke();
    }
    // v1.5.1: ONE shared venue mat under the whole audience
    // block — a single quiet ground cloth instead of the old
    // read of twenty separate coloured pads under twenty slabs.
    const audSeats = (mapDef.seats || []).filter(s2 => s2.kind === 'audience');
    if (audSeats.length) {
      const axs = audSeats.map(s2 => s2.x), ays = audSeats.map(s2 => s2.y);
      const mx0 = Math.min(...axs) - 36, mx1 = Math.max(...axs) + 36;
      const my0 = Math.min(...ays) - 28, my1 = Math.max(...ays) + 28;
      const mc1 = proj(mx0, my0), mc2 = proj(mx1, my0), mc3 = proj(mx1, my1), mc4 = proj(mx0, my1);
      ctx.beginPath();
      ctx.moveTo(mc1[0], mc1[1]); ctx.lineTo(mc2[0], mc2[1]);
      ctx.lineTo(mc3[0], mc3[1]); ctx.lineTo(mc4[0], mc4[1]);
      ctx.closePath();
      ctx.fillStyle = 'rgba(76,48,34,.34)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,214,150,.16)'; ctx.lineWidth = 2; ctx.stroke();
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
    // v1.1 show dressing: while a set is LIVE the stage washes in
    // colored light (day/night aware via darknessNow) and pyro
    // bursts fire on the mix's bar grid at the front corners. Idle
    // stage = no lights, no pyro.
    if (live) {
      const [ccx, ccy] = proj(st.x + st.w / 2, st.y + st.h / 2);
      const boost = 0.55 + darknessNow();
      const tNow = Date.now();
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const washes = ['255,190,80', '255,110,150', '140,170,255'];
      for (let i = 0; i < 3; i++) {
        const a = 0.11 * boost * (0.75 + 0.25 * Math.sin(tNow / 700 + i * 2.1));
        const gx = ccx + (i - 1) * 74, gy = ccy - 12, r = 200 - i * 26;
        const grd = ctx.createRadialGradient(gx, gy, 8, gx, gy, r);
        grd.addColorStop(0, `rgba(${washes[i]},${a.toFixed(3)})`);
        grd.addColorStop(1, `rgba(${washes[i]},0)`);
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      const startAt = perf.startAt || 0, bpm = perf.bpm || 112;
      const barIdx = startAt ? Math.floor((tNow - startAt) / ((60000 / bpm) * 4)) : -1;
      if (barIdx >= 0 && barIdx !== pyroBar) {
        pyroBar = barIdx;
        const pit2 = st.pit;
        const west2 = pit2 && pit2.x < st.x, south2 = pit2 && pit2.y > st.y;
        const corners = west2
          ? [[st.x + 6, st.y + 10], [st.x + 6, st.y + st.h - 10], [st.x + 6, st.y + st.h / 2]]
          : south2
            ? [[st.x + 10, st.y + st.h - 6], [st.x + st.w - 10, st.y + st.h - 6], [st.x + st.w / 2, st.y + st.h - 6]]
            : [[st.x + 10, st.y + 6], [st.x + st.w - 10, st.y + 6], [st.x + st.w / 2, st.y + 6]];
        const [wx, wy] = corners[barIdx % corners.length];
        spawnPyro(wx, wy);
      }
    } else {
      pyroBar = -1;
    }
    if (pyro.length) {
      for (let i = pyro.length - 1; i >= 0; i--) {
        const q = pyro[i];
        q.x += q.vx; q.y += q.vy; q.vy += 0.055; q.vx *= 0.985; q.life -= q.decay;
        if (q.life <= 0) { pyro.splice(i, 1); continue; }
        ctx.globalAlpha = Math.max(0, q.life);
        ctx.fillStyle = q.col;
        ctx.beginPath(); ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
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
      drawSlotCabinet(sx2, sy2, idx, s.ix < s.x - 4 ? 'W' : 'S', s.id);
    });
    for (const t of cz.tables) {
      const [tx2, ty2] = proj(t.x, t.y);
      for (const ch2 of t.chairs) {
        const [chx, chy] = proj(ch2.x, ch2.y);
        // v1.2 (Item E/K): poker chairs are the SHARED v3 chair —
        // a real chair with a back, ringed at the unchanged seat
        // positions. Facing derives from the chair's side of the
        // table (the sitter faces the felt): north chair faces
        // down-screen, south chair up, east chair left, west right.
        const face = Math.abs(chx - tx2) > Math.abs(chy - ty2)
          ? (chx > tx2 ? 'left' : 'right')
          : (chy > ty2 ? 'up' : 'down');
        drawChairAt(chx, chy, face, {
          deferNearBack: face === 'up' && occupiedSeatIds.has(`poker:${t.id}:${ch2.dir}`),
        });
      }
      ctx.beginPath(); ctx.ellipse(tx2, ty2, 44, 23, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#7a5a2b'; ctx.fill();
      ctx.beginPath(); ctx.ellipse(tx2, ty2 - 2, 38, 19, 0, 0, Math.PI * 2);
      // v1.5: blackjack tables wear a deep-blue felt so the two
      // games read differently at a glance (poker stays green).
      ctx.fillStyle = t.game === 'blackjack' ? '#1d4468' : '#14663c'; ctx.fill();
      if (t.game === 'blackjack') drawBlackjackState(t, tx2, ty2);
      else drawFeltState(t, tx2, ty2);
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
    // tell the casino tray whether we are inside the lounge
    if (window.SolarionCasino && myRp) window.SolarionCasino.updatePresence(myRp.x, myRp.y, mapDef);
    // v1.2 (Item O): the fishing proximity prompt — visible only
    // while I stand at a fishable bank, unseated, line not out.
    {
      const hint = $('fishHint');
      let show = false;
      if (mapDef && mapDef.fishable && mapDef.rows && myRp && me && !me.seated && !me.casting) {
        const ts = mapDef.tileSize || 32;
        const mtx = Math.floor(myRp.x / ts), mty = Math.floor(myRp.y / ts);
        for (let ty = mty - 2; ty <= mty + 2 && !show; ty++) {
          const row = mapDef.rows[ty]; if (!row) continue;
          for (let tx = mtx - 2; tx <= mtx + 2; tx++) if (row[tx] === '%') { show = true; break; }
        }
      }
      hint.classList.toggle('hidden', !show);
    }
  }

  // Club Mirage (v1.4): stages, dancers, spotlights, the bar.
  if (mapDef.club) drawClubPass(Date.now());

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
    // v1.1: home seating + tables get the real furniture art (the
    // catalog's chair and table pieces) instead of the generic block,
    // facing from the piece's rotation (same rot→dir map as the sim).
    if (f.type === 'seating') {
      const fdir = ['down', 'left', 'up', 'right'][f.rot & 3] || 'down';
      drawChairAt(fx, fy + 2, fdir, {
        deferNearBack: fdir === 'up' && occupiedSeatIds.has(`furn:${f.instanceId}`),
      });
      ctx.restore();
      continue;
    }
    if (f.type === 'table') {
      drawTableAt(fx, fy);
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
      // v1.2 (Items K/Q): a bench has a BACK — slatted, on the side
      // opposite the sitter's facing (drawn before the seat when
      // it's on the far side, over the seat's edge when near).
      const bk = { down: [0, -7], up: [0, 7], left: [10, 2], right: [-10, 2] }[s.dir] || [0, -7];
      const benchBack = () => {
        ctx.strokeStyle = '#5a3d1f'; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(sx3 + bk[0] - 11, sy3 + bk[1] + 3); ctx.lineTo(sx3 + bk[0] - 11, sy3 + bk[1] - 8);
        ctx.moveTo(sx3 + bk[0] + 11, sy3 + bk[1] + 3); ctx.lineTo(sx3 + bk[0] + 11, sy3 + bk[1] - 8);
        ctx.stroke();
        ctx.strokeStyle = '#a5713a'; ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(sx3 + bk[0] - 12, sy3 + bk[1] - 4); ctx.lineTo(sx3 + bk[0] + 12, sy3 + bk[1] - 4);
        ctx.moveTo(sx3 + bk[0] - 12, sy3 + bk[1] - 8); ctx.lineTo(sx3 + bk[0] + 12, sy3 + bk[1] - 8);
        ctx.stroke();
      };
      if (s.dir !== 'up') benchBack();
      // v1.3.1: legs + a skirt, so a bench reads as furniture with
      // thickness, never a flat pad on the ground.
      ctx.strokeStyle = '#5a3d1f'; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx3 - 12, sy3 + 2); ctx.lineTo(sx3 - 13, sy3 + 9);
      ctx.moveTo(sx3 + 12, sy3 + 2); ctx.lineTo(sx3 + 13, sy3 + 9);
      ctx.stroke();
      diamond(sx3, sy3 + 2, 32, 11, '#6e4525');
      diamond(sx3, sy3, 30, 10, '#8a5a2b');
      diamond(sx3, sy3 - 4, 30, 6, '#a5713a');
      if (s.dir === 'up') benchBack();
    } else if (s.kind === 'sofa') {
      drawSofaAt(sx3, sy3, s.dir);
    } else if (s.kind === 'towel') {
      drawTowelAt(sx3, sy3);
    } else if (s.kind === 'cafe') {
      // Lane C booth seating, v1.1 scale: the table sits at the TRUE
      // projected midpoint between the facing pair (the old hand-tuned
      // offsets drifted, worst on 'left'), and everything is sized
      // for 1.5x characters — a table you sit AT, not a coaster.
      const off = { down: [0, 23], up: [0, -23], left: [-23, 12], right: [23, 12] }[s.dir] || [0, 23];
      diamond(sx3 - off[0] * 0.55, sy3 - off[1] * 0.55 - 2, 34, 10, '#7e2f3c'); // backrest
      diamond(sx3, sy3, 36, 12, '#b03a48');                                     // bench cushion
      diamond(sx3, sy3 - 3, 36, 9, '#c4505f');
      ctx.beginPath(); ctx.ellipse(sx3 + off[0], sy3 + off[1], 21, 10.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#caa06a'; ctx.fill();
      ctx.strokeStyle = '#7a5a2b'; ctx.lineWidth = 1; ctx.stroke();
    } else if (s.kind === 'hookah') {
      // Lane C: low booth benches flanking the station's low table.
      // v1.3.1: a low backrest strip on the side away from the
      // station, so the booth pad reads as a seat, not a box.
      const hb = { right: [-13, -1], left: [13, -1], down: [0, -8], up: [0, 6] }[s.dir] || [0, -8];
      diamond(sx3 + hb[0], sy3 + hb[1], 22, 8, '#4a2740');
      diamond(sx3, sy3, 30, 10, '#5d3450');
      diamond(sx3, sy3 - 4, 30, 7, '#7a4666');
    } else if (s.kind === 'audience') { // v1.5.1: the venue chair — open-ladder back, never a box
      drawAudienceChairAt(sx3, sy3, s.dir, {
        deferNearBack: s.dir === 'up' && occupiedSeatIds.has(s.id),
      });
    } else { // chair — v1.1: a real chair (legs, cushion, backrest)
      drawChairAt(sx3, sy3, s.dir, {
        deferNearBack: s.dir === 'up' && occupiedSeatIds.has(s.id),
      });
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

  // v1.1.1: pond fish leap now and then — a little arc + splash.
  tickPondLeaps(Date.now());

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
    // v1.2.3 (Item 1): a table sitter is pulled in toward their
    // table before projecting — shadow, nameplate and bubbles all
    // ride the same nudged point.
    const tbl = p.seated && !p.fallen ? tableSeatInfo(p) : null;
    const [sx, sy] = tbl ? proj(rp.x + tbl.pull[0], rp.y + tbl.pull[1]) : proj(rp.x, rp.y);
    let bob = rp.moving ? Math.abs(Math.sin(now / 110 + p.id)) * 3 : 0;
    // Phase 9: dancing is a whole-body bounce (anywhere, anytime).
    if (p.emote === 'dance') bob += Math.abs(Math.sin(now / 130 + p.id * 1.3)) * 6;
    // Fish emote: a little triumph hop while the catch is held high.
    if (p.emote === 'fish') bob += Math.abs(Math.sin(now / 160 + p.id * 1.7)) * 2.5;

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
    // v1.3.1 (Item 13): a player seated on a beach TOWEL lies on it.
    const lying = Boolean(p.seated)
      && ((mapDef.seats || []).find(s2 => s2.id === p.seatId) || {}).kind === 'towel';
    ctx.save();
    if (p.fallen) {
      ctx.translate(sx, sy - 3);
      ctx.rotate(-1.45); // flat on the floor, visible to everyone
      ctx.drawImage(spr, -dw / 2, -dh + 8, dw, dh);
    } else if (lying) {
      // Flat along the towel like the fallen pose, head toward the
      // towel's NW end (its umbrella stands at that shoulder).
      ctx.translate(sx, sy - 2);
      ctx.rotate(-1.45);
      ctx.drawImage(spr, -dw / 2, -dh + 10, dw, dh);
    } else {
      ctx.translate(sx + sway, sy - bob + (p.seated ? 3 : 0));
      if (p.dir === 'right') ctx.scale(-1, 1); // side sprite faces left natively; flip for right
      ctx.drawImage(spr, -dw / 2, -dh + 4, dw, dh);
    }
    ctx.restore();

    // v1.2.2 (Item 3): an occupied 'up' chair's near-side back is
    // replayed OVER its sitter — from behind, the backrest is what
    // the camera sees against the sitter's back. Without this pass
    // the sprite (drawn after the seat) buried the back entirely
    // and slot seats read backless while occupied.
    if (p.seated && !p.fallen) {
      const bp = deferredSeatBackPos(p);
      // v1.5.1: audience seats replay the AUDIENCE back (open
      // ladder), every other deferred seat the table chair's.
      if (bp) (bp[2] === 'audience' ? drawAudienceBackNear : drawChairBackNear)(bp[0], bp[1]);
    }

    // v1.2.3 (Item 1): the table's front replays over the
    // sitter's lap — legs under the table, not painted over it.
    if (tbl) drawTableFrontAt(tbl.tx, tbl.ty);

    // performer holds the mic (soul doc §9.3)
    if (p.performing) {
      ctx.font = '15px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('🎤', sx + 13 * CHAR_SCALE, sy - 12 * CHAR_SCALE - bob);
    }

    // Fish emote (Zan, 2026-10-21): the catch brandished overhead
    // in triumph — the real fish art, wiggling, beside the head.
    if (p.emote === 'fish' && !p.fallen) {
      const wig = Math.sin(now / 120 + p.id * 2.3) * 0.22;
      drawFishShape(sx + 15 * CHAR_SCALE, sy - dh - 9 - bob, 'sunfish', 0.95, wig);
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

    // Fishing cast (v1.2 Item O): the fish-cast event carries the
    // real landing point ~2–3 tiles out. First ~450ms: the bobber
    // ARCS out along a curve while the rod (a line from the hand)
    // swings with it; then the bobber sits on the water with
    // ripples — or, on ice, a dark drill hole at the landing.
    if (p.casting) {
      const fx = castFx.get(p.id);
      const handX = sx + (p.dir === 'left' ? -12 : 12), handY = sy - 52 - bob;
      let lx, ly, landed = true, ice = false;
      if (fx && now - fx.at < 3400) {
        const [tx2, ty2] = proj(fx.landX, fx.landY);
        ice = fx.ice;
        const t = Math.min(1, (now - fx.at) / 450);
        landed = t >= 1;
        const mx = (handX + tx2) / 2, my = Math.min(handY, ty2) - 34;
        lx = (1 - t) * (1 - t) * handX + 2 * (1 - t) * t * mx + t * t * tx2;
        ly = (1 - t) * (1 - t) * handY + 2 * (1 - t) * t * my + t * t * ty2;
        // the rod: hand to a tip that leads the bobber's arc.
        const tipX = handX + (lx - handX) * 0.42, tipY = handY - 16 + (ly - handY) * 0.3;
        ctx.strokeStyle = '#6b4a26'; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(handX, handY + 6); ctx.lineTo(tipX, tipY); ctx.stroke();
        ctx.strokeStyle = 'rgba(240,248,255,.8)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(tipX, tipY); ctx.quadraticCurveTo(mx, my, lx, ly); ctx.stroke();
      } else {
        const off = { down: [44, 44], up: [-44, -44], right: [22, -22], left: [-22, 22] }[p.dir] || [44, 44];
        [lx, ly] = proj(rp.x + off[0], rp.y + off[1]);
        ctx.strokeStyle = 'rgba(240,248,255,.8)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(handX, handY);
        ctx.quadraticCurveTo((handX + lx) / 2, Math.min(handY, ly) - 14, lx, ly); ctx.stroke();
      }
      if (landed && ice) {
        // the drill hole on the ice + the line dropping into it
        ctx.beginPath(); ctx.ellipse(lx, ly, 7, 3.4, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#16222e'; ctx.fill();
        ctx.beginPath(); ctx.ellipse(lx, ly, 9.5, 4.6, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(230,244,255,.5)'; ctx.lineWidth = 1; ctx.stroke();
      } else if (landed) {
        const rip = 3 + ((now / 320) % 1) * 6;
        ctx.beginPath(); ctx.ellipse(lx, ly, rip, rip * 0.45, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(210,240,255,.55)'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.beginPath(); ctx.arc(lx, ly - 2, 2.6, 0, Math.PI * 2); ctx.fillStyle = '#e2543e'; ctx.fill();
        ctx.beginPath(); ctx.arc(lx, ly - 0.4, 2.6, Math.PI, Math.PI * 2); ctx.fillStyle = '#fff6e6'; ctx.fill();
      }
    }
    // v1.1.1: the catch hold-up — the fish, overhead, for its second.
    if (p.heldFish) {
      drawFishShape(sx, sy - dh - 30 - bob, p.heldFish, 1.05, Math.sin(now / 90 + p.id) * 0.14);
    }

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

  // v1.5 (Feature 1): the poker board overlay — plaque + community
  // cards + pot + winners replayed OVER the entities, so a seated
  // player's sprite can never bury the board (see drawBoardOverlay).
  if (mapDef.casino) {
    for (const t of mapDef.casino.tables) {
      if (t.game === 'blackjack') continue;
      const [btx, bty] = proj(t.x, t.y);
      drawBoardOverlay(t, btx, bty);
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
      // Seasonal palettes ride the SAME day/night system (no fork):
      // Halloween deepens the plum and pushes the dark further;
      // Christmas warms the plum a touch.
      if (season === 'halloween') {
        ctx.fillStyle = `rgba(22,8,34,${Math.min(0.54, dark * 1.24)})`;
      } else if (season === 'christmas') {
        ctx.fillStyle = `rgba(34,16,30,${dark})`;
      } else {
        ctx.fillStyle = `rgba(32,18,36,${dark})`;
      }
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
    // Halloween burns more orange than gold in every lamp.
    const glowRGB = season === 'halloween' ? '255,150,60' : '255,205,110';
    const glow = (wx, wy, r, a) => {
      const [gx, gy] = proj(wx, wy);
      const g = ctx.createRadialGradient(gx, gy, 2, gx, gy, r);
      g.addColorStop(0, `rgba(${glowRGB},${a})`);
      g.addColorStop(1, `rgba(${glowRGB},0)`);
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
      if (pr.kind === 'hearth') glow(pr.x, pr.y - 16, 175, 0.38); // v1.2.3: the BIG hearth throws a room-filling pool
      else if (pr.kind === 'lamp' || pr.kind === 'lantern' || pr.kind === 'stringlights') glow(pr.x, pr.y - 14, 62, 0.24);
      // Lane C heroes that burn at night: the lighthouse lamp, the
      // great NEON sign, the forge's embers. (Equal x/y offsets
      // project to straight screen-up, onto the drawn light source.)
      else if (pr.kind === 'lighthouse') glow(pr.x - 100, pr.y - 100, 115, 0.34);
      else if (pr.kind === 'neonsign') glow(pr.x - 88, pr.y - 88, 95, 0.22);
      else if (pr.kind === 'forge') glow(pr.x, pr.y - 14, 70, 0.26);
      // Seasonal: jack-o'-lanterns burn from inside; holiday bulbs hum.
      else if (pr.kind === 'jackolantern' || pr.kind === 'pumpkinstack') glow(pr.x, pr.y - 10, 60, 0.32);
      else if (pr.kind === 'holidaylights') glow(pr.x, pr.y - 24, 68, 0.20);
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
      if (f.type === 'hearth') glow((f.x + 0.5) * TSg, (f.y + 0.5) * TSg - 14, 165, 0.38);
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
    // v1.1: a real gesture is also what a deferred stage performance
    // (Item 5) and the zone music (Item 14) are waiting on.
    try { if (typeof AE !== 'undefined' && AE.notifyGesture) AE.notifyGesture(); } catch (e) { /* no audio */ }
    if (window.SolarionSfx) window.SolarionSfx.unlock();
    if (window.SolarionZoneMusic) window.SolarionZoneMusic.kick();
  }, { passive: true });
}
