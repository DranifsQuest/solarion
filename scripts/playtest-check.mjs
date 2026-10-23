#!/usr/bin/env node
'use strict';

/**
 * Solarion Playtest Gate — image-space checker.
 *
 * WHY THIS EXISTS (X, 2026-10-21): every defect he caught by eye
 * was a RENDER-read problem the dressing validator cannot see —
 * seat rows legal in the data but jumbled on screen, sitters
 * painted over tabletops, chair backs swallowed by their sitters.
 * The validator checks the DATA; this checker checks the RENDER.
 *
 * INPUT: previews/playtest/manifest.json + the PNG captures the
 * Bake Shop's playtest scene produced (scripts/preview.mjs
 * --scene playtest). Each manifest entry records the camera anchor
 * (the posed "you" actor's world position) and every posed actor's
 * seat/stand data, so any world point's screen position is exact:
 * the client's camera is a pure translation of proj() (client.js:
 * camState centres "you"; draw is translate(-cam)), i.e.
 *   screen(p) = proj(p) - proj(camera) + (canvasW/2, canvasH/2)
 * plus the canvas's page offset recorded in the manifest.
 *
 * CHECKS (each with a named failure; thresholds in TH below):
 *   ROW ALIGNMENT   — venue audience seats' screen anchors lie on
 *                     straight iso rows (<=2.5px off the fitted
 *                     line) with uniform spacing; anchors are
 *                     VERIFIED against the image (cushion-palette
 *                     centroid within 7px of the computed anchor),
 *                     so this measures the render, not just math.
 *   BACK VISIBILITY — two passes over facing-specific back
 *                     windows taken from the draw code's own
 *                     geometry (drawChairAt / bench / sofa / cafe
 *                     branches in client.js). (1) REFERENCE: every
 *                     backed seat's back must render — sampled in
 *                     its best UNOCCUPIED observation across the
 *                     captures. (2) OCCUPIED: facings whose back is
 *                     designed to read with a sitter in it (chair
 *                     'up' deferred panels, iso side panels, sofa
 *                     crests, cafe near/side backs) must still
 *                     sample their palette around the sitter.
 *                     Far-side backs (chair 'down', bench slats,
 *                     cafe 'down') are occluded by the sitter's
 *                     ±15px sprite BY DESIGN (posts sit at ±13.5)
 *                     — measured: unoccupied windows read
 *                     0.50–0.66, occupied 0.0–0.11 — so they are
 *                     verified by the reference pass, not faked
 *                     with a lower bar. Profile backs (chair
 *                     'left'/'right') are edge-on: their window
 *                     is the panel's outboard post strip, with
 *                     its own measured bands (see TH), and an
 *                     occupied observation a NEIGHBOUR's sprite
 *                     covers (poker-ring geometry) is covered
 *                     by the reference pass the same way.
 *                     Hookah booths have no backrest BY DESIGN
 *                     and are excluded.
 *   LEGS UNDER TABLES — posed sitters wear neon-green pants
 *                     (accent_color marker set by the playtest
 *                     scene); each posed table's tabletop-
 *                     interior window must be ~free of marker
 *                     green and actually covered by tabletop
 *                     colours (legs UNDER the table; feet below
 *                     the front band are legitimate and outside
 *                     the window by construction).
 *   CLEAR ZONES     — render-space confirmation of the data laws,
 *                     scoped to the laws as written in
 *                     scripts/validate-dressing.mjs: the DOORSTEP
 *                     law binds seasonal dressing (base props
 *                     legitimately flank doors — the casino
 *                     lanterns are the standing example); the
 *                     PIT-FRONT law binds every prop layer, all
 *                     seats, and posed sitters. Standing actors
 *                     are exempt: doorways and pit fronts are
 *                     FOR standing in.
 *   CROWDING        — interiors: furniture-unit centres (table
 *                     groups, hookah stations) keep the game's
 *                     own spacings — >= 5 tiles for table groups
 *                     (the validator's table law), >= 3.5 tiles
 *                     between stations. Hearth arcs are fixed
 *                     architectural seating, not units.
 *   EDGE MARGIN     — buildings keep >= 40px of screen space from
 *                     the map boundary diamond (proj-space).
 *
 * Pixel checks run on DAY captures only: the night lamp-glow pass
 * is additive and shifts palettes; night captures exist for the
 * human contact sheet. Geometry checks are phase-independent
 * (proj space is camera-translation invariant).
 *
 * Every check is negative-tested: `node scripts/playtest-check.mjs
 * --selftest` builds synthetic fixtures (doctored images / shifted
 * anchors / injected props) and asserts each check FAILS by name.
 * test/playtest-gate.test.js runs that selftest in the suite.
 *
 * Usage:
 *   node scripts/playtest-check.mjs            # check the captures
 *   node scripts/playtest-check.mjs --selftest # negative tests
 * Exit 0 = PASS, 1 = FAIL, 2 = tooling error.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAPS, TILE } = require('../src/maps');
const { overlayProps } = require('../src/seasons');

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PT_DIR = path.join(ROOT, 'previews', 'playtest');

// ---------------------------------------------------------------------------
// Thresholds — tuned against the baseline run; see gate report.
// ---------------------------------------------------------------------------
export const TH = {
  alignMaxDevPx: 2.5,        // seat anchor off its row's iso line
  alignGapTolPx: 3,          // row spacing non-uniformity
  anchorCentroidTolPx: 7,    // image cushion centroid vs computed anchor
  // Chair-family bars, calibrated on measured renders.
  // UP/DOWN facings (chair 0.10, 2026-10-22 baseline): a HIDDEN
  // back reads <= 0.9%; a correctly drawn near-side panel over
  // dark poker felt tops out at ~13.3% (the panel is translucent
  // — over the sitter's marker pants and the felt it blends
  // off-palette; only the solid posts match), while the same
  // panel over a light café floor reads ~55%. 10% sits inside
  // the empty band between hidden and drawn.
  // PROFILE facings (left/right, profile 0.10, recalibrated
  // 2026-10-22 on main 8ade950): the profile panel is EDGE-ON —
  // a 20px-wide strip on the cushion's back diagonal — and the
  // first calibration's windows still pointed at the pre-v1.3.1
  // panel position (~11px outboard, over bare floor), reading
  // 0.6–8.5% on backs that zoomed crops show fully drawn. With
  // the window on the panel's outboard post strip (backWindow),
  // the measured bands are: HIDDEN = 0.0% (in-situ controls:
  // the strip painted over with floor/felt on real captures,
  // occupied and unoccupied — the sitter's sprite contributes
  // zero wood-palette pixels to the strip); DRAWN unoccupied
  // >= 55% (per-seat best; per-observation p10 61%); DRAWN
  // occupied, no neighbour over the strip >= 46%. 10% sits in
  // the empty band with >4x margin to the weakest drawn case.
  // The one sub-band configuration — a poker W seat whose S
  // neighbour sits 43px screen-north and whose sprite covers
  // the strip (reads ~8%) — is handled by the occupied pass's
  // neighbour rule, not by lowering this bar.
  backFrac: { chair: 0.10, profile: 0.10, bench: 0.08, sofa: 0.18, cafe: 0.18 },
  legsMaxGreenFrac: 0.02,    // marker-green allowed ON a tabletop (legs over the table = defect)
  legsMinTableFrac: 0.55,    // tabletop share the table window must actually show
  crowdTableTiles: 5,        // table-group centres (the validator's own table law)
  crowdUnitTiles: 3.5,       // station centres (station ~2 tiles wide + a walk lane)
  edgeMinMarginPx: 40,       // building facade to map boundary (screen)
};

// ---------------------------------------------------------------------------
// Minimal PNG codec (8-bit truecolor/alpha, no interlace) — decode
// for sampling, encode for selftest fixtures. Node stdlib only.
// ---------------------------------------------------------------------------
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType)) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, type ${colorType})`);
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      if (ch === 1) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = 255; }
      else if (ch === 2) { out[d] = out[d + 1] = out[d + 2] = cur[s]; out[d + 3] = cur[s + 1]; }
      else { out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2]; out[d + 3] = ch === 4 ? cur[s + 3] : 255; }
    }
    prev = cur;
  }
  return { w, h, data: out };
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(img) {
  const { w, h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, payload) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Render geometry — mirrors public/client.js exactly.
// ---------------------------------------------------------------------------
export const ZOOM = 0.72;
export const proj = (x, y) => [(x - y) * ZOOM, (x + y) * ZOOM * 0.5];

/** Screen (image) px of a world point in a manifest entry's frame. */
export function screenOf(entry, wx, wy) {
  const [px, py] = proj(wx, wy);
  const [cx, cy] = proj(entry.camera.x, entry.camera.y);
  return [
    (entry.canvas.ox || 0) + px - cx + entry.canvas.w / 2,
    (entry.canvas.oy || 0) + py - cy + entry.canvas.h / 2,
  ];
}

