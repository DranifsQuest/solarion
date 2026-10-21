'use strict';

/**
 * Solarion — private studios (Phase 4, soul doc §5 + §9.15/17/18).
 *
 * Each account owns ONE studio: an instanced scene keyed
 * `studio:<ownerUserId>`, built from a single cozy template
 * (20×14 tiles, door on the south wall). Studios are NOT in the static
 * MAPS registry — game.js resolves a scene id through studioMapForId()
 * so presence, movement, snapshots and per-scene chat work exactly
 * like a public map for the players inside, and players in different
 * studios never see or hear each other.
 *
 * Furniture: a fixed original catalog (this module owns it). Buying is
 * an atomic z-coin debit (`UPDATE ... WHERE zcoins >= price`) inside a
 * transaction with the inventory insert — a failed guard means "not
 * enough funds", never a negative balance and never a free item.
 * Placement is owner-only, in your own studio only, inside the room,
 * never on the door tile, rotations 0–3, max 100 placed items
 * (soul doc §5). Everything persists in the `studio_items` table, so
 * furniture survives relogs and full server restarts.
 *
 * Visiting is public by default in v1. The owner can kick a visitor:
 * they land back in the Gateway and are blocked from re-entering that
 * studio for 10 minutes (in-memory blocklist keyed by studio owner).
 *
 * Client -> server:
 *   { type:'enter-studio', owner }          username or userId
 *   { type:'leave-studio' }
 *   { type:'studio-buy', itemId }           (in your OWN studio only)
 *   { type:'studio-place', instanceItemId, x, y, rot }   tile coords
 *   { type:'studio-pickup', instanceItemId }
 *   { type:'studio-kick', userId }          (or { username })
 *   { type:'studio-state' }                 re-request your state
 * Server -> client:
 *   { type:'map', ..., studio:{...}, furniture:[...] }   on entry
 *   { type:'studio-state', ownerId, ownerName, isOwner, catalog?, inventory?, furniture }
 *   { type:'studio-furniture', ownerId, furniture }      live placement updates
 *   { type:'zcoins', zcoins }                            after a purchase
 *
 * Phase 8 — player homes. The catalog grew from 14 to 44 items
 * (beds, 9 sittable chairs/sofas, shelves, rugs, lamps/plants/wall
 * decor, TVs, radios). Placed TVs and radios are DEVICES: their
 * state lives in the `studio_devices` table (server-side, persisted
 * across relogs and restarts) and syncs live to everyone in the room
 * via { type:'home-device' }. Documented choice: ANYONE present in
 * the room — owner or visitor — may work the TV and the radio; it's
 * a social room, and the furniture itself stays owner-only.
 *
 *   { type:'home-device', instanceId, action, ... }   tv/radio control
 *   { type:'home-device', ownerId, device }           state broadcast
 *        (device === null when a device is picked up / removed)
 *
 * Room invites: the owner invites any ONLINE player from anywhere;
 * the invitee gets { type:'studio-invite' } and answers with
 * { type:'studio-invite-response', ownerId, accept }. Accepting runs
 * the standard enter flow (3s load-screen transfer) and OVERRIDES a
 * kick block — an invite is a fresh, one-shot ride in, never
 * standing access; the owner's kick stays absolute afterwards.
 *
 *   { type:'studio-invite', username }  (or { userId })
 *   { type:'studio-invite-response', ownerId, accept }
 */

const { db, q } = require('./db');
const { TILE } = require('./maps');
const music = require('./music');

// ---------------------------------------------------------------- template
const STUDIO_W = 20;
const STUDIO_H = 14;
const STUDIO_DOOR = { x: 10, y: 13 };        // tile coords, south wall
const MAX_PLACED = 100;                      // soul doc §5 room cap
const KICK_BLOCK_MS = 10 * 60 * 1000;        // 10-minute re-entry block

// ---------------------------------------------------------------- Phase 9: homes v2
// Size tiers (expansion keeps the top-left origin, so every placed
// item's tile coords stay valid), wall paints and floor styles.
const HOME_TIERS = [
  { name: 'Studio', w: 20, h: 14, price: 0 },
  { name: 'Loft', w: 24, h: 17, price: 1500 },
  { name: 'Penthouse', w: 28, h: 20, price: 4000 },
];
const WALL_STYLES = [
  { name: 'Warm Wood', wall: '#4a3423' },
  { name: 'Midnight', wall: '#10151f' },
  { name: 'Sunset Plum', wall: '#4a2436' },
  { name: 'Sage', wall: '#24382b' },
  { name: 'Slate', wall: '#2b2f36' },
];
const FLOOR_STYLES = [
  { name: 'Classic Wood', floor: '#8a6844', floorAlt: '#7f613e' },
  { name: 'Marble', floor: '#cfd4da', floorAlt: '#bcc2ca' },
  { name: 'Neon Grid', floor: '#1b2340', floorAlt: '#232c52' },
  { name: 'Meadow', floor: '#3f7a3d', floorAlt: '#356b34' },
];
const HOME_NAME_MAX = 30;

function buildStudioRows(w, h) {
  const doorX = Math.floor(w / 2);
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      if (y === h - 1 && x === doorX) row += '.';
      else if (x === 0 || y === 0 || x === w - 1 || y === h - 1) row += '#';
      else row += '.';
    }
    rows.push(row);
  }
  return rows;
}

let SQ_META = null;
function getHomeMeta(ownerId) {
  const row = SQ_META ? SQ_META.get.get(ownerId) : null;
  return {
    name: row && row.name ? row.name : null,
    wall: row ? Math.min(WALL_STYLES.length - 1, Math.max(0, row.wall)) : 0,
    floor: row ? Math.min(FLOOR_STYLES.length - 1, Math.max(0, row.floor)) : 0,
    tier: row ? Math.min(HOME_TIERS.length - 1, Math.max(0, row.tier)) : 0,
    locked: row ? Boolean(row.locked) : false,
  };
}

function setHomeMeta(ownerId, patch) {
  const cur = getHomeMeta(ownerId);
  const next = { ...cur, ...patch };
  SQ_META.set.run(ownerId, next.name, next.wall, next.floor, next.tier, next.locked ? 1 : 0);
  return next;
}

function isHomeLocked(ownerId) {
  return getHomeMeta(ownerId).locked;
}

const STUDIO_ROWS = (() => {
  const rows = [];
  for (let y = 0; y < STUDIO_H; y++) {
    let row = '';
    for (let x = 0; x < STUDIO_W; x++) {
      if (y === STUDIO_DOOR.y && x === STUDIO_DOOR.x) row += '.';
      else if (x === 0 || y === 0 || x === STUDIO_W - 1 || y === STUDIO_H - 1) row += '#';
      else row += '.';
    }
    rows.push(row);
  }
  return rows;
})();

