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
 * 'C'=casino floor (walkable). Lane C added: 'T'=tree (solid),
 * 'P'=planter (solid), 'R'=rock (solid), 'b'=boardwalk, 's'=stone
 * plaza, 'p'=path (all walkable). Gateways are GATEHOUSES now: a
 * 2-tile trigger rect on the map edge (the inner threshold), solid
 * flank towers, and a short passage the client renders with real
 * double doors; `spawnOut` is where a traveller arriving INTO this
 * map through this gatehouse lands (just outside its mouth, clear
 * of the trigger). Doors (interior sub-areas) are pixel-space
 * rectangles; stepping into one triggers a server-side scene switch.
 * Enterable places carry exactly one `buildings` facade entry —
 * tiles under a facade stay '#' (solid); the client draws the
 * building instead of per-tile cubes.
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

/**
 * A gatehouse on a map edge (Lane C). (tx, ty) is the 2-tile-wide
 * trigger rect — the INNER threshold, at the same tiles the old
 * arches used. `dir` is the edge the structure sits on: 'N' (trigger
 * on row ty, passage extends south/into the map) or 'S' (trigger on
 * row ty, passage extends north). `spawnOut` (tile coords) is where
 * a player arriving into THIS map through this gatehouse lands:
 * just outside the passage mouth, clear of every trigger.
 */
function arch(tx, ty, target, label, dir, spawnOutTy) {
  return {
    x: px(tx), y: px(ty), w: TILE * 2, h: TILE, target, label, dir,
    spawnOut: { x: px(tx) + TILE, y: cy(spawnOutTy) },
  };
}
/**
 * Solid flank columns for a gatehouse: the towers either side of
 * the 2-wide passage, 2 tiles deep from the trigger row toward the
 * plaza. Passage tiles themselves stay walkable.
 */
function gatehouseWalls(g, tx, ty, dir) {
  const rows = dir === 'N' ? [ty, ty + 1] : [ty, ty - 1];
  for (const ry of rows) {
    g[ry][tx - 1] = '#';
    g[ry][tx + 2] = '#';
  }
}
/**
 * A building facade (Lane C): exactly one per enterable place. The
 * tiles under the rect are '#' (solid); the client draws ONE quality
 * building (walls, pitched roof, glowing windows) instead of cubes.
 * `style` keys the client's palette: cafe | casino | neon | hookah |
 * home.
 */
