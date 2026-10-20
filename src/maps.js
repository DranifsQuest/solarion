'use strict';

/**
 * Solarion — maps (scenes).
 *
 * Maps are DATA, not code. Each map definition is:
 *   { id, name, theme colors, tile layout, spawn, gateways[] }
 *
 * `tiles` is a string grid: '#'=solid (wall/water), '.'=walkable.
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
const bay = {
  id: 'solstice-bay',
  name: 'Solstice Bay',
  tiles: BAY_TILES,
  tileSize: TILE,
  floor: '#e8cf9a',
  floorAlt: '#e2c588',
  wall: '#2b6f8f',
  spawn: { x: 512, y: 480 },
  gateways: [
    { x: 15 * TILE, y: 17 * TILE, w: TILE * 2, h: TILE, target: 'the-gateway', label: 'The Gateway' },
  ],
};

const MAPS = {
  [gateway.id]: gateway,
  [bay.id]: bay,
};

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

function isSolidTile(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.tiles.w || ty >= map.tiles.h) return true;
  return map.tiles.rows[ty][tx] !== '.';
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
  };
}

module.exports = { TILE, MAPS, collides, gatewayAt, clientMap };