function parseStudioId(sceneId) {
  if (typeof sceneId !== 'string') return null;
  const m = /^studio:(\d+)$/.exec(sceneId);
  return m ? Number(m[1]) : null;
}

function isStudioId(sceneId) {
  return parseStudioId(sceneId) !== null;
}

/** Build the scene object for one owner's studio (data-shaped like a map). */
function studioMapFor(ownerId, ownerName) {
  const name = ownerName || (q.userById.get(ownerId) || {}).username || 'Private';
  const meta = getHomeMeta(ownerId);
  const tier = HOME_TIERS[meta.tier];
  const fl = FLOOR_STYLES[meta.floor];
  const wl = WALL_STYLES[meta.wall];
  const doorX = Math.floor(tier.w / 2);
  return {
    id: `studio:${ownerId}`,
    name: meta.name || `${name}'s Studio`,
    tiles: { rows: buildStudioRows(tier.w, tier.h), w: tier.w, h: tier.h },
    tileSize: TILE,
    floor: fl.floor,
    floorAlt: fl.floorAlt,
    wall: wl.wall,
    spawn: { x: doorX * TILE + TILE / 2, y: (tier.h - 3) * TILE + TILE / 2 },
    gateways: [],
    isStudio: true,
    ownerId,
    studio: {
      ownerId,
      ownerName: name,
      door: { x: doorX * TILE, y: (tier.h - 1) * TILE, w: TILE, h: TILE },
    },
  };
}

function studioMapForId(sceneId) {
  const ownerId = parseStudioId(sceneId);
  return ownerId === null ? null : studioMapFor(ownerId);
}

