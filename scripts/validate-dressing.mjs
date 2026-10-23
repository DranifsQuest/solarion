'use strict';

/**
 * Solarion Bake Shop — dressing validator.
 *
 * Reads the map data from src/maps.js (the same module the server
 * runs) and fails LOUDLY (exit 1, itemized report) on layout bugs
 * that otherwise surface minutes later in a test suite — or worse,
 * in a player's session:
 *
 *   ERRORS
 *   - ragged tile rows / unknown tile characters
 *   - spawn point inside a solid tile (game's own collision test)
 *   - a door or gateway rect sitting entirely on solid tiles, or
 *     unreachable from the map spawn (tile BFS over the game's
 *     walkable set)
 *   - a door/gateway whose target map doesn't exist, or that is
 *     one-way (no door/gateway in the target points back)
 *   - a door's targetSpawn landing that collides, or lands inside
 *     a door/gateway rect in the target (the bounce-back bug class)
 *   - dressing props or seats overlapping door/gateway tiles, or
 *     seats embedded in solid tiles
 *   - casino slot interact spots / bar spot embedded in solid tiles
 *   - SEASONAL overlay layers (src/seasons.js) held to the same
 *     rules as the base dressing: no prop on a door/gateway tile,
 *     none inside a venue's seat block / pit / platform, none on
 *     top of a seat, only known seasonal kinds, in-bounds only
 *   - VENUE APRON (v1.2.2, Item 1c): no prop (any layer) and no
 *     non-audience seat within one tile of a venue's audience
 *     seat block — "technically outside" the block still reads
 *     as junk inside the venue at play zoom
 *   - DOORSTEP LAW (v1.2.2, Item 7): no seasonal prop shares a
 *     tile with a base prop, and none sits inside a doorstep
 *     apron (every door/gateway rect and gateway landing, framed
 *     by one tile) — seasonal pieces flank doorsteps, never pile
 *     onto them. Wreaths are exempt: they hang on the facade.
 *   - FRONT-DOOR LAW (v1.2.2, Item 8): a door adjacent to a
 *     building facade must sit on a FRONT (south or east) face —
 *     a door on a back (north/west) wall fails
 *   - DOOR + LANDING CLEARANCE (v1.2.3, Items 2/8): no seat
 *     within 2 tiles (Chebyshev) of a door tile in any map, and
 *     no seat or table within 2 tiles of a door's landing in the
 *     target map — doors and arrivals keep a clear apron
 *   - TABLE GROUP SPACING (v1.2.3, Item 8): in interiors, table
 *     props sit >=5 tiles apart centre-to-centre, so groups keep
 *     >=2 clear tiles between their chair rings
 *   - HEARTH AIM (v1.2.3, Item 7; v1.3.1 SCREEN-BEARING): a
 *     chair/sofa seat within 6 tiles of a fireplace is a hearth-arc
 *     seat and must AIM at the fire IN SCREEN SPACE (facing is
 *     screen-space since v1.1 — the old tile-space dot product
 *     passed arcs whose rendered backs sat ~90° off the fire)
 *   - PIT-FRONT CLEAR (v1.2.3, Item 9): the band between a pit's
 *     front edge and the audience block — the performer's apron
 *     and the crowd's standing edge — holds no seats, no props
 *   - UNIFORM VENUE GEOMETRY (v1.3.1, Item 3): every venue is the
 *     same shape — stage platform against the back (north) wall,
 *     pit in front of it, audience rows behind the pit, every
 *     audience seat facing the stage ('up', screen-bearing to the
 *     stage rect >= 0.7). Replaces the v1.2 Item P profile-row
 *     rule, whose 'right' rows aimed ~90° off the stage in Neon.
 *   - SEAT SPACING BANDS (v1.3.1, Items 1/7/8): table-group chairs
 *     sit 46-58px from their table's centre; poker chairs 55-66px
 *     from their table's centre.
 *   - SEAT FOOTPRINT LAW (v1.4.1, the seat audit): judged in the
 *     client's TRUE screen geometry (positions scale by ZOOM
 *     0.72, furniture art does not — the v1.3.1 slot test modelled
 *     the cushion at half size and passed stools that painted
 *     over their cabinets). A slot stool's whole art bbox must
 *     clear its cabinet's screen rect (and not float); a poker
 *     cushion centre stays outside the felt ellipse; no chair/
 *     stool cushion may overlap the raised top face of a '#'/'W'
 *     tile; bar counters are flat 'B' tiles by construction
 *     (interior 'W'/'#' counters fail) with every bar stool one
 *     tile north of its counter; seat kinds are a closed set and
 *     audience seats are always kind 'chair' (the current art).
 *   - ARRANGEMENT LAW (v1.3.1, Item 5): every seat belongs to a
 *     registered arrangement — table group, hearth arc, audience
 *     grid, casino floor, hookah station, beach towel unit, or an
 *     explicitly registered nook below. Lone chairs fail.
 *   - PROP ANCHOR LAW (v1.3.1, Items 4/14/15): every prop (base +
 *     seasonal) anchors to a feature — within 4 tiles of a door,
 *     gatehouse, building, stage/pit, water (2), or a hero prop —
 *     or clusters with other props (<=3 tiles), or stands inside
 *     a populated named area. Open-ground loners fail.
 *
 *   WARNINGS (Zan's standing rules, as far as the data supports)
 *   - an interior map with != 1 inbound door (one facade entrance)
 *   - an exterior door with no solid tile adjacent (no building
 *     face — a floating door)
 *
 * Tile BFS is a tile-level approximation of the game's circle
 * collision; door/gateway LANDING and spawn checks use the game's
 * collides() directly. Studios are dynamic (src/studio.js) and are
 * out of scope here.
 *
 * Usage: npm run validate:maps   (exit 0 = clean, warnings allowed)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MAPS, TILE, collides, WALKABLE } = require('../src/maps');
const { overlayProps, SEASONAL, SEASONAL_KINDS } = require('../src/seasons');

// The tile alphabet exactly as documented in src/maps.js (header):
// '#'=solid, '%'=water, '|'=post, 'W'=casino wall, 'T'=tree, 'P'=planter,
// 'R'=rock, 'B'=bar counter (all solid); '.'=ground, 'C'=casino floor,
// 'b'=boardwalk, 's'=stone, 'p'=path (walkable — see WALKABLE in maps.js).
const KNOWN_CHARS = new Set(['.', '#', '%', '|', 'W', 'C', 'T', 'P', 'R', 'b', 's', 'p', 'B']);
const errors = [];
const warnings = [];
const notes = [];

const err = (mapId, msg) => errors.push(`[${mapId}] ${msg}`);
const warn = (mapId, msg) => warnings.push(`[${mapId}] ${msg}`);

const tileAt = (map, tx, ty) =>
  (tx < 0 || ty < 0 || tx >= map.tiles.w || ty >= map.tiles.h) ? '#' : map.tiles.rows[ty][tx];
const walkable = (map, tx, ty) => WALKABLE.has(tileAt(map, tx, ty));
const tileOfPx = (v) => Math.floor(v / TILE);

function rectTiles(r) {
  const out = [];
  const x0 = tileOfPx(r.x), x1 = tileOfPx(r.x + r.w - 1);
  const y0 = tileOfPx(r.y), y1 = tileOfPx(r.y + r.h - 1);
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([tx, ty]);
  return out;
}
const inRect = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

// ------------------------------------------------------------------
// SEAT FOOTPRINT LAW constants (v1.4.1, the seat audit) — the
// client's TRUE screen geometry, mirrored from public/client.js.
// The render projects world -> screen with ZOOM 0.72 and then draws
// furniture art at FIXED screen sizes, so world-space distances
// systematically understate screen-space overlap (a 52px world gap
// is 37px on screen). Every constant below is the drawn size:
//   proj:        client.js `proj` (ZOOM = 0.72)
//   chair art:   client.js `drawChairAt` — cushion diamonds are
//                hw=30 (60px wide!), skirt/pad/top union hh=15.5
//                centred ~+1.75 below the seat point; ladder backs
//                rise 27-28px on the side away from the facing.
//   slot cabinet: client.js `drawSlotCabinet` — body ±15 plus the
//                cheek panel to ±21, 52px above its centre to +2.
//   wall tile:   drawTile '#'/'W' — top-face diamond at -WALL_H
//                (20px), hw = TILE*ZOOM = 23.04, hh = 11.52.
//   bar counter: drawTile 'B' — FLAT (top at -4px): governed by
//                construction law, not intersection (like tables).
const projS = (x, y) => [(x - y) * 0.72, (x + y) * 0.36];
const SEAT_BBOX = {
  down: { x: [-30, 30], y: [-33, 17] },
  up: { x: [-30, 30], y: [-20, 17] },
  left: { x: [-30, 30], y: [-35, 17] },
  right: { x: [-30, 30], y: [-35, 17] },
};
const CABINET_RECT = { x: [-21, 21], y: [-52, 2] };
const CUSHION_D = { hw: 30, hh: 15.5, dy: 1.75 };
// v1.6 (slot-row fix): the slot stool's OWN art (client.js
// drawStoolAt) — a backless pedestal stool whose solid cushion
// union is a diamond hw=17, hh=12 centred ~+1.5 below the seat
// point. Law A tests slot seats with the art their KIND actually
// draws: stools get this diamond, any other kind at a slot seat
// gets the chair bbox (and fails — see the law itself).
const STOOL_D = { hw: 17, hh: 12, dy: 1.5 };
/** Diamond (centre + half-extents) vs axis-aligned rect overlap.
 * Both shapes are convex; centre-in-rect, closest-point,
 * vertex-in-rect and corner-in-diamond together decide it. */
