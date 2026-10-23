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
 * plaza, 'p'=path (all walkable). v1.4.1 (seat audit): 'B'=bar
 * counter (solid) — a counter is FLOOR-LEVEL furniture in the
 * render (a flat top + short skirt, like a table), never an
 * extruded wall cube: a stool one tile away of a WALL_H counter
 * lands its cushion on the counter's raised top face in screen
 * space ("chairs ON the bar"). Bar counters are 'B' by law
 * (see scripts/validate-dressing.mjs, SEAT FOOTPRINT LAW). Gateways are GATEHOUSES now: a
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
 * outside the passage mouth, a full tile BEYOND the flank-tower line
 * (spawnOutTy = tower row ± 2). That clearance matters: with the
 * doorstep only one tile out, a traveller leaving the gatehouse
 * diagonally (e.g. NE toward the next arch) clips the tower's inner
 * corner, gets deflected along its face, and grazes the trigger
 * rect's own corner — bouncing straight back through the gatehouse
 * they just exited. One more tile of clearance makes diagonal
 * departures pass clear of the towers entirely.
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
/**
 * A stage complex (v1.1; v1.2 Item B): the platform AND the pit
 * are exactly as WIDE as the audience seating block behind them
 * (the 5-row × 4 grid spans 10 tiles incl. its spacing), 3 tiles
 * deep, speakers at the two FRONT corners, standing PIT on the
 * audience side. `facing` says where the audience is: 'S'
 * (default), 'N', or 'W'. For 'W' the complex rotates: 3 deep in
 * x, 10 wide in y — the width rule holds on the audience axis.
 * The 20 audience chairs behind the pit are ordinary seats, added
 * per city via audienceSeats().
 */
function stageDef(tx, ty, facing = 'S') {
  const w = TILE * 10, h = TILE * 3;
  let pit, speakers;
  if (facing === 'N') {
    pit = { x: px(tx), y: px(ty - 3), w, h: TILE * 3 };
    speakers = [{ x: cx(tx - 1), y: cy(ty) }, { x: cx(tx + 10), y: cy(ty) }];
  } else if (facing === 'W') {
    pit = { x: px(tx - 3), y: px(ty), w: TILE * 3, h: TILE * 10 };
    speakers = [{ x: cx(tx - 1), y: cy(ty) }, { x: cx(tx - 1), y: cy(ty + 9) }];
    return { x: px(tx), y: px(ty), w: TILE * 3, h: TILE * 10, pit, speakers };
  } else {
    pit = { x: px(tx), y: px(ty + 3), w, h: TILE * 3 };
    speakers = [{ x: cx(tx - 1), y: cy(ty + 2) }, { x: cx(tx + 10), y: cy(ty + 2) }];
  }
  return { x: px(tx), y: px(ty), w, h, pit, speakers };
}

/** v1.1: 20 audience chairs — 5 rows of 4 facing the stage.
 *  v1.5.1: kind 'audience', NOT 'chair'. The generic table-chair
 *  art (drawChairAt) reads fine at a table, but in a 20-seat block
 *  seen from behind its panel-filled back + wide cushion merged
 *  into a crate on a red pad — Zan circled it ten times ("old
 *  chair models... those chairs all gotta go; the others are
 *  fine"). Audience seats get their own draw path in the client
 *  (drawAudienceChairAt): arched slatted back with real gaps,
 *  four visible legs, same cushion — a chair, not a box. The
 *  validator's sprite-path law pins this kind to these seats. */