/** A posed actor's render anchor: seat/stand position + the table
 *  pull-in the client applies before projecting (client.js draw()). */
export function actorAnchor(entry, actor) {
  const pull = actor.pull || [0, 0];
  return screenOf(entry, actor.x + pull[0], actor.y + pull[1]);
}
export const seatAnchor = (entry, s) => screenOf(entry, s.x, s.y);

// ---------------------------------------------------------------------------
// Palettes (from public/client.js draw code) + sampling.
// ---------------------------------------------------------------------------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const PAL = {
  // Chair frame + slats only. The dark post tone #5a3d1f is
  // deliberately NOT matched: it sits within tolerance of the
  // cafés' brown floors and would fake a pass on bare floor.
  wood: ['#8a5a2b', '#a5713a'].map(hex),
  cushion: hex('#c96f4a'),                                // chair pad (anchor verification)
  sofaBack: [hex('#a8667e')],
  cafeBack: [hex('#7e2f3c')],
  table: [hex('#caa06a'), hex('#8a5a2b'), hex('#7a5a2b')], // tabletop + rim
};
const near = (r, g, b, c, tol) =>
  Math.abs(r - c[0]) <= tol && Math.abs(g - c[1]) <= tol && Math.abs(b - c[2]) <= tol;
export const isWood = (r, g, b) => PAL.wood.some(c => near(r, g, b, c, 34));
export const isGreenMarker = (r, g, b) => g >= 130 && g - r >= 48 && g - b >= 40;
export const isTable = (r, g, b) => PAL.table.some(c => near(r, g, b, c, 40));

/** Fraction of pixels in rect(s) matching pred. Rects are [x0,y0,x1,y1]
 *  in image px, clipped to the image. Returns {frac, n, hits}. */
export function sampleFrac(img, rects, pred) {
  let n = 0, hits = 0;
  for (const [rx0, ry0, rx1, ry1] of rects) {
    const x0 = Math.max(0, Math.floor(rx0)), x1 = Math.min(img.w - 1, Math.ceil(rx1));
    const y0 = Math.max(0, Math.floor(ry0)), y1 = Math.min(img.h - 1, Math.ceil(ry1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * img.w + x) * 4;
        n++;
        if (pred(img.data[i], img.data[i + 1], img.data[i + 2])) hits++;
      }
    }
  }
  return { frac: n ? hits / n : 0, n, hits };
}

/** Centroid of palette-matching pixels within a square around (cx,cy). */
export function paletteCentroid(img, cx, cy, radius, pred) {
  let n = 0, sx = 0, sy = 0;
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(img.w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(img.h - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * img.w + x) * 4;
      if (pred(img.data[i], img.data[i + 1], img.data[i + 2])) { n++; sx += x; sy += y; }
    }
  }
  return n >= 6 ? { x: sx / n, y: sy / n, n } : null;
}

// ---------------------------------------------------------------------------
// Shared map derivations (same rules as scripts/validate-dressing.mjs).
// ---------------------------------------------------------------------------
const tileOfPx = (v) => Math.floor(v / TILE);
const audienceSeats = (map) => (map.seats || []).filter(s => {
  const m = /-seat-(\d+)$/.exec(s.id);
  return m && Number(m[1]) >= 101;
});
function rectTiles(r) {
  const out = [];
  const x0 = tileOfPx(r.x), x1 = tileOfPx(r.x + r.w - 1);
  const y0 = tileOfPx(r.y), y1 = tileOfPx(r.y + r.h - 1);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([tx, ty]);
  return out;
}
function doorstepTiles(map) {
  const set = new Set();
  const inflate = (tiles) => {
    for (const [tx, ty] of tiles) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) set.add(`${tx + dx},${ty + dy}`);
    }
  };
  for (const d of map.doors || []) inflate(rectTiles(d));
  for (const g of map.gateways || []) {
    inflate(rectTiles(g));
    inflate([[tileOfPx(g.spawnOut.x), tileOfPx(g.spawnOut.y)]]);
  }
  return set;
}
function pitBandTiles(map) {
  const set = new Set();
  const aud = audienceSeats(map);
  if (!map.stage || !aud.length) return set;
  const st = map.stage;
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (const s of aud) {
    x0 = Math.min(x0, tileOfPx(s.x)); x1 = Math.max(x1, tileOfPx(s.x));
    y0 = Math.min(y0, tileOfPx(s.y)); y1 = Math.max(y1, tileOfPx(s.y));
  }
  const pitX0 = tileOfPx(st.pit.x), pitX1 = tileOfPx(st.pit.x + st.pit.w - 1);
  const pitY0 = tileOfPx(st.pit.y), pitY1 = tileOfPx(st.pit.y + st.pit.h - 1);
  if (y0 > pitY1) { for (let ty = pitY1 + 1; ty < y0; ty++) for (let tx = x0; tx <= x1; tx++) set.add(`${tx},${ty}`); }
  else if (y1 < pitY0) { for (let ty = y1 + 1; ty < pitY0; ty++) for (let tx = x0; tx <= x1; tx++) set.add(`${tx},${ty}`); }
  else if (x0 > pitX1) { for (let tx = pitX1 + 1; tx < x0; tx++) for (let ty = y0; ty <= y1; ty++) set.add(`${tx},${ty}`); }
  else if (x1 < pitX0) { for (let tx = x1 + 1; tx < pitX0; tx++) for (let ty = y0; ty <= y1; ty++) set.add(`${tx},${ty}`); }
  return set;
}
const allProps = (map) => [
  ...(map.props || []).map(p => ({ ...p, layer: 'base' })),
  ...overlayProps(map.id, 'halloween').map(p => ({ ...p, layer: 'halloween' })),
  ...overlayProps(map.id, 'christmas').map(p => ({ ...p, layer: 'christmas' })),
];