const diamondRectHit = (cx, cy, hw, hh, x0, y0, x1, y1) => {
  const inD = (x, y) => Math.abs(x - cx) / hw + Math.abs(y - cy) / hh < 1;
  if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) return true;
  const px = Math.max(x0, Math.min(cx, x1)), py = Math.max(y0, Math.min(cy, y1));
  if (inD(px, py)) return true;
  for (const [vx, vy] of [[cx - hw, cy], [cx + hw, cy], [cx, cy - hh], [cx, cy + hh]]) {
    if (vx > x0 && vx < x1 && vy > y0 && vy < y1) return true;
  }
  for (const [kx, ky] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    if (inD(kx, ky)) return true;
  }
  return false;
};
const WALLTOP_D = { hw: 23.04, hh: 11.52, dy: -20 };
/** Iso-diamond overlap (L1 in scaled space); <1 means the two
 * diamonds' interiors intersect. 0.98 leaves a hair of margin. */
const diamondHit = (ax, ay, ahw, ahh, bx, by, bhw, bhh) =>
  Math.abs(ax - bx) / (ahw + bhw) + Math.abs(ay - by) / (ahh + bhh) < 0.98;

/** Tile-level BFS over the game's walkable set, from the spawn tile. */
function reachableTiles(map) {
  const seen = new Set();
  const sx = tileOfPx(map.spawn.x), sy = tileOfPx(map.spawn.y);
  if (!walkable(map, sx, sy)) return seen;
  const q = [[sx, sy]];
  seen.add(`${sx},${sy}`);
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (!seen.has(k) && walkable(map, nx, ny)) { seen.add(k); q.push([nx, ny]); }
    }
  }
  return seen;
}

function checkPortalRect(map, reach, kind, p) {
  const tiles = rectTiles(p);
  if (!tiles.some(([tx, ty]) => walkable(map, tx, ty))) {
    err(map.id, `${kind} "${p.label}" rect sits entirely on solid tiles`);
    return;
  }
  if (!tiles.some(([tx, ty]) => reach.has(`${tx},${ty}`))) {
    err(map.id, `${kind} "${p.label}" is unreachable from spawn (BFS)`);
  }
  const cxp = p.x + p.w / 2, cyp = p.y + p.h / 2;
  if (collides(map, cxp, cyp, 10)) {
    err(map.id, `${kind} "${p.label}" centre collides — a player cannot stand on it`);
  }
}

function hasBackLink(fromMap, targetMap) {
  return (targetMap.doors || []).some(d => d.target === fromMap.id)
    || (targetMap.gateways || []).some(g => g.target === fromMap.id);
}

