'use strict';

/**
 * Solarion — Bake Shop asset factory (Phase 10 style language).
 *
 * Parametric drawing parts so a build pass COMPOSES buildings and
 * props instead of hand-drawing every facade from scratch. Every
 * function takes the 2D context first and draws in projected SCREEN
 * space — the same convention as public/client.js's own draw pass
 * (drawDoor, drawHearthAt, drawLampAt): ground anchor (cx, cy),
 * warm wood + brass palette, lit windows/lamps in #ffca7a so the
 * results sit naturally beside the Phase 10 doors and join the
 * night-glow pass by returning glow anchors where relevant.
 *
 * Browser: window.SolarionFactory. Node: module.exports (the draw
 * functions need a ctx — in Node pass any canvas-like 2D context,
 * e.g. from a headless page; see scripts/factory-demo.html).
 *
 * ZOOM / proj mirror client.js exactly (2:1 iso, ZOOM 0.72) so
 * factory pieces land on the same ground the client draws.
 */

const ZOOM = 0.72;

const PALETTE = {
  woodDark: '#4a3423',   // door frames, sign boards
  wood: '#8a5a2b',       // door leaf, planter boxes
  woodLight: '#a5713a',
  brass: '#ffd23f',      // knobs, marquee bulbs
  lamp: '#ffca7a',       // warm lit glass — the glow-pass color
  ink: '#fff6e6',        // sign text
  threshold: '#140b06',  // darkened doorway
  leaf: '#8a5a2b',
};

function proj(x, y) {
  return [(x - y) * ZOOM, (x + y) * ZOOM * 0.5];
}

function shade(hex, amt) {
  const n = parseInt(String(hex || '#888888').slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 0xff) + amt, b = (n & 0xff) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return `rgb(${r},${g},${b})`;
}

function diamond(ctx, cx, cy, hw, hh, fill) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - hh);
  ctx.lineTo(cx + hw, cy);
  ctx.lineTo(cx, cy + hh);
  ctx.lineTo(cx - hw, cy);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * A building facade, front-facing like the Phase 10 doors: two-tone
 * wall (the center seam is the iso corner), a pitched gable roof,
 * a grid of windows (warm-lit by default), the door centered with
 * its lintel sign. (cx, cy) = ground point at the door threshold.
 * opts: { w=190 (px frontage), floors=2, wall, roof, sign, lit }
 * Returns { w, h, door: {x, y} } — h is total height above cy.
 */