// ---------------------------------------------------------------------------
// CHECK 1 — ROW ALIGNMENT (pure geometry + image anchor verification)
// ---------------------------------------------------------------------------
export function alignmentFromSeats(seats) {
  // Proj-space anchors; rows share a tile row, columns a tile col.
  const anchors = seats.map(s => ({ id: s.id, tx: tileOfPx(s.x), ty: tileOfPx(s.y), p: proj(s.x, s.y) }));
  let maxDev = 0, maxGapErr = 0, worst = null;
  const byRow = new Map(), byCol = new Map();
  for (const a of anchors) {
    if (!byRow.has(a.ty)) byRow.set(a.ty, []);
    byRow.get(a.ty).push(a);
    if (!byCol.has(a.tx)) byCol.set(a.tx, []);
    byCol.get(a.tx).push(a);
  }
  const fit = (list, key) => {
    // iso line: for a tile row, sy - 0.5*sx is constant; for a tile
    // column, sy + 0.5*sx is constant. Deviation is perpendicular.
    if (list.length < 2) return;
    const vals = list.map(a => key === 'row' ? a.p[1] - 0.5 * a.p[0] : a.p[1] + 0.5 * a.p[0]);
    const med = vals.slice().sort((x, y) => x - y)[Math.floor(vals.length / 2)];
    for (let i = 0; i < list.length; i++) {
      const dev = Math.abs(vals[i] - med) / Math.sqrt(1.25);
      if (dev > maxDev) { maxDev = dev; worst = list[i].id; }
    }
    const sorted = list.slice().sort((a, b) => a.p[0] - b.p[0]);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].p[0] - sorted[i - 1].p[0]);
    if (gaps.length > 1) {
      const g0 = gaps[0];
      for (const g of gaps) maxGapErr = Math.max(maxGapErr, Math.abs(g - g0));
    }
  };
  for (const list of byRow.values()) fit(list, 'row');
  for (const list of byCol.values()) fit(list, 'col');
  // Grid completeness ON THE BLOCK'S OWN LATTICE: the audience
  // seats form a full rectangle over the tile rows/columns they
  // occupy (rows step 2 tiles, columns 2–4 — the gaps BETWEEN
  // lattice lines are by design). A seat shifted into its own
  // row leaves holes on the lattice (the v1.2.2 jumble shape).
  let holes = 0;
  if (anchors.length) {
    const cells = new Set(anchors.map(a => `${a.tx},${a.ty}`));
    const txs = [...new Set(anchors.map(a => a.tx))], tys = [...new Set(anchors.map(a => a.ty))];
    for (const ty of tys) for (const tx of txs) if (!cells.has(`${tx},${ty}`)) holes++;
  }
  // Row/column progression: line constants must step by exactly
  // TILE*ZOOM*sqrt(1.25) per tile (23.04 in line units) — catches
  // a whole row parked a tile off the block's rhythm.
  let maxProgDev = 0;
  const STEP = 23.04;
  const progression = (groups, key) => {
    const items = [...groups.entries()].map(([t, list]) => {
      const vals = list.map(a => key === 'row' ? a.p[1] - 0.5 * a.p[0] : a.p[1] + 0.5 * a.p[0]);
      return { t, c: vals.slice().sort((x, y) => x - y)[Math.floor(vals.length / 2)] };
    }).sort((a, b) => a.t - b.t);
    if (items.length < 3) return;
    const { t: t0, c: c0 } = items[0];
    for (const it of items) {
      const dev = Math.abs(it.c - (c0 + STEP * (it.t - t0))) / Math.sqrt(1.25);
      maxProgDev = Math.max(maxProgDev, dev);
    }
  };
  progression(byRow, 'row');
  progression(byCol, 'col');
  return { maxDev, maxGapErr, holes, maxProgDev, worst, count: anchors.length };
}

function checkRowAlignment(ctx) {
  const lines = [], failures = [];
  let worstDev = 0, worstGap = 0, worstCentroid = 0, verified = 0;
  for (const map of Object.values(ctx.maps)) {
    if (!map.stage) continue;
    const aud = audienceSeats(map);
    if (!aud.length) continue;
    const r = alignmentFromSeats(aud);
    worstDev = Math.max(worstDev, r.maxDev);
    worstGap = Math.max(worstGap, r.maxGapErr);
    if (r.maxDev > TH.alignMaxDevPx || r.maxGapErr > TH.alignGapTolPx || r.holes > 0 || r.maxProgDev > TH.alignMaxDevPx) {
      failures.push(`${map.id}: audience grid is jumbled (max deviation ${r.maxDev.toFixed(1)}px at ${r.worst}, spacing error ${r.maxGapErr.toFixed(1)}px, ${r.holes} grid hole(s), row-rhythm error ${r.maxProgDev.toFixed(1)}px)`);
    }
    // Verify anchors against the actual pixels: the chair cushion
    // palette centroid near each computed anchor, measured in a
    // capture where the seat is UNOCCUPIED (a sitter's sprite
    // covers the cushion's north half and drags the centroid
    // ~9px south — measured on frosthaven seat-101: 9.4px
    // occupied vs 0.5–0.9px in every unoccupied observation).
    for (const s of aud) {
      let observed = false;
      for (const entry of ctx.entries) {
        if (entry.map !== map.id || entry.phase !== 'day') continue;
        const img = ctx.images.get(entry.file);
        if (!img) continue;
        if (entry.actors.some(a => a.seatId === s.id)) continue;
        const [ax, ay] = seatAnchor(entry, s);
        if (ax < 12 || ay < 12 || ax > img.w - 12 || ay > img.h - 12) continue;
        const c = paletteCentroid(img, ax, ay, 11, (r2, g, b) => near(r2, g, b, PAL.cushion, 46));
        if (!c) continue;
        observed = true;
        const off = Math.hypot(c.x - ax, c.y - ay);
        verified++;
        worstCentroid = Math.max(worstCentroid, off);
        if (off > TH.anchorCentroidTolPx) {
          failures.push(`${map.id}: seat ${s.id} cushion centroid ${off.toFixed(1)}px from its computed anchor (in ${entry.shot})`);
        }
        break;
      }
      if (!observed) failures.push(`${map.id}: seat ${s.id} anchor could not be verified in any unoccupied capture`);
    }
    lines.push(`${map.id}: ${aud.length} audience seats, max row deviation ${r.maxDev.toFixed(2)}px, spacing error ${r.maxGapErr.toFixed(2)}px, grid holes ${r.holes}, row-rhythm error ${r.maxProgDev.toFixed(2)}px`);
  }
  lines.push(`anchor verification: ${verified} seat anchors confirmed in-image, worst centroid offset ${worstCentroid.toFixed(1)}px (tol ${TH.anchorCentroidTolPx})`);
  return { name: 'ROW ALIGNMENT', ok: failures.length === 0, failures, lines };
}

