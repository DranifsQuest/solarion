'use strict';

/**
 * Solarion — tile pathfinding (Phase 9).
 *
 * BFS over the scene's tile grid; a tile is passable when a player
 * circle at its centre does not collide (reuses maps.collides, so
 * the path can never route somewhere the movement sim would refuse).
 * The raw grid path is then smoothed greedily: from each point, jump
 * to the furthest waypoint visible in a straight line (sampled
 * collision checks), which turns stair-step BFS output into natural
 * walking lines. Server-side only — clients send a destination, the
 * server owns the route (same trust model as input intents).
 */

const { TILE, collides } = require('./maps');

const RADIUS = 12; // mirrors game.PLAYER_RADIUS
const MAX_TILES = 5000; // expansion cap (largest scene is 72x45 = 3240)

function tileWalkable(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.tiles.w || ty >= map.tiles.h) return false;
  return !collides(map, tx * TILE + TILE / 2, ty * TILE + TILE / 2, RADIUS);
}

/** Nearest walkable tile to (tx, ty), spiral search up to `maxR` tiles. */
function nearestWalkable(map, tx, ty, maxR = 6) {
  if (tileWalkable(map, tx, ty)) return { tx, ty };
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (tileWalkable(map, tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
    }
  }
  return null;
}

/** Straight-line visibility between two px points (sampled). */
function losClear(map, x0, y0, x1, y1) {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(dist / (TILE / 2)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (collides(map, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, RADIUS)) return false;
  }
  return !collides(map, x1, y1, RADIUS);
}

/**
 * Find a smoothed waypoint path (px points) from (sx, sy) to (tx, ty)
 * in pixel space. Returns null when no route exists.
 */
function findPath(map, sx, sy, tx, ty) {
  const start = nearestWalkable(map, Math.floor(sx / TILE), Math.floor(sy / TILE), 2);
  const goalRaw = { tx: Math.floor(tx / TILE), ty: Math.floor(ty / TILE) };
  const goal = nearestWalkable(map, goalRaw.tx, goalRaw.ty, 6);
  if (!start || !goal) return null;
  // Direct line? Then it's a single waypoint (the exact destination).
  if (losClear(map, sx, sy, tx, ty)) return [{ x: tx, y: ty }];

  const W = map.tiles.w, H = map.tiles.h;
  const key = (x, y) => y * W + x;
  const prev = new Map();
  const seen = new Set([key(start.tx, start.ty)]);
  const queue = [[start.tx, start.ty]];
  let found = false;
  let expansions = 0;
  while (queue.length && expansions < MAX_TILES) {
    const [cx, cy] = queue.shift();
    expansions++;
    if (cx === goal.tx && cy === goal.ty) { found = true; break; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      // Diagonal-free BFS; corner cutting is impossible by construction.
      if (!tileWalkable(map, nx, ny)) continue;
      seen.add(k);
      prev.set(k, key(cx, cy));
      queue.push([nx, ny]);
    }
  }
  if (!found && !(start.tx === goal.tx && start.ty === goal.ty)) {
    // The goal may have been enqueued but not expanded before the cap.
    if (!seen.has(key(goal.tx, goal.ty))) return null;
  }
  // Rebuild the tile path.
  const tiles = [];
  let k = key(goal.tx, goal.ty);
  const startK = key(start.tx, start.ty);
  tiles.push([goal.tx, goal.ty]);
  while (k !== startK) {
    const p = prev.get(k);
    if (p === undefined) break;
    k = p;
    tiles.push([k % W, Math.floor(k / W)]);
  }
  tiles.reverse();
  const pts = tiles.map(([x, y]) => ({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }));
  pts[pts.length - 1] = { x: tx, y: ty }; // finish at the exact click point
  // Greedy smoothing: keep only the corners that matter.
  const out = [];
  let anchor = { x: sx, y: sy };
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !losClear(map, anchor.x, anchor.y, pts[j].x, pts[j].y)) j--;
    out.push(pts[j]);
    anchor = pts[j];
    i = j + 1;
  }
  return out;
}

module.exports = { findPath, tileWalkable, nearestWalkable };