// ---------------------------------------------------------------- catalog
// Phase 8: 44 original items. All footprints are 1 tile (the system
// has always been 1-tile; beds included — stated per item in v1 and
// kept consistent). `type` drives behavior: 'seating' items work with
// the Phase B sitting system inside homes (game.seatsInScene picks
// them up automatically), 'rug' renders flat under everything, 'tv'
// and 'radio' are devices with server-side state (below). `cat` is
// the shop grouping the client renders and the suite counts.
// The original 14 items keep their ids AND prices (save games and
// the Phase 4 suite depend on them).
const CATALOG = [
  // ---- the original 14 (Phase 4)
  { id: 'cozy-chair',    name: 'Cozy Chair',       price: 40,  type: 'seating', cat: 'chairs',  color: '#b5533c', accent: '#7d3524', icon: '🪑', footprint: 1 },
  { id: 'cloud-couch',   name: 'Cloud Couch',      price: 120, type: 'seating', cat: 'chairs',  color: '#3aa7e0', accent: '#2b7cb0', icon: '🛋️', footprint: 1 },
  { id: 'wood-table',    name: 'Wood Table',       price: 60,  type: 'table',   cat: 'decor',   color: '#8a5a2b', accent: '#6e4520', icon: '🟫', footprint: 1 },
  { id: 'coffee-table',  name: 'Coffee Table',     price: 45,  type: 'table',   cat: 'decor',   color: '#a5713a', accent: '#845a2c', icon: '☕', footprint: 1 },
  { id: 'sun-rug',       name: 'Sun Rug',          price: 35,  type: 'rug',     cat: 'rugs',    color: '#ffd23f', accent: '#e0a92e', icon: '🟨', footprint: 1 },
  { id: 'palm-plant',    name: 'Palm Plant',       price: 30,  type: 'plant',   cat: 'decor',   color: '#2e8b57', accent: '#1f6b41', icon: '🌴', footprint: 1 },
  { id: 'glow-lamp',     name: 'Glow Lamp',        price: 55,  type: 'lamp',    cat: 'decor',   color: '#ffe9a3', accent: '#d9b64f', icon: '💡', footprint: 1 },
  { id: 'jukebox',       name: 'Jukebox',          price: 250, type: 'machine', cat: 'decor',   color: '#ff5d8f', accent: '#c23a68', icon: '🎵', footprint: 1 },
  { id: 'speaker',       name: 'Stage Speaker',    price: 90,  type: 'machine', cat: 'decor',   color: '#23262b', accent: '#ffd23f', icon: '🔊', footprint: 1 },
  { id: 'poster',        name: 'Sunset Poster',    price: 25,  type: 'wall',    cat: 'decor',   color: '#ff8c42', accent: '#c25e1e', icon: '🖼️', footprint: 1 },
  { id: 'gold-record',   name: 'Gold Record',      price: 300, type: 'wall',    cat: 'decor',   color: '#ffd700', accent: '#b8960f', icon: '🏆', footprint: 1 },
  // Phase 9 — ritual furniture: trophies are EARNED (25 / 100 lifetime
  // up-votes on one mix, src/records.js), never sold; the chart
  // poster is a normal purchase that opens the Top-40 in your home.
  { id: 'platinum-record', name: 'Platinum Record', price: 1000,  type: 'wall',    cat: 'decor',   color: '#e5e4e2', accent: '#9aa5b1', icon: '💿', footprint: 1, awardOnly: true },
  { id: 'chart-poster',  name: 'Top-40 Chart Poster', price: 60, type: 'wall',   cat: 'decor',   color: '#22304a', accent: '#ffd23f', icon: '📊', footprint: 1 },
  { id: 'neon-sign',     name: 'Neon Sign',        price: 180, type: 'wall',    cat: 'decor',   color: '#ff2e88', accent: '#22d3ee', icon: '✨', footprint: 1 },
  { id: 'dispenser',     name: 'Drink Dispenser',  price: 150, type: 'machine', cat: 'decor',   color: '#e63946', accent: '#a62633', icon: '🥤', footprint: 1 },
  { id: 'bookshelf',     name: 'Bookshelf',        price: 80,  type: 'storage', cat: 'shelves', color: '#6b4226', accent: '#4e2f1a', icon: '📚', footprint: 1 },
  // ---- beds (Phase 8)
  { id: 'single-bed',    name: 'Single Bed',       price: 90,  type: 'bed',     cat: 'beds',    color: '#7aa5d2', accent: '#54749c', icon: '🛏️', footprint: 1 },
  { id: 'double-bed',    name: 'Double Bed',       price: 160, type: 'bed',     cat: 'beds',    color: '#c46a8a', accent: '#9c4f6c', icon: '🛏️', footprint: 1 },
  { id: 'bunk-bed',      name: 'Bunk Bed',         price: 140, type: 'bed',     cat: 'beds',    color: '#8a5a2b', accent: '#6e4520', icon: '🛏️', footprint: 1 },
  { id: 'canopy-bed',    name: 'Canopy Bed',       price: 220, type: 'bed',     cat: 'beds',    color: '#e8e4da', accent: '#b9b2a2', icon: '🛏️', footprint: 1 },
  // ---- chairs & sofas (Phase 8) — all type 'seating' = sittable
  { id: 'dining-chair',  name: 'Dining Chair',     price: 45,  type: 'seating', cat: 'chairs',  color: '#a5713a', accent: '#845a2c', icon: '🪑', footprint: 1 },
  { id: 'armchair',      name: 'Armchair',         price: 85,  type: 'seating', cat: 'chairs',  color: '#4f7d5a', accent: '#38603f', icon: '💺', footprint: 1 },
  { id: 'beanbag',       name: 'Beanbag',          price: 55,  type: 'seating', cat: 'chairs',  color: '#e07b39', accent: '#b85c24', icon: '🟣', footprint: 1 },
  { id: 'rocking-chair', name: 'Rocking Chair',    price: 70,  type: 'seating', cat: 'chairs',  color: '#9c6b30', accent: '#7a5222', icon: '🪑', footprint: 1 },
  { id: 'bar-stool',     name: 'Bar Stool',        price: 35,  type: 'seating', cat: 'chairs',  color: '#59637a', accent: '#3f475c', icon: '🪑', footprint: 1 },
  { id: 'floor-cushion', name: 'Floor Cushion',    price: 25,  type: 'seating', cat: 'chairs',  color: '#d94f4f', accent: '#b03a3a', icon: '🟥', footprint: 1 },
  { id: 'loveseat',      name: 'Loveseat',         price: 150, type: 'seating', cat: 'chairs',  color: '#7a3b4f', accent: '#5d2c3c', icon: '🛋️', footprint: 1 },
  // ---- shelves & storage (Phase 8)
  { id: 'wall-shelf',    name: 'Wall Shelf',       price: 45,  type: 'shelf',   cat: 'shelves', color: '#a5713a', accent: '#845a2c', icon: '🪵', footprint: 1 },
  { id: 'display-shelf', name: 'Display Shelf',    price: 95,  type: 'shelf',   cat: 'shelves', color: '#c8b8a2', accent: '#9c8b74', icon: '🏺', footprint: 1 },
  { id: 'cube-shelf',    name: 'Cube Storage',     price: 65,  type: 'shelf',   cat: 'shelves', color: '#e8e4da', accent: '#b9b2a2', icon: '🗄️', footprint: 1 },
  { id: 'tall-bookcase', name: 'Tall Bookcase',    price: 120, type: 'shelf',   cat: 'shelves', color: '#54381e', accent: '#3d2812', icon: '📚', footprint: 1 },
  // ---- rugs (Phase 8) — flat, walkable, no collision, drawn under all
  { id: 'wave-rug',      name: 'Wave Rug',         price: 40,  type: 'rug',     cat: 'rugs',    color: '#3aa7e0', accent: '#2b7cb0', icon: '🌊', footprint: 1 },
  { id: 'star-rug',      name: 'Star Rug',         price: 45,  type: 'rug',     cat: 'rugs',    color: '#ffd23f', accent: '#e0a92e', icon: '⭐', footprint: 1 },
  { id: 'checker-rug',   name: 'Checker Rug',      price: 50,  type: 'rug',     cat: 'rugs',    color: '#e8e4da', accent: '#23262b', icon: '🏁', footprint: 1 },
  { id: 'rainbow-rug',   name: 'Rainbow Rug',      price: 65,  type: 'rug',     cat: 'rugs',    color: '#ff5d8f', accent: '#22d3ee', icon: '🌈', footprint: 1 },
  { id: 'moon-rug',      name: 'Moon Rug',         price: 55,  type: 'rug',     cat: 'rugs',    color: '#2b3a55', accent: '#171f30', icon: '🌙', footprint: 1 },
  // ---- decor (Phase 8): lamps, plants, side tables, wall art
  { id: 'floor-lamp',    name: 'Floor Lamp',       price: 70,  type: 'lamp',    cat: 'decor',   color: '#ffe9a3', accent: '#c9a227', icon: '💡', footprint: 1 },
  { id: 'cactus',        name: 'Cactus',           price: 35,  type: 'plant',   cat: 'decor',   color: '#2e8b57', accent: '#c46a8a', icon: '🌵', footprint: 1 },
  { id: 'side-table',    name: 'Side Table',       price: 40,  type: 'table',   cat: 'decor',   color: '#6e4520', accent: '#54351a', icon: '🟫', footprint: 1 },
  { id: 'wave-poster',   name: 'Wave Poster',      price: 30,  type: 'wall',    cat: 'decor',   color: '#2f8fb8', accent: '#1f6b8a', icon: '🖼️', footprint: 1 },
  // ---- TVs (Phase 8) — devices: on/off + channel, fake shows
  { id: 'tube-tv',       name: 'Tube TV',          price: 150, type: 'tv',      cat: 'tvs',     color: '#59637a', accent: '#3f475c', icon: '📺', footprint: 1 },
  { id: 'flat-tv',       name: 'Flat TV',          price: 260, type: 'tv',      cat: 'tvs',     color: '#23262b', accent: '#111317', icon: '🖥️', footprint: 1 },
  { id: 'cinema-tv',     name: 'Cinema TV',        price: 400, type: 'tv',      cat: 'tvs',     color: '#171126', accent: '#0d0a16', icon: '🎬', footprint: 1 },
  // ---- radios (Phase 8) — devices: loop library or the owner's mixes
  { id: 'boombox',       name: 'Boombox',          price: 80,  type: 'radio',   cat: 'radios',   color: '#e63946', accent: '#a62633', icon: '📻', footprint: 1 },
  { id: 'retro-radio',   name: 'Retro Radio',      price: 120, type: 'radio',   cat: 'radios',   color: '#8a5a2b', accent: '#6e4520', icon: '📻', footprint: 1 },
  { id: 'hifi-system',   name: 'Hi-Fi System',     price: 200, type: 'radio',   cat: 'radios',   color: '#23262b', accent: '#ffd23f', icon: '🎛️', footprint: 1 },
];
const CATALOG_BY_ID = new Map(CATALOG.map(i => [i.id, i]));

// ---------------------------------------------------------------- tables
let SQ = null;