function makeBuilding(ctx, cx, cy, opts = {}) {
  const w = opts.w || 190;
  const floors = opts.floors || 2;
  const wall = opts.wall || '#7a4a2f';
  const roof = opts.roof || '#5a2e22';
  const wallH = 26 + floors * 30;
  const topY = cy - wallH;
  const roofH = Math.round(w * 0.22);
  const hw = w / 2;

  // walls: left half shaded (iso corner at center, as drawTile does)
  ctx.fillStyle = shade(wall, -14);
  ctx.fillRect(cx - hw, topY, hw, wallH);
  ctx.fillStyle = wall;
  ctx.fillRect(cx, topY, hw, wallH);
  // cornice
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(cx - hw - 3, topY - 4, w + 6, 5);
  // pitched roof: gable triangle + ridge highlight
  ctx.beginPath();
  ctx.moveTo(cx - hw - 7, topY - 3);
  ctx.lineTo(cx, topY - 3 - roofH);
  ctx.lineTo(cx + hw + 7, topY - 3);
  ctx.closePath();
  ctx.fillStyle = roof;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, topY - 3 - roofH);
  ctx.lineTo(cx + hw + 7, topY - 3);
  ctx.lineTo(cx, topY - 3);
  ctx.closePath();
  ctx.fillStyle = shade(roof, 16);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,202,122,.55)';
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(cx - hw - 7, topY - 3); ctx.lineTo(cx, topY - 3 - roofH); ctx.stroke();

  // windows: a grid of warm-lit panes with dark frames
  if (opts.windows !== false) {
    const cols = Math.max(2, Math.floor(w / 44));
    const rowsN = floors;
    for (let r = 0; r < rowsN; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = cx - hw + 16 + c * ((w - 32) / Math.max(1, cols - 1)) - 6;
        const wy = topY + 12 + r * 30;
        if (Math.abs(wx + 6 - cx) < 17 && r === rowsN - 1) continue; // door bay
        const lit = opts.lit !== false && ((c * 7 + r * 3) % 4 !== 0);
        ctx.fillStyle = PALETTE.woodDark;
        ctx.fillRect(wx - 1.5, wy - 1.5, 13, 17);
        ctx.fillStyle = lit ? PALETTE.lamp : '#1c2733';
        ctx.fillRect(wx, wy, 10, 14);
        ctx.fillStyle = 'rgba(255,255,255,.28)';
        ctx.fillRect(wx + 1.5, wy + 1.5, 3, 5);
      }
    }
  }

  // the door (Phase 10 language: dark threshold, paneled leaf,
  // brass knob, framed posts + lintel, welcome mat)
  const doorW = 30, doorH = 44;
  const dTop = cy - doorH;
  diamond(ctx, cx, cy + 8, doorW * 0.62, doorW * 0.3, '#9c4034');
  diamond(ctx, cx, cy + 8, doorW * 0.42, doorW * 0.2, '#c96f4a');
  ctx.fillStyle = PALETTE.threshold;
  ctx.fillRect(cx - doorW / 2, dTop + 3, doorW, doorH - 3);
  ctx.fillStyle = PALETTE.leaf;
  ctx.fillRect(cx - doorW / 2, dTop + 3, doorW, doorH - 3);
  ctx.strokeStyle = 'rgba(46,29,16,.8)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - doorW / 2 + 3.5, dTop + 8, doorW - 7, doorH * 0.34);
  ctx.strokeRect(cx - doorW / 2 + 3.5, dTop + doorH * 0.56, doorW - 7, doorH * 0.28);
  ctx.beginPath(); ctx.arc(cx + doorW / 2 - 5, dTop + doorH * 0.52, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = PALETTE.brass; ctx.fill();
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(cx - doorW / 2 - 5, dTop, 5, doorH);
  ctx.fillRect(cx + doorW / 2, dTop, 5, doorH);
  ctx.fillRect(cx - doorW / 2 - 5, dTop - 6, doorW + 10, 6);

  if (opts.sign) {
    ctx.font = 'bold 13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.ink;
    ctx.strokeStyle = 'rgba(30,18,8,.75)';
    ctx.lineWidth = 3;
    ctx.strokeText(opts.sign, cx, dTop - 13);
    ctx.fillText(opts.sign, cx, dTop - 13);
  }
  return { w, h: wallH + roofH, door: { x: cx, y: cy } };
}

/**
 * An arcade cabinet (the slot/pinball lesson from X's Coke
 * reference): chunky body, lit marquee with bulbs, angled glass
 * screen with the reels showing through a shine streak, coin panel.
 * (cx, cy) = ground point at the cabinet's base center.
 * opts: { body, marquee, screen, label } — label defaults '7·7·7'.
 * Returns { w: 36, h: 56 }.
 */
