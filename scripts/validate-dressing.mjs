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

const KNOWN_CHARS = new Set(['.', '#', '%', '|', 'W', 'C']);
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
  for (const pr of map.props || []) {
    const k = `${tileOfPx(pr.x)},${tileOfPx(pr.y)}`;
    if (portalTiles.has(k)) err(map.id, `prop "${pr.kind}" sits on a door/gateway tile (${k})`);
  }
  for (const s of map.seats || []) {
    const k = `${tileOfPx(s.x)},${tileOfPx(s.y)}`;
    if (portalTiles.has(k)) err(map.id, `seat ${s.id} sits on a door/gateway tile (${k})`);
    if (collides(map, s.x, s.y, 6)) err(map.id, `seat ${s.id} is embedded in a solid tile`);
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