// ---------------------------------------------------------------------------
// CHECK 2 — BACK VISIBILITY (pixel sampling per posed sitter)
// ---------------------------------------------------------------------------
// Windows are [x0,y0,x1,y1] offsets from the seat anchor, taken
// from the draw geometry in public/client.js (see header). Returns
// null for seat kinds with no backrest by design (hookah booths).
export function backWindow(kind, dir, [sx, sy]) {
  const R = (rects, pal, th) => ({ rects: rects.map(([a, b, c, d]) => [sx + a, sy + b, sx + c, sy + d]), pal, th });
  if (kind === 'audience') {
    // v1.5.1: the venue chair's back is an OPEN ladder by design
    // (audienceBack in public/client.js: posts at anchor ±13,
    // slats at rise*0.38/0.66, arched rail — the FLOOR shows
    // through the gaps). The windows therefore sample the two
    // POST strips only, where posts + slat crossings + rail ends
    // stack wood: the guarantee this check makes is "the back's
    // structure stands in the back region" — a seat rendering
    // with NO back (bare cushion/plank, the exact read X
    // circled) still fails, while the open gaps are never
    // measured as missing back. Same strips and bar as the
    // table chair's 'up'/'down'; profile strips as its panels.
    // CALIBRATION (v1.5.1, measured on the real Playtest
    // captures with this sampler): unoccupied audience backs
    // read 61.0–86.9% (n=100, median 65.4%), occupied 65.2–73.5%
    // (n=20 posed sitters) — the posts+slats stack MORE wood in
    // the strips than the table chair's panel does, so the
    // shared 10% bar sits in the same kind of empty band as the
    // chair's (drawn >= 61% vs backless 0.0% in the selftest).
    // No threshold was loosened for the open design.
    if (dir === 'down') return R([[9, -34, 16, -10], [-16, -34, -9, -10]], 'wood', TH.backFrac.chair);
    if (dir === 'up') return R([[10, -20, 16, 8], [-16, -20, -10, 8]], 'wood', TH.backFrac.chair);
    if (dir === 'left') return R([[8, -34, 17, -2]], 'wood', TH.backFrac.profile);
    return R([[-17, -34, -8, -2]], 'wood', TH.backFrac.profile); // right
  }
  if (kind === 'chair' || kind === 'stool' || kind === 'poker') {
    if (dir === 'down') return R([[9, -34, 16, -10], [-16, -34, -9, -10]], 'wood', TH.backFrac.chair);
    if (dir === 'up') return R([[10, -20, 16, 8], [-16, -20, -10, 8]], 'wood', TH.backFrac.chair);
    // Profile: the v1.3.1 panel stands ON the cushion's back
    // diagonal — posts at anchor x-1 and x+15 (facing left),
    // rising 28px from y-7. The window is the panel's OUTBOARD
    // post strip: the part that peeks beside a sitter (the
    // inboard half sits behind the sprite). The pre-v1.3.1
    // windows ([±17..±28]) pointed at the OLD floating panel's
    // position and sampled bare floor beside the real panel —
    // see the profile calibration note in TH.
    if (dir === 'left') return R([[8, -34, 17, -2]], 'wood', TH.backFrac.profile);
    return R([[-17, -34, -8, -2]], 'wood', TH.backFrac.profile); // right
  }
  if (kind === 'bench') {
    // The bench back is two 3px slats (#a5713a) spanning bk.x±12
    // at bk.y-4 and bk.y-8, bk = {down [0,-7], up [0,7],
    // left [10,2], right [-10,2]} (public/client.js bench draw).
    // Windows are the slat bands.
    if (dir === 'down') return R([[-13, -17, 13, -9]], 'wood', TH.backFrac.bench);
    if (dir === 'up') return R([[-13, -3, 13, 5]], 'wood', TH.backFrac.bench);
    if (dir === 'left') return R([[-2, -7, 22, 1]], 'wood', TH.backFrac.bench);
    return R([[-22, -7, 2, 1]], 'wood', TH.backFrac.bench); // right
  }
  if (kind === 'sofa') {
    if (dir === 'down') return R([[16, -15, 29, -3], [-29, -15, -16, -3]], 'sofaBack', TH.backFrac.sofa);
    if (dir === 'up') return R([[16, 0, 29, 12], [-29, 0, -16, 12]], 'sofaBack', TH.backFrac.sofa);
    if (dir === 'left') return R([[18, -6, 40, 6]], 'sofaBack', TH.backFrac.sofa);
    return R([[-40, -6, -18, 6]], 'sofaBack', TH.backFrac.sofa); // right
  }
  if (kind === 'cafe') {
    // Backrest = diamond hw 34 at anchor - off*0.55 - [0,2]; for
    // 'down' its tips peek beside the sitter at |x| 18..30.
    if (dir === 'down') return R([[18, -18, 30, -11], [-30, -18, -18, -11]], 'cafeBack', TH.backFrac.cafe);
    if (dir === 'up') return R([[17, 5, 33, 20], [-33, 5, -17, 20]], 'cafeBack', TH.backFrac.cafe);
    if (dir === 'left') return R([[18, -14, 44, 1]], 'cafeBack', TH.backFrac.cafe);
    return R([[-44, -14, -18, 1]], 'cafeBack', TH.backFrac.cafe); // right
  }
  return null;
}
const BACK_PRED = {
  wood: isWood,
  sofaBack: (r, g, b) => PAL.sofaBack.some(c => near(r, g, b, c, 44)),
  cafeBack: (r, g, b) => PAL.cafeBack.some(c => near(r, g, b, c, 44)),
};

// Sample one seat's back window in one capture. seatLike is
// {x, y (world px), kind, dir}; returns null for backless kinds.
export function windowFracFor(img, entry, seatLike) {
  const win = backWindow(seatLike.kind, seatLike.dir, seatAnchor(entry, seatLike));
  if (!win) return null;
  const { frac, n } = sampleFrac(img, win.rects, BACK_PRED[win.pal]);
  return { frac, n, th: win.th, ok: frac >= win.th };
}

// Facings whose back is DESIGNED to read with a sitter in the
// seat: chair/stool/poker 'up' (the client redraws the near back
// OVER the sitter — deferredSeatBackPos) and 'left'/'right' (iso
// panels beside the sitter); sofa crests (they span ±30, tips
// peek in every facing); cafe 'up'/'left'/'right' (backrest
// offset to the visible side). Everything else — chair 'down',
// bench slats (±12, inside the ±15 sprite silhouette), cafe
// 'down' — is occluded by the sitter BY DESIGN at play zoom;
// those backs are verified on the UNOCCUPIED seat instead
// (measured: unoccupied chair 'down' windows read 0.50–0.66
// back palette; the same seat occupied reads 0.0–0.11 because
// the sprite covers the posts at ±13.5).
const OCCUPIED_CHECKABLE = (kind, dir) => {
  if (kind === 'sofa') return true;
  if (kind === 'bench' || kind === 'hookah') return false;
  return dir !== 'down';
};

