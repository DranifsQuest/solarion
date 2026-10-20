'use strict';

/**
 * Solarion — maps (scenes).
 *
 * Maps are DATA, not code. Each map definition is:
 *   { id, name, theme colors, tile layout, spawn, gateways[], doors[],
 *     seats[], stage?, casino? }
 *
 * `tiles` is a { rows, w, h } grid: '#'=solid, '%'=water (solid),
 * '|'=tree/stall post (solid), '.'=walkable, 'W'=casino wall (solid),
 * 'C'=casino floor (walkable). Gateways (grand arches between the hub
 * and the cities) and doors (interior sub-areas) are pixel-space
 * rectangles; stepping into one triggers a server-side scene switch.
 *
 * PHASE 7 ("Phase B" — the big world): every public scene was scaled
 * to ~5x the original 32x20-tile footprint. The Gateway and the five
 * cities are now 72x45 tiles (2304x1440 px = 5.06x the tiles),
 * re-laid-out as real places — plazas, building blocks, streets,
 * stage grounds — not stretched versions of the old rooms. The
 * Casino Lounge is its OWN interior scene (24x15) entered through a
 * door in Solstice Bay, and the Gateway gained a café interior
 * (20x13) behind a door of its own. Studios are player rooms and
 * keep their own template (studio.js).
 */

const TILE = 32;

const px = (t) => t * TILE;                 // tile -> px (top-left)
const cx = (t) => t * TILE + TILE / 2;      // tile -> px (centre)
const cy = (t) => t * TILE + TILE / 2;

/** A w x h grid of `fill`, mutated by the painter helpers below. */
function makeGrid(w, h, fill) {
  return Array.from({ length: h }, () => Array(w).fill(fill));
}
function setRect(g, x, y, w, h, ch) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (g[yy] && g[yy][xx] !== undefined) g[yy][xx] = ch;
    }
  }
}
function setBorder(g, w, h, ch) {
  setRect(g, 0, 0, w, 1, ch);
  setRect(g, 0, h - 1, w, 1, ch);
  setRect(g, 0, 0, 1, h, ch);
  setRect(g, w - 1, 0, 1, h, ch);
}
function gridOf(g) {
  const rows = g.map(r => r.join(''));
  return { rows, w: rows[0].length, h: rows.length };
}

/** A 2-tile-wide gateway arch rect on a tile row (hub<->city travel). */
function arch(tx, ty, target, label) {
  return { x: px(tx), y: px(ty), w: TILE * 2, h: TILE, target, label };
}
/** A door rect: stepping on it enters an interior scene. */
function door(tx, ty, target, targetSpawn, label, wTiles = 1) {
  return { x: px(tx), y: px(ty), w: TILE * wTiles, h: TILE, target, targetSpawn, label };
}
/** A stage zone from its tile position (6x2 tiles, speakers flanking). */
function stageDef(tx, ty) {
  return {
    x: px(tx), y: px(ty), w: TILE * 6, h: TILE * 2,
    speakers: [
      { x: cx(tx - 1), y: cy(ty) },
      { x: cx(tx + 6), y: cy(ty) },
    ],
  };
}
/** A sittable spot. dir = the way the sitter faces. */
function seat(mapId, n, tx, ty, dir, kind) {
  return { id: `${mapId}-seat-${n}`, x: cx(tx), y: cy(ty), dir, kind };
}

