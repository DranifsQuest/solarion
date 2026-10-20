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

// ------------------------------------------------------------------
// PHASE 4 CITIES — one strong read each (soul doc §9.21). Grids are
// built programmatically (border walls + obstacle rects on open floor)
// so every row is exactly 32 wide by construction; layouts, palettes,
// stage positions and return-gateway corners all differ per city.
// Every city carries ONE stage zone in the exact Phase 2 shape, so the
// StageManager picks it up with zero special-casing.
// ------------------------------------------------------------------
function buildCityTiles(obstacles) {
  const W = 32, H = 20;
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) row.push(x === 0 || y === 0 || x === W - 1 || y === H - 1 ? '#' : '.');
    rows.push(row);
  }
  for (const o of obstacles) {
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) {
        const gx = o.x + dx, gy = o.y + dy;
        if (gx > 0 && gy > 0 && gx < W - 1 && gy < H - 1) rows[gy][gx] = o.ch;
      }
    }
  }
  return grid(rows.map(r => r.join('')));
}

const stageDef = (tx, ty) => ({
  x: tx * TILE, y: ty * TILE, w: 6 * TILE, h: 2 * TILE,
  speakers: [
    { x: (tx - 1) * TILE + TILE / 2, y: ty * TILE + TILE / 2 },
    { x: (tx + 6) * TILE + TILE / 2, y: ty * TILE + TILE / 2 },
  ],
});
const retGw = (tx, ty, label = 'The Gateway') => ({
  x: tx * TILE, y: ty * TILE, w: TILE * 2, h: TILE, target: 'the-gateway', label,
});

// NEON DISTRICT — night-market glow: near-black violet floor, hot-pink
// walls, market stalls ('|') and neon pillars around a north stage.
const neon = {
  id: 'neon-district',
  name: 'Neon District',
  tiles: buildCityTiles([
    { x: 3, y: 4, w: 2, h: 2, ch: '|' }, { x: 27, y: 4, w: 2, h: 2, ch: '|' },
    { x: 6, y: 15, w: 2, h: 1, ch: '|' }, { x: 24, y: 15, w: 2, h: 1, ch: '|' },
    { x: 8, y: 7, w: 1, h: 3, ch: '#' }, { x: 23, y: 7, w: 1, h: 3, ch: '#' },
    { x: 8, y: 12, w: 1, h: 2, ch: '#' }, { x: 23, y: 12, w: 1, h: 2, ch: '#' },
    { x: 4, y: 10, w: 3, h: 1, ch: '|' }, { x: 25, y: 10, w: 3, h: 1, ch: '|' },
  ]),
  tileSize: TILE,
  floor: '#17102b', floorAlt: '#1e1438', wall: '#ff2e88',
  spawn: { x: 512, y: 530 },
  gateways: [retGw(15, 18)],
  stage: stageDef(13, 3),
};

// CINDER MESA — ember/desert forge: baked-orange sand, dark forge-rock
// walls, rock clusters and forge stalls; stage on the east side.
const cinder = {
  id: 'cinder-mesa',
  name: 'Cinder Mesa',
  tiles: buildCityTiles([
    { x: 4, y: 4, w: 3, h: 2, ch: '#' }, { x: 10, y: 3, w: 2, h: 1, ch: '#' },
    { x: 5, y: 14, w: 2, h: 2, ch: '#' }, { x: 14, y: 5, w: 4, h: 1, ch: '#' },
    { x: 14, y: 15, w: 4, h: 1, ch: '#' }, { x: 8, y: 9, w: 2, h: 2, ch: '|' },
    { x: 24, y: 14, w: 2, h: 1, ch: '|' }, { x: 3, y: 9, w: 1, h: 3, ch: '#' },
  ]),
  tileSize: TILE,
  floor: '#c47b3a', floorAlt: '#bb7031', wall: '#6e2418',
  spawn: { x: 96, y: 530 },
  gateways: [retGw(2, 18)],
  stage: stageDef(20, 8),
};

// FROSTHAVEN — aurora ice: pale blue-white ice floor, deep glacier
// walls, a frozen pond ('%') north-west; stage on the south side,
// return arch on the north edge (you arrive facing the stage).
const frost = {
  id: 'frosthaven',
  name: 'Frosthaven',
  tiles: buildCityTiles([
    { x: 2, y: 2, w: 6, h: 3, ch: '%' },
    { x: 24, y: 3, w: 3, h: 2, ch: '#' }, { x: 5, y: 15, w: 2, h: 2, ch: '#' },
    { x: 25, y: 14, w: 2, h: 2, ch: '#' }, { x: 10, y: 6, w: 1, h: 1, ch: '|' },
    { x: 21, y: 6, w: 1, h: 1, ch: '|' }, { x: 15, y: 10, w: 2, h: 1, ch: '#' },
  ]),
  tileSize: TILE,
  floor: '#d7edf7', floorAlt: '#c6e3f2', wall: '#2f5d8a',
  spawn: { x: 512, y: 90 },
  gateways: [retGw(15, 1)],
  stage: stageDef(13, 15),
};

// VERDANT HOLLOW — firefly grove: deep green floor, grove-brown walls,
// tree clusters ('|') everywhere and a pond; stage at the grove heart.
const verdant = {
  id: 'verdant-hollow',
  name: 'Verdant Hollow',
  tiles: buildCityTiles([
    { x: 3, y: 3, w: 2, h: 2, ch: '|' }, { x: 27, y: 3, w: 2, h: 2, ch: '|' },
    { x: 3, y: 16, w: 2, h: 2, ch: '|' }, { x: 27, y: 16, w: 2, h: 2, ch: '|' },
    { x: 8, y: 6, w: 1, h: 2, ch: '|' }, { x: 23, y: 6, w: 1, h: 2, ch: '|' },
    { x: 8, y: 13, w: 1, h: 1, ch: '|' }, { x: 23, y: 13, w: 1, h: 1, ch: '|' },
    { x: 14, y: 16, w: 4, h: 2, ch: '%' }, { x: 5, y: 10, w: 2, h: 1, ch: '#' },
    { x: 25, y: 10, w: 2, h: 1, ch: '#' },
  ]),
  tileSize: TILE,
  floor: '#2e5d33', floorAlt: '#26502b', wall: '#4a3520',
  spawn: { x: 928, y: 470 },
  gateways: [retGw(28, 18)],
  stage: stageDef(13, 9),
};

const MAPS = {
  [gateway.id]: gateway,
  [bay.id]: bay,
  [neon.id]: neon,
  [cinder.id]: cinder,
  [frost.id]: frost,
  [verdant.id]: verdant,
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
    studio: map.studio ? {
      ownerId: map.studio.ownerId, ownerName: map.studio.ownerName,
      door: { ...map.studio.door },
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