function makeCabinet(ctx, cx, cy, opts = {}) {
  const body = opts.body || '#7a1f2b';
  const marquee = opts.marquee || '#ffd23f';
  const W = 36, H = 56;
  const x0 = cx - W / 2, y0 = cy - H;
  // side depth (right slant face)
  ctx.beginPath();
  ctx.moveTo(x0 + W, y0 + 6); ctx.lineTo(x0 + W + 7, y0 + 1);
  ctx.lineTo(x0 + W + 7, cy - 5); ctx.lineTo(x0 + W, cy);
  ctx.closePath();
  ctx.fillStyle = shade(body, -26); ctx.fill();
  // body
  ctx.fillStyle = body;
  ctx.fillRect(x0, y0, W, H);
  ctx.fillStyle = shade(body, 18);
  ctx.fillRect(x0, y0, 4, H);
  // marquee band + bulbs
  ctx.fillStyle = marquee;
  ctx.fillRect(x0 - 2, y0 - 8, W + 4, 11);
  ctx.fillStyle = '#171126';
  ctx.font = 'bold 8px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(opts.label || '★ SLOTS ★', cx, y0);
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(x0 + 4 + i * ((W - 8) / 3), y0 - 11, 1.8, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.brass; ctx.fill();
  }
  // angled glass screen with reels + shine
  ctx.beginPath();
  ctx.moveTo(x0 + 5, y0 + 9); ctx.lineTo(x0 + W - 5, y0 + 6);
  ctx.lineTo(x0 + W - 5, y0 + 24); ctx.lineTo(x0 + 5, y0 + 27);
  ctx.closePath();
  ctx.fillStyle = opts.screen || '#ffe9a8'; ctx.fill();
  ctx.fillStyle = '#171126';
  ctx.font = 'bold 11px system-ui';
  ctx.fillText(opts.reels || '7·7·7', cx, y0 + 20);
  ctx.strokeStyle = 'rgba(255,255,255,.65)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0 + 9, y0 + 24); ctx.lineTo(x0 + 17, y0 + 8); ctx.stroke();
  // coin panel: slot + buttons
  ctx.fillStyle = shade(body, -18);
  ctx.fillRect(x0 + 5, y0 + 32, W - 10, 10);
  ctx.fillStyle = PALETTE.brass;
  ctx.fillRect(cx - 1, y0 + 34, 2, 6);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x0 + 9 + i * 9, y0 + 48, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = ['#ff5d5d', '#ffd23f', '#57d977'][i]; ctx.fill();
  }
  return { w: W + 7, h: H + 8 };
}

/** A leafy tree: tapered trunk, three-shade layered canopy. */
function makeTree(ctx, cx, cy, opts = {}) {
  const s = opts.size || 1;
  const canopy = opts.canopy || '#2e6b34';
  ctx.fillStyle = opts.trunk || '#6e4a26';
  ctx.beginPath();
  ctx.moveTo(cx - 3.5 * s, cy); ctx.lineTo(cx - 2 * s, cy - 20 * s);
  ctx.lineTo(cx + 2 * s, cy - 20 * s); ctx.lineTo(cx + 3.5 * s, cy);
  ctx.closePath(); ctx.fill();
  const blob = (bx, by, r, col) => {
    ctx.beginPath(); ctx.ellipse(bx, by, r, r * 0.82, 0, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  };
  blob(cx, cy - 34 * s, 17 * s, shade(canopy, -18));
  blob(cx - 11 * s, cy - 27 * s, 12 * s, canopy);
  blob(cx + 11 * s, cy - 27 * s, 12 * s, canopy);
  blob(cx - 4 * s, cy - 40 * s, 11 * s, shade(canopy, 22));
  if (opts.fruit) {
    ctx.fillStyle = opts.fruit;
    for (const [fx, fy] of [[-9, -30], [6, -36], [12, -24], [-1, -27]]) {
      ctx.beginPath(); ctx.arc(cx + fx * s, cy + fy * s, 1.7 * s, 0, Math.PI * 2); ctx.fill();
    }
  }
  return { w: 40 * s, h: 52 * s };
}

/**
 * A lamp post (or hanging lantern with opts.lantern). Draws the post
 * and warm head; RETURNS the glow anchor { x, y, r } so the caller
 * can punch it through the night pass exactly like client.js does
 * for map lamps (radial gradient, 'lighter' composite).
 */
function makeLamp(ctx, cx, cy, opts = {}) {
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(cx - 1.6, cy - 34, 3.2, 34);
  ctx.fillRect(cx - 5, cy - 2, 10, 2.4);
  if (opts.lantern) {
    ctx.strokeStyle = PALETTE.woodDark; ctx.lineWidth = 1.4;
    ctx.strokeRect(cx - 4.5, cy - 44, 9, 11);
    ctx.fillStyle = PALETTE.lamp;
    ctx.fillRect(cx - 3, cy - 42.5, 6, 8);
    ctx.fillStyle = PALETTE.woodDark;
    ctx.fillRect(cx - 5.5, cy - 46, 11, 2.4);
  } else {
    ctx.beginPath(); ctx.arc(cx, cy - 38, 5, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.lamp; ctx.fill();
    ctx.strokeStyle = PALETTE.woodDark; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 6, cy - 41); ctx.lineTo(cx, cy - 47); ctx.lineTo(cx + 6, cy - 41);
    ctx.closePath(); ctx.fillStyle = PALETTE.woodDark; ctx.fill();
  }
  return { x: cx, y: cy - 38, r: 62 };
}

/** A planter box: iso box, soil top, foliage + flower dots. */
function makePlanter(ctx, cx, cy, opts = {}) {
  const box = opts.box || PALETTE.wood;
  const hw = opts.hw || 26;
  const hh = hw * 0.5;
  // faces
  ctx.beginPath();
  ctx.moveTo(cx - hw, cy - 8); ctx.lineTo(cx, cy + hh - 8);
  ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy);
  ctx.closePath(); ctx.fillStyle = shade(box, -16); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx, cy + hh - 8); ctx.lineTo(cx + hw, cy - 8);
  ctx.lineTo(cx + hw, cy); ctx.lineTo(cx, cy + hh);
  ctx.closePath(); ctx.fillStyle = box; ctx.fill();
  diamond(ctx, cx, cy - 8, hw, hh, '#3a2a18'); // soil
  // foliage blobs + flowers
  const greens = ['#2e6b34', '#3a7d40', '#26502b'];
  for (let i = 0; i < 5; i++) {
    const fx = cx - hw * 0.6 + i * hw * 0.3;
    const fy = cy - 12 - (i % 2) * 3.5;
    ctx.beginPath(); ctx.ellipse(fx, fy, 6.4, 4.6, 0, 0, Math.PI * 2);
    ctx.fillStyle = greens[i % 3]; ctx.fill();
  }
  const flowers = opts.flowers || ['#e5639e', '#ffd23f', '#ff5d5d'];
  for (let i = 0; i < 6; i++) {
    const fx = cx - hw * 0.62 + i * hw * 0.24;
    const fy = cy - 15 - ((i * 5) % 3) * 2.4;
    ctx.beginPath(); ctx.arc(fx, fy, 1.9, 0, Math.PI * 2);
    ctx.fillStyle = flowers[i % flowers.length]; ctx.fill();
  }
  return { w: hw * 2, h: 22 };
}