// ------------------------------------------------------------------
// THE GATEWAY — entrance plaza / hub. Five gateway arches along the
// north terrace, a fountain at the plaza centre, market corners, and
// the Gateway Café building in the south-east (door on its north
// face). Benches ring the fountain; café tables sit outside the café.
// ------------------------------------------------------------------
function buildGateway() {
  const W = 72, H = 45;
  const g = makeGrid(W, H, '.');
  setBorder(g, W, H, '#');
  setRect(g, 3, 4, 6, 6, '#');    // NW market block
  setRect(g, 63, 4, 6, 6, '#');   // NE market block
  setRect(g, 3, 18, 4, 9, '#');   // W block
  setRect(g, 65, 18, 4, 9, '#');  // E block
  setRect(g, 33, 20, 6, 3, '%');  // fountain
  for (const [x, y] of [[10, 36], [11, 36], [10, 37], [14, 38], [52, 38], [57, 36], [58, 36], [58, 37]]) {
    g[y][x] = '|';                // market stall posts, south plaza
  }
  setRect(g, 57, 33, 12, 9, '#'); // the Gateway Café building (SE)
  const id = 'the-gateway';
  return {
    id, name: 'The Gateway', tiles: gridOf(g), tileSize: TILE,
    floor: '#2e3a52', floorAlt: '#33415c', wall: '#10151f',
    spawn: { x: cx(36), y: cy(28) },
    gateways: [
      arch(6, 1, 'neon-district', 'Neon District'),
      arch(20, 1, 'cinder-mesa', 'Cinder Mesa'),
      arch(34, 1, 'solstice-bay', 'Solstice Bay'),
      arch(48, 1, 'frosthaven', 'Frosthaven'),
      arch(62, 1, 'verdant-hollow', 'Verdant Hollow'),
    ],
    doors: [
      door(62, 32, 'gateway-cafe', { x: cx(10), y: cy(10) }, 'Gateway Café'),
    ],
    seats: [
      seat(id, 1, 31, 19, 'right', 'bench'),
      seat(id, 2, 31, 23, 'right', 'bench'),
      seat(id, 3, 40, 19, 'left', 'bench'),
      seat(id, 4, 40, 23, 'left', 'bench'),
      seat(id, 5, 34, 17, 'down', 'bench'),
      seat(id, 6, 37, 25, 'up', 'bench'),
      seat(id, 7, 60, 30, 'down', 'cafe'),
      seat(id, 8, 64, 30, 'down', 'cafe'),
      seat(id, 9, 20, 28, 'up', 'chair'),
      seat(id, 10, 52, 28, 'up', 'chair'),
    ],
  };
}

// ------------------------------------------------------------------
// GATEWAY CAFÉ — a small interior off the hub: serving counter along
// the north wall, five café tables with a chair each side, and a
// door on the south wall back to the Gateway.
// ------------------------------------------------------------------
function buildCafe() {
  const W = 20, H = 13;
  const g = makeGrid(W, H, '.');
  setBorder(g, W, H, '#');
  setRect(g, 2, 2, 16, 1, '#');   // serving counter
  g[10][2] = '|'; g[10][17] = '|'; // plants
  const id = 'gateway-cafe';
  // Tables at tiles (4,5) (9,5) (14,5) (6,9) (12,9); chairs flank them.
  const chairPairs = [
    [3, 5, 'right'], [5, 5, 'left'], [8, 5, 'right'], [10, 5, 'left'],
    [13, 5, 'right'], [15, 5, 'left'], [5, 9, 'right'], [7, 9, 'left'],
    [11, 9, 'right'], [13, 9, 'left'],
  ];
  return {
    id, name: 'Gateway Café', tiles: gridOf(g), tileSize: TILE,
    floor: '#4a3226', floorAlt: '#443022', wall: '#2e1d12',
    spawn: { x: cx(10), y: cy(10) },
    gateways: [],
    doors: [
      door(9, 11, 'the-gateway', { x: cx(62), y: cy(31) }, 'The Gateway', 2),
    ],
    seats: chairPairs.map(([x, y, dir], i) => seat(id, i + 1, x, y, dir, 'cafe')),
  };
}

// ------------------------------------------------------------------
// SOLSTICE BAY — golden-hour beach city (soul doc §9.16). The sea
// across the north, boardwalk promenade + stage below it, beach
// huts and stalls, and the Casino building in the south-west — its
// door (east face) leads into the Casino Lounge interior scene.
// ------------------------------------------------------------------
function buildSolsticeBay() {
  const W = 72, H = 45;
  const g = makeGrid(W, H, '.');
  setRect(g, 0, 0, W, 5, '%');          // the sea
  setRect(g, 0, H - 1, W, 1, '#');
  setRect(g, 0, 0, 1, H, '#');
  setRect(g, W - 1, 0, 1, H, '#');
  g[6][32] = '|'; g[6][39] = '|';       // stage speakers
  for (const [x, y] of [[6, 12], [7, 12], [64, 12], [65, 12], [10, 26], [62, 26], [36, 30], [37, 30]]) {
    g[y][x] = '|';                      // boardwalk stalls
  }
  setRect(g, 22, 32, 3, 2, '#');        // beach hut
  setRect(g, 48, 32, 3, 2, '#');        // beach hut
  setRect(g, 3, 33, 12, 10, '#');       // the Casino building (SW)
  const id = 'solstice-bay';
  return {
    id, name: 'Solstice Bay', tiles: gridOf(g), tileSize: TILE,
    floor: '#e8cf9a', floorAlt: '#e2c588', wall: '#2b6f8f',
    spawn: { x: cx(36), y: cy(41) },
    gateways: [arch(35, 43, 'the-gateway', 'The Gateway')],
    doors: [
      door(15, 37, 'casino-lounge', { x: 400, y: 368 }, 'Casino Lounge'),
    ],
    stage: stageDef(33, 6),
    seats: [
      seat(id, 1, 10, 8, 'up', 'chair'),
      seat(id, 2, 14, 8, 'up', 'chair'),
      seat(id, 3, 52, 8, 'up', 'chair'),
      seat(id, 4, 58, 8, 'up', 'chair'),
      seat(id, 5, 28, 10, 'up', 'bench'),
      seat(id, 6, 44, 10, 'up', 'bench'),
      seat(id, 7, 56, 14, 'left', 'cafe'),
      seat(id, 8, 60, 14, 'left', 'cafe'),
    ],
  };
}