function building(tx, ty, tw, th, name, style) {
  return { tx, ty, tw, th, name, style };
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
/**
 * A static dressing prop (Phase 10, the Warm Home pass): hearths,
 * lamps, lanterns, string lights and rugs baked into public maps.
 * Purely visual (the client renders them; hearths/lamps/lights join
 * the night-glow pass) — sittable nook furniture is real `seats`.
 */
function prop(kind, tx, ty) {
  return { kind, x: cx(tx), y: cy(ty) };
}
/** A named area (Phase 9): entering one raises a place nameplate. */
function area(name, tx, ty, tw, th) {
  return { name, x: px(tx), y: px(ty), w: px(tw), h: px(th) };
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
  // Lane C ground zoning: stone plaza at the centre, stone under
  // the café corner + south market + the two market terraces.
  setRect(g, 28, 15, 16, 14, 's');  // Fountain Plaza stone
  setRect(g, 54, 28, 16, 15, 's');  // Café Corner stone
  setRect(g, 6, 32, 20, 10, 's');   // South Market stone
  setRect(g, 3, 4, 6, 6, 's');      // NW market terrace
  setRect(g, 63, 4, 6, 6, 's');     // NE market terrace
  setRect(g, 65, 18, 4, 9, 's');    // E terrace
  // Dirt paths run south from every gatehouse mouth to the plaza.
  for (const tx of [6, 20, 34, 48, 62]) setRect(g, tx, 4, 2, 11, 'p');
  setRect(g, 3, 18, 4, 9, '#');   // the Homes building (W) — a facade now
  setRect(g, 33, 20, 6, 3, '%');  // fountain
  for (const [x, y] of [[10, 36], [11, 36], [10, 37], [14, 38], [52, 38], [57, 36], [58, 36], [58, 37]]) {
    g[y][x] = '|';                // market stall posts, south plaza
  }
  // Market terraces: stall posts + trees instead of the old blocks.
  g[6][5] = '|'; g[8][7] = '|'; g[6][64] = '|'; g[8][66] = '|';
  g[4][8] = 'T'; g[9][3] = 'T'; g[4][63] = 'T'; g[9][68] = 'T';
  // E terrace dressing: trees + a planter where the E block stood.
  g[19][66] = 'T'; g[25][68] = 'T'; g[22][65] = 'P';
  // Plaza shade trees.
  g[14][12] = 'T'; g[14][60] = 'T'; g[31][24] = 'T'; g[31][48] = 'T';
  setRect(g, 57, 33, 12, 9, '#'); // the Gateway Café building (SE) — a facade now
  // Gatehouse flank towers for the five north arches.
  for (const tx of [6, 20, 34, 48, 62]) gatehouseWalls(g, tx, 1, 'N');
  const id = 'the-gateway';
  return {
    id, name: 'The Gateway', tiles: gridOf(g), tileSize: TILE,
    floor: '#2e3a52', floorAlt: '#33415c', wall: '#10151f',
    spawn: { x: cx(36), y: cy(28) },
    gateways: [
      arch(6, 1, 'neon-district', 'Neon District', 'N', 3),
      arch(20, 1, 'cinder-mesa', 'Cinder Mesa', 'N', 3),
      arch(34, 1, 'solstice-bay', 'Solstice Bay', 'N', 3),
      arch(48, 1, 'frosthaven', 'Frosthaven', 'N', 3),
      arch(62, 1, 'verdant-hollow', 'Verdant Hollow', 'N', 3),
    ],
    buildings: [
      building(3, 18, 4, 9, 'Homes', 'home'),
      building(57, 33, 12, 9, 'Gateway Café', 'cafe'),
    ],
    doors: [
      door(62, 32, 'gateway-cafe', { x: cx(10), y: cy(10) }, 'Gateway Café'),
      // Phase 10: your own front door in the world — a real door on
      // the west block's east face. Stepping through takes you home
      // (game.js routes the 'studio:self' target to the studio system).
      door(7, 22, 'studio:self', null, 'My Home'),
    ],
    props: [
      // Homes Corner dressing: lanterns flank the home-door walkway.
      prop('lantern', 8, 20), prop('lantern', 8, 24),
      // The fountain is the plaza's hero now — a real fountain, not
      // just blue tiles.
      prop('fountain', 36, 21),
      // A fountain-side nook: rug + lamps + a string of warm bulbs.
      prop('rug', 36, 31), prop('lamp', 34, 31), prop('lamp', 38, 31),
      prop('stringlights', 36, 30),
      // Café Corner dressing.
      prop('lamp', 59, 31), prop('stringlights', 62, 31),
      // Market stalls on their posts (Lane C).
      prop('stall', 5, 6), prop('stall', 64, 6), prop('stall', 10, 36), prop('stall', 57, 36),
      // Flower beds at the plaza's south edge + the south market.
      prop('flowers', 30, 29), prop('flowers', 42, 29), prop('flowers', 12, 33),
    ],
    areas: [
      area('The Arches', 2, 0, 68, 4),
      area('Fountain Plaza', 28, 15, 16, 14),
      area('Homes Corner', 0, 16, 13, 12),
      area('Café Corner', 54, 28, 16, 15),
      area('South Market', 6, 32, 20, 10),
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
  g[5][1] = '#';                   // Phase 10: the hearth niche (west wall)
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
    props: [
      prop('hearth', 1, 5),
      prop('stringlights', 10, 3),
      prop('lantern', 18, 4),
    ],
    areas: [area('The Hearth Corner', 0, 3, 7, 6), area('The Café', 1, 1, 18, 11)],
    seats: [
      ...chairPairs.map(([x, y, dir], i) => seat(id, i + 1, x, y, dir, 'cafe')),
      // Phase 10: hearth-side seats, facing the fire (west).
      seat(id, 11, 2, 4, 'left', 'chair'),
      seat(id, 12, 2, 5, 'left', 'sofa'),
      seat(id, 13, 2, 6, 'left', 'chair'),
    ],
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
  setRect(g, 1, 5, 70, 5, 'b');         // the boardwalk promenade (Lane C)
  setRect(g, 15, 18, 2, 19, 'p');       // sand path down to the Casino door
  g[6][32] = '|'; g[6][39] = '|';       // stage speakers
  for (const [x, y] of [[6, 12], [7, 12], [64, 12], [65, 12], [36, 30], [37, 30]]) {
    g[y][x] = '|';                      // boardwalk stalls
  }
  g[26][10] = 'P'; g[26][62] = 'P';     // planters where stall posts stood
  g[5][3] = '#';                        // the lighthouse plinth (hero)
  g[32][23] = 'T'; g[33][49] = 'T';     // palms where the beach huts stood
  gatehouseWalls(g, 35, 43, 'S');
  setRect(g, 3, 33, 12, 10, '#');       // the Casino building (SW) — a facade now
  const id = 'solstice-bay';
  return {
    id, name: 'Solstice Bay', tiles: gridOf(g), tileSize: TILE,
    floor: '#e8cf9a', floorAlt: '#e2c588', wall: '#2b6f8f',
    spawn: { x: cx(36), y: cy(41) },
    gateways: [arch(35, 43, 'the-gateway', 'The Gateway', 'S', 41)],
    buildings: [
      building(3, 33, 12, 10, 'Casino Lounge', 'casino'),
    ],
    doors: [
      door(15, 37, 'casino-lounge', { x: cx(15), y: cy(16) }, 'Casino Lounge'),
    ],
    props: [
      prop('lantern', 16, 36), prop('lantern', 16, 38),
      // The lighthouse keeps the bay's north-west shore (hero).
      prop('lighthouse', 3, 5),
      // A boardwalk nook: rug, a lamp, and a string of bulbs.
      prop('rug', 36, 15), prop('lamp', 33, 15), prop('stringlights', 36, 13),
      // Stalls on the boardwalk posts.
      prop('stall', 6, 12), prop('stall', 64, 12),
      // Planter colour along the boardwalk's south edge.
      prop('flowers', 20, 11), prop('flowers', 52, 11),
    ],
    stage: stageDef(33, 6),
    areas: [
      area('The Stage', 29, 4, 14, 6),
      area('The Boardwalk', 8, 10, 56, 12),
      area('The Beach', 16, 24, 40, 16),
      area('Casino Corner', 1, 31, 16, 12),
    ],
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
// CASINOS (Phase B amendment) — poker lives in exactly TWO grand
// casino interiors: the Casino Lounge off Solstice Bay and the Neon
// Casino off Neon District. One shared floor plan at 30x20 tiles:
//   - WEST: six Hold'em tables in two columns of three
//   - NORTH-EAST + EAST: the slots section — ten machines spaced
//     well away from the tables, every machine with its own stool
//     (you sit to spin)
//   - SOUTH-WEST: the bar — counter, bartender NPC behind it, bar
//     stools; drinks are 5z from the bartender
//   - SOUTH-CENTRE: the entryway — a 2-tile door back to the host
//     city, sofas flanking the foyer
// ------------------------------------------------------------------
const CASINO_FLOOR = '#3a2350';      // deep club purple — reads "indoor"
const CASINO_FLOOR_ALT = '#432a5c';
const CASINO_WALL = '#241533';
const NEON_CASINO_FLOOR = '#2b1030';
const NEON_CASINO_FLOOR_ALT = '#33153a';
const NEON_CASINO_WALL = '#180a20';

function buildCasino({ id, name, hostId, hostLabel, hostSpawn, floor, floorAlt, wall, bartender }) {
  const W = 30, H = 20;
  const g = makeGrid(W, H, 'C');
  setBorder(g, W, H, 'W');
  setRect(g, 2, 17, 7, 1, 'W'); // bar counter (bartender stands behind it)
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
    tableAt(1, 5, 4), tableAt(2, 12, 4),
    tableAt(3, 5, 9), tableAt(4, 12, 9),
    tableAt(5, 5, 14), tableAt(6, 12, 14),
  ];
  // Slots section: 5 machines along the north wall + 5 down the east
  // wall. (ix, iy) is the stool spot you sit on to play.
  const slots = [];
  for (let i = 0; i < 5; i++) {
    const tx = 16 + i * 2;
    slots.push({
      id: `${id}-slot-${i + 1}`, seatId: `${id}-slotseat-${i + 1}`,
      x: cx(tx), y: cy(2) - 10, ix: cx(tx), iy: cy(3),
    });
  }
  for (let i = 0; i < 5; i++) {
    const ty = 4 + i * 2;
    slots.push({
      id: `${id}-slot-${i + 6}`, seatId: `${id}-slotseat-${i + 6}`,
      x: cx(28), y: cy(ty), ix: cx(27), iy: cy(ty),
    });
  }
  const seats = [
    // slot stools (sit to spin): north row faces up, east row faces right
    ...slots.slice(0, 5).map((s, i) => ({ id: s.seatId, x: s.ix, y: s.iy, dir: 'up', kind: 'stool' })),
    ...slots.slice(5).map((s) => ({ id: s.seatId, x: s.ix, y: s.iy, dir: 'right', kind: 'stool' })),
    // bar stools face the counter (south)
    { id: `${id}-seat-1`, x: cx(3), y: cy(16), dir: 'down', kind: 'stool' },
    { id: `${id}-seat-2`, x: cx(7), y: cy(16), dir: 'down', kind: 'stool' },
    // foyer sofas
    { id: `${id}-seat-3`, x: cx(22), y: cy(17), dir: 'up', kind: 'sofa' },
    { id: `${id}-seat-4`, x: cx(26), y: cy(17), dir: 'up', kind: 'sofa' },
  ];
  return {
    id, name, tiles: gridOf(g), tileSize: TILE,
    floor, floorAlt, wall,
    spawn: { x: cx(15), y: cy(16) },
    gateways: [],
    doors: [
      door(14, 18, hostId, hostSpawn, hostLabel, 2),
    ],
    // Phase 10: lanterns flank the entryway door inside.
    props: [prop('lantern', 12, 17), prop('lantern', 17, 17), prop('rug', 15, 15)],
    seats,
    areas: [
      area('Poker Floor', 1, 1, 14, 17),
      area('The Slots', 15, 1, 14, 10),
      area('The Bar', 1, 14, 9, 5),
      area('The Foyer', 10, 14, 12, 5),
    ],
    casino: {
      id: `${id}-casino`,
      mapId: id,
      label: name,
      x: 0, y: 0, w: W * TILE, h: H * TILE,
      floor, floorAlt, wall,
      tables,
      slots,
      bar: { x: cx(5), y: cy(16) }, // patron spot in front of the counter
      bartender: { x: cx(5), y: cy(18), name: bartender.name, look: bartender.look },
    },
  };
}

function buildCasinoLounge() {
  return buildCasino({
    id: 'casino-lounge', name: 'Casino Lounge',
    // hostSpawn is where the door back LANDS in the bay: one tile
    // EAST of the door pad (the pad is tile (15,37)). Landing ON the
    // pad would bounce the player straight back inside the moment
    // the portal debounce lapses and they take a step.
    hostId: 'solstice-bay', hostLabel: 'Solstice Bay', hostSpawn: { x: cx(16), y: cy(37) },
    floor: CASINO_FLOOR, floorAlt: CASINO_FLOOR_ALT, wall: CASINO_WALL,
    bartender: {
      name: 'Salty Sam',
      look: {
        gender: 'M', face: 'classic', eyes: 'round', eye_color: '#20242c', nose: 'button', lips: 'smirk',
        skin_tone: '#8d5524', hair_style: 'short', hair_color: '#111111', top_style: 'button-up',
        body_color: '#22242c', bottom_style: 'pants', accent_color: '#2b3a55', shoe_color: '#23262b', accessory: 'none',
      },
    },
  });
}

function buildNeonCasino() {
  return buildCasino({
    id: 'neon-casino', name: 'Neon Casino',
    hostId: 'neon-district', hostLabel: 'Neon District', hostSpawn: { x: cx(61), y: cy(28) },
    floor: NEON_CASINO_FLOOR, floorAlt: NEON_CASINO_FLOOR_ALT, wall: NEON_CASINO_WALL,
    bartender: {
      name: 'Vex',
      look: {
        gender: 'F', face: 'sharp', eyes: 'lash', eye_color: '#1e4d8f', nose: 'tiny', lips: 'bold',
        skin_tone: '#f1c27d', hair_style: 'ponytail', hair_color: '#ff2e88', top_style: 'tank',
        body_color: '#17102b', bottom_style: 'leggings', accent_color: '#23232e', shoe_color: '#ffd23f', accessory: 'sunglasses',
      },
    },
  });
}

// ------------------------------------------------------------------
// HOOKAH LOUNGE — a small interior off Cinder Mesa (Phase B
// amendment). Four hookah stations, two seats each: sit down, then
// interact to take a puff (5z). The door back is on the south wall.
// ------------------------------------------------------------------
function buildHookahLounge() {
  const W = 20, H = 14;
  const g = makeGrid(W, H, '.');
  setBorder(g, W, H, '#');
  g[2][2] = '|'; g[2][17] = '|'; g[11][2] = '|'; g[11][17] = '|'; // plants
  g[1][10] = '#'; // Phase 10: the hearth niche (north wall, centre)
  const id = 'hookah-lounge';
  const stations = [[5, 4], [14, 4], [5, 9], [14, 9]];
  const seats = [];
  stations.forEach(([tx, ty], i) => {
    seats.push(seat(id, i * 2 + 1, tx - 1, ty, 'right', 'hookah'));
    seats.push(seat(id, i * 2 + 2, tx + 1, ty, 'left', 'hookah'));
  });
  return {
    id, name: 'Hookah Lounge', tiles: gridOf(g), tileSize: TILE,
    floor: '#3d2b1f', floorAlt: '#37271c', wall: '#241610',
    spawn: { x: cx(10), y: cy(11) },
    gateways: [],
    doors: [
      door(9, 12, 'cinder-mesa', { x: cx(30), y: cy(30) }, 'Cinder Mesa', 2),
    ],
    props: [
      prop('hearth', 10, 1),
      prop('stringlights', 10, 6),
    ],
    seats: [
      ...seats,
      // Phase 10: hearth-side seats facing the fire (north).
      seat(id, 9, 9, 2, 'up', 'chair'),
      seat(id, 10, 11, 2, 'up', 'sofa'),
    ],
    areas: [area('The Hearth Corner', 6, 0, 8, 4), area('The Lounge', 1, 1, 18, 12)],
    hookahs: stations.map(([tx, ty]) => ({ x: cx(tx), y: cy(ty) })),
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
  // Lane C: the fake block-buildings are GONE. Their footprints are
  // dressed ground now — a stone market square at the centre, stone
  // plaza patches where the blocks stood, street bands, and the
  // casino terrace. Only the enterable casino keeps a building.
  setRect(g, 26, 14, 20, 16, 's');      // Market Square stone
  setRect(g, 1, 11, 70, 2, 'p');        // north street
  setRect(g, 1, 38, 70, 2, 'p');        // south street
  setRect(g, 4, 4, 10, 7, 's');         // ex-block plaza (NW)
  setRect(g, 18, 4, 12, 7, 's');        // ex-block plaza (N)
  setRect(g, 42, 4, 12, 7, 's');        // ex-block plaza (N)
  setRect(g, 58, 4, 10, 7, 's');        // ex-block plaza (NE)
  setRect(g, 4, 16, 12, 9, 's');        // ex-block plaza (W)
  setRect(g, 56, 16, 12, 9, 's');       // ex-block plaza (E)
  setRect(g, 4, 30, 12, 8, 's');        // ex-block plaza (SW)
  setRect(g, 24, 30, 10, 8, 's');       // ex-block plaza (S)
  setRect(g, 40, 30, 8, 8, 's');        // ex-block plaza (S)
  setRect(g, 52, 26, 18, 14, 's');      // casino terrace
  setRect(g, 56, 30, 12, 8, '#');       // the Neon Casino (SE) — the one real building
  g[3][32] = '|'; g[3][39] = '|'; // stage speakers
  for (const [x, y] of [[30, 18], [41, 18], [30, 26], [41, 26], [36, 16]]) g[y][x] = '|'; // market stalls
  // Dressing on the old footprints: trees, planters, stall posts.
  g[6][6] = 'T'; g[9][12] = 'T'; g[5][8] = 'P';
  g[7][24] = '|'; g[7][46] = '|';
  g[9][20] = 'T'; g[5][50] = 'T';
  g[20][6] = 'P'; g[23][6] = 'P'; g[24][12] = 'T';
  g[18][58] = 'T'; g[22][64] = 'T'; g[20][66] = 'P';
  g[33][10] = '|'; g[34][28] = 'T'; g[33][44] = 'P';
  g[13][36] = '#';                      // the great sign's plinth (hero)
  gatehouseWalls(g, 35, 43, 'S');
  const id = 'neon-district';
  return {
    id, name: 'Neon District', tiles: gridOf(g), tileSize: TILE,
    floor: '#17102b', floorAlt: '#1e1438', wall: '#ff2e88',
    spawn: { x: cx(36), y: cy(41) },
    gateways: [arch(35, 43, 'the-gateway', 'The Gateway', 'S', 41)],
    buildings: [
      building(56, 30, 12, 8, 'Neon Casino', 'neon'),
    ],
    doors: [
      // The SE block (tiles 56..67, 30..37) is the Neon Casino —
      // its door sits on the block's north face.
      door(61, 29, 'neon-casino', { x: cx(15), y: cy(16) }, 'Neon Casino'),
    ],
    props: [
      prop('lantern', 60, 28),
      // The hero: a giant glowing NEON sign over the market square.
      prop('neonsign', 36, 13),
      // A market-square nook: rug + lamp + string lights over the stalls.
      prop('rug', 36, 22), prop('lamp', 32, 22), prop('stringlights', 36, 20),
      // Stalls on their posts (Lane C).
      prop('stall', 30, 18), prop('stall', 41, 26), prop('stall', 24, 7), prop('stall', 10, 33),
      prop('flowers', 30, 15), prop('flowers', 42, 28),
    ],
    stage: stageDef(33, 3),
    areas: [
      area('Stage Grounds', 29, 1, 14, 9),
      area('Market Square', 26, 14, 20, 16),
      area('Casino Row', 52, 26, 18, 14),
    ],
    seats: [
      seat(id, 1, 20, 13, 'down', 'bench'),
      seat(id, 2, 50, 13, 'down', 'bench'),
      seat(id, 3, 34, 20, 'down', 'cafe'),
      seat(id, 4, 38, 24, 'up', 'cafe'),
      seat(id, 5, 24, 22, 'right', 'chair'),
      // Phase 10: the market nook sofas, facing each other.
      seat(id, 6, 33, 22, 'right', 'sofa'),
      seat(id, 7, 39, 22, 'left', 'sofa'),
    ],
  };
}

// CINDER MESA — ember forge country: scattered rock clusters, a
// forge plaza west-center, stage on the east rim, arch south-west.
function buildCinderMesa() {
  const W = 72, H = 45;
  const g = cityShell(W, H);
  // Lane C: the rock clusters were box-rects — now scattered 'R'
  // boulders (solid, but they read as rocks, not buildings).
  for (const [x, y] of [
    [6, 6], [8, 6], [7, 7], [9, 8], [6, 8],
    [20, 4], [22, 5], [24, 4],
    [50, 5], [52, 6], [54, 5], [55, 7],
    [62, 14], [64, 15], [63, 17], [65, 16],
    [8, 20], [10, 21], [12, 22], [9, 22],
    [16, 32], [18, 33], [20, 34], [17, 34],
    [56, 32], [58, 33], [60, 35], [57, 35],
    [30, 14], [32, 15],
    [36, 36], [38, 37],
    [10, 36], [12, 37], [11, 38],
    [24, 20], [24, 21],
  ]) g[y][x] = 'R';
  setRect(g, 24, 17, 9, 12, 's');   // Forge Plaza stone
  setRect(g, 27, 29, 7, 3, 's');    // Hookah Corner doorstep terrace
  setRect(g, 4, 40, 24, 1, 'p');    // south path from the gatehouse
  g[21][62] = '|'; g[21][69] = '|'; // stage speakers
  g[18][28] = '|'; g[24][28] = '|'; // forge posts
  g[21][28] = 'R';                  // the forge monument's stone base (hero)
  g[20][24] = 'R'; g[21][24] = 'R'; // plaza-edge boulders (after the stone fill)
  gatehouseWalls(g, 3, 43, 'S');
  setRect(g, 26, 32, 9, 6, '#');    // the Hookah Lounge building (S-centre) — a facade now
  const id = 'cinder-mesa';
  return {
    id, name: 'Cinder Mesa', tiles: gridOf(g), tileSize: TILE,
    floor: '#c47b3a', floorAlt: '#bb7031', wall: '#6e2418',
    spawn: { x: cx(4), y: cy(41) },
    gateways: [arch(3, 43, 'the-gateway', 'The Gateway', 'S', 41)],
    buildings: [
      building(26, 32, 9, 6, 'Hookah Lounge', 'hookah'),
    ],
    doors: [
      door(30, 31, 'hookah-lounge', { x: cx(10), y: cy(11) }, 'Hookah Lounge'),
    ],
    props: [
      prop('lantern', 29, 30),
      // The hero: the great forge between its posts, embers lit.
      prop('forge', 28, 21),
      // A forge-plaza nook: rug + lamp to sit by.
      prop('rug', 28, 22), prop('lamp', 26, 21),
    ],
    stage: stageDef(63, 21),
    areas: [
      area('Forge Plaza', 20, 15, 16, 14),
      area('Stage Rim', 58, 17, 13, 10),
      area('Hookah Corner', 24, 29, 16, 12),
    ],
    seats: [
      seat(id, 1, 58, 20, 'right', 'bench'),
      seat(id, 2, 58, 24, 'right', 'bench'),
      seat(id, 3, 24, 24, 'down', 'chair'),
      seat(id, 4, 26, 27, 'up', 'cafe'),
      seat(id, 5, 27, 22, 'down', 'sofa'),
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
  // Lane C: the ice blocks were box-rects — now scattered 'R'
  // boulders (tinted icy by the map's wall colour client-side).
  for (const [x, y] of [
    [56, 8], [58, 9], [60, 11], [57, 11],
    [60, 20], [62, 22], [65, 24], [61, 24],
    [8, 30], [10, 31], [12, 32],
    [20, 20], [22, 21],
  ]) g[y][x] = 'R';
  setRect(g, 29, 33, 14, 10, 's');  // Stage Grounds stone
  setRect(g, 35, 5, 2, 15, 'p');    // path south from the gatehouse
  setRect(g, 25, 13, 10, 1, 'p');   // path west to the pond-shore nook
  for (const [x, y] of [[30, 12], [44, 14], [52, 30], [24, 32], [16, 26], [66, 12], [34, 26]]) g[y][x] = 'T'; // pines
  g[37][32] = '|'; g[37][39] = '|'; // stage speakers
  g[7][47] = '#';                   // the ice sculpture's plinth (hero)
  gatehouseWalls(g, 35, 1, 'N');
  const id = 'frosthaven';
  return {
    id, name: 'Frosthaven', tiles: gridOf(g), tileSize: TILE,
    floor: '#d7edf7', floorAlt: '#c6e3f2', wall: '#2f5d8a',
    spawn: { x: cx(36), y: cy(4) },
    gateways: [arch(35, 1, 'the-gateway', 'The Gateway', 'N', 3)],
    doors: [],
    props: [
      // The hero: a great ice sculpture on its plinth, NE grounds.
      prop('icesculpt', 47, 7),
      // A pond-shore nook: rug, lamp, and string lights in the cold.
      prop('rug', 24, 13), prop('lamp', 23, 13), prop('stringlights', 24, 12),
      prop('lantern', 34, 32),
    ],
    stage: stageDef(33, 37),
    areas: [
      area('The Frozen Pond', 2, 2, 20, 10),
      area('Stage Grounds', 29, 33, 14, 10),
    ],
    seats: [
      seat(id, 1, 30, 34, 'down', 'bench'),
      seat(id, 2, 42, 34, 'down', 'bench'),
      seat(id, 3, 22, 8, 'left', 'chair'),
      seat(id, 4, 48, 34, 'down', 'cafe'),
      seat(id, 5, 24, 14, 'up', 'sofa'),
    ],
  };
}

// VERDANT HOLLOW — firefly grove: dense tree clusters around a
// central clearing with the stage at its heart; pond to the south,
// return arch in the south-east corner.
function buildVerdantHollow() {
  const W = 72, H = 45;
  const g = cityShell(W, H);
  // Lane C: the tree-cluster rects were solid post-blocks — now
  // scattered 'T' trees (solid trunks, real canopies client-side).
  for (const [x, y] of [
    [4, 4], [6, 5], [8, 4], [5, 7], [7, 6],
    [14, 3], [16, 4], [15, 5],
    [24, 5], [26, 6], [25, 7],
    [44, 4], [46, 5], [48, 6], [45, 7],
    [56, 3], [58, 4], [60, 3], [61, 5],
    [64, 8], [66, 9], [65, 11], [67, 10],
    [4, 16], [6, 18], [5, 20], [7, 17],
    [64, 18], [66, 19], [68, 21], [65, 21],
    [8, 28], [10, 29], [9, 31], [11, 30],
    [56, 28], [58, 29], [60, 30], [57, 31],
    [20, 32], [22, 33], [21, 34],
    [44, 33], [46, 34], [45, 35],
  ]) g[y][x] = 'T';
  setRect(g, 44, 40, 23, 1, 'p');   // path west from the gatehouse
  setRect(g, 43, 29, 1, 11, 'p');   // path north to the pond shore
  setRect(g, 30, 37, 10, 5, '%');
  g[21][32] = '|'; g[21][39] = '|'; // stage speakers
  g[15][28] = 'P';                  // the Great Tree's root planter (hero)
  gatehouseWalls(g, 66, 43, 'S');
  const id = 'verdant-hollow';
  return {
    id, name: 'Verdant Hollow', tiles: gridOf(g), tileSize: TILE,
    floor: '#2e5d33', floorAlt: '#26502b', wall: '#4a3520',
    spawn: { x: cx(67), y: cy(41) },
    gateways: [arch(66, 43, 'the-gateway', 'The Gateway', 'S', 41)],
    doors: [],
    props: [
      // The hero: the Great Tree at the clearing's NW shoulder.
      prop('greattree', 28, 15),
      // A grove nook south of the stage: rug, lamp, firefly bulbs.
      prop('rug', 36, 28), prop('lamp', 33, 28), prop('stringlights', 36, 19),
      // Flower drifts around the clearing and the pond shore.
      prop('flowers', 31, 24), prop('flowers', 41, 24), prop('flowers', 36, 33), prop('flowers', 60, 38),
    ],
    stage: stageDef(33, 21),
    areas: [
      area('The Clearing', 29, 17, 14, 12),
      area('The Pond Shore', 28, 35, 14, 8),
    ],
    seats: [
      seat(id, 1, 28, 25, 'up', 'bench'),
      seat(id, 2, 44, 25, 'up', 'bench'),
      seat(id, 3, 12, 12, 'down', 'chair'),
      seat(id, 4, 58, 12, 'down', 'chair'),
      seat(id, 5, 36, 27, 'up', 'cafe'),
      seat(id, 6, 34, 28, 'up', 'sofa'),
    ],
  };
}

const MAPS = {};
for (const def of [
  buildGateway(), buildCafe(), buildSolsticeBay(), buildCasinoLounge(),
  buildNeonDistrict(), buildNeonCasino(), buildCinderMesa(), buildHookahLounge(),
  buildFrosthaven(), buildVerdantHollow(),
]) {
  MAPS[def.id] = def;
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

const WALKABLE = new Set(['.', 'C', 'b', 's', 'p']); // open ground, casino floor, boardwalk, stone, path

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
      x: g.x, y: g.y, w: g.w, h: g.h, label: g.label, dir: g.dir,
      active: Boolean(MAPS[g.target]),
    })),
    buildings: (map.buildings || []).map(b => ({ ...b })),
    doors: (map.doors || []).map(d => ({
      x: d.x, y: d.y, w: d.w, h: d.h, label: d.label,
      home: d.target === 'studio:self',
    })),
    props: (map.props || []).map(p => ({ kind: p.kind, x: p.x, y: p.y })),
    seats: (map.seats || []).map(s => ({ id: s.id, x: s.x, y: s.y, dir: s.dir, kind: s.kind })),
    areas: (map.areas || []).map(a => ({ ...a })),
    hookahs: (map.hookahs || []).map(h => ({ x: h.x, y: h.y })),
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
      bar: map.casino.bar || null,
      bartender: map.casino.bartender || null,
    } : null,
  };
}

module.exports = { TILE, MAPS, collides, gatewayAt, doorAt, clientMap };