for (const map of Object.values(MAPS)) {
  // -- tile grid sanity
  for (let ty = 0; ty < map.tiles.rows.length; ty++) {
    const row = map.tiles.rows[ty];
    if (row.length !== map.tiles.w) err(map.id, `row ${ty} has length ${row.length}, expected ${map.tiles.w}`);
    for (const ch of row) {
      if (!KNOWN_CHARS.has(ch)) { err(map.id, `unknown tile char "${ch}" in row ${ty}`); break; }
    }
  }
  if (map.tiles.rows.length !== map.tiles.h) err(map.id, `has ${map.tiles.rows.length} rows, expected h=${map.tiles.h}`);

  // -- spawn
  if (collides(map, map.spawn.x, map.spawn.y, 10)) {
    err(map.id, `spawn (${map.spawn.x},${map.spawn.y}) collides with a solid tile`);
  }

  const reach = reachableTiles(map);
  const portalTiles = new Set();
  for (const p of [...(map.doors || []), ...(map.gateways || [])]) {
    for (const [tx, ty] of rectTiles(p)) portalTiles.add(`${tx},${ty}`);
  }

  // v1.2.2 (Item 7): doorstep aprons — every door/gateway rect and
  // every gateway landing tile, framed by one tile on all sides.
  const doorstepTiles = new Set();
  const inflateInto = (tiles, set) => {
    for (const [tx, ty] of tiles) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) set.add(`${tx + dx},${ty + dy}`);
    }
  };
  for (const d of map.doors || []) inflateInto(rectTiles(d), doorstepTiles);
  for (const g of map.gateways || []) {
    inflateInto(rectTiles(g), doorstepTiles);
    inflateInto([[tileOfPx(g.spawnOut.x), tileOfPx(g.spawnOut.y)]], doorstepTiles);
  }
  const basePropTiles = new Set((map.props || []).map(p => `${tileOfPx(p.x)},${tileOfPx(p.y)}`));

  // v1.2.2 (Item 8): FRONT-DOOR LAW — a door touching a building
  // facade must sit on a front (south/east) face. (Which side of
  // the door tile the building is on names the face the door
  // pierces: building north of the tile = the building's SOUTH
  // face; building south of it = its NORTH/back face.)
  for (const d of map.doors || []) {
    for (const b of map.buildings || []) {
      const inB = (x, y) => x >= b.tx && x < b.tx + b.tw && y >= b.ty && y < b.ty + b.th;
      for (const [tx, ty] of rectTiles(d)) {
        if (inB(tx, ty + 1)) err(map.id, `front-door law: door "${d.label}" sits on the BACK (north) wall of building "${b.name}" — doors face front (south/east)`);
        if (inB(tx + 1, ty)) err(map.id, `front-door law: door "${d.label}" sits on the BACK (west) wall of building "${b.name}" — doors face front (south/east)`);
      }
    }
  }

  // -- doors
  for (const d of map.doors || []) {
    checkPortalRect(map, reach, 'door', d);
    if (d.target === 'studio:self') {
      notes.push(`[${map.id}] door "${d.label}" -> studio:self (dynamic home door; pairing n/a)`);
    } else {
      const target = MAPS[d.target];
      if (!target) { err(map.id, `door "${d.label}" targets unknown map "${d.target}"`); continue; }
      if (!hasBackLink(map, target)) {
        err(map.id, `door "${d.label}" is one-way: ${d.target} has no door/gateway back to ${map.id}`);
      }
      if (d.targetSpawn) {
        const { x, y } = d.targetSpawn;
        if (collides(target, x, y, 10)) {
          err(map.id, `door "${d.label}" lands its targetSpawn inside a solid tile in ${d.target}`);
        }
        // v1.2.3 (Items 2/8): LANDING CLEARANCE — no seat and no
        // table within 2 tiles (Chebyshev) of where the traveller
        // appears in the target map.
        const lx = tileOfPx(x), ly = tileOfPx(y);
        for (const s of target.seats || []) {
          const sx2 = tileOfPx(s.x), sy2 = tileOfPx(s.y);
          if (Math.max(Math.abs(sx2 - lx), Math.abs(sy2 - ly)) <= 2) {
            err(map.id, `landing clearance: door "${d.label}" lands within 2 tiles of seat ${s.id} in ${d.target} — landings stay clear`);
          }
        }
        for (const pr of target.props || []) {
          if (pr.kind !== 'table') continue;
          const px2 = tileOfPx(pr.x), py2 = tileOfPx(pr.y);
          if (Math.max(Math.abs(px2 - lx), Math.abs(py2 - ly)) <= 2) {
            err(map.id, `landing clearance: door "${d.label}" lands within 2 tiles of a table in ${d.target} — landings stay clear`);
          }
        }
        for (const p of [...(target.doors || []), ...(target.gateways || [])]) {
          if (inRect(x, y, p)) {
            err(map.id, `door "${d.label}" targetSpawn lands inside ${d.target}'s "${p.label}" rect — bounce-back risk`);
          }
        }
      }
    }
    // Facade proxy: an exterior door should touch a solid face.
    const tiles = rectTiles(d);
    const touchesSolid = tiles.some(([tx, ty]) =>
      [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !WALKABLE.has(tileAt(map, tx + dx, ty + dy))));
    if (!touchesSolid) warn(map.id, `door "${d.label}" has no adjacent solid tile — no building face (floating door?)`);
  }

  // -- gateways
  for (const g of map.gateways || []) {
    checkPortalRect(map, reach, 'gateway', g);
    const target = MAPS[g.target];
    if (!target) { err(map.id, `gateway "${g.label}" targets unknown map "${g.target}"`); continue; }
    if (!hasBackLink(map, target)) {
      err(map.id, `gateway "${g.label}" is one-way: ${g.target} has no door/gateway back to ${map.id}`);
    }
  }

  // -- props & seats vs portals / solids
  // The base dressing AND each seasonal overlay layer go through
  // the same portal check; seasonal layers get the extra rules
  // (known kinds, in-bounds, never on a seat tile).
  const seatTiles = new Set((map.seats || []).map(s => `${tileOfPx(s.x)},${tileOfPx(s.y)}`));
  const layers = [
    { label: 'base', seasonal: false, props: map.props || [] },
    { label: 'halloween', seasonal: true, props: overlayProps(map.id, 'halloween') },
    { label: 'christmas', seasonal: true, props: overlayProps(map.id, 'christmas') },
  ];
  for (const layer of layers) {
    for (const pr of layer.props) {
      const tx = tileOfPx(pr.x), ty = tileOfPx(pr.y), k = `${tx},${ty}`;
      if (portalTiles.has(k)) err(map.id, `[${layer.label}] prop "${pr.kind}" sits on a door/gateway tile (${k})`);
      if (layer.seasonal) {
        if (!SEASONAL_KINDS.has(pr.kind)) err(map.id, `[${layer.label}] unknown seasonal prop kind "${pr.kind}" (${k})`);
        if (tx < 0 || ty < 0 || tx >= map.tiles.w || ty >= map.tiles.h) err(map.id, `[${layer.label}] prop "${pr.kind}" is out of bounds (${k})`);
        if (seatTiles.has(k)) err(map.id, `[${layer.label}] prop "${pr.kind}" sits on a seat tile (${k})`);
        // v1.2.2 (Item 7): DOORSTEP LAW — seasonal pieces flank a
        // doorstep composition, never pile onto it: no sharing a
        // tile with a base prop, no sitting inside a doorstep
        // apron. Wreaths hang on the facade by design (exempt).
        if (basePropTiles.has(k)) err(map.id, `doorstep law: [${layer.label}] prop "${pr.kind}" shares a tile with a base prop (${k}) — seasonal dressing composes WITH the base, never on top of it`);
        if (pr.kind !== 'wreath' && doorstepTiles.has(k)) err(map.id, `doorstep law: [${layer.label}] prop "${pr.kind}" sits inside a doorstep apron (${k}) — flank the doorstep, keep the apron clear`);
      }
    }
  }
  for (const s of map.seats || []) {
    const k = `${tileOfPx(s.x)},${tileOfPx(s.y)}`;
    if (portalTiles.has(k)) err(map.id, `seat ${s.id} sits on a door/gateway tile (${k})`);
    if (collides(map, s.x, s.y, 6)) err(map.id, `seat ${s.id} is embedded in a solid tile`);
  }

  // -- v1.2.3 (SPACE PASS) layout laws
  const seatTilesArr = (map.seats || []).map(s => [tileOfPx(s.x), tileOfPx(s.y), s]);
  // DOOR CLEARANCE (Items 2/8): no seat crowds a door — every
  // seat keeps >2 tiles (Chebyshev) from every door tile.
  for (const d of map.doors || []) {
    for (const [tx, ty] of rectTiles(d)) {
      for (const [sx2, sy2, s] of seatTilesArr) {
        if (Math.max(Math.abs(sx2 - tx), Math.abs(sy2 - ty)) <= 2) {
          err(map.id, `door clearance: seat ${s.id} crowds door "${d.label}" (${sx2},${sy2} within 2 of door tile ${tx},${ty}) — doors keep a clear apron`);
        }
      }
    }
  }
  // TABLE GROUP SPACING (Item 8): in interiors (no gateways),
  // round-table groups keep >=2 clear tiles between their chair
  // rings — centres >=5 tiles apart (Chebyshev).
  if (!(map.gateways || []).length) {
    const tables = (map.props || []).filter(p => p.kind === 'table')
      .map(p => [tileOfPx(p.x), tileOfPx(p.y)]);
    for (let i = 0; i < tables.length; i++) for (let j = i + 1; j < tables.length; j++) {
      const dd = Math.max(Math.abs(tables[i][0] - tables[j][0]), Math.abs(tables[i][1] - tables[j][1]));
      if (dd < 5) err(map.id, `group spacing: tables at (${tables[i]}) and (${tables[j]}) sit ${dd} tiles apart — table groups keep >=2 clear tiles between chair rings (>=5 centre to centre)`);
    }
  }
  // HEARTH AIM (Item 7; v1.3.1 SCREEN-BEARING): a chair/sofa seat
  // near a fireplace is a hearth-arc seat, and arc seats AIM AT
  // THE FIRE — judged in SCREEN space, because facing has been
  // screen-space since v1.1: the seat's facing vector must carry
  // toward the hearth on screen (dot >= 0.7). The old tile-space
  // dot product passed the café's southern chairs ('left', tile
  // dot > 0) whose rendered backs sat ~90° off the fire — the
  // data-vs-render mismatch behind Item 2. (Hookah station seats
  // are their own kind and aim at their stations, not the hearth.)
  const SCRV = { up: [0, -1], down: [0, 1], left: [-0.894, 0.447], right: [0.894, 0.447] };
  const screenDot = (dir, dxPx, dyPx) => {
    const sx = dxPx - dyPx, sy = (dxPx + dyPx) / 2;
    const len = Math.hypot(sx, sy) || 1;
    const v = SCRV[dir] || [0, 0];
    return (v[0] * sx + v[1] * sy) / len;
  };
  for (const hp of (map.props || []).filter(p => p.kind === 'hearth')) {
    const hx = tileOfPx(hp.x), hy = tileOfPx(hp.y);
    for (const [sx2, sy2, s] of seatTilesArr) {
      if (s.kind !== 'chair' && s.kind !== 'sofa') continue;
      if (Math.max(Math.abs(sx2 - hx), Math.abs(sy2 - hy)) > 6) continue;
      const dot = screenDot(s.dir, hp.x - s.x, hp.y - s.y);
      // 0.55, not higher: a seat due west/north of the fire caps
      // at 0.60 under cardinal facings (world-west projects to
      // screen up-left, between 'left' and 'up'). 0.55 still
      // rejects sideways (<=0.45) and back-to-fire facings.
      if (dot < 0.55) err(map.id, `hearth aim: seat ${s.id} at (${sx2},${sy2}) faces '${s.dir}' (screen bearing ${dot.toFixed(2)}) — hearth-arc seats aim at the fireplace (${hx},${hy})`);
    }
  }

  // -- venue purity + facing + width (v1.2, Items B/M/P)
  // For maps with a stage, the venue rects are DERIVED from the
  // map's own data: the audience seat block is the tile bounding
  // box of the audienceSeats() seats (ids …-seat-101 and up), and
  // the pit/platform come from map.stage itself. Rules:
  //   - the seat block contains ONLY audience seats: no props, no
  //     other seats, no solid/grid dressing tiles;
  //   - the pit and platform contain no props and no seats at all;
  //   - grid tiles inside the seat block or pit must be walkable,
  //     except the stage's own speaker posts (map.stage.speakers);
  //   - audience seats face the stage under the UNIFORM VENUE
  //     GEOMETRY law (v1.3.1 — see below);
  //   - platform and pit width EQUAL the seat block's width on the
  //     audience axis, aligned to the same span (Item B).
  if (map.stage) {
    const st = map.stage;
    const aud = (map.seats || []).filter(s => {
      const m = /-seat-(\d+)$/.exec(s.id);
      return m && Number(m[1]) >= 101;
    });
    const speakerTiles = new Set((st.speakers || []).map(sp => `${tileOfPx(sp.x)},${tileOfPx(sp.y)}`));
    const pitTiles = new Set(rectTiles(st.pit).map(([tx, ty]) => `${tx},${ty}`));
    const stageTiles = new Set(rectTiles(st).map(([tx, ty]) => `${tx},${ty}`));
    if (aud.length) {
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      for (const s of aud) {
        x0 = Math.min(x0, tileOfPx(s.x)); x1 = Math.max(x1, tileOfPx(s.x));
        y0 = Math.min(y0, tileOfPx(s.y)); y1 = Math.max(y1, tileOfPx(s.y));
      }
      const inBox = (tx, ty) => tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1;
      // v1.2.2 (Item 1c): the APRON — one tile around the seat
      // block. Dressing that is merely "technically outside" the
      // block still reads as junk inside the venue at play zoom,
      // so the apron is held clear too (the pit/platform keep
      // their own stricter rules above).
      const inApron = (tx, ty) => tx >= x0 - 1 && tx <= x1 + 1 && ty >= y0 - 1 && ty <= y1 + 1;
      // v1.2.3 (Item 9): PIT-FRONT CLEAR — the band strictly
      // between the pit's front edge and the audience block, on
      // the audience axis, is the performer's apron and the
      // crowd's standing edge: no seats, no props (any layer).
      const pitX0 = tileOfPx(st.pit.x), pitX1 = tileOfPx(st.pit.x + st.pit.w - 1);
      const pitY0 = tileOfPx(st.pit.y), pitY1 = tileOfPx(st.pit.y + st.pit.h - 1);
      const bandSet = new Set();
      if (y0 > pitY1) { for (let ty = pitY1 + 1; ty < y0; ty++) for (let tx = x0; tx <= x1; tx++) bandSet.add(`${tx},${ty}`); }
      else if (y1 < pitY0) { for (let ty = y1 + 1; ty < pitY0; ty++) for (let tx = x0; tx <= x1; tx++) bandSet.add(`${tx},${ty}`); }
      else if (x0 > pitX1) { for (let tx = pitX1 + 1; tx < x0; tx++) for (let ty = y0; ty <= y1; ty++) bandSet.add(`${tx},${ty}`); }
      else if (x1 < pitX0) { for (let tx = x1 + 1; tx < pitX0; tx++) for (let ty = y0; ty <= y1; ty++) bandSet.add(`${tx},${ty}`); }
      if (bandSet.size) {
        for (const layer of layers) {
          for (const pr of layer.props) {
            const k = `${tileOfPx(pr.x)},${tileOfPx(pr.y)}`;
            if (bandSet.has(k)) err(map.id, `pit-front clear: [${layer.label}] prop "${pr.kind}" stands in front of the pit (${k}) — the pit front stays clear`);
          }
        }
        for (const s of map.seats || []) {
          const k = `${tileOfPx(s.x)},${tileOfPx(s.y)}`;
          if (bandSet.has(k)) err(map.id, `pit-front clear: seat ${s.id} stands in front of the pit (${k}) — the pit front stays clear`);
        }
      }
      for (const layer of layers) {
        for (const pr of layer.props) {
          const tx = tileOfPx(pr.x), ty = tileOfPx(pr.y), k = `${tx},${ty}`;
          if (inBox(tx, ty)) err(map.id, `venue purity: [${layer.label}] prop "${pr.kind}" intrudes into the audience seat block (${k})`);
          if (pitTiles.has(k)) err(map.id, `venue purity: [${layer.label}] prop "${pr.kind}" intrudes into the stage pit (${k})`);
          if (stageTiles.has(k)) err(map.id, `venue purity: [${layer.label}] prop "${pr.kind}" intrudes onto the stage platform (${k})`);
          if (!inBox(tx, ty) && !pitTiles.has(k) && !stageTiles.has(k) && inApron(tx, ty)) {
            err(map.id, `venue apron: [${layer.label}] prop "${pr.kind}" crowds the audience seat block (${k}) — keep one clear tile around the venue`);
          }
        }
      }
      for (const s of map.seats || []) {
        const tx = tileOfPx(s.x), ty = tileOfPx(s.y), k = `${tx},${ty}`;
        const isAud = aud.includes(s);
        if (!isAud && inBox(tx, ty)) err(map.id, `venue purity: non-audience seat ${s.id} inside the audience seat block (${k})`);
        if (pitTiles.has(k)) err(map.id, `venue purity: seat ${s.id} stands in the stage pit (${k})`);
        if (stageTiles.has(k)) err(map.id, `venue purity: seat ${s.id} stands on the stage platform (${k})`);
        if (!isAud && !pitTiles.has(k) && !stageTiles.has(k) && inApron(tx, ty)) {
          err(map.id, `venue apron: non-audience seat ${s.id} crowds the audience seat block (${k}) — keep one clear tile around the venue`);
        }
        if (isAud && s.dir !== 'up') err(map.id, `venue geometry: audience seat ${s.id} aims '${s.dir}' — uniform venues face the stage ('up')`);
      }
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
        const ch = tileAt(map, tx, ty);
        if (!WALKABLE.has(ch) && !speakerTiles.has(`${tx},${ty}`)) {
          err(map.id, `venue purity: solid/grid dressing '${ch}' inside the audience seat block (${tx},${ty})`);
        }
      }
      for (const k of pitTiles) {
        const [tx, ty] = k.split(',').map(Number);
        const ch = tileAt(map, tx, ty);
        if (!WALKABLE.has(ch) && !speakerTiles.has(k)) {
          err(map.id, `venue purity: solid/grid dressing '${ch}' inside the stage pit (${k})`);
        }
      }
      // Item B: width equality + alignment on the audience axis.
      const west = st.pit.x < st.x;
      if (west) {
        if (st.h !== TILE * (y1 - y0 + 1) || st.pit.h !== st.h) {
          err(map.id, `venue width: west-face stage/pit height (${st.h / TILE}t) != seat block height (${y1 - y0 + 1}t)`);
        }
        if (tileOfPx(st.y) !== y0 || tileOfPx(st.pit.y) !== y0) {
          err(map.id, 'venue width: west-face stage/pit not aligned to the seat block span');
        }
      } else {
        if (st.w !== TILE * (x1 - x0 + 1) || st.pit.w !== st.w) {
          err(map.id, `venue width: stage/pit width (${st.w / TILE}t) != seat block width (${x1 - x0 + 1}t)`);
        }
        if (tileOfPx(st.x) !== x0 || tileOfPx(st.pit.x) !== x0) {
          err(map.id, 'venue width: stage/pit not aligned to the seat block span');
        }
      }
      // UNIFORM VENUE GEOMETRY (v1.3.1, Item 3): the platform
      // stands against the venue's BACK (north) wall — its top
      // edge within the map's first 6 tile rows — with the pit
      // directly in front (south) of it and every audience seat
      // behind the pit, facing the stage rect (screen bearing
      // >= 0.7). This REPLACES the v1.2 Item P profile-row rule.
      if (!(st.pit.y > st.y)) {
        err(map.id, 'venue geometry: the pit is not in front (south) of the stage — uniform venues face south into their audience');
      }
      if (tileOfPx(st.y) > 6) {
        err(map.id, `venue geometry: stage top edge at tile row ${tileOfPx(st.y)} — stages stand against the back wall (row <= 6)`);
      }
      const pitBackRow = tileOfPx(st.pit.y + st.pit.h - 1);
      for (const s of aud) {
        if (tileOfPx(s.y) <= pitBackRow) {
          err(map.id, `venue geometry: audience seat ${s.id} is not behind the pit`);
          continue;
        }
        // Bearing to the NEAREST point of the stage rect (the
        // stage front at the seat's own column): tile-north
        // projects to screen up-right, so a cardinal facing caps
        // at 0.447 for a due-north frontage — 'up' (checked above)
        // is the only facing that presents the sitter's back to
        // the camera toward the stage, and 0.4 is its floor here.
        const nx = Math.max(st.x, Math.min(st.x + st.w, s.x));
        const ny = Math.max(st.y, Math.min(st.y + st.h, s.y));
        const dot = screenDot(s.dir, nx - s.x, ny - s.y);
        if (dot < 0.4) err(map.id, `venue geometry: audience seat ${s.id} faces '${s.dir}' (screen bearing to stage front ${dot.toFixed(2)}) — audience seats aim at the stage`);
      }
    }
  }

  // -- casino interact spots
  if (map.casino) {
    for (const s of map.casino.slots) {
      if (collides(map, s.ix, s.iy, 6)) err(map.id, `slot ${s.id} interact spot is embedded in a solid tile`);
    }
    if (map.casino.bar && collides(map, map.casino.bar.x, map.casino.bar.y, 6)) {
      err(map.id, 'bar patron spot is embedded in a solid tile');
    }
  }

  // -- club spots (v1.4, Club Mirage): the bar's patron spot and
  // every dancer's platform spot must be standable floor, and
  // every stage must carry exactly one named dancer fixture.
  if (map.club) {
    if (map.club.bar && collides(map, map.club.bar.x, map.club.bar.y, 6)) {
      err(map.id, 'club bar patron spot is embedded in a solid tile');
    }
    if (!map.club.bartender || !map.club.bartender.name) err(map.id, 'club has no named bartender');
    for (const stg of map.club.stages || []) {
      const d = stg.dancer;
      if (!d || !d.name) { err(map.id, `club stage ${stg.id} has no dancer fixture`); continue; }
      if (collides(map, d.x, d.y, 6)) err(map.id, `dancer ${d.name} (${stg.id}) is embedded in a solid tile`);
      if (!(d.x >= stg.x && d.x < stg.x + stg.w && d.y >= stg.y && d.y < stg.y + stg.h)) {
        err(map.id, `dancer ${d.name} stands outside her stage rect (${stg.id})`);
      }
    }
  }

  // -- v1.3.1 (chair-spacing pass) laws
  // SEAT SPACING BANDS (Items 1/7/8): chairs near a round table
  // belong to its group and must sit in the 46-58px band from the
  // table's centre — never crammed into the tabletop (the old
  // 32px ring: "i'm sitting in the tables"), never floating.
  for (const tp of (map.props || []).filter(p => p.kind === 'table')) {
    for (const s of map.seats || []) {
      if (s.kind !== 'chair') continue;
      const d = Math.hypot(s.x - tp.x, s.y - tp.y);
      if (d <= 70 && (d < 46 || d > 58)) {
        err(map.id, `table band: chair ${s.id} sits ${d.toFixed(0)}px from the table at (${tileOfPx(tp.x)},${tileOfPx(tp.y)}) — table-group chairs keep a 46-58px gap band`);
      }
    }
  }
  if (map.casino) {
    // Poker chairs: 55-66px from their table's centre (Item 7 —
    // the old 44px ring tucked cushions half under the felt).
    for (const t of map.casino.tables) {
      for (const c of t.chairs) {
        const d = Math.hypot(c.x - t.x, c.y - t.y);
        if (d < 55 || d > 66) err(map.id, `poker band: ${t.id} chair ${c.dir} sits ${d.toFixed(0)}px from the table centre — poker chairs keep a 55-66px band`);
      }
    }
    // Slot stools (Item 8; REBUILT v1.4.1 seat audit; EXTENDED
    // v1.6 slot-row fix): the v1.4.1 law modelled the stool's
    // true art bbox in true screen geometry — but only ever
    // tested it against the stool's OWN cabinet. The east row's
    // cabinets sit at a (46, 23) screen pitch while the seat art
    // was the 60px-wide table chair, so every east stool's
    // cushion landed inside the NEXT cabinet south's rect (its
    // centre included) and the law passed it — Zan's circled
    // "chairs ON the slots" shipped straight through the gate.
    // The law now tests EVERY slot seat, with the art bbox of
    // the kind it actually is (stool diamond / chair bbox),
    // against EVERY cabinet rect in the map. A slot seat of any
    // other kind is the same failure by name: slot seats are
    // stools, sized for the rows, clear of every machine.
    for (const sl of map.casino.slots) {
      const seat = (map.seats || []).find(s => s.id === sl.seatId);
      const dir = seat ? seat.dir : 'up';
      const kind = seat ? seat.kind : 'stool';
      const [msx, msy] = projS(sl.x, sl.y);
      const [isx, isy] = projS(sl.ix, sl.iy);
      for (const other of map.casino.slots) {
        const [osx, osy] = projS(other.x, other.y);
        const rx0 = osx + CABINET_RECT.x[0], rx1 = osx + CABINET_RECT.x[1];
        const ry0 = osy + CABINET_RECT.y[0], ry1 = osy + CABINET_RECT.y[1];
        let hit;
        if (kind === 'stool') {
          hit = diamondRectHit(isx, isy + STOOL_D.dy, STOOL_D.hw, STOOL_D.hh, rx0, ry0, rx1, ry1);
        } else {
          const bb = SEAT_BBOX[dir] || SEAT_BBOX.up;
          hit = (isx + bb.x[1] > rx0) && (isx + bb.x[0] < rx1)
            && (isy + bb.y[1] > ry0) && (isy + bb.y[0] < ry1);
        }
        if (hit) {
          const whose = other.id === sl.id ? 'its cabinet\'s screen rect' : `${other.id}'s cabinet screen rect`;
          err(map.id, `slot footprint: ${sl.id}'s seat (kind '${kind}', dir '${dir}') intersects ${whose} — slot seats sit IN FRONT of their machine and clear EVERY cabinet, never on one (v1.6)`);
          break;
        }
      }
      const distS = Math.hypot(isx - msx, isy - msy);
      if (distS > 75) err(map.id, `slot footprint: ${sl.id}'s stool floats ${distS.toFixed(0)} screen-px from its machine (cap 75)`);
    }
    // Poker chairs (v1.4.1): the sitter's cushion CENTRE must stay
    // outside the table's felt ellipse in screen space — the band
    // above keeps the ring honest, this keeps a chair from ever
    // sitting IN the table.
    for (const t of map.casino.tables) {
      const [tsx, tsy] = projS(t.x, t.y);
      for (const c of t.chairs) {
        const [csx, csy] = projS(c.x, c.y);
        const e = ((csx - tsx) / 44) ** 2 + ((csy - tsy) / 23) ** 2;
        if (e <= 1) err(map.id, `poker footprint: ${t.id} chair ${c.dir}'s cushion centre sits inside the felt ellipse — chairs ring the table, never sit in it`);
      }
    }
  }
  // -- SEAT FOOTPRINT LAW (v1.4.1, the seat audit) ---------------
  // Zan's live playtest found three faces of one class: seats whose
  // art lands ON the furniture they serve (club bar stools on the
  // counter, casino stools over the slot cabinets). The class is
  // screen-space: the render scales positions by ZOOM 0.72 but
  // draws furniture at fixed screen sizes, so world-space bands
  // passed data the screen rejected. Three rules pin it:
  //
  // (B) TALL FURNITURE: a chair/stool seat's CUSHION diamond may
  //     not overlap the raised TOP-FACE diamond of any '#'/'W'
  //     tile (walls and old-style counters extrude WALL_H=20px —
  //     cushion height). One tile north of an extruded counter is
  //     exactly this geometry, which is why bar counters are 'B'
  //     (flat) by construction now. Poker chairs are checked with
  //     their client-derived facing.
  // (C) BAR CONSTRUCTION: in casino maps any interior (non-border)
  //     'W' tile is a counter wearing a wall's extrusion — fail.
  //     In the club any interior '#' tile likewise. And every bar
  //     stool (a non-slot 'stool' seat in a casino, every 'stool'
  //     in the club) must stand exactly one tile north of a 'B'
  //     counter tile in its own column — the patron side, at the
  //     counter, never on it or behind it.
  // (D) SPRITE PATH: seat kinds are a closed set (an unknown kind
  //     silently falls into the client's chair branch), and
  //     audience seats (ids >= 101) are ALWAYS kind 'audience' —
  //     the dedicated venue-chair art (drawAudienceChairAt).
  //     (v1.4.1 pinned them to 'chair'; v1.5.1 flips the pin: the
  //     generic table chair's panel back read as a crate in a
  //     20-seat block, so the audience path is its own kind now.)
  {
    const tallTiles = [];
    map.tiles.rows.forEach((row, ty) => {
      [...row].forEach((ch, tx) => { if (ch === '#' || ch === 'W') tallTiles.push([tx, ty]); });
    });
    const cushionVsTall = (sx2, sy2, label) => {
      const stx = tileOfPx(sx2), sty = tileOfPx(sy2);
      const [csx, csy] = projS(sx2, sy2 + 0); // seat point in screen space
      for (const [tx, ty] of tallTiles) {
        if (Math.max(Math.abs(tx - stx), Math.abs(ty - sty)) > 3) continue;
        const [tsx, tsy] = projS((tx + 0.5) * TILE, (ty + 0.5) * TILE);
        if (diamondHit(csx, csy + CUSHION_D.dy, CUSHION_D.hw, CUSHION_D.hh,
          tsx, tsy + WALLTOP_D.dy, WALLTOP_D.hw, WALLTOP_D.hh)) {
          err(map.id, `seat footprint: ${label}'s cushion overlaps the raised top face of the '${tileAt(map, tx, ty)}' tile at (${tx},${ty}) — a seat against tall furniture reads as sitting ON it; counters are flat 'B' tiles, and chairs keep off wall tops (v1.4.1)`);
          return;
        }
      }
    };
    for (const s of map.seats || []) {
      if (s.kind === 'chair' || s.kind === 'stool' || s.kind === 'audience') cushionVsTall(s.x, s.y, `seat ${s.id}`);
    }
    if (map.casino) {
      for (const t of map.casino.tables) {
        for (const c of t.chairs) cushionVsTall(c.x, c.y, `${t.id} poker chair ${c.dir}`);
      }
    }
    // (C) bar construction
    const isBorder = (tx, ty) => tx === 0 || ty === 0 || tx === map.tiles.w - 1 || ty === map.tiles.h - 1;
    if (map.casino) {
      map.tiles.rows.forEach((row, ty) => {
        [...row].forEach((ch, tx) => {
          if (ch === 'W' && !isBorder(tx, ty)) err(map.id, `bar construction: interior 'W' tile at (${tx},${ty}) — a casino counter drawn as a wall extrudes its top to stool-cushion height ("chairs on the bar"); counters are 'B' tiles (v1.4.1)`);
        });
      });
    }
    if (map.club) {
      map.tiles.rows.forEach((row, ty) => {
        [...row].forEach((ch, tx) => {
          if (ch === '#' && !isBorder(tx, ty)) err(map.id, `bar construction: interior '#' tile at (${tx},${ty}) — the club's counter drawn as a wall cube puts its top at stool-cushion height ("chairs on the bar"); counters are 'B' tiles (v1.4.1)`);
        });
      });
    }
    const slotSeatIds = new Set((map.casino ? map.casino.slots : []).map(sl => sl.seatId));
    for (const s of map.seats || []) {
      if (s.kind !== 'stool' || slotSeatIds.has(s.id)) continue;
      if (!map.casino && !map.club) continue;
      const tx = tileOfPx(s.x), ty = tileOfPx(s.y);
      if (tileAt(map, tx, ty + 1) !== 'B') {
        err(map.id, `bar construction: bar stool ${s.id} at (${tx},${ty}) does not face a 'B' counter one tile south (found '${tileAt(map, tx, ty + 1)}') — bar stools stand on the patron side, one tile north of the counter (v1.4.1)`);
      }
    }
    // (D) sprite path: closed kind set + audience is always
    // 'audience'. v1.5.1: the pin flips — venue audience seats
    // resolve to the AUDIENCE chair art (drawAudienceChairAt),
    // not the generic table chair whose panel-filled back read
    // as a crate in a 20-seat block. An audience seat on any
    // other path (or a kind outside the closed set) fails here.
    const SEAT_KINDS = new Set(['chair', 'stool', 'sofa', 'bench', 'cafe', 'hookah', 'towel', 'audience']);
    for (const s of map.seats || []) {
      if (!SEAT_KINDS.has(s.kind)) err(map.id, `sprite path: seat ${s.id} has unknown kind '${s.kind}' — kinds are a closed set; table chairs are 'chair', venue audience chairs are 'audience' (v1.5.1)`);
      const m = /-seat-(\d+)$/.exec(s.id);
      if (m && Number(m[1]) >= 101 && s.kind !== 'audience') {
        err(map.id, `sprite path: audience seat ${s.id} is kind '${s.kind}' — audience seats always resolve to the audience chair art (kind 'audience') (v1.5.1)`);
      }
    }
  }
  // ARRANGEMENT LAW (Item 5): a seat may exist ONLY inside a
  // registered arrangement. Auto-detected: audience grid, casino
  // floor, hookah station, table group (in the band), hearth arc
  // (near a hearth AND aiming at it), beach towel unit (by an
  // umbrella). Everything else must be named in REGISTERED_SEATS.
  const REGISTERED_SEATS = {
    'the-gateway': new Set([1, 2, 3, 4, 5, 6, 15, 16]), // fountain ring + pond-bank nook
    'solstice-bay': new Set([5, 6]),                    // venue-flank bench pair
    'neon-district': new Set([1, 2, 6, 7]),             // street benches + market nook sofas
    'cinder-mesa': new Set([5]),                        // forge nook sofa
    'verdant-hollow': new Set([6, 7]),                 // grove nook sofa + chair
  };
  const seatArrangement = (s) => {
    const m = /-seat-(\d+)$/.exec(s.id);
    const n = m ? Number(m[1]) : -1;
    if (n >= 101) return 'audience grid';
    if (map.casino) return 'casino floor';
    if (map.club && s.kind === 'stool') {
      // v1.4: the club's bar stools belong to the bar arrangement.
      const b = map.club.bar;
      if (b && Math.max(Math.abs(tileOfPx(s.x) - tileOfPx(b.x)), Math.abs(tileOfPx(s.y) - tileOfPx(b.y))) <= 3) return 'club bar';
    }
    if (s.kind === 'hookah') return 'hookah station';
    if (s.kind === 'towel') {
      const near = (map.props || []).some(pr => pr.kind === 'umbrella'
        && Math.max(Math.abs(tileOfPx(pr.x) - tileOfPx(s.x)), Math.abs(tileOfPx(pr.y) - tileOfPx(s.y))) <= 2);
      return near ? 'beach towel unit' : null;
    }
    if (s.kind === 'chair' && (map.props || []).some(pr => pr.kind === 'table'
      && Math.hypot(s.x - pr.x, s.y - pr.y) >= 46 && Math.hypot(s.x - pr.x, s.y - pr.y) <= 58)) return 'table group';
    for (const hp of (map.props || []).filter(p => p.kind === 'hearth')) {
      if ((s.kind === 'chair' || s.kind === 'sofa')
        && Math.max(Math.abs(tileOfPx(s.x) - tileOfPx(hp.x)), Math.abs(tileOfPx(s.y) - tileOfPx(hp.y))) <= 6
        && screenDot(s.dir, hp.x - s.x, hp.y - s.y) >= 0.55) return 'hearth arc';
    }
    if (REGISTERED_SEATS[map.id] && REGISTERED_SEATS[map.id].has(n)) return 'registered nook';
    return null;
  };
  for (const s of map.seats || []) {
    if (!seatArrangement(s)) {
      err(map.id, `arrangement law: seat ${s.id} (kind '${s.kind}') at (${tileOfPx(s.x)},${tileOfPx(s.y)}) belongs to no registered arrangement — lone chairs are deleted, not kept (Item 5)`);
    }
  }
  // PROP ANCHOR LAW (Items 4/14/15): every prop — base and
  // seasonal alike — must anchor to a feature (door, gatehouse,
  // building frontage, stage/pit, water, a hero prop), cluster
  // with other props, or stand in a populated named area. A prop
  // in open ground with none of those is scatter, and scatter is
  // what Zan keeps circling in screenshots.
  {
    const HERO_KINDS = new Set(['hearth', 'forge', 'fountain', 'greattree', 'lighthouse', 'icesculpt', 'neonsign', 'stall', 'volleyball']);
    const nearAny = (set, tx, ty, r) => {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (set.has(`${tx + dx},${ty + dy}`)) return true;
      return false;
    };
    const featureTiles = new Set();
    const waterTiles = new Set();
    map.tiles.rows.forEach((row, ty) => { [...row].forEach((ch, tx) => { if (ch === '%') waterTiles.add(`${tx},${ty}`); }); });
    for (const p of [...(map.doors || []), ...(map.gateways || [])]) {
      for (const [tx, ty] of rectTiles(p)) featureTiles.add(`${tx},${ty}`);
    }
    for (const b of map.buildings || []) {
      for (let ty = b.ty; ty < b.ty + b.th; ty++) for (let tx = b.tx; tx < b.tx + b.tw; tx++) featureTiles.add(`${tx},${ty}`);
    }
    if (map.stage) {
      for (const [tx, ty] of [...rectTiles(map.stage), ...rectTiles(map.stage.pit)]) featureTiles.add(`${tx},${ty}`);
    }
    if (map.club) {
      // v1.4: the club's stages and bar are anchor features too.
      for (const stg of map.club.stages || []) {
        for (const [tx, ty] of rectTiles(stg)) featureTiles.add(`${tx},${ty}`);
      }
      if (map.club.bar) featureTiles.add(`${tileOfPx(map.club.bar.x)},${tileOfPx(map.club.bar.y)}`);
      if (map.club.bartender) featureTiles.add(`${tileOfPx(map.club.bartender.x)},${tileOfPx(map.club.bartender.y)}`);
    }
    const allProps = layers.flatMap(l => l.props.map(pr => ({ ...pr, layer: l.label })));
    for (const pr of allProps) if (HERO_KINDS.has(pr.kind)) featureTiles.add(`${tileOfPx(pr.x)},${tileOfPx(pr.y)}`);
    const areaRects = (map.areas || []).map(a => ({
      name: a.name,
      x0: tileOfPx(a.x), x1: tileOfPx(a.x + a.w - 1), y0: tileOfPx(a.y), y1: tileOfPx(a.y + a.h - 1),
    }));
    for (const pr of allProps) {
      const tx = tileOfPx(pr.x), ty = tileOfPx(pr.y);
      if (nearAny(featureTiles, tx, ty, 4)) continue;
      if (nearAny(waterTiles, tx, ty, 2)) continue;
      if (allProps.some(q => q !== pr && Math.max(Math.abs(tileOfPx(q.x) - tx), Math.abs(tileOfPx(q.y) - ty)) <= 3)) continue;
      const area = areaRects.find(a => tx >= a.x0 && tx <= a.x1 && ty >= a.y0 && ty <= a.y1);
      if (area) {
        const inside = (px2, py2) => {
          const ax = tileOfPx(px2), ay = tileOfPx(py2);
          return ax >= area.x0 && ax <= area.x1 && ay >= area.y0 && ay <= area.y1;
        };
        // Population counts props, seats AND fixed furniture
        // (casino tables/slots) — a cobweb in the corner of a
        // furnished room is room dressing, not open-ground scatter.
        const furnitureTiles = map.casino
          ? [...map.casino.tables.map(t => [t.x, t.y]), ...map.casino.slots.map(sl => [sl.x, sl.y])]
          : [];
        const pop = allProps.filter(q => inside(q.x, q.y)).length
          + (map.seats || []).filter(s => inside(s.x, s.y)).length
          + furnitureTiles.filter(([fx, fy]) => inside(fx, fy)).length;
        if (pop >= 2) continue;
      }
      err(map.id, `prop anchor law: [${pr.layer}] prop "${pr.kind}" at (${tx},${ty}) anchors to nothing — no feature within 4 tiles, no cluster, no populated area. Open-ground scatter is deleted, not kept (Items 4/14/15)`);
    }
  }
}