// ------------------------------------------------------------------
// CASINO LOUNGE — its own interior scene (Phase B; it used to be a
// 10x7 room embedded in Solstice Bay). Six Hold'em tables in two
// rows of three, ten slot machines along the north wall, sofas in
// the south corners, and a door on the south wall back to the bay.
// ------------------------------------------------------------------
const CASINO_FLOOR = '#3a2350';      // deep club purple — reads "indoor"
const CASINO_FLOOR_ALT = '#432a5c';
const CASINO_WALL = '#241533';

function buildCasinoLounge() {
  const W = 24, H = 15;
  const g = makeGrid(W, H, 'C');
  setBorder(g, W, H, 'W');
  const id = 'casino-lounge';
  const chairSet = (x, y) => [
    { dir: 'N', x, y: y - 44 },
    { dir: 'E', x: x + 44, y },
    { dir: 'S', x, y: y + 44 },
    { dir: 'W', x: x - 44, y },
  ];
  const tableAt = (n, tx, ty) => ({
    id: `${id}-poker-${n}`, x: cx(tx), y: cy(ty), chairs: chairSet(cx(tx), cy(ty)),
  });
  const tables = [
    tableAt(1, 4, 5), tableAt(2, 11, 5), tableAt(3, 18, 5),
    tableAt(4, 4, 10), tableAt(5, 11, 10), tableAt(6, 18, 10),
  ];
  const slots = [];
  for (let i = 0; i < 10; i++) {
    const tx = 2 + i * 2;
    slots.push({ id: `${id}-slot-${i + 1}`, x: cx(tx), y: cy(2) - 10, ix: cx(tx), iy: cy(3) });
  }
  return {
    id, name: 'Casino Lounge', tiles: gridOf(g), tileSize: TILE,
    floor: CASINO_FLOOR, floorAlt: CASINO_FLOOR_ALT, wall: CASINO_WALL,
    spawn: { x: 400, y: 368 },
    gateways: [],
    doors: [
      door(11, 13, 'solstice-bay', { x: cx(15), y: cy(37) }, 'Solstice Bay', 2),
    ],
    seats: [
      seat(id, 1, 2, 12, 'up', 'sofa'),
      seat(id, 2, 21, 12, 'up', 'sofa'),
    ],
    casino: {
      id: `${id}-casino`,
      mapId: id,
      label: 'Casino Lounge',
      x: 0, y: 0, w: W * TILE, h: H * TILE,
      floor: CASINO_FLOOR, floorAlt: CASINO_FLOOR_ALT, wall: CASINO_WALL,
      tables,
      slots,
    },
  };
}

// ------------------------------------------------------------------
// THE FOUR OUTER CITIES share the 72x45 canvas; each gets its own
// layout language (soul doc §9.21 — one strong read per city), its
// own stage position and its own return-arch corner.
// ------------------------------------------------------------------
function cityShell(W, H) {
  const g = makeGrid(W, H, '.');
  setBorder(g, W, H, '#');
  return g;
}

// NEON DISTRICT — night market: building blocks form a street grid
// around a market square; stage on the north-center.
function buildNeonDistrict() {
  const W = 72, H = 45;
  const g = cityShell(W, H);
  setRect(g, 4, 4, 10, 7, '#'); setRect(g, 18, 4, 12, 7, '#');
  setRect(g, 42, 4, 12, 7, '#'); setRect(g, 58, 4, 10, 7, '#');
  setRect(g, 4, 16, 12, 9, '#'); setRect(g, 56, 16, 12, 9, '#');
  setRect(g, 4, 30, 12, 8, '#'); setRect(g, 24, 30, 10, 8, '#');
  setRect(g, 40, 30, 8, 8, '#'); setRect(g, 56, 30, 12, 8, '#');
  g[3][32] = '|'; g[3][39] = '|'; // stage speakers
  for (const [x, y] of [[30, 18], [41, 18], [30, 26], [41, 26], [36, 16]]) g[y][x] = '|'; // market stalls
  const id = 'neon-district';
  return {
    id, name: 'Neon District', tiles: gridOf(g), tileSize: TILE,
    floor: '#17102b', floorAlt: '#1e1438', wall: '#ff2e88',
    spawn: { x: cx(36), y: cy(41) },
    gateways: [arch(35, 43, 'the-gateway', 'The Gateway')],
    doors: [],
    stage: stageDef(33, 3),
    seats: [
      seat(id, 1, 20, 13, 'down', 'bench'),
      seat(id, 2, 50, 13, 'down', 'bench'),
      seat(id, 3, 34, 20, 'down', 'cafe'),
      seat(id, 4, 38, 24, 'up', 'cafe'),
      seat(id, 5, 24, 22, 'right', 'chair'),
    ],
  };
}