function checkBackVisibility(ctx) {
  const failures = [], lines = [];
  // -- Reference pass: every backed seat's best UNOCCUPIED
  // observation across the map's day captures.
  let refChecked = 0, refUnverifiable = 0, refWorst = null;
  for (const map of Object.values(ctx.maps)) {
    const seatLikes = new Map();
    // v1.6: casino slot stools are BACKLESS by design (a pedestal
    // stool, drawStoolAt) — they resolve to kind 'slotstool' here
    // so the back windows skip them (backWindow returns null,
    // "backless by design"). Bar stools keep kind 'stool' and
    // their chair backs: only SLOT seats change.
    const slotSeatIds = new Set(((map.casino || {}).slots || []).map((sl) => sl.seatId));
    for (const s of map.seats || []) seatLikes.set(s.id, { id: s.id, x: s.x, y: s.y, kind: slotSeatIds.has(s.id) ? 'slotstool' : s.kind, dir: s.dir });
    for (const e of ctx.entries) {
      if (e.map !== map.id) continue;
      for (const a of e.actors) {
        if (a.seated && a.seatId && !seatLikes.has(a.seatId)) {
          seatLikes.set(a.seatId, { id: a.seatId, x: a.x, y: a.y, kind: a.seatKind, dir: a.dir });
        }
      }
    }
    for (const sl of seatLikes.values()) {
      if (!backWindow(sl.kind, sl.dir, [0, 0])) continue; // backless by design
      let best = null;
      for (const e of ctx.entries) {
        if (e.map !== map.id || e.phase !== 'day') continue;
        const img = ctx.images.get(e.file);
        if (!img) continue;
        if (e.actors.some(a => a.seatId === sl.id)) continue;
        const S = seatAnchor(e, sl);
        // On-canvas margin = the window's own reach (widest
        // window: cafe side backs at 44px) + a breath.
        const win0 = backWindow(sl.kind, sl.dir, [0, 0]);
        const reach = Math.max(...win0.rects.flatMap(r => [Math.abs(r[0]), Math.abs(r[1]), Math.abs(r[2]), Math.abs(r[3])])) + 2;
        if (S[0] < reach || S[1] < reach || S[0] > img.w - reach || S[1] > img.h - reach) continue;
        // Another actor within 36px may overlap the window; the
        // BEST fraction across entries is kept, and occlusion
        // only ever lowers a reading — never fakes a pass.
        if (e.actors.some(a => { const A = actorAnchor(e, a); return Math.hypot(A[0] - S[0], A[1] - S[1]) < 36; })) continue;
        const r = windowFracFor(img, e, sl);
        if (r && (!best || r.frac > best.frac)) best = { ...r, shot: e.shot };
      }
      if (!best) { refUnverifiable++; continue; }
      refChecked++;
      if (!refWorst || best.frac < refWorst.frac) refWorst = { ...best, map: map.id, id: sl.id };
      if (!best.ok) {
        failures.push(`${map.id}: seat ${sl.id} (${sl.kind}, facing ${sl.dir}) — its back does not render: best unoccupied observation ${(best.frac * 100).toFixed(1)}% back palette in ${best.shot}, needs ${(best.th * 100).toFixed(0)}%`);
      }
    }
  }
  lines.push(`reference pass: ${refChecked} backed seats verified unoccupied (${refUnverifiable} never cleanly observable in any capture)`);
  if (refWorst) lines.push(`weakest rendered back: ${refWorst.map} ${refWorst.id} at ${(refWorst.frac * 100).toFixed(1)}%`);
  // -- Occupied pass: facings designed to read with a sitter.
  let occChecked = 0, occCovered = 0, occNbrCovered = 0, occWorst = null;
  for (const entry of ctx.entries) {
    if (entry.phase !== 'day') continue;
    const img = ctx.images.get(entry.file);
    const map = ctx.maps[entry.map];
    if (!img || !map) continue;
    for (const actor of entry.actors) {
      if (!actor.seated || !actor.seatKind) continue;
      // v1.6: an actor on a casino SLOT seat sits on the backless
      // pedestal stool — same resolution as the reference pass
      // above (kind 'slotstool', backWindow null, skipped). The
      // harness records the raw seat kind ('stool'), which would
      // otherwise demand a chair back that no longer exists.
      const seat0 = (map.seats || []).find(s => s.id === actor.seatId);
      const effKind = (seat0 && ((map.casino || {}).slots || []).some((sl) => sl.seatId === seat0.id)) ? 'slotstool' : actor.seatKind;
      if (!backWindow(effKind, actor.dir, [0, 0])) continue;
      if (!OCCUPIED_CHECKABLE(effKind, actor.dir)) { occCovered++; continue; }
      const seat = seat0;
      const sl = seat
        ? { x: seat.x, y: seat.y, kind: effKind, dir: actor.dir }
        : { x: actor.x, y: actor.y, kind: effKind, dir: actor.dir }; // poker pseudo-seat
      const r = windowFracFor(img, entry, sl);
      if (!r) continue;
      if (!r.ok) {
        // NEIGHBOUR RULE: a low reading is only evidence about
        // THIS seat's back when nothing else paints over the
        // window. At a poker ring the S chair sits 43px
        // screen-north of the W chair, and its sprite hangs
        // over the W panel's peek strip (measured: the same
        // seat reads ~8% crowded, >= 46% uncrowded, 0.0% with
        // the panel erased). A neighbour within 48px of the
        // seat anchor therefore covers the observation — the
        // seat's back is still verified by the reference pass,
        // and the same art is verified occupied at uncrowded
        // seats. A neighbour can only excuse, never pass: an
        // uncrowded low reading still fails below.
        const S = seatAnchor(entry, sl);
        const crowded = entry.actors.some(a => {
          if (a === actor) return false;
          const A = actorAnchor(entry, a);
          return Math.hypot(A[0] - S[0], A[1] - S[1]) < 48;
        });
        if (crowded) { occNbrCovered++; continue; }
      }
      occChecked++;
      if (!occWorst || r.frac < occWorst.frac) occWorst = { ...r, map: entry.map, shot: entry.shot, id: actor.seatId };
      if (!r.ok) {
        failures.push(`${entry.map}/${entry.shot}: ${actor.name} in ${actor.seatId} (${actor.seatKind}, facing ${actor.dir}) — back palette ${(r.frac * 100).toFixed(1)}% of window, needs ${(r.th * 100).toFixed(0)}% — the back is hidden behind the sitter`);
      }
    }
  }
  lines.push(`occupied pass: ${occChecked} sitters in visible-back facings checked; ${occCovered} far-side sitters covered by the reference pass (occluded by design); ${occNbrCovered} sitters covered by the reference pass (a neighbour's sprite covers the back window)`);
  if (occWorst) lines.push(`worst occupied back: ${occWorst.map}/${occWorst.shot} ${occWorst.id} at ${(occWorst.frac * 100).toFixed(1)}%`);
  return { name: 'BACK VISIBILITY', ok: failures.length === 0, failures, lines };
}

// ---------------------------------------------------------------------------
// CHECK 3 — LEGS UNDER TABLES (marker-green sampling)
// ---------------------------------------------------------------------------
// The tabletop-interior window for a table anchor: inside the
// rim ellipse (centre y-5, radii 32x16), clear of edge
// anti-aliasing, of items sitting on the table, and of the feet
// that legitimately peek out BELOW the table front. Marker green
// in here can only be a sitter's legs painted over the top —
// the v1.2.3 defect. Measured on the known-good café render:
// green 0.000, tabletop 0.86.
export const legsWindow = ([tx, ty]) => [[tx - 24, ty - 14, tx + 24, ty + 2]];

export function legsFor(img, entry, map) {
  const out = [];
  const TS = TILE;
  const byTable = new Map();
  for (const actor of entry.actors) {
    if (!actor.seated || actor.seatKind !== 'chair' || !actor.seatId) continue;
    if (!actor.pull) continue; // only pulled-in (baked-at-table) sitters
    const seat = (map.seats || []).find(s => s.id === actor.seatId);
    if (!seat) continue;
    const t = (map.props || []).find(pr => pr.kind === 'table'
      && Math.abs(pr.x - seat.x) <= TS * 1.05 && Math.abs(pr.y - seat.y) <= TS * 1.05
      && (pr.x !== seat.x || pr.y !== seat.y));
    if (!t) continue;
    const key = `${t.x},${t.y}`;
    if (!byTable.has(key)) byTable.set(key, { table: t, sitters: [] });
    byTable.get(key).sitters.push(actor);
  }
  for (const { table, sitters } of byTable.values()) {
    const T = screenOf(entry, table.x, table.y);
    const rect = legsWindow(T);
    const green = sampleFrac(img, rect, isGreenMarker);
    const tab = sampleFrac(img, rect, isTable);
    out.push({
      table, sitters, green: green.frac, tableFrac: tab.frac,
      ok: green.frac <= TH.legsMaxGreenFrac && tab.frac >= TH.legsMinTableFrac,
    });
  }
  return out;
}

function checkLegs(ctx) {
  const failures = [], lines = [];
  let checked = 0, worst = null;
  for (const entry of ctx.entries) {
    if (entry.phase !== 'day') continue;
    const img = ctx.images.get(entry.file);
    const map = ctx.maps[entry.map];
    if (!img || !map) continue;
    for (const r of legsFor(img, entry, map)) {
      checked++;
      if (!worst || r.green > worst.green) worst = { ...r, map: entry.map, shot: entry.shot };
      if (!r.ok) {
        const who = r.sitters.map(a => `${a.name} (${a.seatId})`).join(', ');
        failures.push(`${entry.map}/${entry.shot}: tabletop at (${r.table.x},${r.table.y}) sat by ${who} — tabletop window is ${(r.green * 100).toFixed(1)}% marker-green (max ${(TH.legsMaxGreenFrac * 100).toFixed(0)}%) / ${(r.tableFrac * 100).toFixed(1)}% tabletop (min ${(TH.legsMinTableFrac * 100).toFixed(0)}%) — legs are painted OVER the table, or the table is missing`);
      }
    }
  }
  lines.push(`${checked} posed tables checked (tabletop-interior window per table)`);
  if (worst) lines.push(`worst tabletop: ${worst.map}/${worst.shot} green ${(worst.green * 100).toFixed(1)}%, tabletop ${(worst.tableFrac * 100).toFixed(1)}%`);
  return { name: 'LEGS UNDER TABLES', ok: failures.length === 0, failures, lines };
}