function audienceSeats(id, startN, cols, rows, dir) {
  const out = [];
  let n = startN;
  for (const ty of rows) for (const tx of cols) out.push(seat(id, n++, tx, ty, dir, 'audience'));
  return out;
}
/** A sittable spot. dir = the way the sitter faces. */
function seat(mapId, n, tx, ty, dir, kind) {
  return { id: `${mapId}-seat-${n}`, x: cx(tx), y: cy(ty), dir, kind };
}
/**
 * Fishing geography (v1.2, Item O): there are NO fixed spots and
 * no rod stands anymore. A map opts in with `fishable: true` on
 * its def (plus `frozen: true` for ice fishing), and the server
 * validates casts by WATER ADJACENCY — the player stands next to
 * a '%' water/ice tile, anywhere along the bank. See
 * game.fishingContext.
 */
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
// the Gateway Café building in the south-east (door on its FRONT,
// south face since v1.2.2 Item 8; shifted north off the map edge
// in v1.2.3). Benches ring the fountain; composed terrace table
// sets flank the café's front door.
// ------------------------------------------------------------------
function buildGateway() {
  const W = 72, H = 45;
  const g = makeGrid(W, H, '.');
  setBorder(g, W, H, '#');
  // Lane C ground zoning: stone plaza at the centre, stone under
  // the café corner + south market + the two market terraces.
  setRect(g, 28, 15, 16, 14, 's');  // Fountain Plaza stone
  setRect(g, 54, 28, 16, 16, 's');  // Café Corner stone (v1.2.3: plaza under the shifted café, its terrace, and the open margin to the map edge)
  setRect(g, 6, 32, 20, 10, 's');   // South Market stone
  setRect(g, 3, 4, 6, 6, 's');      // NW market terrace
  setRect(g, 63, 4, 6, 6, 's');     // NE market terrace
  setRect(g, 65, 18, 4, 9, 's');    // E terrace
  // Dirt paths run south from every gatehouse mouth to the plaza.
  for (const tx of [6, 20, 34, 48, 62]) setRect(g, tx, 4, 2, 11, 'p');
  setRect(g, 3, 18, 4, 9, '#');   // the Homes building (W) — a facade now
  setRect(g, 33, 20, 6, 3, '%');  // fountain
  // v1.3.1 (Item 12): the South Market patch is a POND now — a
  // rounded water shape (the old lone stall + confetti specks that
  // sat pointless in open stone are gone, post tiles included).
  // Gateway is not a fishable map: the pond is scenery, fishing
  // rules unchanged. Tree clusters dress its four corners.
  setRect(g, 11, 34, 11, 5, '%');
  for (const [wx, wy] of [[10, 35], [10, 36], [10, 37], [22, 35], [22, 36], [22, 37], [13, 39], [19, 39]]) g[wy][wx] = '%';
  g[34][7] = 'T'; g[33][8] = 'T';   // NW cluster
  g[34][24] = 'T'; g[33][25] = 'T'; // NE cluster
  g[39][7] = 'T'; g[40][8] = 'T';   // SW cluster
  g[39][24] = 'T'; g[40][25] = 'T'; // SE cluster
  // Market terraces: stall posts + trees instead of the old blocks.
  g[6][5] = '|'; g[6][64] = '|';
  g[8][7] = 'T'; g[8][66] = 'T';
  g[4][8] = 'T'; g[9][3] = 'T'; g[4][64] = 'T'; g[9][68] = 'T';
  // E terrace dressing: trees where the E block stood.
  g[19][66] = 'T'; g[25][68] = 'T'; g[22][65] = 'T';
  // Plaza shade trees.
  g[14][12] = 'T'; g[14][60] = 'T'; g[31][24] = 'T'; g[31][48] = 'T';
  setRect(g, 57, 27, 12, 9, '#'); // the Gateway Café building (SE) — a facade now (v1.2.3 Item 3: shifted north, off the map edge)
  // Gatehouse flank towers for the five north arches.
  for (const tx of [6, 20, 34, 48, 62]) gatehouseWalls(g, tx, 1, 'N');
  const id = 'the-gateway';
  return {
    id, name: 'The Gateway', tiles: gridOf(g), tileSize: TILE,
    floor: '#2e3a52', floorAlt: '#33415c', wall: '#10151f',
    spawn: { x: cx(36), y: cy(28) },
    gateways: [
      arch(6, 1, 'neon-district', 'Neon District', 'N', 4),
      arch(20, 1, 'cinder-mesa', 'Cinder Mesa', 'N', 4),
      arch(34, 1, 'solstice-bay', 'Solstice Bay', 'N', 4),
      arch(48, 1, 'frosthaven', 'Frosthaven', 'N', 4),
      arch(62, 1, 'verdant-hollow', 'Verdant Hollow', 'N', 4),
    ],
    buildings: [
      building(3, 18, 4, 9, 'Homes', 'home'),
      building(57, 27, 12, 9, 'Gateway Café', 'cafe'),
    ],
    doors: [
      // v1.2.2 (Item 8 — doors front-facing): the café door sits
      // on the FRONT (south) face, centred on the camera-facing
      // wall, terrace in front. v1.2.3 (Item 3): the whole building
      // shifted north off the map edge; the door — and the landing
      // inside the bigger café — moved with it.
      door(62, 36, 'gateway-cafe', { x: cx(16), y: cy(16) }, 'Gateway Café'),
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
      // v1.3.1 (Items 4/5): the purposeless rug + lamp + string-light
      // cluster that floated in open ground south of the fountain is
      // GONE — seasonal/scatter props anchor to features now
      // (validator-enforced). The fountain keeps its ring of chairs
      // and the jack-o'-lanterns flanking its south face.
      // Café terrace (v1.2.3, Item 4): ONE composed arrangement
      // set to the SIDES of the door — a round-table set west and
      // east of the doorstep, string lights strung over each table
      // (never across the doorway), a lamp at each terrace end.
      // The doorstep itself — door tile, landing, a tile each
      // side — stays fully clear; the old scatter of pads, discs
      // and lights at the doorway is gone.
      prop('table', 57, 38), prop('table', 67, 38),
      prop('stringlights', 57, 38), prop('stringlights', 67, 38),
      prop('lamp', 55, 38), prop('lamp', 69, 38),
      // Market stalls on their posts (Lane C) — only the two
      // gatehouse-anchored terrace stalls remain; the lone stall in
      // the open south patch and the café-corner loner are removed
      // (v1.3.1, Items 4/12).
      prop('stall', 5, 6), prop('stall', 64, 6),
      // The pond's dressing (v1.3.1, Item 12): a lamp on each bank
      // and flower beds at the water's corners.
      prop('lamp', 16, 33), prop('lamp', 16, 40),
      prop('flowers', 10, 33), prop('flowers', 22, 33),
      prop('flowers', 10, 40), prop('flowers', 22, 40),
    ],
    areas: [
      area('The Arches', 2, 0, 68, 4),
      area('Fountain Plaza', 28, 15, 16, 14),
      area('Homes Corner', 0, 16, 13, 12),
      area('Café Corner', 54, 25, 16, 18),
      area('The Pond', 6, 32, 20, 10),
    ],
    seats: [
      // v1.3.1 (Item 11): the fountain ring is CURRENT backed
      // chairs now, not the old flat brown diamond pads — same
      // composed ring, same facings (every chair aims at the water).
      seat(id, 1, 31, 19, 'right', 'chair'),
      seat(id, 2, 31, 23, 'right', 'chair'),
      seat(id, 3, 40, 19, 'left', 'chair'),
      seat(id, 4, 40, 23, 'left', 'chair'),
      seat(id, 5, 34, 17, 'down', 'chair'),
      seat(id, 6, 37, 25, 'up', 'chair'),
      // v1.2.3 (Item 4) + v1.3.1 (Item 1): the terrace table sets —
      // four chairs around each round table, pulled OUT to a
      // ~half-tile gap (50px from the table centre, was a full tile
      // ring crammed into the tabletop). The two sets flank the
      // door with the doorstep kept clear between them.
      seat(id, 7, 57, 36.4375, 'down', 'chair'),
      seat(id, 8, 57, 39.5625, 'up', 'chair'),
      seat(id, 9, 55.4375, 38, 'right', 'chair'),
      seat(id, 10, 58.5625, 38, 'left', 'chair'),
      seat(id, 11, 67, 36.4375, 'down', 'chair'),
      seat(id, 12, 67, 39.5625, 'up', 'chair'),
      seat(id, 13, 65.4375, 38, 'right', 'chair'),
      seat(id, 14, 68.5625, 38, 'left', 'chair'),
      // v1.3.1 (Item 12): the pond's north-bank seating nook — two
      // current chairs facing the water over the bank, lamp between.
      seat(id, 15, 14, 33, 'down', 'chair'),
      seat(id, 16, 18, 33, 'down', 'chair'),
      // v1.2 (Item Q rider): the two lone mid-plaza chairs are gone —
      // plaza seating exists only as composed nooks (fountain ring,
      // café corner), never as orphan pads.
    ],
  };
}