// CINDER MESA — ember forge country: scattered rock clusters, a
// forge plaza west-center, stage on the east rim, arch south-west.
function buildCinderMesa() {
  const W = 72, H = 45;
  const g = cityShell(W, H);
  for (const [x, y, w, h] of [
    [6, 6, 4, 3], [20, 4, 5, 2], [50, 5, 6, 3], [62, 14, 4, 4],
    [8, 20, 5, 3], [16, 32, 6, 3], [56, 32, 5, 4], [30, 14, 3, 2],
    [36, 36, 4, 2], [10, 36, 3, 3], [24, 20, 3, 2],
  ]) setRect(g, x, y, w, h, '#');
  g[21][62] = '|'; g[21][69] = '|'; // stage speakers
  g[18][28] = '|'; g[24][28] = '|'; // forge posts
  const id = 'cinder-mesa';
  return {
    id, name: 'Cinder Mesa', tiles: gridOf(g), tileSize: TILE,
    floor: '#c47b3a', floorAlt: '#bb7031', wall: '#6e2418',
    spawn: { x: cx(4), y: cy(41) },
    gateways: [arch(3, 43, 'the-gateway', 'The Gateway')],
    doors: [],
    stage: stageDef(63, 21),
    seats: [
      seat(id, 1, 58, 20, 'right', 'bench'),
      seat(id, 2, 58, 24, 'right', 'bench'),
      seat(id, 3, 24, 24, 'down', 'chair'),
      seat(id, 4, 26, 27, 'up', 'cafe'),
    ],
  };
}

// FROSTHAVEN — aurora ice: a frozen pond north-west, ice blocks,
// pines; stage on the south side, return arch on the north edge
// (you arrive facing the stage).
function buildFrosthaven() {
  const W = 72, H = 45;
  const g = cityShell(W, H);
  setRect(g, 3, 3, 14, 8, '%');
  setRect(g, 17, 5, 4, 4, '%');
  for (const [x, y, w, h] of [[56, 8, 5, 4], [60, 20, 6, 5], [8, 30, 5, 3], [20, 20, 3, 2]]) {
    setRect(g, x, y, w, h, '#');
  }
  for (const [x, y] of [[30, 12], [44, 14], [52, 30], [24, 32]]) g[y][x] = '|'; // pines
  g[37][32] = '|'; g[37][39] = '|'; // stage speakers
  const id = 'frosthaven';
  return {
    id, name: 'Frosthaven', tiles: gridOf(g), tileSize: TILE,
    floor: '#d7edf7', floorAlt: '#c6e3f2', wall: '#2f5d8a',
    spawn: { x: cx(36), y: cy(4) },
    gateways: [arch(35, 1, 'the-gateway', 'The Gateway')],
    doors: [],
    stage: stageDef(33, 37),
    seats: [
      seat(id, 1, 30, 34, 'down', 'bench'),
      seat(id, 2, 42, 34, 'down', 'bench'),
      seat(id, 3, 22, 8, 'left', 'chair'),
      seat(id, 4, 48, 34, 'down', 'cafe'),
    ],
  };
}