function init() {
  if (SQ) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS studio_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    x INTEGER,
    y INTEGER,
    rot INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_studio_items_owner ON studio_items(owner_id);
  CREATE TABLE IF NOT EXISTS studio_devices (
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    instance_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (owner_id, instance_id)
  );
  CREATE TABLE IF NOT EXISTS studio_meta (
    owner_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    wall INTEGER NOT NULL DEFAULT 0,
    floor INTEGER NOT NULL DEFAULT 0,
    tier INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0
  );
  `);
  SQ_META = {
    get: db.prepare('SELECT * FROM studio_meta WHERE owner_id = ?'),
    set: db.prepare(`INSERT INTO studio_meta (owner_id, name, wall, floor, tier, locked) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET name = excluded.name, wall = excluded.wall,
        floor = excluded.floor, tier = excluded.tier, locked = excluded.locked`),
  };
  SQ = {
    debit: db.prepare('UPDATE avatars SET zcoins = zcoins - ? WHERE user_id = ? AND zcoins >= ?'),
    zOf: db.prepare('SELECT zcoins FROM avatars WHERE user_id = ?'),
    insertItem: db.prepare('INSERT INTO studio_items (owner_id, item_id, x, y, rot, created_at) VALUES (?, ?, NULL, NULL, 0, ?)'),
    allFor: db.prepare('SELECT * FROM studio_items WHERE owner_id = ? ORDER BY id'),
    placedFor: db.prepare('SELECT * FROM studio_items WHERE owner_id = ? AND x IS NOT NULL ORDER BY id'),
    placedCount: db.prepare('SELECT COUNT(*) AS n FROM studio_items WHERE owner_id = ? AND x IS NOT NULL'),
    byIdOwner: db.prepare('SELECT * FROM studio_items WHERE id = ? AND owner_id = ?'),
    place: db.prepare('UPDATE studio_items SET x = ?, y = ?, rot = ? WHERE id = ? AND owner_id = ?'),
    unplace: db.prepare('UPDATE studio_items SET x = NULL, y = NULL WHERE id = ? AND owner_id = ?'),
    devGet: db.prepare('SELECT * FROM studio_devices WHERE owner_id = ? AND instance_id = ?'),
    devSet: db.prepare(`INSERT INTO studio_devices (owner_id, instance_id, kind, state) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, instance_id) DO UPDATE SET kind = excluded.kind, state = excluded.state`),
    devDel: db.prepare('DELETE FROM studio_devices WHERE owner_id = ? AND instance_id = ?'),
  };
}

function decorate(row) {
  const def = CATALOG_BY_ID.get(row.item_id) || {};
  return {
    instanceId: row.id,
    itemId: row.item_id,
    name: def.name || row.item_id,
    type: def.type || 'furniture',
    cat: def.cat || 'decor',
    color: def.color || '#888888',
    accent: def.accent || '#555555',
    icon: def.icon || '📦',
    price: def.price || 0,
    x: row.x, y: row.y, rot: row.rot,
    placed: row.x !== null && row.x !== undefined,
  };
}

function getPlaced(ownerId) {
  return SQ.placedFor.all(ownerId).map(decorate);
}

function getInventory(ownerId) {
  return SQ.allFor.all(ownerId).map(decorate);
}

function zcoinsOf(userId) {
  const r = SQ.zOf.get(userId);
  return r ? r.zcoins : 0;
}

// ---------------------------------------------------------------- devices
// Phase 8: placed TVs and radios are devices. Their state is one JSON
// row per placed instance in `studio_devices` — server-side, so it
// persists across relogs and restarts exactly like the furniture
// itself, and every occupant of the room gets the same picture.
//   TV state:    { on: bool, channel: 0..TV_CHANNELS-1 }
//   Radio state: { source: 'loops'|'mixes', index, playing, startedAt }
// `startedAt` is a server epoch-ms (play time + a sync delay) so all
// clients schedule the same track from the same instant; late joiners
// align to the loop/mix grid from it. Radio tracks for the 'mixes'
// source are always the ROOM OWNER's saved mixes.

const TV_CHANNELS = [
  { id: 'news',    name: 'Solarion News 24/7' },
  { id: 'soap',    name: 'Days of Our Tides' },
  { id: 'cooking', name: 'Sizzle & Sun' },
  { id: 'weather', name: 'Solarion Weather' },
  { id: 'cartoon', name: 'Captain Comet' },
  { id: 'static',  name: 'Off-Air Static' },
];
const RADIO_SYNC_DELAY_MS = 1200; // matches the stage's START_DELAY_MS idea

function defaultDeviceState(kind) {
  return kind === 'tv'
    ? { on: false, channel: 0 }
    : { source: 'loops', index: 0, playing: false, startedAt: 0 };
}

/** Raw device state for one placed instance (defaults when unset). */
function deviceState(ownerId, instanceId, kind) {
  const row = SQ.devGet.get(ownerId, instanceId);
  if (row) {
    try {
      const s = JSON.parse(row.state);
      if (s && typeof s === 'object') return { ...defaultDeviceState(kind), ...s };
    } catch (e) { /* fall through to defaults */ }
  }
  return defaultDeviceState(kind);
}

function saveDeviceState(ownerId, instanceId, kind, state) {
  SQ.devSet.run(ownerId, instanceId, kind, JSON.stringify(state));
}

function deleteDevice(ownerId, instanceId) {
  SQ.devDel.run(ownerId, instanceId);
}

/**
 * The client-ready device payload for one placed item row: raw state
 * resolved into names/ids the client can render and play without any
 * further lookups (channel id+name; the radio's current track — for
 * mixes, the FULL mix data, exactly like performance-start carries).
 */
function devicePayload(ownerId, row) {
  const def = CATALOG_BY_ID.get(row.item_id);
  if (!def || (def.type !== 'tv' && def.type !== 'radio')) return null;
  const kind = def.type;
  const state = deviceState(ownerId, row.id, kind);
  const base = { instanceId: row.id, itemId: row.item_id, name: def.name, kind };
  if (kind === 'tv') {
    const ch = TV_CHANNELS[Math.max(0, Math.min(TV_CHANNELS.length - 1, state.channel || 0))];
    return { ...base, on: Boolean(state.on), channel: TV_CHANNELS.indexOf(ch), channelId: ch.id, channelName: ch.name };
  }
  // radio
  const ownerMixes = music.listMixes(ownerId);
  const payload = {
    ...base,
    source: state.source === 'mixes' ? 'mixes' : 'loops',
    playing: Boolean(state.playing),
    startedAt: state.startedAt || 0,
    loopCount: music.LOOPS.length,
    mixes: ownerMixes.map(m => ({ id: m.id, name: m.name })),
    track: null,
  };
  if (payload.source === 'loops') {
    const idx = ((state.index || 0) % music.LOOPS.length + music.LOOPS.length) % music.LOOPS.length;
    const loop = music.LOOPS[idx];
    payload.index = idx;
    payload.track = { kind: 'loop', loopId: loop.id, name: loop.name };
  } else {
    if (!ownerMixes.length) {
      payload.index = 0;
    } else {
      const idx = ((state.index || 0) % ownerMixes.length + ownerMixes.length) % ownerMixes.length;
      const mix = ownerMixes[idx];
      payload.index = idx;
      payload.track = { kind: 'mix', mixId: mix.id, name: mix.name, mix: mix.data };
    }
  }
  return payload;
}

/** Payloads for every placed TV/radio in one owner's studio. */
function devicesPayload(ownerId) {
  return SQ.placedFor.all(ownerId)
    .map(row => devicePayload(ownerId, row))
    .filter(Boolean);
}

function getDevices(ownerId) {
  return devicesPayload(ownerId);
}

// ---------------------------------------------------------------- blocklist
// In-memory: ownerId -> Map(userId -> unblock timestamp). 10 minutes.
const blocklist = new Map();

function blockVisitor(ownerId, userId, ms = KICK_BLOCK_MS) {
  let m = blocklist.get(ownerId);
  if (!m) { m = new Map(); blocklist.set(ownerId, m); }
  m.set(userId, Date.now() + ms);
}

function blockedUntil(ownerId, userId) {
  const m = blocklist.get(ownerId);
  if (!m) return 0;
  const until = m.get(userId) || 0;
  if (until && until <= Date.now()) { m.delete(userId); return 0; }
  return until;
}

/** A fresh room invite overrides the kick block (Phase 8). */
function unblockVisitor(ownerId, userId) {
  const m = blocklist.get(ownerId);
  if (m) m.delete(userId);
}

// ---------------------------------------------------------------- system
const INVITE_MS = 60 * 1000; // room invites live for one minute

class StudioSystem {
  constructor(game) {
    this.game = game;
    // Phase 8: pending room invites — inviteeUserId -> { ownerId, expiresAt }.
    this.invites = new Map();
  }

  resolveUser(ref) {
    // Phase 5: ref arrives from the wire — cap it before it touches the DB.
    if (typeof ref === 'number') {
      if (!Number.isSafeInteger(ref) || ref < 0 || ref > 1e12) return null;
      return q.userById.get(ref) || null;
    }
    if (typeof ref === 'string') {
      if (ref.length === 0 || ref.length > 64) return null;
      const byName = q.userByName.get(ref);
      if (byName) return byName;
      if (/^\d+$/.test(ref)) return q.userById.get(Number(ref)) || null;
    }
    return null;
  }

  sceneOwnerId(p) {
    return parseStudioId(p.mapId);
  }

  isInOwnStudio(p) {
    return this.sceneOwnerId(p) === p.userId;
  }

  stateFor(p, ownerId, ownerName) {
    const isOwner = ownerId === p.userId;
    const msg = {
      type: 'studio-state',
      ownerId,
      ownerName,
      isOwner,
      furniture: getPlaced(ownerId),
      // Phase 8: device states + the TV channel guide go to EVERYONE
      // in the room (visitors work the TV/radio too).
      devices: devicesPayload(ownerId),
      channels: TV_CHANNELS,
    };
    if (isOwner) {
      msg.catalog = CATALOG;
      msg.inventory = getInventory(ownerId);
    }
    return msg;
  }

  sendState(p) {
    const ownerId = this.sceneOwnerId(p);
    if (ownerId === null) return;
    const owner = q.userById.get(ownerId);
    this.game.send(p, this.stateFor(p, ownerId, owner ? owner.username : 'Private'));
  }

  broadcastFurniture(ownerId) {
    this.game.broadcastToMap(`studio:${ownerId}`, {
      type: 'studio-furniture', ownerId, furniture: getPlaced(ownerId),
    });
  }

  /** Broadcast one device's resolved state to everyone in the studio. */
  broadcastDevice(ownerId, instanceId) {
    const row = SQ.byIdOwner.get(instanceId, ownerId);
    const device = row && row.x !== null ? devicePayload(ownerId, row) : null;
    this.game.broadcastToMap(`studio:${ownerId}`, {
      type: 'home-device', ownerId, instanceId, device,
    });
  }

  // ------------------------------------------------------------ enter/leave

  handleEnter(p, msg) {
    const owner = this.resolveUser(msg.owner !== undefined ? msg.owner : p.name);
    if (!owner) {
      this.game.send(p, { type: 'notice', text: 'No player by that name — nobody owns that studio.' });
      return;
    }
    if (owner.id !== p.userId) {
      // Phase 9: a locked home admits only the owner — everyone
      // else needs an invite (invite-accept enters directly).
      if (isHomeLocked(owner.id)) {
        this.game.send(p, { type: 'notice', text: `🔒 ${owner.username}'s home is locked — ask them for an invite.` });
        return;
      }
      const until = blockedUntil(owner.id, p.userId);
      if (until) {
        const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
        this.game.send(p, { type: 'notice', text: `You were kicked from that studio — try again in ~${mins} min.` });
        return;
      }
    }
    this.enterStudio(p, owner);
  }

  /**
   * The actual scene switch into a studio (shared by enter-studio
   * and invite-accept). Runs through switchScene, so every entry is
   * a standard 3s load-screen transfer.
   */
  enterStudio(p, owner) {
    const scene = studioMapFor(owner.id, owner.username);
    if (p.mapId === scene.id) { this.sendState(p); return; }
    // Remember where to return to — only from a public map; hopping
    // studio→studio keeps the original return point.
    if (!isStudioId(p.mapId)) p.returnTo = { mapId: p.mapId, x: p.x, y: p.y };
    const placed = getPlaced(owner.id);
    this.game.switchScene(p, scene, {
      extra: {
        studio: { ownerId: owner.id, ownerName: owner.username, furniture: placed },
        furniture: placed,
        devices: devicesPayload(owner.id),
      },
    });
    this.sendState(p);
  }

  // ------------------------------------------------------------ invites

  /**
   * { type:'studio-invite', username|userId } — the owner invites any
   * ONLINE player, from anywhere in the world (they don't need to be
   * standing in their studio). One pending invite per invitee; a new
   * invite replaces the old.
   */
  handleInvite(p, msg) {
    const targetUser = this.resolveUser(msg.username !== undefined ? msg.username : msg.userId);
    if (!targetUser) {
      this.game.send(p, { type: 'notice', text: 'No player by that name — nobody to invite.' });
      return;
    }
    if (targetUser.id === p.userId) {
      this.game.send(p, { type: 'notice', text: "You can't invite yourself — it's your room." });
      return;
    }
    const target = this.game.getPlayer(targetUser.id);
    if (!target) {
      this.game.send(p, { type: 'notice', text: `${targetUser.username} isn't online right now.` });
      return;
    }
    if (target.mapId === `studio:${p.userId}`) {
      this.game.send(p, { type: 'notice', text: `${targetUser.username} is already in your studio.` });
      return;
    }
    this.invites.set(targetUser.id, { ownerId: p.userId, expiresAt: Date.now() + INVITE_MS });
    this.game.send(target, {
      type: 'studio-invite',
      fromId: p.userId,
      fromName: p.name,
      ownerId: p.userId,
      expiresInSec: Math.round(INVITE_MS / 1000),
    });
    this.game.send(p, { type: 'notice', text: `📩 Invite sent to ${targetUser.username} — it lasts ${Math.round(INVITE_MS / 1000)} seconds.` });
  }

  /**
   * { type:'studio-invite-response', ownerId, accept } — accepting
   * consumes the invite, lifts any kick block (a fresh invite is the
   * ONLY way back in for a kicked visitor) and rides the standard
   * transfer into the owner's studio. One invite = one transport.
   */
  handleInviteResponse(p, msg) {
    const inv = this.invites.get(p.userId);
    const ownerId = Number.isInteger(msg.ownerId) ? msg.ownerId : null;
    if (inv && inv.expiresAt <= Date.now()) this.invites.delete(p.userId);
    if (!inv || inv.expiresAt <= Date.now() || inv.ownerId !== ownerId) {
      this.game.send(p, { type: 'notice', text: 'That invite is no longer valid.' });
      return;
    }
    this.invites.delete(p.userId);
    const ownerUser = q.userById.get(inv.ownerId);
    if (!msg.accept) {
      const ownerPlayer = this.game.getPlayer(inv.ownerId);
      if (ownerPlayer && ownerUser) {
        this.game.send(ownerPlayer, { type: 'notice', text: `${p.name} declined your studio invite.` });
      }
      return;
    }
    if (!ownerUser) return;
    unblockVisitor(inv.ownerId, p.userId);
    this.enterStudio(p, ownerUser);
  }

  handleLeave(p) {
    if (!isStudioId(p.mapId)) {
      this.game.send(p, { type: 'notice', text: 'You are not in a studio.' });
      return;
    }
    // Leave destination (documented choice): the map/position you came
    // from, remembered at entry; if that is somehow unavailable, the
    // Gateway spawn. Kicked players always go to the Gateway.
    const { MAPS } = require('./maps');
    const ret = p.returnTo;
    p.returnTo = null;
    const dest = ret && MAPS[ret.mapId] ? MAPS[ret.mapId] : MAPS['the-gateway'];
    const spawn = ret && MAPS[ret.mapId] ? { x: ret.x, y: ret.y } : dest.spawn;
    this.game.switchScene(p, dest, { spawn });
    this.game.send(p, { type: 'notice', text: 'You leave the studio.' });
  }

  // ------------------------------------------------------------ buy

  handleBuy(p, msg) {
    if (!this.isInOwnStudio(p)) {
      this.game.send(p, { type: 'notice', text: 'You can only buy furniture in your own studio.' });
      return;
    }
    const item = typeof msg.itemId === 'string' && msg.itemId.length <= 64
      ? CATALOG_BY_ID.get(msg.itemId) : undefined;
    if (!item) {
      this.game.send(p, { type: 'notice', text: 'That item is not in the catalog.' });
      return;
    }
    // Phase 9: record trophies are earned on stage, never bought.
    if (item.awardOnly || item.id === 'gold-record') {
      this.game.send(p, { type: 'notice', text: `🏆 The ${item.name} is earned on stage — 25 lifetime 👍 on one mix for Gold, 100 for Platinum — not bought.` });
      return;
    }
    // Atomic debit + insert: the WHERE guard is the funds check, and
    // the transaction makes debit and delivery indivisible.
    let inserted = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      const debited = SQ.debit.run(item.price, p.userId, item.price);
      if (debited.changes === 1) {
        SQ.insertItem.run(p.userId, item.id, Date.now());
        inserted = true;
        db.exec('COMMIT');
      } else {
        db.exec('ROLLBACK');
      }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
      inserted = false;
    }
    if (!inserted) {
      this.game.send(p, { type: 'notice', text: `Not enough z coins — the ${item.name} costs ${item.price}z.` });
      return;
    }
    this.game.send(p, { type: 'zcoins', zcoins: zcoinsOf(p.userId) });
    this.game.send(p, { type: 'notice', text: `🛋️ Bought a ${item.name} for ${item.price}z — find it in your studio items to place it.` });
    this.sendState(p);
  }

  // ------------------------------------------------------------ place/pickup

  handlePlace(p, msg) {
    if (!this.isInOwnStudio(p)) {
      this.game.send(p, { type: 'notice', text: 'You can only place furniture in your own studio.' });
      return;
    }
    if (!Number.isInteger(msg.instanceItemId)) { // Phase 5: wire value, never trust its type
      this.game.send(p, { type: 'notice', text: 'That is not one of your studio items.' });
      return;
    }
    const row = SQ.byIdOwner.get(msg.instanceItemId, p.userId);
    if (!row) {
      this.game.send(p, { type: 'notice', text: 'That is not one of your studio items.' });
      return;
    }
    const { x, y } = msg;
    const rot = msg.rot === undefined ? 0 : msg.rot;
    // Phase 9: bounds + doorway follow the home's CURRENT size tier.
    const tier = HOME_TIERS[getHomeMeta(p.userId).tier];
    const doorTile = { x: Math.floor(tier.w / 2), y: tier.h - 1 };
    if (x === doorTile.x && y === doorTile.y) {
      this.game.send(p, { type: 'notice', text: 'Keep the doorway clear — nothing goes on the door tile.' });
      return;
    }
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || x > tier.w - 2 || y < 1 || y > tier.h - 2) {
      this.game.send(p, { type: 'notice', text: 'That tile is outside the studio walls.' });
      return;
    }
    if (!Number.isInteger(rot) || rot < 0 || rot > 3) {
      this.game.send(p, { type: 'notice', text: 'Rotation must be 0–3.' });
      return;
    }
    const alreadyPlaced = row.x !== null;
    if (!alreadyPlaced) {
      const n = SQ.placedCount.get(p.userId).n;
      if (n >= MAX_PLACED) {
        this.game.send(p, { type: 'notice', text: `Your studio is full — max ${MAX_PLACED} placed items.` });
        return;
      }
    }
    SQ.place.run(x, y, rot, row.id, p.userId);
    this.broadcastFurniture(p.userId);
    // A freshly placed TV/radio joins the room's device sync.
    const def = CATALOG_BY_ID.get(row.item_id);
    if (def && (def.type === 'tv' || def.type === 'radio')) this.broadcastDevice(p.userId, row.id);
    this.sendState(p);
  }

  handlePickup(p, msg) {
    if (!this.isInOwnStudio(p)) {
      this.game.send(p, { type: 'notice', text: 'You can only pick up furniture in your own studio.' });
      return;
    }
    if (!Number.isInteger(msg.instanceItemId)) { // Phase 5: wire value, never trust its type
      this.game.send(p, { type: 'notice', text: 'That is not one of your studio items.' });
      return;
    }
    const row = SQ.byIdOwner.get(msg.instanceItemId, p.userId);
    if (!row) {
      this.game.send(p, { type: 'notice', text: 'That is not one of your studio items.' });
      return;
    }
    SQ.unplace.run(row.id, p.userId);
    // Picking up a TV/radio ends its device life: state row deleted,
    // room clients told the device is gone (radios stop, TVs vanish).
    const def = CATALOG_BY_ID.get(row.item_id);
    if (def && (def.type === 'tv' || def.type === 'radio')) {
      deleteDevice(p.userId, row.id);
      this.game.broadcastToMap(`studio:${p.userId}`, {
        type: 'home-device', ownerId: p.userId, instanceId: row.id, device: null,
      });
    }
    this.broadcastFurniture(p.userId);
    this.sendState(p);
  }

  // ------------------------------------------------------------ devices

  /**
   * { type:'home-device', instanceId, action, channel?, source? } —
   * work a placed TV or radio. Documented choice: ANYONE present in
   * the room may use the devices (the furniture itself stays
   * owner-only). Every successful change persists to studio_devices
   * and broadcasts the resolved state to the whole room.
   *   TV actions:    'power' | 'channel-next' | 'channel-prev' |
   *                  'channel-set' (channel: 0..n-1)
   *   Radio actions: 'play' | 'stop' | 'next' | 'prev' |
   *                  'source' (source: 'loops' | 'mixes', or toggle)
   */
  handleDevice(p, msg) {
    const ownerId = this.sceneOwnerId(p);
    if (ownerId === null) {
      this.game.send(p, { type: 'notice', text: 'TVs and radios only work inside a home.' });
      return;
    }
    if (!Number.isInteger(msg.instanceId)) {
      this.game.send(p, { type: 'notice', text: 'That device is not here.' });
      return;
    }
    const row = SQ.byIdOwner.get(msg.instanceId, ownerId);
    const def = row ? CATALOG_BY_ID.get(row.item_id) : null;
    if (!row || row.x === null || !def || (def.type !== 'tv' && def.type !== 'radio')) {
      this.game.send(p, { type: 'notice', text: 'That device is not here.' });
      return;
    }
    const kind = def.type;
    const state = deviceState(ownerId, row.id, kind);
    const now = Date.now();

    if (kind === 'tv') {
      if (msg.action === 'power') {
        state.on = !state.on;
      } else if (msg.action === 'channel-next' || msg.action === 'channel-prev') {
        const d = msg.action === 'channel-next' ? 1 : -1;
        state.channel = ((state.channel + d) % TV_CHANNELS.length + TV_CHANNELS.length) % TV_CHANNELS.length;
        state.on = true; // changing channel wakes the TV, like a real remote
      } else if (msg.action === 'channel-set') {
        if (!Number.isInteger(msg.channel) || msg.channel < 0 || msg.channel >= TV_CHANNELS.length) {
          this.game.send(p, { type: 'notice', text: 'No such channel.' });
          return;
        }
        state.channel = msg.channel;
        state.on = true;
      } else {
        return;
      }
      saveDeviceState(ownerId, row.id, kind, state);
      this.broadcastDevice(ownerId, row.id);
      return;
    }

    // ---- radio
    const ownerMixes = music.listMixes(ownerId);
    const trackCount = state.source === 'mixes' ? ownerMixes.length : music.LOOPS.length;
    if (msg.action === 'play') {
      if (trackCount === 0) {
        this.game.send(p, { type: 'notice', text: "The owner has no saved mixes yet — the radio's mix source is empty." });
        return;
      }
      state.index = Math.max(0, Math.min(state.index || 0, trackCount - 1));
      state.playing = true;
      state.startedAt = now + RADIO_SYNC_DELAY_MS;
    } else if (msg.action === 'stop') {
      state.playing = false;
    } else if (msg.action === 'next' || msg.action === 'prev') {
      if (trackCount === 0) {
        this.game.send(p, { type: 'notice', text: 'Nothing on that source to skip to.' });
        return;
      }
      const d = msg.action === 'next' ? 1 : -1;
      state.index = (((state.index || 0) + d) % trackCount + trackCount) % trackCount;
      if (state.playing) state.startedAt = now + RADIO_SYNC_DELAY_MS;
    } else if (msg.action === 'source') {
      const next = (msg.source === 'loops' || msg.source === 'mixes')
        ? msg.source
        : (state.source === 'loops' ? 'mixes' : 'loops');
      state.source = next;
      state.index = 0;
      if (state.playing) {
        if (next === 'mixes' && ownerMixes.length === 0) {
          state.playing = false;
          this.game.send(p, { type: 'notice', text: "The owner has no saved mixes yet — the radio went quiet." });
        } else {
          state.startedAt = now + RADIO_SYNC_DELAY_MS;
        }
      }
    } else {
      return;
    }
    saveDeviceState(ownerId, row.id, kind, state);
    this.broadcastDevice(ownerId, row.id);
  }

  // ------------------------------------------------------------ kick

  handleKick(p, msg) {
    const ownerId = this.sceneOwnerId(p);
    if (ownerId === null || ownerId !== p.userId) {
      this.game.send(p, { type: 'notice', text: 'Only the studio owner can kick visitors.' });
      return;
    }
    const targetUser = this.resolveUser(msg.userId !== undefined ? msg.userId : msg.username);
    if (!targetUser) {
      this.game.send(p, { type: 'notice', text: 'No such player to kick.' });
      return;
    }
    if (targetUser.id === p.userId) {
      this.game.send(p, { type: 'notice', text: 'You cannot kick yourself.' });
      return;
    }
    const target = this.game.getPlayer(targetUser.id);
    if (!target || target.mapId !== p.mapId) {
      this.game.send(p, { type: 'notice', text: `${targetUser.username} is not in your studio.` });
      return;
    }
    blockVisitor(ownerId, targetUser.id);
    target.returnTo = null;
    const { MAPS } = require('./maps');
    this.game.switchScene(target, MAPS['the-gateway']);
    this.game.send(target, { type: 'notice', text: `🚪 You were kicked from ${p.name}'s studio.` });
    this.game.send(p, { type: 'notice', text: `Kicked ${targetUser.username} — they can't re-enter for 10 minutes.` });
  }

  // ------------------------------------------------------------ Phase 9: home settings

  homeMetaPayload(ownerId) {
    const meta = getHomeMeta(ownerId);
    return {
      type: 'home-meta',
      ownerId,
      name: meta.name || '',
      wall: meta.wall, floor: meta.floor, tier: meta.tier, locked: meta.locked,
      tiers: HOME_TIERS.map((t, i) => ({ index: i, name: t.name, w: t.w, h: t.h, price: t.price })),
      walls: WALL_STYLES.map((s, i) => ({ index: i, name: s.name })),
      floors: FLOOR_STYLES.map((s, i) => ({ index: i, name: s.name })),
    };
  }

  sendHomeMeta(p) {
    this.game.send(p, this.homeMetaPayload(p.userId));
  }

  /** Re-send the (possibly resized/repainted) room to everyone inside. */
  refreshRoom(ownerId) {
    const owner = q.userById.get(ownerId);
    if (!owner) return;
    const scene = studioMapFor(ownerId, owner.username);
    const placed = getPlaced(ownerId);
    const { clientMap } = require('./maps');
    for (const occ of this.game.players.values()) {
      if (occ.mapId !== scene.id) continue;
      const occupants = this.game.playersInMap(scene.id);
      this.game.send(occ, {
        type: 'map',
        map: clientMap(scene),
        players: occupants,
        chat: this.game.historyFor(scene.id),
        you: occupants.find(x => x.id === occ.userId),
        transferMs: 0,
        studio: { ownerId, ownerName: owner.username, furniture: placed },
        furniture: placed,
        devices: devicesPayload(ownerId),
      });
      this.sendState(occ);
    }
  }

  /** { type:'home-set', name?, wall?, floor?, locked? } — owner-only. */
  handleHomeSet(p, msg) {
    const patch = {};
    if (msg.name !== undefined) {
      if (typeof msg.name !== 'string') return;
      const cleaned = msg.name.replace(/[<>&"]/g, '').trim().slice(0, HOME_NAME_MAX);
      patch.name = cleaned || null;
    }
    if (msg.wall !== undefined) {
      if (!Number.isInteger(msg.wall) || msg.wall < 0 || msg.wall >= WALL_STYLES.length) {
        this.game.send(p, { type: 'notice', text: 'No such wall paint.' });
        return;
      }
      patch.wall = msg.wall;
    }
    if (msg.floor !== undefined) {
      if (!Number.isInteger(msg.floor) || msg.floor < 0 || msg.floor >= FLOOR_STYLES.length) {
        this.game.send(p, { type: 'notice', text: 'No such floor style.' });
        return;
      }
      patch.floor = msg.floor;
    }
    if (msg.locked !== undefined) patch.locked = Boolean(msg.locked);
    if (!Object.keys(patch).length) return;
    setHomeMeta(p.userId, patch);
    this.game.send(p, { type: 'notice', text: '🏠 Home updated.' });
    this.sendHomeMeta(p);
    if (p.mapId === `studio:${p.userId}`) this.refreshRoom(p.userId);
  }

  /** { type:'home-expand' } — buy the next size tier. */
  handleHomeExpand(p) {
    const meta = getHomeMeta(p.userId);
    const next = HOME_TIERS[meta.tier + 1];
    if (!next) {
      this.game.send(p, { type: 'notice', text: 'Your home is already at the largest size — the Penthouse.' });
      return;
    }
    let paid = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      const debited = SQ.debit.run(next.price, p.userId, next.price);
      if (debited.changes === 1) { paid = true; db.exec('COMMIT'); } else { db.exec('ROLLBACK'); }
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    }
    if (!paid) {
      this.game.send(p, { type: 'notice', text: `Expanding to the ${next.name} (${next.w}×${next.h}) costs ${next.price}z.` });
      return;
    }
    setHomeMeta(p.userId, { tier: meta.tier + 1 });
    this.game.send(p, { type: 'zcoins', zcoins: zcoinsOf(p.userId) });
    this.game.send(p, { type: 'notice', text: `🏠 Welcome to your ${next.name} — ${next.w}×${next.h} tiles! Your furniture stayed right where it was.` });
    this.sendHomeMeta(p);
    if (p.mapId === `studio:${p.userId}`) this.refreshRoom(p.userId);
  }

  // ------------------------------------------------------------ dispatch

  handle(p, msg) {
    switch (msg.type) {
      case 'enter-studio': this.handleEnter(p, msg); break;
      case 'leave-studio': this.handleLeave(p); break;
      case 'studio-buy': this.handleBuy(p, msg); break;
      case 'studio-place': this.handlePlace(p, msg); break;
      case 'studio-pickup': this.handlePickup(p, msg); break;
      case 'studio-kick': this.handleKick(p, msg); break;
      case 'studio-state': this.sendState(p); break;
      case 'home-device': this.handleDevice(p, msg); break;
      case 'studio-invite': this.handleInvite(p, msg); break;
      case 'studio-invite-response': this.handleInviteResponse(p, msg); break;
      case 'home-meta': this.sendHomeMeta(p); break;
      case 'home-set': this.handleHomeSet(p, msg); break;
      case 'home-expand': this.handleHomeExpand(p); break;
      default: break;
    }
  }
}

module.exports = {
  init, StudioSystem,
  CATALOG, CATALOG_BY_ID,
  TV_CHANNELS, RADIO_SYNC_DELAY_MS, INVITE_MS,
  STUDIO_W, STUDIO_H, STUDIO_DOOR, MAX_PLACED, KICK_BLOCK_MS,
  STUDIO_ROWS, studioMapFor, studioMapForId, parseStudioId, isStudioId,
  getPlaced, getInventory, getDevices, devicePayload, devicesPayload,
  blockVisitor, blockedUntil, unblockVisitor,
  HOME_TIERS, WALL_STYLES, FLOOR_STYLES, getHomeMeta, setHomeMeta, isHomeLocked,
};
