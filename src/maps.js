'use strict';

/**
 * Solarion — maps (scenes).
 *
 * Maps are DATA, not code. Each map definition is:
 *   { id, name, theme colors, tile layout, spawn, gateways[] }
 *
 * `tiles` is a string grid: '#'=solid, '%'=water, '.'=walkable,
 * 'W'=casino-lounge wall (solid), 'C'=casual lounge floor (walkable).
 * Gateways are pixel-space rectangles; stepping into one triggers a
 * server-side scene switch. A gateway whose `target` is a map id that
 * exists in MAPS is active; others are rendered sealed ("soon").
 *
 * To add a city: drop a definition in MAPS and give it a gateway entry
 * here in the Gateway plaza. Nothing else changes.
 */

const TILE = 32;

function grid(rows) {
  const h = rows.length;
  const w = rows[0].length;
  for (const r of rows) {
    if (r.length !== w) throw new Error('ragged map row');
  }
  return { rows, w, h };
}


// ------------------------------------------------------------------
// THE GATEWAY — entrance plaza / hub. Five gateway arches along the
// north edge; only Solstice Bay is open in Phase 1.
// ------------------------------------------------------------------
const GATEWAY_TILES = grid([
  '################################',
  '#..............................#',
  '#..............................#',
  '#..............................#',
  '#..............................#',
  '#..............................#',
  '#........##..........##........#',
  '#........##..........##........#',
  '#..............................#',
  '#............####..............#',
  '#............####..............#',
  '#..............................#',
  '#..............................#',
  '#..##......................##..#',
  '#..##......................##..#',
  '#..............................#',
  '#..............................#',
  '#..............................#',
  '#..............................#',
  '################################',
]);

// 32 x 20 tiles = 1024 x 640 px
const GATE_GW = (x, y, label, target) => ({
  x: x * TILE, y: y * TILE, w: TILE * 2, h: TILE,
  target, label,
});

const gateway = {
  id: 'the-gateway',
  name: 'The Gateway',
  tiles: GATEWAY_TILES,
  tileSize: TILE,
  floor: '#2e3a52',
  floorAlt: '#33415c',
  wall: '#10151f',
  spawn: { x: 512, y: 560 },
  gateways: [
    GATE_GW(4, 1, 'Neon District', 'neon-district'),       // planned — sealed
    GATE_GW(8, 1, 'Cinder Mesa', 'cinder-mesa'),           // planned — sealed
    GATE_GW(14, 1, 'Solstice Bay', 'solstice-bay'),        // open
    GATE_GW(20, 1, 'Frosthaven', 'frosthaven'),            // planned — sealed
    GATE_GW(24, 1, 'Verdant Hollow', 'verdant-hollow'),    // planned — sealed
  ],
};

// ------------------------------------------------------------------
// CASINO LOUNGE (Phase 3) — a data-driven indoor room that can be
// dropped into ANY city map with zero code changes: pick a free
// corner (tx, ty in tiles) and the builder returns the lounge def +
// rewrites those tiles as 'W' walls with a doorway gap on the east
// wall and 'C' indoor floor. Layout inside is expressed in tile
// offsets from the lounge origin, so a same-size lounge in another
// city is identical. Soul doc §2: the room is a machine, not a
// diorama — tables and machines are interactable furniture.
// ------------------------------------------------------------------
const CASINO_FLOOR = '#3a2350';      // deep club purple — reads "indoor"
const CASINO_FLOOR_ALT = '#432a5c';
const CASINO_WALL = '#241533';

function makeCasinoLounge(mapId, tx, ty) {
  const tw = 10, th = 7;                       // tiles, incl. walls
  const x = tx * TILE, y = ty * TILE, w = tw * TILE, h = th * TILE;
  const cx = (dx) => x + dx * TILE + TILE / 2; // px centre of tile offset
  const cy = (dy) => y + dy * TILE + TILE / 2;
  const chairSet = (txPx, tyPx) => [
    { dir: 'N', x: txPx, y: tyPx - 44 },
    { dir: 'E', x: txPx + 44, y: tyPx },
    { dir: 'S', x: txPx, y: tyPx + 44 },
    { dir: 'W', x: txPx - 44, y: tyPx },
  ];
  // Two poker tables on the upper floor of the lounge.
  const t1 = { x: cx(3), y: cy(2) };   // tile offset (3,2) centre
  const t2 = { x: cx(7), y: cy(2) };
  // Four slot machines along the south interior wall; (ix, iy) is the
  // standing spot in front of each machine.
  const slotXs = [2, 4, 6, 8].map((dx) => cx(dx));
  return {
    id: `${mapId}-casino`,
    mapId,
    label: 'Casino Lounge',
    x, y, w, h,
    floor: CASINO_FLOOR, floorAlt: CASINO_FLOOR_ALT, wall: CASINO_WALL,
    doorway: { x: (tx + tw - 1) * TILE, y: (ty + 3) * TILE, w: TILE, h: TILE },
    tables: [
      { id: `${mapId}-poker-1`, x: t1.x, y: t1.y, chairs: chairSet(t1.x, t1.y) },
      { id: `${mapId}-poker-2`, x: t2.x, y: t2.y, chairs: chairSet(t2.x, t2.y) },
    ],
    slots: slotXs.map((sx, i) => ({
      id: `${mapId}-slot-${i + 1}`,
      x: sx, y: cy(6) - 10,
      ix: sx, iy: cy(5),
    })),
  };
}