// VERDANT HOLLOW — firefly grove: dense tree clusters around a
// central clearing with the stage at its heart; pond to the south,
// return arch in the south-east corner.
function buildVerdantHollow() {
  const W = 72, H = 45;
  const g = cityShell(W, H);
  for (const [x, y, w, h] of [
    [4, 4, 5, 4], [14, 3, 4, 3], [24, 5, 3, 3], [44, 4, 5, 4],
    [56, 3, 6, 3], [64, 8, 4, 4], [4, 16, 4, 5], [64, 18, 5, 4],
    [8, 28, 4, 4], [56, 28, 5, 4], [20, 32, 4, 3], [44, 33, 4, 3],
  ]) setRect(g, x, y, w, h, '|');
  setRect(g, 30, 37, 10, 5, '%');
  g[21][32] = '|'; g[21][39] = '|'; // stage speakers
  const id = 'verdant-hollow';
  return {
    id, name: 'Verdant Hollow', tiles: gridOf(g), tileSize: TILE,
    floor: '#2e5d33', floorAlt: '#26502b', wall: '#4a3520',
    spawn: { x: cx(67), y: cy(41) },
    gateways: [arch(66, 43, 'the-gateway', 'The Gateway')],
    doors: [],
    stage: stageDef(33, 21),
    seats: [
      seat(id, 1, 28, 25, 'up', 'bench'),
      seat(id, 2, 44, 25, 'up', 'bench'),
      seat(id, 3, 12, 12, 'down', 'chair'),
      seat(id, 4, 58, 12, 'down', 'chair'),
      seat(id, 5, 36, 27, 'up', 'cafe'),
    ],
  };
}

const MAPS = {};
for (const def of [
  buildGateway(), buildCafe(), buildSolsticeBay(), buildCasinoLounge(),
  buildNeonDistrict(), buildCinderMesa(), buildFrosthaven(), buildVerdantHollow(),
]) {
  MAPS[def.id] = def;
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

const WALKABLE = new Set(['.', 'C']); // '.' open ground, 'C' casino-lounge floor

function isSolidTile(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.tiles.w || ty >= map.tiles.h) return true;
  return !WALKABLE.has(map.tiles.rows[ty][tx]);
}

function pointInRect(x, y, r) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Circle (player) vs. tile grid. Check the tiles the circle overlaps. */
function collides(map, x, y, r) {
  const minTx = Math.floor((x - r) / TILE);
  const maxTx = Math.floor((x + r) / TILE);
  const minTy = Math.floor((y - r) / TILE);
  const maxTy = Math.floor((y + r) / TILE);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!isSolidTile(map, tx, ty)) continue;
      // Closest point on the tile rect to the circle centre.
      const ccx = Math.max(tx * TILE, Math.min(x, tx * TILE + TILE));
      const ccy = Math.max(ty * TILE, Math.min(y, ty * TILE + TILE));
      const dx = x - ccx, dy = y - ccy;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}

function gatewayAt(map, x, y) {
  for (const gw of map.gateways || []) {
    if (pointInRect(x, y, gw)) return gw;
  }
  return null;
}

function doorAt(map, x, y) {
  for (const d of map.doors || []) {
    if (pointInRect(x, y, d)) return d;
  }
  return null;
}

/** Strip a map def down to what the client needs to render it. */
function clientMap(map) {
  return {
    id: map.id,
    name: map.name,
    tileSize: map.tileSize,
    rows: map.tiles.rows,
    w: map.tiles.w,
    h: map.tiles.h,
    floor: map.floor,
    floorAlt: map.floorAlt,
    wall: map.wall,
    gateways: (map.gateways || []).map(g => ({
      x: g.x, y: g.y, w: g.w, h: g.h, label: g.label,
      active: Boolean(MAPS[g.target]),
    })),
    doors: (map.doors || []).map(d => ({
      x: d.x, y: d.y, w: d.w, h: d.h, label: d.label,
    })),
    seats: (map.seats || []).map(s => ({ id: s.id, x: s.x, y: s.y, dir: s.dir, kind: s.kind })),
    stage: map.stage ? {
      x: map.stage.x, y: map.stage.y, w: map.stage.w, h: map.stage.h,
      speakers: map.stage.speakers.map(s => ({ x: s.x, y: s.y })),
    } : null,
    studio: map.studio ? {
      ownerId: map.studio.ownerId, ownerName: map.studio.ownerName,
      door: { ...map.studio.door },
    } : null,
    casino: map.casino ? {
      id: map.casino.id, label: map.casino.label,
      x: map.casino.x, y: map.casino.y, w: map.casino.w, h: map.casino.h,
      floor: map.casino.floor, floorAlt: map.casino.floorAlt, wall: map.casino.wall,
      tables: map.casino.tables.map(t => ({
        id: t.id, x: t.x, y: t.y,
        chairs: t.chairs.map(c => ({ dir: c.dir, x: c.x, y: c.y })),
      })),
      slots: map.casino.slots.map(s => ({ id: s.id, x: s.x, y: s.y, ix: s.ix, iy: s.iy })),
    } : null,
  };
}

module.exports = { TILE, MAPS, collides, gatewayAt, doorAt, clientMap };