// ------------------------------------------------------------------
// GATEWAY CAFÉ — an interior off the hub: serving counter along the
// north wall, THREE 4-seat tables (a chair on every side, facing
// in), a hearth corner on the west wall, and a door on the south
// wall back to the Gateway.
// v1.1.1: enlarged 20x13 -> 26x16. v1.2.3 (SPACE PASS, Items 2/5/
// 7/8): enlarged again to 32x20 and given real breathing room —
// the exit door stands in its own clearing (no table or seat
// within 2 tiles of the door or its landing; the old layout put a
// 4-seat table right beside it), the hearth arc is SPACED with a
// clear gap between every seat and every seat AIMED at the fire,
// table groups keep >=2 clear tiles between their chair rings,
// and the floor inside the door stays open as congregation space.
// ------------------------------------------------------------------
function buildCafe() {
  const W = 32, H = 20;
  const g = makeGrid(W, H, '.');
  setBorder(g, W, H, '#');
  setRect(g, 3, 2, 26, 1, 'B');   // serving counter (north wall) — 'B': counters are flat (v1.4.1 seat audit)
  // v1.2 (Item K rider): the two south-corner post cubes are gone —
  // they rendered as stray crate boxes in the café corners.
  g[10][1] = '#';                  // Phase 10: the hearth niche (west wall, centred)
  const id = 'gateway-cafe';
  // 4-seat tables at (13,7), (21,7), (20,13): one chair per side.
  // The southern table stands well east of the door's clearing.
  // v1.3.1 (Item 1): chairs pulled OUT to 50px from the table
  // centre (fractional tiles) — a visible ~half-tile gap between
  // chair and table edge; the old full-tile ring left sitters "in
  // the tables" and the up-facing chair backs blended into the
  // tabletop. The validator enforces the [46,58]px band.
  const tableChairs = [];
  for (const [tx, ty] of [[13, 7], [21, 7], [20, 13]]) {
    tableChairs.push(
      [tx, ty - 1.5625, 'down'], [tx, ty + 1.5625, 'up'],
      [tx - 1.5625, ty, 'right'], [tx + 1.5625, ty, 'left'],
    );
  }
  return {
    id, name: 'Gateway Café', tiles: gridOf(g), tileSize: TILE,
    floor: '#4a3226', floorAlt: '#443022', wall: '#2e1d12',
    spawn: { x: cx(16), y: cy(16) },
    gateways: [],
    doors: [
      // v1.2.3: the Gateway-side landing follows the (shifted) café
      // door — you step out onto the terrace's clear doorstep.
      door(15, 18, 'the-gateway', { x: cx(62), y: cy(37) }, 'The Gateway', 2),
    ],
    props: [
      prop('hearth', 1, 10),
      prop('stringlights', 16, 3),
      prop('lantern', 28, 4),
      // v1.2.2 (Item 4): a hearth rug under the fire seats' arc.
      prop('rug', 3, 10),
      // The tables themselves (v1.1.1): drawn furniture, chairs are seats.
      prop('table', 13, 7), prop('table', 21, 7), prop('table', 20, 13),
    ],
    areas: [area('The Hearth Corner', 0, 5, 9, 11), area('The Café', 1, 1, 30, 18)],
    seats: [
      ...tableChairs.map(([x, y, dir], i) => seat(id, i + 1, x, y, dir, 'chair')),
      // v1.2.3 (Item 7 — hearth seating done right): FIVE seats in
      // a SPACED arc — a clear gap between every pair, the arc set
      // back from the fire with the rug in front of it, a walkway
      // behind it, and EVERY seat facing the fireplace (west).
      // Sofa at the centre; the end chairs step one tile east,
      // opening the arc toward the fire.
      // v1.3.1 (Item 2): the arc FANS in SCREEN space — facing is
      // screen-space since v1.1, and the southern chairs stored as
      // 'left' actually presented their backs ~90° off the fire in
      // the render (screen-bearing dot 0 / −0.22). The fan is now
      // left,left,left,up,up with every seat's screen bearing to
      // the hearth ≥ 0.89 — validator-enforced.
      seat(id, 13, 5, 5, 'left', 'chair'),
      seat(id, 14, 4, 7, 'left', 'chair'),
      seat(id, 15, 4, 10, 'left', 'sofa'),
      seat(id, 16, 4, 13, 'up', 'chair'),
      seat(id, 17, 5, 15, 'up', 'chair'),
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
  g[8][32] = '|'; g[8][43] = '|';       // stage speakers (v1.1: front corners of the bigger stage)
  // v1.2 (Item Q): one post per stall prop; the extra bare cubes
  // (7,12)/(65,12) and the mystery pair at (36,30) are gone — the
  // volleyball net stands at (36,30) now (Item L).
  for (const [x, y] of [[6, 12], [64, 12]]) {
    g[y][x] = '|';                      // boardwalk stalls
  }
  g[26][10] = 'P'; g[26][62] = 'P';     // planters where stall posts stood
  g[5][3] = '#';                        // the lighthouse plinth (hero)
  g[32][23] = 'T'; g[33][49] = 'T';     // palms where the beach huts stood
  // v1.2 (Item L): palm clusters around the two beach planters.
  g[25][9] = 'T'; g[27][11] = 'T'; g[25][61] = 'T'; g[27][63] = 'T';
  gatehouseWalls(g, 35, 43, 'S');
  setRect(g, 3, 33, 12, 10, '#');       // the Casino building (SW) — a facade now
  const id = 'solstice-bay';
  return {
    id, name: 'Solstice Bay', tiles: gridOf(g), tileSize: TILE,
    floor: '#e8cf9a', floorAlt: '#e2c588', wall: '#2b6f8f',
    spawn: { x: cx(36), y: cy(41) },
    gateways: [arch(35, 43, 'the-gateway', 'The Gateway', 'S', 40)],
    buildings: [
      building(3, 33, 12, 10, 'Casino Lounge', 'casino'),
    ],
    doors: [
      door(15, 37, 'casino-lounge', { x: cx(17), y: cy(20) }, 'Casino Lounge'),
    ],
    props: [
      prop('lantern', 16, 36), prop('lantern', 16, 38),
      // The lighthouse keeps the bay's north-west shore (hero).
      prop('lighthouse', 3, 5),
      // A boardwalk nook WEST of the venue (v1.2 Items I/L/M: it
      // used to sit ON the front seat rows — venue purity now).
      prop('rug', 25, 15), prop('lamp', 24, 14), prop('stringlights', 25, 13),
      // Stalls on the boardwalk posts.
      prop('stall', 6, 12), prop('stall', 64, 12),
      // Planter colour beside the two boardwalk stalls.
      prop('flowers', 8, 11), prop('flowers', 62, 11),
      // v1.2 (Item L) + v1.3.1 (Item 13): beach life — a volleyball
      // net mid-sand and FOUR umbrella+towel units in an even row
      // flanking the court (8-tile spacing, the court is the middle
      // gap). The umbrellas render BIG now and each towel is a real
      // seat you can LAY DOWN on.
      prop('volleyball', 36, 30),
      prop('umbrella', 19, 32), prop('umbrella', 27, 32),
      prop('umbrella', 43, 32), prop('umbrella', 51, 32),
    ],
    stage: stageDef(33, 6, 'S'),
    areas: [
      area('The Stage', 29, 4, 14, 6),
      area('The Boardwalk', 8, 10, 56, 12),
      area('The Beach', 16, 24, 40, 16),
      area('Casino Corner', 1, 31, 16, 12),
    ],
    seats: [
      // v1.3.1 (Item 5): the four lone boardwalk chairs and the two
      // café-booth seats are GONE — seats exist only in registered
      // arrangements now. The two benches flanking the venue stay
      // (venue-flank pair, registered in the validator).
      seat(id, 5, 28, 10, 'up', 'bench'),
      seat(id, 6, 44, 10, 'up', 'bench'),
      // v1.3.1 (Item 13): the beach towels — lying seats, one per
      // umbrella unit, just south of their umbrella poles.
      seat(id, 7, 20, 33, 'down', 'towel'),
      seat(id, 8, 28, 33, 'down', 'towel'),
      seat(id, 9, 44, 33, 'down', 'towel'),
      seat(id, 10, 52, 33, 'down', 'towel'),
      // v1.1: stage audience — pit rows 9-11, then 5 rows of 4 chairs.
      // v1.3.1 (Item 3 — UNIFORM VENUE GEOMETRY): every venue's stage
      // stands against its back wall with the audience facing
      // straight at it ('up', toward the north stage) — the old
      // per-venue profile-row exceptions are abolished.
      ...audienceSeats(id, 101, [33, 36, 39, 42], [13, 15, 17, 19, 21], 'up'),
    ],
  };
}

// ------------------------------------------------------------------
// CASINOS (Phase B amendment) — poker lives in exactly TWO grand
// casino interiors: the Casino Lounge off Solstice Bay and the Neon
// Casino off Neon District. One shared floor plan at 36x24 tiles
// (30x20 until v1.2.3's SPACE PASS — wider aisles everywhere, and
// the foyer inside the door is open congregation floor):
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
  const W = 36, H = 24;
  const g = makeGrid(W, H, 'C');
  setBorder(g, W, H, 'W');
  setRect(g, 2, 21, 9, 1, 'B'); // bar counter (bartender stands behind it) — 'B', not 'W': counters are flat (v1.4.1 seat audit)
  // v1.3.1 (Item 7): poker chairs pulled OUT to 60px from the
  // table centre — the old 44px ring tucked the cushions half
  // under the felt edge. Validator band: [55,66]px.
  const chairSet = (x, y) => [
    { dir: 'N', x, y: y - 60 },
    { dir: 'E', x: x + 60, y },
    { dir: 'S', x, y: y + 60 },
    { dir: 'W', x: x - 60, y },
  ];
  const tableAt = (n, tx, ty) => ({
    id: `${id}-poker-${n}`, game: 'poker', x: cx(tx), y: cy(ty), chairs: chairSet(cx(tx), cy(ty)),
  });
  const tables = [
    tableAt(1, 5, 5), tableAt(2, 12, 5),
    tableAt(3, 5, 11),
    // v1.5 (Zan, live playtest 2026-10-22): "make a couple tables
    // black jack instead" — ONE table per casino converts: the
    // centre-east table (#4 spot, middle row, east column) in BOTH
    // lounges (shared floor plan, so the conversion is symmetric).
    // Same chairs at the same spots (seat laws untouched); the id
    // and game type are what change.
    { id: `${id}-blackjack-1`, game: 'blackjack', x: cx(12), y: cy(11), chairs: chairSet(cx(12), cy(11)) },
    tableAt(5, 5, 17), tableAt(6, 12, 17),
  ];
  // Slots section: 5 machines along the north wall + 5 down the east
  // wall. (ix, iy) is the stool spot you sit on to play.
  const slots = [];
  for (let i = 0; i < 5; i++) {
    const tx = 19 + i * 2;
    slots.push({
      id: `${id}-slot-${i + 1}`, seatId: `${id}-slotseat-${i + 1}`,
      // v1.4.1 (seat audit): the stool sits 70px south of the
      // cabinet centre (was 42 — in SCREEN space the stool's back
      // panel clipped the cabinet's bottom corner by ~6x7px; the
      // v1.3.1 validator modelled the cushion at half its drawn
      // size and passed it). Screen-space law now: the stool's
      // whole art bbox must clear the cabinet's rect.
      x: cx(tx), y: cy(2) - 10, ix: cx(tx), iy: cy(3) + 28,
    });
  }
  for (let i = 0; i < 5; i++) {
    const ty = 5 + i * 2;
    slots.push({
      id: `${id}-slot-${i + 6}`, seatId: `${id}-slotseat-${i + 6}`,
      // v1.4.1 (seat audit): the east-row stool sits 64px west +
      // 16px south of the cabinet centre (v1.3.1: 52px due west —
      // in screen space a due-west offset RISES 0.36px per px into
      // the cabinet's 52px-tall body, and the stool's 60px-wide
      // cushion painted over the machine: "chairs on top of slot
      // machines"). The southward step keeps the stool at the
      // machine's front, the westward step clears its rect.
      x: cx(34), y: cy(ty), ix: cx(34) - 64, iy: cy(ty) + 16,
    });
  }
  const seats = [
    // slot stools (sit to spin): north row faces up, east row faces right
    ...slots.slice(0, 5).map((s, i) => ({ id: s.seatId, x: s.ix, y: s.iy, dir: 'up', kind: 'stool' })),
    ...slots.slice(5).map((s) => ({ id: s.seatId, x: s.ix, y: s.iy, dir: 'right', kind: 'stool' })),
    // (v1.6: NO bar stools — Zan's order, game-wide. Patrons STAND
    // at the counter; the drink flow is proximity-based and never
    // needed the seat. The validator's bar law now FORBIDS bar
    // stools in bar maps. Slot stools above are machines' seats,
    // not bar chairs — they stay.)
    // foyer sofas — flanking the open congregation floor inside the door
    { id: `${id}-seat-3`, x: cx(24), y: cy(21), dir: 'up', kind: 'sofa' },
    { id: `${id}-seat-4`, x: cx(28), y: cy(21), dir: 'up', kind: 'sofa' },
  ];
  return {
    id, name, tiles: gridOf(g), tileSize: TILE,
    floor, floorAlt, wall,
    spawn: { x: cx(17), y: cy(20) },
    gateways: [],
    doors: [
      door(16, 22, hostId, hostSpawn, hostLabel, 2),
    ],
    // Phase 10: lanterns flank the entryway door inside.
    props: [prop('lantern', 14, 21), prop('lantern', 19, 21), prop('rug', 17, 19)],
    seats,
    areas: [
      area('Poker Floor', 1, 1, 15, 19),
      area('The Slots', 17, 1, 18, 13),
      area('The Bar', 1, 18, 11, 5),
      area('The Foyer', 12, 18, 15, 5),
    ],
    casino: {
      id: `${id}-casino`,
      mapId: id,
      label: name,
      x: 0, y: 0, w: W * TILE, h: H * TILE,
      floor, floorAlt, wall,
      tables,
      slots,
      bar: { x: cx(6), y: cy(20) }, // patron spot in front of the counter
      bartender: { x: cx(6), y: cy(22), name: bartender.name, look: bartender.look },
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
    // v1.2.2 (Item 8): exit landing follows the door to the front face.
    hostId: 'neon-district', hostLabel: 'Neon District', hostSpawn: { x: cx(61), y: cy(39) },
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
// CLUB MIRAGE — the go-go bar off Neon District (v1.4, Zan's spec
// 2026-10-21). A SEPARATE building from the Neon Casino, with its
// own facade on the district's SW block. Inside, built BIG from the
// start (40x26 — the scale rule: "we arent paying for real estate
// here"):
//   - NORTH: three little stages against the back wall, each with
//     a dance pole and a dancer NPC — a platform FIXTURE like the
//     bartenders (she dances on loop; she never wanders).
//   - In front of the stages: six small tables in one even row,
//     two chairs apiece in the 46-58px band (validator law), the
//     south chairs facing the stages over their tables.
//   - CENTRE-SOUTH: an open dance floor (club checker tiles).
//   - SOUTH-WEST: the bar — counter, bartender fixture behind it,
//     two stools; drinks are 5z from the shared vice model.
//   - SOUTH-EAST: the 2-wide door back to Neon District, foyer
//     kept clear as congregation space (door/landing law).
// Tipping a dancer is a pure z SINK (she's an NPC — nobody is
// credited): src/club.js owns the interaction.
// ------------------------------------------------------------------
function clubDancer(n, tx, name, look) {
  return {
    id: `club-mirage-dancer-${n}`,
    name,
    x: px(tx) + TILE * 3, y: cy(2),
    look,
  };
}
function clubStage(n, tx, dancer) {
  return {
    id: `club-mirage-stage-${n}`,
    x: px(tx), y: px(1), w: TILE * 6, h: TILE * 3,
    pole: { x: px(tx) + TILE * 3, y: cy(2) },
    dancer,
  };
}

function buildClubMirage() {
  const W = 40, H = 26;
  const g = makeGrid(W, H, '.');
  setBorder(g, W, H, '#');
  setRect(g, 14, 13, 12, 8, 'C');  // the dance floor (club checker)
  setRect(g, 3, 23, 10, 1, 'B');   // the bar counter (south-west) — 'B', not '#': counters are flat (v1.4.1 seat audit; the '#' cube put the stools' cushions ON the bar)
  const id = 'club-mirage';
  // Six stage tables in one even row, two chairs apiece pulled OUT
  // to the 50px band (v1.3.1 Item 1): the south chair faces the
  // stage over the table ('up'), the north chair faces in ('down').
  const tableChairs = [];
  for (const tx of [3, 10, 16, 23, 29, 36]) {
    tableChairs.push(
      [tx, 9 + 1.5625, 'up'], [tx, 9 - 1.5625, 'down'],
    );
  }
  // The dancers (fixtures): all blonde, curvier figure (the
  // sprites carry a `figure: 'curvy'` variant drawn only for
  // these looks), club wear = tank + skirt.
  const dancers = [
    clubDancer(1, 4, 'Roxy', {
      gender: 'F', face: 'heart', eyes: 'lash', eye_color: '#1e4d8f', nose: 'tiny', lips: 'red',
      skin_tone: '#f1c27d', hair_style: 'long', hair_color: '#e8c88a', top_style: 'tank',
      body_color: '#ff2e88', bottom_style: 'skirt', accent_color: '#1c0a24', shoe_color: '#e8e4da',
      accessory: 'none', figure: 'curvy',
    }),
    clubDancer(2, 17, 'Vega', {
      gender: 'F', face: 'classic', eyes: 'winged', eye_color: '#2e5e1e', nose: 'button', lips: 'pink',
      skin_tone: '#ffcd94', hair_style: 'ponytail', hair_color: '#f0d49a', top_style: 'tank',
      body_color: '#37b6e0', bottom_style: 'skirt', accent_color: '#241533', shoe_color: '#ffd23f',
      accessory: 'none', figure: 'curvy',
    }),
    clubDancer(3, 30, 'Lola', {
      gender: 'F', face: 'soft', eyes: 'double-lash', eye_color: '#6e2a8f', nose: 'small', lips: 'plum',
      skin_tone: '#ffe0bd', hair_style: 'bob', hair_color: '#e5b95f', top_style: 'tank',
      body_color: '#c7248f', bottom_style: 'skirt', accent_color: '#2b1030', shoe_color: '#8f1e3a',
      accessory: 'none', figure: 'curvy',
    }),
  ];
  return {
    id, name: 'Club Mirage', tiles: gridOf(g), tileSize: TILE,
    floor: '#34102c', floorAlt: '#3d1533', wall: '#1c0716',
    spawn: { x: cx(30), y: cy(21) },
    gateways: [],
    doors: [
      door(30, 24, 'neon-district', { x: cx(9), y: cy(39) }, 'Neon District', 2),
    ],
    props: [
      prop('lantern', 28, 23), prop('lantern', 33, 23),
      prop('rug', 30, 20),
      // The six stage tables (chairs are seats, in the band).
      prop('table', 3, 9), prop('table', 10, 9), prop('table', 16, 9),
      prop('table', 23, 9), prop('table', 29, 9), prop('table', 36, 9),
      // The bar's warm dressing: string lights over the counter,
      // a lamp at each end of it.
      prop('stringlights', 7, 21),
      prop('lamp', 3, 21), prop('lamp', 12, 21),
    ],
    areas: [
      area('The Stages', 0, 0, 40, 12),
      area('The Dance Floor', 12, 12, 18, 12),
      area('The Bar', 1, 19, 14, 6),
    ],
    seats: [
      ...tableChairs.map(([x, y, dir], i) => seat(id, i + 1, x, y, dir, 'chair')),
      // (v1.6: the two bar stools that stood here are GONE — Zan's
      // order, game-wide. Mira serves patrons standing at the
      // counter; the drink flow is proximity-based.)
    ],
    // v1.6 (Zan's order): a REAL player-performance stage in the
    // club — the full stage complex (platform + standing pit +
    // speakers) but PIT-ONLY: no 20-chair audience grid (the
    // ringside tables are the club's seating). Placement: the EAST
    // wall, facing west into the room ('W' facing: platform cols
    // 36-38, pit cols 33-35, rows 12-21) — the end of the dance
    // floor, clear of the dancer stages (north), the bar (SW),
    // the ringside tables (row 9 and its south chairs end at tile
    // row 11) and the door/spawn (SE, col 30). The validator holds
    // this map to the REGISTERED pit-only venue variant; every
    // city venue still owes its 20 chairs.
    stage: stageDef(36, 12, 'W'),
    club: {
      stages: [
        clubStage(1, 4, dancers[0]),
        clubStage(2, 17, dancers[1]),
        clubStage(3, 30, dancers[2]),
      ],
      bar: { x: cx(7), y: cy(22) }, // patron spot in front of the counter
      bartender: {
        x: cx(7), y: cy(24), name: 'Mira',
        look: {
          gender: 'F', face: 'sharp', eyes: 'lash', eye_color: '#20242c', nose: 'tiny', lips: 'bold',
          skin_tone: '#e0ac69', hair_style: 'bun', hair_color: '#191410', top_style: 'button-up',
          body_color: '#2b1030', bottom_style: 'pants', accent_color: '#17102b', shoe_color: '#23262b',
          accessory: 'none',
        },
      },
    },
  };
}

// ------------------------------------------------------------------
// HOOKAH LOUNGE — an interior off Cinder Mesa (Phase B amendment).
// Four hookah stations, two seats each: sit down, then interact to
// take a puff (5z). The door back is on the south wall.
// v1.2.3 (SPACE PASS, Items 5/7/8): enlarged 20x14 -> 26x18. The
// BIG fireplace (Item 6) anchors the north wall; its arc is
// SPACED — a clear gap between every seat, set back from the fire
// with the rug in front, a walkway behind — and every seat aims
// at the fire. The floor inside the door stays open for a crowd.
// ------------------------------------------------------------------
function buildHookahLounge() {
  const W = 26, H = 18;
  const g = makeGrid(W, H, '.');
  setBorder(g, W, H, '#');
  // v1.2.2 (Item 5): the four corner post tiles are GONE — they
  // rendered as stray crate boxes in the lounge's corners and were
  // part of no composition.
  g[1][13] = '#'; // Phase 10: the hearth niche (north wall, centre)
  const id = 'hookah-lounge';
  const stations = [[6, 6], [19, 6], [6, 13], [19, 13]];
  const seats = [];
  stations.forEach(([tx, ty], i) => {
    seats.push(seat(id, i * 2 + 1, tx - 1, ty, 'right', 'hookah'));
    seats.push(seat(id, i * 2 + 2, tx + 1, ty, 'left', 'hookah'));
  });
  return {
    id, name: 'Hookah Lounge', tiles: gridOf(g), tileSize: TILE,
    floor: '#3d2b1f', floorAlt: '#37271c', wall: '#241610',
    spawn: { x: cx(13), y: cy(14) },
    gateways: [],
    doors: [
      // v1.2.2 (Item 8): the Mesa-side landing follows the lounge
      // door to its new front face.
      door(12, 16, 'cinder-mesa', { x: cx(30), y: cy(39) }, 'Cinder Mesa', 2),
    ],
    props: [
      prop('hearth', 13, 1),
      prop('stringlights', 13, 9),
      // v1.2.2 (Item 4): a hearth rug in front of the fire seats.
      prop('rug', 13, 3),
    ],
    seats: [
      ...seats,
      // v1.2.3 (Item 7 — hearth seating done right): FIVE seats in
      // a SPACED arc facing the big fire — sofa at the centre, a
      // clear gap between every pair, the end chairs stepping one
      // tile south to open the arc toward the hearth.
      // v1.3.1 (Item 2): the arc FANS in SCREEN space — the west
      // seats stored 'up' presented ~90° off the fire in the render
      // (screen-bearing dots −0.06 / 0 / 0.45); they now face
      // 'right' (dots 0.97 / 1.0 / 0.89) and the fan reads
      // right,right,right,up,up — validator-enforced.
      seat(id, 9, 8, 5, 'right', 'chair'),
      seat(id, 10, 10, 4, 'right', 'chair'),
      seat(id, 11, 13, 4, 'right', 'sofa'),
      seat(id, 12, 16, 4, 'up', 'chair'),
      seat(id, 13, 18, 5, 'up', 'chair'),
    ],
    areas: [area('The Hearth Corner', 8, 0, 10, 6), area('The Lounge', 1, 1, 24, 16)],
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
  setRect(g, 56, 30, 12, 8, '#');       // the Neon Casino (SE) — a facade now
  setRect(g, 4, 30, 12, 8, '#');        // Club Mirage (SW) — its own building (v1.4)
  g[5][33] = '|'; g[5][44] = '|'; // stage speakers (front corners; stage shifted +1 in v1.2 for Item B alignment)
  // v1.2 (Items I/Q): stall posts ONLY where a stall prop stands.
  // The old list planted bare cubes at (41,18)/(30,26) and one at
  // (36,16) INSIDE the audience grid — all gone.
  for (const [x, y] of [[30, 18], [41, 26]]) g[y][x] = '|'; // market stalls
  // Dressing on the old footprints: trees, planters, stall posts.
  g[6][6] = 'T'; g[9][12] = 'T'; g[5][8] = 'P';
  g[7][46] = 'T'; // v1.3.1: the (24,7) stall post went with its loner stall (Item 14)
  g[9][20] = 'T'; g[5][50] = 'T';
  g[20][6] = 'P'; g[23][6] = 'P'; g[24][12] = 'T';
  g[18][58] = 'T'; g[22][64] = 'T'; g[20][66] = 'P';
  g[34][28] = 'T'; g[33][44] = 'P'; // v1.3.1: the (10,33) stall post went with its loner stall (Item 14)
  // v1.2 (Item I): the great NEON sign leaves the seating block —
  // twin signs now flank the stage ends, each on its own post.
  g[4][32] = '|'; g[4][45] = '|';
  gatehouseWalls(g, 35, 43, 'S');
  const id = 'neon-district';
  return {
    id, name: 'Neon District', tiles: gridOf(g), tileSize: TILE,
    floor: '#17102b', floorAlt: '#1e1438', wall: '#ff2e88',
    spawn: { x: cx(36), y: cy(41) },
    gateways: [arch(35, 43, 'the-gateway', 'The Gateway', 'S', 40)],
    buildings: [
      building(56, 30, 12, 8, 'Neon Casino', 'neon'),
      building(4, 30, 12, 8, 'Club Mirage', 'club'),
    ],
    doors: [
      // The SE block (tiles 56..67, 30..37) is the Neon Casino.
      // v1.2.2 (Item 8 — doors front-facing): its door moves from
      // the back (north) face to the FRONT (south) face.
      door(61, 38, 'neon-casino', { x: cx(17), y: cy(20) }, 'Neon Casino'),
      // v1.4: Club Mirage — the SW block (tiles 4..15, 30..37),
      // door on its FRONT (south) face, same pattern as the casino.
      door(9, 38, 'club-mirage', { x: cx(30), y: cy(21) }, 'Club Mirage'),
    ],
    props: [
      // v1.2.2 (Item 8): the doorstep lantern moved with the door.
      prop('lantern', 60, 39),
      // v1.4: a lantern flanks the Club Mirage doorstep too.
      prop('lantern', 8, 39),
      // The heroes: twin NEON signs flanking the STAGE ends (v1.2
      // Item I — the old single sign stood mid-seating on a cube).
      prop('neonsign', 32, 4), prop('neonsign', 45, 4),
      // A market-square nook: rug + lamp + string lights over the stalls.
      // v1.2.2 (Item 1): the nook steps a full 3 tiles clear of the
      // audience block (it hugged the back row and read as junk
      // inside the venue); the string lights keep their 2-north
      // offset over the rug.
      prop('rug', 36, 25), prop('lamp', 32, 25), prop('stringlights', 36, 23),
      // Stalls on their posts (Lane C) — only the two market-square
      // stalls remain. v1.3.1 (Item 14 — Neon cleanup): the loner
      // stalls at (24,7) and (10,33) sat alone in open ground and
      // are REMOVED, posts included.
      prop('stall', 30, 18), prop('stall', 41, 26),
      prop('flowers', 30, 15), prop('flowers', 42, 28),
    ],
    // v1.2 (Item B): stage + pit span exactly the seating block
    // (x34..43) — the complex shifted one tile east to align.
    stage: stageDef(34, 3, 'S'),
    areas: [
      area('Stage Grounds', 30, 1, 14, 9),
      area('Market Square', 26, 14, 20, 16),
      area('Casino Row', 52, 26, 18, 14),
    ],
    seats: [
      seat(id, 1, 20, 13, 'down', 'bench'),
      seat(id, 2, 50, 13, 'down', 'bench'),
      // v1.2.2 (Item 1d — plaza scatter round 2): the two solo café
      // booths (34,20)/(38,24) and the lone chair at (24,22) are
      // GONE — seating exists only inside composed arrangements
      // (street benches, the market nook, the venue).
      // Phase 10: the market nook sofas, facing each other (moved
      // south with their nook, clear of the venue — Item 1c).
      seat(id, 6, 33, 25, 'right', 'sofa'),
      seat(id, 7, 39, 25, 'left', 'sofa'),
      // v1.2.2 (Item 1a): the audience grid is UNIFORM — five rows
      // at a strict 2-tile pitch, all south of the north street
      // (the old [10,13,...] split put a 3-gap at the street and
      // the rows read scattered). The street now reads as the
      // aisle between the pit and the seats.
      // v1.3.1 (Item 3 — UNIFORM VENUE GEOMETRY): the audience
      // faces straight at the stage ('up') — Zan's annotated
      // screenshot showed the old 'right' profile rows aiming
      // screen-SE, ~90° off the stage. The per-venue profile
      // exceptions are abolished in all five cities.
      ...audienceSeats(id, 101, [34, 37, 40, 43], [13, 15, 17, 19, 21], 'up'),
    ],
  };
}

// CINDER MESA — ember forge country: scattered rock clusters, a
// forge plaza west-center, stage on the north rim (v1.3.1 uniform
// venue geometry), arch south-west.
function buildCinderMesa() {
  const W = 72, H = 45;
  const g = cityShell(W, H);
  // Lane C: the rock clusters were box-rects — now scattered 'R'
  // boulders (solid, but they read as rocks, not buildings).
  // v1.2.3 (Item 9): composition law — rocks stand in CLUSTERS of
  // 3+ at edges and plaza shoulders, never as lone mounds or bare
  // pairs dotted mid-plaza (the last pairs grew into clusters).
  for (const [x, y] of [
    [6, 6], [8, 6], [7, 7], [9, 8], [6, 8],
    [20, 4], [22, 5], [24, 4],
    [50, 5], [52, 6], [54, 5], [55, 7],
    [62, 14], [64, 15], [63, 17], [65, 16],
    [8, 20], [10, 21], [12, 22], [9, 22],
    [16, 32], [18, 33], [20, 34], [17, 34],
    [56, 32], [58, 33], [60, 35], [57, 35],
    [28, 14], [30, 15], [29, 13], [31, 14], // v1.3.1: shifted west, clear of the rebuilt north venue
    [36, 36], [38, 37], [37, 38],
    [10, 36], [12, 37], [11, 38],
    [24, 20], [24, 21], [23, 19],
  ]) g[y][x] = 'R';
  setRect(g, 24, 17, 9, 12, 's');   // Hearth Plaza stone
  setRect(g, 31, 2, 16, 12, 's');   // Stage Grounds stone (v1.3.1: the venue moved north — see stage below)
  setRect(g, 27, 38, 7, 2, 's');    // Hookah Corner doorstep terrace (v1.2.2, Item 8: on the FRONT/south side now)
  setRect(g, 4, 40, 24, 1, 'p');    // south path from the gatehouse
  g[5][32] = '|'; g[5][43] = '|';   // stage speakers (v1.3.1: front corners of the north stage)
  // v1.5.1 (Job B): the forge's two '|' POSTS are DELETED — as
  // tiles they extrude into plain wooden cubes, and flanking the
  // old forge they read as stray CRATES in the nook (Zan: "get
  // rid of boxes"). The forge's 'R' stone-base tile goes too:
  // the big hearth (below) draws its own stone floor, and the
  // plaza's 's' stone shows through where all three stood.
  g[20][24] = 'R'; g[21][24] = 'R'; // plaza-edge boulders (after the stone fill)
  gatehouseWalls(g, 3, 43, 'S');
  setRect(g, 26, 32, 9, 6, '#');    // the Hookah Lounge building (S-centre) — a facade now
  const id = 'cinder-mesa';
  return {
    id, name: 'Cinder Mesa', tiles: gridOf(g), tileSize: TILE,
    floor: '#c47b3a', floorAlt: '#bb7031', wall: '#6e2418',
    spawn: { x: cx(4), y: cy(41) },
    gateways: [arch(3, 43, 'the-gateway', 'The Gateway', 'S', 40)],
    buildings: [
      building(26, 32, 9, 6, 'Hookah Lounge', 'hookah'),
    ],
    doors: [
      // v1.2.2 (Item 8 — doors front-facing): the lounge door moves
      // from the back (north) face to the FRONT (south) face.
      door(30, 38, 'hookah-lounge', { x: cx(13), y: cy(14) }, 'Hookah Lounge'),
    ],
    props: [
      // v1.2.2 (Item 8): the doorstep lantern moved with the door.
      prop('lantern', 29, 39),
      // v1.5.1 (Job B — Zan: "make cozy, get rid of boxes,
      // bigger fireplace"): the old FORGE prop read as a little
      // stove in the corner, so the plaza's hero is now the BIG
      // HEARTH (the v3 chimney-breast fireplace, same as the
      // café/hookah interiors) — a real fire to sit by, with the
      // room-filling night glow that comes with the kind.
      prop('hearth', 28, 21),
      // The nook's rug sits in the middle of the hearth arc
      // (below), the lamp keeps its spot west of the fire.
      prop('rug', 29, 24), prop('lamp', 26, 21),
    ],
    // v1.3.1 (Item 3 — UNIFORM VENUE GEOMETRY): the stage stands
    // against the NORTH rim now, pit in front, audience behind —
    // the old west-face 'W' complex on the east rim is retired in
    // every city. Item 10: the two flat bench remnants at the old
    // stage's ends ((57,15)/(57,28)) are DELETED with it, along
    // with the lone forge-plaza chair (24,24) and café booth
    // (26,27) (Item 5). The forge nook sofa now faces the forge.
    stage: stageDef(33, 3, 'S'),
    areas: [
      area('Hearth Plaza', 20, 15, 16, 14),
      area('Stage Grounds', 31, 1, 16, 12),
      area('Hookah Corner', 24, 29, 16, 12),
    ],
    seats: [
      // v1.5.1 (Job B): the hearth nook, recomposed as a proper
      // SCREEN-SPACE hearth arc around the big hearth at (28,21)
      // (the validator's hearth-aim law judges the fan in screen
      // space; bearings noted per seat). The sofa used to sit due
      // south of the fire at (28,25) — a screen bearing of 0.45,
      // under the law's 0.55 floor — so it slides south-east onto
      // the fan's spine, where 'up' aims true (0.89). The two
      // chairs fan the arc's shoulders; the rug (29,24) lies
      // between the fire and the seats.
      seat(id, 5, 31, 26, 'up', 'sofa'),   // arc spine (bearing 0.89)
      seat(id, 6, 27, 26, 'right', 'chair'), // west shoulder (0.71)
      seat(id, 7, 33, 24, 'up', 'chair'),    // east shoulder (0.89)
      // v1.3.1: stage audience — pit rows 6-8, then 5 rows of 4
      // chairs facing straight at the stage ('up').
      ...audienceSeats(id, 101, [33, 36, 39, 42], [10, 12, 14, 16, 18], 'up'),
    ],
  };
}

// FROSTHAVEN — aurora ice: a frozen pond north-west, ice blocks,
// pines; stage on the north-west rim (v1.3.1 uniform venue
// geometry), return arch on the north edge.
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
  setRect(g, 19, 2, 17, 17, 's');   // Stage Grounds stone (v1.3.1: the venue moved to the north-west rim)
  setRect(g, 35, 5, 2, 15, 'p');    // path south from the gatehouse
  // v1.3.1: the path west to the old pond-shore nook is gone with
  // the nook (Item 15 — the cluster was trash, not an arrangement).
  for (const [x, y] of [[34, 13], [44, 14], [52, 30], [24, 32], [16, 26], [66, 12], [31, 26]]) g[y][x] = 'T'; // pines ((30,12) moved east, clear of the rebuilt venue's apron)
  g[4][21] = '|'; g[4][32] = '|';   // stage speakers (v1.3.1: front corners of the north stage)
  g[7][47] = '#';                   // the ice sculpture's plinth (hero)
  gatehouseWalls(g, 35, 1, 'N');
  const id = 'frosthaven';
  return {
    id, name: 'Frosthaven', tiles: gridOf(g), tileSize: TILE,
    floor: '#d7edf7', floorAlt: '#c6e3f2', wall: '#2f5d8a',
    spawn: { x: cx(36), y: cy(4) },
    gateways: [arch(35, 1, 'the-gateway', 'The Gateway', 'N', 4)],
    doors: [],
    props: [
      // The hero: a great ice sculpture on its plinth, NE grounds.
      prop('icesculpt', 47, 7),
      // v1.3.1 (Items 15/16 — TRASH, deleted whole, NOT reorganized):
      // the frozen-pond cluster (rug + lamp + string lights hanging
      // to nothing) and the old venue's remnants (the pit-corner
      // lantern, the café booth's round table top, the dumped rug
      // pads past the rows) are all GONE. The snow mounds stay —
      // they're natural dressing.
    ],
    // v1.3.1 (Item 3 — UNIFORM VENUE GEOMETRY): the stage stands
    // against the north-west rim (the gatehouse holds the north
    // centre), pit in front, audience behind facing it ('up').
    // The old south-rim 'N' complex is retired.
    stage: stageDef(22, 2, 'S'),
    // v1.2 (Items N/O): ICE fishing — cast from the frozen pond's
    // edge; the drill hole renders at the landing point on the ice.
    fishable: true,
    frozen: true,
    areas: [
      area('The Frozen Pond', 2, 2, 20, 10),
      area('Stage Grounds', 19, 2, 17, 17),
    ],
    seats: [
      // v1.3.1 (Items 5/15/16): Frosthaven's ONLY seats are the
      // audience grid now — the pond-nook chair + sofa, the two
      // venue benches and the café booth were all remnants and are
      // deleted. Stage audience: pit rows 5-7, then 5 rows of 4
      // chairs facing straight at the stage ('up').
      ...audienceSeats(id, 101, [22, 25, 28, 31], [9, 11, 13, 15, 17], 'up'),
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
  // v1.1.1: the pond moved south AND grew (was 10x5 at y37-41 in
  // v1.1, then 10x4 at y40): the v1.1 audience grid's back row (ty36)
  // sat one tile above the old waterline and rendered as sitting in
  // the shallows. Water now spans x26-43, y40-43 (72 tiles), leaving
  // 3 clear tiles (37-39) behind the back row — and it's a proper
  // fishing pond now (proximity fishing all along its banks).
  setRect(g, 26, 40, 18, 4, '%');
  g[5][32] = '|'; g[5][43] = '|';   // stage speakers (v1.3.1: front corners of the north stage)
  g[15][28] = 'P';                  // the Great Tree's root planter (hero)
  gatehouseWalls(g, 66, 43, 'S');
  const id = 'verdant-hollow';
  return {
    id, name: 'Verdant Hollow', tiles: gridOf(g), tileSize: TILE,
    floor: '#2e5d33', floorAlt: '#26502b', wall: '#4a3520',
    spawn: { x: cx(67), y: cy(41) },
    gateways: [arch(66, 43, 'the-gateway', 'The Gateway', 'S', 40)],
    doors: [],
    props: [
      // The hero: the Great Tree at the clearing's NW shoulder.
      prop('greattree', 28, 15),
      // A grove nook south of the clearing (v1.3.1: recomposed —
      // rug + lamp + two seats facing each other over the rug).
      // The string lights moved behind the rebuilt north stage —
      // stage-end dressing.
      prop('rug', 28, 29), prop('lamp', 26, 28), prop('stringlights', 36, 2),
      // Flower drifts: one beside the Great Tree, one at the
      // clearing's south edge. (The drifts that sat inside the old
      // audience grid and alone in open ground east of the pond
      // are gone — the anchor law fails open-ground loners now.)
      prop('flowers', 30, 17), prop('flowers', 28, 32),
    ],
    // v1.2 (Item O): proximity fishing — anywhere along the pond's
    // bank; the static rod stands are gone (they looked dead).
    fishable: true,
    // v1.3.1 (Item 3 — UNIFORM VENUE GEOMETRY): the stage stands at
    // the clearing's NORTH edge now (it sat mid-map), pit in
    // front, audience behind facing it ('up').
    stage: stageDef(33, 4, 'S'),
    areas: [
      area('The Clearing', 28, 1, 18, 21),
      area('The Pond Shore', 24, 37, 20, 8),
    ],
    seats: [
      // v1.3.1 (Item 5): the two venue benches, the café booth and
      // the two tree-cluster LAWN CHAIRS (12,12)/(58,12) are
      // deleted — the lawn pair's pending veto is exercised. The
      // grove nook keeps two seats facing each other over the rug.
      seat(id, 6, 28, 27, 'down', 'sofa'),
      seat(id, 7, 28, 31, 'up', 'chair'),
      // v1.3.1: stage audience — pit rows 7-9, then 5 rows of 4
      // chairs facing straight at the stage ('up').
      ...audienceSeats(id, 101, [33, 36, 39, 42], [11, 13, 15, 17, 19], 'up'),
    ],
  };
}

const MAPS = {};
for (const def of [
  buildGateway(), buildCafe(), buildSolsticeBay(), buildCasinoLounge(),
  buildNeonDistrict(), buildNeonCasino(), buildClubMirage(), buildCinderMesa(), buildHookahLounge(),
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

/**
 * Strip a map def down to what the client needs to render it.
 * `seasonOverride` is for tooling/tests (the Bake Shop preview):
 * pass a season name to force that layer, or null to force none.
 * Live callers omit it and get the calendar's current season —
 * its overlay props are merged into `props` (src/seasons.js);
 * the BASE dressing above is never edited by a season.
 */
function clientMap(map, seasonOverride) {
  const { seasonAt, overlayProps } = require('./seasons');
  const season = seasonOverride === undefined ? seasonAt(new Date()) : seasonOverride;
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
    props: [
      ...(map.props || []).map(p => ({ kind: p.kind, x: p.x, y: p.y })),
      ...overlayProps(map.id, season),
    ],
    seats: (map.seats || []).map(s => ({ id: s.id, x: s.x, y: s.y, dir: s.dir, kind: s.kind })),
    areas: (map.areas || []).map(a => ({ ...a })),
    hookahs: (map.hookahs || []).map(h => ({ x: h.x, y: h.y })),
    fishable: Boolean(map.fishable),
    frozen: Boolean(map.frozen),
    stage: map.stage ? {
      x: map.stage.x, y: map.stage.y, w: map.stage.w, h: map.stage.h,
      pit: map.stage.pit || null,
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
        id: t.id, game: t.game || 'poker', x: t.x, y: t.y,
        chairs: t.chairs.map(c => ({ dir: c.dir, x: c.x, y: c.y })),
      })),
      slots: map.casino.slots.map(s => ({ id: s.id, x: s.x, y: s.y, ix: s.ix, iy: s.iy })),
      bar: map.casino.bar || null,
      bartender: map.casino.bartender || null,
    } : null,
    club: map.club ? {
      stages: map.club.stages.map(s => ({
        id: s.id, x: s.x, y: s.y, w: s.w, h: s.h,
        pole: { x: s.pole.x, y: s.pole.y },
        dancer: { id: s.dancer.id, name: s.dancer.name, x: s.dancer.x, y: s.dancer.y, look: s.dancer.look },
      })),
      bar: map.club.bar || null,
      bartender: map.club.bartender || null,
    } : null,
  };
}

module.exports = { TILE, MAPS, collides, gatewayAt, doorAt, clientMap, isSolidTile, WALKABLE };