/** Rewrite a tile-grid (array of strings) with the lounge footprint. */
function applyCasinoToRows(rows, lounge) {
  const tx = Math.round(lounge.x / TILE), ty = Math.round(lounge.y / TILE);
  const tw = Math.round(lounge.w / TILE), th = Math.round(lounge.h / TILE);
  const doorTy = Math.round(lounge.doorway.y / TILE);
  const out = rows.map((r) => r.split(''));
  for (let dy = 0; dy < th; dy++) {
    for (let dx = 0; dx < tw; dx++) {
      const gx = tx + dx, gy = ty + dy;
      if (gy < 0 || gy >= out.length || gx < 0 || gx >= out[gy].length) continue;
      const isDoor = dx === tw - 1 && gy === doorTy;
      const isWall = dx === 0 || dy === 0 || dx === tw - 1 || dy === th - 1;
      out[gy][gx] = isDoor ? 'C' : isWall ? 'W' : 'C';
    }
  }
  return out.map((r) => r.join(''));
}

// ------------------------------------------------------------------
// SOLSTICE BAY — first city lobby. Breezy boardwalk: water across the
// top, stalls along the promenade, return gateway at the south edge.
// ------------------------------------------------------------------
const BAY_TILES = grid([
  '%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%',
  '%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%',
  '%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%',
  '%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%',
  '................................',
  '................................',
  '..##........................##..',
  '..##....##....####....##....##..',
  '........##....####....##........',
  '................................',
  '................................',
  '................................',
  '.....||..................||.....',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '................................',
  '################################',
]);

// Water (%) and stalls/trees (#, |) are solid; '.' is walkable sand/boardwalk.
// The stage (Phase 2) is the room's anchor (soul doc §9.1): a raised
// platform on the north-center promenade (tiles x13–18, y4–5, facing the
// audience floor to the south) flanked by two speakers that animate
// while someone performs. The stage tiles stay walkable — the server
// walks the performer to centre stage when their set starts.
// Casino Lounge (Phase 3): enclosed indoor room in the south-west
// corner (tiles x2–11, y12–18), reached through a doorway in its east
// wall at tile (11,15). Built additively from the same data builder
// every future city will use — the stage rect, gateways and spawn
// above are untouched.
const BAY_CASINO = makeCasinoLounge('solstice-bay', 2, 12);
const BAY_TILES_CASINO = grid(applyCasinoToRows(BAY_TILES.rows, BAY_CASINO));

const bay = {
  id: 'solstice-bay',
  name: 'Solstice Bay',
  tiles: BAY_TILES_CASINO,
  tileSize: TILE,
  floor: '#e8cf9a',
  floorAlt: '#e2c588',
  wall: '#2b6f8f',
  spawn: { x: 512, y: 480 },
  gateways: [
    { x: 15 * TILE, y: 17 * TILE, w: TILE * 2, h: TILE, target: 'the-gateway', label: 'The Gateway' },
  ],
  stage: {
    x: 13 * TILE, y: 4 * TILE, w: 6 * TILE, h: 2 * TILE,
    speakers: [
      { x: 12 * TILE + TILE / 2, y: 4 * TILE + TILE / 2 },
      { x: 19 * TILE + TILE / 2, y: 4 * TILE + TILE / 2 },
    ],
  },
  casino: BAY_CASINO,
};

const MAPS = {
  [gateway.id]: gateway,
  [bay.id]: bay,
};

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
      const cx = Math.max(tx * TILE, Math.min(x, tx * TILE + TILE));
      const cy = Math.max(ty * TILE, Math.min(y, ty * TILE + TILE));
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}

function gatewayAt(map, x, y) {
  for (const gw of map.gateways) {
    if (pointInRect(x, y, gw)) return gw;
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
    gateways: map.gateways.map(g => ({
      x: g.x, y: g.y, w: g.w, h: g.h, label: g.label,
      active: Boolean(MAPS[g.target]),
    })),
    stage: map.stage ? {
      x: map.stage.x, y: map.stage.y, w: map.stage.w, h: map.stage.h,
      speakers: map.stage.speakers.map(s => ({ x: s.x, y: s.y })),
    } : null,
    casino: map.casino ? {
      id: map.casino.id, label: map.casino.label,
      x: map.casino.x, y: map.casino.y, w: map.casino.w, h: map.casino.h,
      floor: map.casino.floor, floorAlt: map.casino.floorAlt, wall: map.casino.wall,
      doorway: { ...map.casino.doorway },
      tables: map.casino.tables.map(t => ({
        id: t.id, x: t.x, y: t.y,
        chairs: t.chairs.map(c => ({ dir: c.dir, x: c.x, y: c.y })),
      })),
      slots: map.casino.slots.map(s => ({ id: s.id, x: s.x, y: s.y, ix: s.ix, iy: s.iy })),
    } : null,
  };
}

module.exports = { TILE, MAPS, collides, gatewayAt, clientMap, makeCasinoLounge, applyCasinoToRows };