// ---------------------------------------------------------------------------
// CHECK 4 — CLEAR ZONES (render-space confirmation of the data laws)
// ---------------------------------------------------------------------------
export function clearZoneViolations(map, extraPoints = [], injectedSeasonal = []) {
  // Scoped to the game's OWN laws (scripts/validate-dressing.mjs):
  // the DOORSTEP law binds seasonal dressing only — base props
  // were placed by the map authors and legitimately flank doors
  // (the lanterns beside the casino/hookah doors are the standing
  // example; the validator has never held base props to aprons).
  // The PIT-FRONT law binds everything: props of every layer,
  // seats, and (via extraPoints) posed sitters.
  const aprons = doorstepTiles(map);
  const band = pitBandTiles(map);
  const out = [];
  const inBand = (label, x, y) => {
    const k = `${tileOfPx(x)},${tileOfPx(y)}`;
    if (band.has(k)) out.push(`${label} stands in front of the pit (${k})`);
  };
  for (const p of [...allProps(map), ...injectedSeasonal]) {
    if (p.kind === 'wreath') continue; // hangs on the facade by design
    if (p.layer !== 'base') {
      const k = `${tileOfPx(p.x)},${tileOfPx(p.y)}`;
      if (aprons.has(k)) out.push(`[${p.layer}] prop "${p.kind}" stands inside a doorstep apron (${k})`);
    }
    inBand(`[${p.layer}] prop "${p.kind}"`, p.x, p.y);
  }
  for (const s of map.seats || []) inBand(`seat ${s.id}`, s.x, s.y);
  for (const pt of extraPoints) inBand(pt.label, pt.x, pt.y);
  return out;
}

function checkClearZones(ctx) {
  const failures = [], lines = [];
  let actorsChecked = 0;
  for (const map of Object.values(ctx.maps)) {
    // Posed SEATED actors join the furniture test (a sitter inside
    // an apron means a seat is). Standing actors are SUPPOSED to
    // stand in doorways and at pit fronts, so they are not held to
    // furniture clearances — the laws bind props and seats.
    const pts = [];
    for (const e of ctx.entries.filter(e2 => e2.map === map.id)) {
      for (const a of e.actors) {
        if (a.seated) { pts.push({ label: `posed sitter ${a.name} (${a.seatId})`, x: a.x, y: a.y }); actorsChecked++; }
      }
    }
    const v = clearZoneViolations(map, pts);
    for (const msg of v) failures.push(`${map.id}: ${msg}`);
    lines.push(`${map.id}: ${allProps(map).length} props + ${(map.seats || []).length} seats clear of ${doorstepTiles(map).size} apron tiles / ${pitBandTiles(map).size} pit-front tiles`);
  }
  lines.push(`${actorsChecked} posed sitters also confirmed outside the clear zones`);
  return { name: 'CLEAR ZONES', ok: failures.length === 0, failures, lines };
}

// ---------------------------------------------------------------------------
// CHECK 5 — CROWDING (furniture-group spacing, proj space)
// ---------------------------------------------------------------------------
// Furniture UNITS: the repeatable groups that jammed the
// pre-space-pass café — a table and its chairs, a hookah
// station's booth pair. Spacing is judged CENTRE TO CENTRE,
// restating the game's own laws in screen space: table groups
// keep >= 5 tiles (the validator's table-group law), stations
// >= 3.5 tiles (a station is ~2 tiles wide; 3.5 keeps a walk
// lane). Hearth arcs are NOT units: they are fixed architectural
// seating whose reach legitimately ends a tile from a booth
// (measured in the hookah lounge — composed, walkable floor
// between; their spacing is governed by the hearth-aim law).
export function furnitureUnits(map) {
  const units = [];
  const seats = map.seats || [];
  for (const t of (map.props || []).filter(p => p.kind === 'table')) {
    units.push({ label: `table@(${tileOfPx(t.x)},${tileOfPx(t.y)})`, kind: 'table', x: t.x, y: t.y });
  }
  const hookah = seats.filter(s => s.kind === 'hookah');
  const seenH = new Set();
  for (const s of hookah) {
    if (seenH.has(s.id)) continue;
    const cluster = hookah.filter(s2 => Math.max(Math.abs(s2.x - s.x), Math.abs(s2.y - s.y)) <= TILE * 3);
    cluster.forEach(s2 => seenH.add(s2.id));
    const cx = cluster.reduce((a, s2) => a + s2.x, 0) / cluster.length;
    const cy = cluster.reduce((a, s2) => a + s2.y, 0) / cluster.length;
    units.push({ label: `hookah station@(${tileOfPx(cx)},${tileOfPx(cy)})`, kind: 'station', x: cx, y: cy });
  }
  return units;
}
export function crowdingFor(map) {
  const units = furnitureUnits(map);
  let min = null;
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    const a = units[i], b = units[j];
    const distTiles = Math.hypot(a.x - b.x, a.y - b.y) / TILE;
    const [ax, ay] = proj(a.x, a.y), [bx, by] = proj(b.x, b.y);
    const distPx = Math.hypot(ax - bx, ay - by);
    const need = (a.kind === 'table' || b.kind === 'table') ? TH.crowdTableTiles : TH.crowdUnitTiles;
    if (!min || distTiles / need < min.distTiles / min.need) {
      min = { distTiles, distPx, need, pair: [a.label, b.label] };
    }
  }
  return { groups: units.length, min };
}

function checkCrowding(ctx) {
  const failures = [], lines = [];
  for (const map of Object.values(ctx.maps)) {
    if ((map.gateways || []).length) continue; // interiors only
    const { groups, min } = crowdingFor(map);
    if (groups < 2 || !min) { lines.push(`${map.id}: ${groups} furniture unit(s) — nothing to crowd`); continue; }
    lines.push(`${map.id}: ${groups} units, tightest centres ${min.distTiles.toFixed(1)} tiles / ${min.distPx.toFixed(0)}px apart (${min.pair.join(' ↔ ')}, needs ${min.need})`);
    if (min.distTiles < min.need) {
      failures.push(`${map.id}: furniture units ${min.pair.join(' ↔ ')} are jammed — centres ${min.distTiles.toFixed(1)} tiles apart (min ${min.need})`);
    }
  }
  return { name: 'CROWDING', ok: failures.length === 0, failures, lines };
}

// ---------------------------------------------------------------------------
// CHECK 6 — EDGE MARGIN (buildings vs the map boundary diamond)
// ---------------------------------------------------------------------------
const segSegDist = (p1, p2, p3, p4) => {
  const ptSeg = (p, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
    return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
  };
  const inter = (a, b, c, d) => {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  };
  if (inter(p1, p2, p3, p4)) return 0;
  return Math.min(ptSeg(p1, p3, p4), ptSeg(p2, p3, p4), ptSeg(p3, p1, p2), ptSeg(p4, p1, p2));
};
export function edgeMarginFor(map, buildings = map.buildings || []) {
  const W = map.tiles.w * TILE, H = map.tiles.h * TILE;
  const corners = [proj(0, 0), proj(W, 0), proj(W, H), proj(0, H)];
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b]) => [corners[a], corners[b]]);
  let min = { margin: Infinity, building: null };
  for (const b of buildings) {
    const bp = [
      proj(b.tx * TILE, b.ty * TILE), proj((b.tx + b.tw) * TILE, b.ty * TILE),
      proj((b.tx + b.tw) * TILE, (b.ty + b.th) * TILE), proj(b.tx * TILE, (b.ty + b.th) * TILE),
    ];
    const bEdges = [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, bb]) => [bp[a], bp[bb]]);
    let m = Infinity;
    for (const be of bEdges) for (const e of edges) m = Math.min(m, segSegDist(be[0], be[1], e[0], e[1]));
    if (m < min.margin) min = { margin: m, building: b.name || `(${b.tx},${b.ty})` };
  }
  return min;
}