/** A wooden sign: two posts, framed board, centered warm text. */
function makeSign(ctx, cx, cy, opts = {}) {
  const text = opts.text || '';
  const bw = opts.w || Math.max(64, text.length * 8.4 + 22);
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(cx - bw / 2 + 7, cy - 26, 3.4, 26);
  ctx.fillRect(cx + bw / 2 - 10.4, cy - 26, 3.4, 26);
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(cx - bw / 2 - 3, cy - 47, bw + 6, 24);
  ctx.fillStyle = opts.board || '#6e4a26';
  ctx.fillRect(cx - bw / 2, cy - 44.5, bw, 19);
  ctx.fillStyle = PALETTE.brass;
  for (const nx of [cx - bw / 2 + 5, cx + bw / 2 - 5]) {
    ctx.beginPath(); ctx.arc(nx, cy - 35, 1.6, 0, Math.PI * 2); ctx.fill();
  }
  if (text) {
    ctx.font = 'bold 12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillStyle = PALETTE.ink;
    ctx.fillText(text, cx, cy - 31.5);
  }
  return { w: bw + 6, h: 47 };
}

/* NOTE: not named `API` — sprites.js already declares a top-level
 * `const API`, and classic scripts share one lexical scope, so a
 * second `const API` would be a SyntaxError that kills the file. */
const FACTORY = {
  ZOOM, PALETTE, proj, shade, diamond,
  makeBuilding, makeCabinet, makeTree, makeLamp, makePlanter, makeSign,
};
if (typeof window !== 'undefined') window.SolarionFactory = FACTORY;
if (typeof module !== 'undefined' && module.exports) module.exports = FACTORY;