// -- seasonal layers must name real maps (a typo'd key would
// silently dress nothing at all)
for (const [seasonName, layer] of Object.entries(SEASONAL)) {
  for (const mapId of Object.keys(layer)) {
    if (!MAPS[mapId]) err(mapId, `seasonal layer "${seasonName}" names an unknown map`);
  }
}

// -- interiors: exactly one inbound door each (one facade entrance)
for (const map of Object.values(MAPS)) {
  const inbound = [];
  for (const m2 of Object.values(MAPS)) {
    for (const d of m2.doors || []) if (d.target === map.id) inbound.push(`${m2.id}:"${d.label}"`);
  }
  const isInterior = inbound.length > 0 && !(map.gateways || []).length;
  if (isInterior && inbound.length !== 1) {
    warn(map.id, `interior has ${inbound.length} inbound doors (${inbound.join(', ')}); expected exactly one facade entrance`);
  }
}

console.log('=== Solarion dressing validator ===');
for (const n of notes) console.log(`  note: ${n}`);
if (warnings.length) {
  console.log(`\nWARNINGS (${warnings.length}):`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}
if (errors.length) {
  console.log(`\nERRORS (${errors.length}):`);
  for (const e of errors) console.log(`  ✖ ${e}`);
  console.log('\nVERDICT: ❌ FAIL');
  process.exit(1);
}
console.log(`\nVERDICT: ✅ PASS (${Object.keys(MAPS).length} maps, ${warnings.length} warning(s))`);