function checkEdgeMargin(ctx) {
  const failures = [], lines = [];
  for (const map of Object.values(ctx.maps)) {
    if (!(map.buildings || []).length) continue;
    const { margin, building } = edgeMarginFor(map);
    lines.push(`${map.id}: tightest building "${building}" keeps ${margin.toFixed(1)}px from the map edge`);
    if (margin < TH.edgeMinMarginPx) {
      failures.push(`${map.id}: building "${building}" sits ${margin.toFixed(1)}px from the map edge (min ${TH.edgeMinMarginPx}) — buildings keep breathing room`);
    }
  }
  return { name: 'EDGE MARGIN', ok: failures.length === 0, failures, lines };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
export function loadContext() {
  const manifestPath = path.join(PT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('previews/playtest/manifest.json missing — run captures first (node scripts/preview.mjs --scene playtest)');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const images = new Map();
  for (const e of manifest.entries) {
    if (e.phase !== 'day') continue; // pixel checks are day-only (see header)
    const p = path.join(ROOT, e.file);
    if (fs.existsSync(p)) images.set(e.file, decodePng(fs.readFileSync(p)));
  }
  return { maps: MAPS, entries: manifest.entries, images, manifest };
}

export function runChecks(ctx = loadContext()) {
  const results = [
    checkRowAlignment(ctx),
    checkBackVisibility(ctx),
    checkLegs(ctx),
    checkClearZones(ctx),
    checkCrowding(ctx),
    checkEdgeMargin(ctx),
  ];
  return { results, ok: results.every(r => r.ok), entries: ctx.entries.length };
}

export function formatReport(run, extra = {}) {
  const L = [];
  L.push('# Playtest Gate — image-space checks');
  if (extra.head) L.push(`- HEAD: \`${extra.head}\``);
  L.push(`- Captures: ${run.entries} posed play-zoom shots (previews/playtest/)`);
  L.push('- Contact sheet: previews/playtest/contact-sheet.html — the parent eyeballs and signs this before any deploy');
  for (const r of run.results) {
    L.push(`\n## ${r.ok ? '✅' : '❌'} ${r.name}`);
    for (const line of r.lines) L.push(`- ${line}`);
    for (const f of r.failures) L.push(`- ❌ ${f}`);
  }
  L.push(`\n## VERDICT: ${run.ok ? '✅ PASS' : '❌ FAIL'}`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Selftest — every check must FAIL BY NAME on a broken fixture.
// Synthetic images/anchors only: no captures, no server needed.
// ---------------------------------------------------------------------------
function blankImg(w, h, [r, g, b]) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return { w, h, data };
}
function paint(img, [fx0, fy0, fx1, fy1], [r, g, b]) {
  const x0 = Math.floor(fx0), y0 = Math.floor(fy0), x1 = Math.ceil(fx1), y1 = Math.ceil(fy1);
  for (let y = Math.max(0, y0); y <= Math.min(img.h - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(img.w - 1, x1); x++) {
      const i = (y * img.w + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
    }
  }
}
const FLOOR = [70, 55, 45];
const WOOD_RGB = hex('#8a5a2b');
const GREEN_RGB = [43, 255, 94];
const entryStub = (actors, camera = { x: 0, y: 0 }) => ({
  map: 'stub', phase: 'day', shot: 'stub', canvas: { w: 400, h: 400, ox: 0, oy: 0 }, camera, actors,
});

export function runSelftest() {
  const cases = [];
  const expect = (name, cond, detail) => cases.push({ name, ok: Boolean(cond), detail });

  // PNG codec roundtrip.
  {
    const img = blankImg(9, 7, [12, 34, 56]);
    paint(img, [2, 2, 4, 4], [200, 100, 50]);
    const back = decodePng(encodePng(img));
    expect('png codec roundtrip', back.w === 9 && back.h === 7 && back.data[(3 * 9 + 3) * 4] === 200, 'encode→decode preserves pixels');
  }
  // BACK VISIBILITY: a seat whose back window shows bare floor
  // must fail; the same window painted with the back passes.
  {
    const seat = { x: 0, y: 0, kind: 'chair', dir: 'down' };
    const e = entryStub([]);
    const bare = windowFracFor(blankImg(400, 400, FLOOR), e, seat);
    expect('BACK VISIBILITY fails on a backless render', bare && bare.ok === false, `frac=${(bare.frac || 0).toFixed(3)}`);
    const good = blankImg(400, 400, FLOOR);
    const win = backWindow('chair', 'down', seatAnchor(e, seat));
    for (const r of win.rects) paint(good, r, WOOD_RGB);
    const withBack = windowFracFor(good, e, seat);
    expect('BACK VISIBILITY passes when the back is drawn', withBack.ok === true, `frac=${(withBack.frac || 0).toFixed(3)}`);
  }
  // BACK VISIBILITY (profile): a genuinely backless PROFILE
  // render must fail by name too — the profile window is the
  // panel's outboard post strip, so bare floor there fails and
  // the painted strip passes, for BOTH profile facings.
  for (const dir of ['left', 'right']) {
    const seat = { x: 0, y: 0, kind: 'chair', dir };
    const e = entryStub([]);
    const bare = windowFracFor(blankImg(400, 400, FLOOR), e, seat);
    expect(`BACK VISIBILITY fails on a backless profile render (${dir})`, bare && bare.ok === false, `frac=${(bare.frac || 0).toFixed(3)}`);
    const good = blankImg(400, 400, FLOOR);
    const win = backWindow('chair', dir, seatAnchor(e, seat));
    for (const r of win.rects) paint(good, r, WOOD_RGB);
    const withBack = windowFracFor(good, e, seat);
    expect(`BACK VISIBILITY passes when the profile back is drawn (${dir})`, withBack.ok === true, `frac=${(withBack.frac || 0).toFixed(3)}`);
  }
  // BACK VISIBILITY (audience, v1.5.1): the venue chair's back
  // is an OPEN ladder — the checker samples its post strips, so
  // a seat that renders as the bare plank X circled (no back
  // at all) must FAIL, and the same seat with its posts/slats
  // standing must PASS, in both venue facings. The open gaps
  // are never sampled, so the slatted design can't fail for
  // being open — but backless still can and does.
  for (const dir of ['up', 'down']) {
    const seat = { x: 0, y: 0, kind: 'audience', dir };
    const e = entryStub([]);
    const bare = windowFracFor(blankImg(400, 400, FLOOR), e, seat);
    expect(`BACK VISIBILITY fails on a backless audience seat (${dir})`, bare && bare.ok === false, `frac=${(bare.frac || 0).toFixed(3)}`);
    const good = blankImg(400, 400, FLOOR);
    const win = backWindow('audience', dir, seatAnchor(e, seat));
    for (const r of win.rects) paint(good, r, WOOD_RGB);
    const withBack = windowFracFor(good, e, seat);
    expect(`BACK VISIBILITY passes when the audience back is drawn (${dir})`, withBack.ok === true, `frac=${(withBack.frac || 0).toFixed(3)}`);
  }
  // BACK VISIBILITY (neighbour rule): on a bare-floor render
  // (NO backs drawn anywhere), an occupied profile seat whose
  // window a neighbour's sprite covers is covered by the
  // reference pass — but the identical backless seat with NO
  // neighbour must still fail by name. Guards the excuse from
  // ever becoming a pass.
  {
    const seatA = { id: 'stub-seat-A', x: 0, y: 0, kind: 'chair', dir: 'left' };
    const seatB = { id: 'stub-seat-B', x: 150, y: 150, kind: 'chair', dir: 'left' };
    const map = { id: 'stub', seats: [seatA, seatB], props: [], doors: [], gateways: [] };
    const sitterA = { pid: 1, name: 'A', x: 0, y: 0, dir: 'left', seated: true, seatId: 'stub-seat-A', seatKind: 'chair' };
    // 43px screen-north of A = world (-60,-60): the poker-ring
    // S-chair position relative to the W chair.
    const neighbour = { pid: 2, name: 'N', x: -60, y: -60, dir: 'up', seated: false };
    const sitterB = { pid: 3, name: 'B', x: 150, y: 150, dir: 'left', seated: true, seatId: 'stub-seat-B', seatKind: 'chair' };
    const e = { ...entryStub([sitterA, neighbour, sitterB]), file: 'stub.png', map: 'stub' };
    const img = blankImg(400, 400, FLOOR);
    const ctxStub = { maps: { stub: map }, entries: [e], images: new Map([['stub.png', img]]), manifest: { entries: [e] } };
    const bv = runChecks(ctxStub).results.find(r => r.name === 'BACK VISIBILITY');
    const failsOnB = bv.failures.filter(f => f.includes('stub-seat-B'));
    const failsOnA = bv.failures.filter(f => f.includes('stub-seat-A'));
    expect('BACK VISIBILITY neighbour rule covers the crowded seat, never excuses the isolated backless seat',
      bv.ok === false && failsOnB.length >= 1 && failsOnA.length === 0,
      `failures on isolated B=${failsOnB.length}, on neighbour-covered A=${failsOnA.length}`);
  }
  // LEGS UNDER TABLES: marker green painted onto the tabletop
  // interior must fail; a clean tabletop passes.
  {
    const map = {
      id: 'stub', seats: [{ id: 'm-seat-1', x: 32, y: 0, dir: 'up', kind: 'chair' }],
      props: [{ kind: 'table', x: 32, y: 32 }],
    };
    const actor = { pid: 1, name: 'T', x: 32, y: 0, dir: 'up', seated: true, seatId: 'm-seat-1', seatKind: 'chair', pull: [0, -5] };
    const e = entryStub([actor], { x: 32, y: 0 });
    const win = legsWindow(screenOf(e, 32, 32))[0];
    const bad = blankImg(400, 400, FLOOR);
    paint(bad, win, GREEN_RGB);
    const badRes = legsFor(bad, e, map);
    expect('LEGS UNDER TABLES fails when legs paint over the table', badRes.length === 1 && badRes[0].ok === false, `green=${(badRes[0].green || 0).toFixed(3)}`);
    const good = blankImg(400, 400, FLOOR);
    paint(good, win, hex('#caa06a'));
    const goodRes = legsFor(good, e, map);
    expect('LEGS UNDER TABLES passes on a clean tabletop', goodRes.length === 1 && goodRes[0].ok === true, `green=${(goodRes[0].green || 0).toFixed(3)} table=${(goodRes[0].tableFrac || 0).toFixed(3)}`);
  }
  // ROW ALIGNMENT: one seat shifted a full tile off its row must fail.
  {
    const row = [];
    for (let i = 0; i < 5; i++) row.push({ id: `a-seat-${101 + i}`, x: (2 + i) * TILE + 16, y: 5 * TILE + 16 });
    const clean = alignmentFromSeats(row);
    const shifted = row.map((s, i) => i === 2 ? { ...s, y: s.y + TILE } : s);
    const dirty = alignmentFromSeats(shifted);
    const badness = (r) => Math.max(r.maxDev, r.maxProgDev) > TH.alignMaxDevPx || r.holes > 0;
    expect('ROW ALIGNMENT fails on a shifted seat', !badness(clean) && badness(dirty),
      `clean dev=${clean.maxDev.toFixed(2)}px holes=${clean.holes}, shifted dev=${dirty.maxDev.toFixed(2)}px holes=${dirty.holes} rhythm=${dirty.maxProgDev.toFixed(2)}px`);
  }
  // CLEAR ZONES: a seasonal prop injected into a doorstep apron
  // must fail (the doorstep law binds seasonal dressing); a
  // sitter injected into a pit-front band must fail too.
  {
    const map = { id: 'stub', doors: [{ x: 64, y: 64, w: 32, h: 32, label: 'D' }], gateways: [], seats: [], props: [] };
    const inside = clearZoneViolations(map, [], [{ kind: 'pumpkin', layer: 'halloween', x: 80, y: 112 }]); // 1 tile below the door = apron
    const outside = clearZoneViolations(map, [], [{ kind: 'pumpkin', layer: 'halloween', x: 400, y: 400 }]);
    const stageMap = {
      id: 'stub', doors: [], gateways: [], props: [],
      stage: { pit: { x: 0, y: 0, w: 320, h: 96 } },
      seats: [0, 1, 2, 3].map(i => ({ id: `stub-seat-${101 + i}`, x: 64 + i * 64, y: 160, kind: 'chair', dir: 'down' })),
    };
    const inBand = clearZoneViolations(stageMap, [{ label: 'injected sitter', x: 96, y: 112 }]); // between pit (rows 0-2) and seats (row 5): band row 3-4
    expect('CLEAR ZONES fails on an apron intruder', inside.length >= 1 && outside.length === 0 && inBand.length >= 1,
      `apron inside=${inside.length}, outside=${outside.length}, pit band=${inBand.length}`);
  }
  // CROWDING: table groups 3 tiles apart must fail; 9 apart passes.
  {
    const mk = (gapTiles) => {
      const seats = [];
      const tableAt = (tx) => {
        seats.push({ id: `s${tx}a`, x: tx * TILE - TILE + 16, y: 16, kind: 'chair' }, { id: `s${tx}b`, x: tx * TILE + TILE + 16, y: 16, kind: 'chair' });
        return { kind: 'table', x: tx * TILE + 16, y: 16 };
      };
      return { id: 'stub', gateways: [], seats, props: [tableAt(2), tableAt(2 + gapTiles)] };
    };
    const tight = crowdingFor(mk(3));
    const roomy = crowdingFor(mk(9));
    expect('CROWDING fails on jammed table groups', tight.min.distTiles < tight.min.need && roomy.min.distTiles >= roomy.min.need,
      `tight centres=${tight.min.distTiles.toFixed(1)} tiles (needs ${tight.min.need}), roomy=${roomy.min.distTiles.toFixed(1)} tiles`);
  }
  // EDGE MARGIN: a building on the map boundary must fail.
  {
    const map = Object.values(MAPS).find(m => (m.buildings || []).length);
    const real = edgeMarginFor(map);
    const shoved = edgeMarginFor(map, [{ name: 'shoved', tx: 0, ty: 0, tw: 6, th: 4 }]);
    expect('EDGE MARGIN fails on an edge-hugging building', shoved.margin < TH.edgeMinMarginPx && real.margin > shoved.margin,
      `shoved=${shoved.margin.toFixed(1)}px, real tightest=${real.margin.toFixed(1)}px`);
  }
  return { ok: cases.every(c => c.ok), cases };
}

// ---------------------------------------------------------------------------
function main() {
  if (process.argv.includes('--selftest')) {
    const { ok, cases } = runSelftest();
    for (const c of cases) console.log(`- ${c.ok ? '✅' : '❌'} SELFTEST ${c.name} — ${c.detail}`);
    console.log(`\nSELFTEST VERDICT: ${ok ? '✅ PASS' : '❌ FAIL'}`);
    process.exit(ok ? 0 : 1);
  }
  let run;
  try {
    run = runChecks();
  } catch (e) {
    console.error(`playtest-check error: ${e.message}`);
    process.exit(2);
  }
  process.stdout.write(formatReport(run));
  process.exit(run.ok ? 0 : 1);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
