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
 */

const { db, q } = require('./db');
const { TILE } = require('./maps');

// ---------------------------------------------------------------- template
const STUDIO_W = 20;
const STUDIO_H = 14;
const STUDIO_DOOR = { x: 10, y: 13 };        // tile coords, south wall
const MAX_PLACED = 100;                      // soul doc §5 room cap
const KICK_BLOCK_MS = 10 * 60 * 1000;        // 10-minute re-entry block

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
  return {
    id: `studio:${ownerId}`,
    name: `${name}'s Studio`,
    tiles: { rows: STUDIO_ROWS, w: STUDIO_W, h: STUDIO_H },
    tileSize: TILE,
    floor: '#8a6844',          // warm wood — cozy, distinct from all cities
    floorAlt: '#7f613e',
    wall: '#4a3423',
    spawn: { x: STUDIO_DOOR.x * TILE + TILE / 2, y: 11 * TILE + TILE / 2 },
    gateways: [],
    isStudio: true,
    ownerId,
    studio: {
      ownerId,
      ownerName: name,
      door: { x: STUDIO_DOOR.x * TILE, y: STUDIO_DOOR.y * TILE, w: TILE, h: TILE },
    },
  };
}

function studioMapForId(sceneId) {
  const ownerId = parseStudioId(sceneId);
  return ownerId === null ? null : studioMapFor(ownerId);
}

// ---------------------------------------------------------------- catalog
// ~14 original items. All footprints are 1 tile in v1 (stated per item);
// the jukebox is decorative in v1 (playing visitors' mixes is a noted
// future hook, soul doc §9.18 — rooms are machines, this one ships as
// furniture first). `icon` is the client-drawn glyph.
const CATALOG = [
  { id: 'cozy-chair',    name: 'Cozy Chair',       price: 40,  type: 'seating', color: '#b5533c', accent: '#7d3524', icon: '🪑', footprint: 1 },
  { id: 'cloud-couch',   name: 'Cloud Couch',      price: 120, type: 'seating', color: '#3aa7e0', accent: '#2b7cb0', icon: '🛋️', footprint: 1 },
  { id: 'wood-table',    name: 'Wood Table',       price: 60,  type: 'table',   color: '#8a5a2b', accent: '#6e4520', icon: '🟫', footprint: 1 },
  { id: 'coffee-table',  name: 'Coffee Table',     price: 45,  type: 'table',   color: '#a5713a', accent: '#845a2c', icon: '☕', footprint: 1 },
  { id: 'sun-rug',       name: 'Sun Rug',          price: 35,  type: 'rug',     color: '#ffd23f', accent: '#e0a92e', icon: '🟨', footprint: 1 },
  { id: 'palm-plant',    name: 'Palm Plant',       price: 30,  type: 'plant',   color: '#2e8b57', accent: '#1f6b41', icon: '🌴', footprint: 1 },
  { id: 'glow-lamp',     name: 'Glow Lamp',        price: 55,  type: 'lamp',    color: '#ffe9a3', accent: '#d9b64f', icon: '💡', footprint: 1 },
  { id: 'jukebox',       name: 'Jukebox',          price: 250, type: 'machine', color: '#ff5d8f', accent: '#c23a68', icon: '🎵', footprint: 1 },
  { id: 'speaker',       name: 'Stage Speaker',    price: 90,  type: 'machine', color: '#23262b', accent: '#ffd23f', icon: '🔊', footprint: 1 },
  { id: 'poster',        name: 'Sunset Poster',    price: 25,  type: 'wall',    color: '#ff8c42', accent: '#c25e1e', icon: '🖼️', footprint: 1 },
  { id: 'gold-record',   name: 'Gold Record',      price: 300, type: 'wall',    color: '#ffd700', accent: '#b8960f', icon: '🏆', footprint: 1 },
  { id: 'neon-sign',     name: 'Neon Sign',        price: 180, type: 'wall',    color: '#ff2e88', accent: '#22d3ee', icon: '✨', footprint: 1 },
  { id: 'dispenser',     name: 'Drink Dispenser',  price: 150, type: 'machine', color: '#e63946', accent: '#a62633', icon: '🥤', footprint: 1 },
  { id: 'bookshelf',     name: 'Bookshelf',        price: 80,  type: 'storage', color: '#6b4226', accent: '#4e2f1a', icon: '📚', footprint: 1 },
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
  `);
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
  };
}

function decorate(row) {
  const def = CATALOG_BY_ID.get(row.item_id) || {};
  return {
    instanceId: row.id,
    itemId: row.item_id,
    name: def.name || row.item_id,
    type: def.type || 'furniture',
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

// ---------------------------------------------------------------- system
class StudioSystem {
  constructor(game) {
    this.game = game;
  }

  resolveUser(ref) {
    if (typeof ref === 'number' && Number.isInteger(ref)) return q.userById.get(ref) || null;
    if (typeof ref === 'string') {
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

  // ------------------------------------------------------------ enter/leave

  handleEnter(p, msg) {
    const owner = this.resolveUser(msg.owner !== undefined ? msg.owner : p.name);
    if (!owner) {
      this.game.send(p, { type: 'notice', text: 'No player by that name — nobody owns that studio.' });
      return;
    }
    if (owner.id !== p.userId) {
      const until = blockedUntil(owner.id, p.userId);
      if (until) {
        const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
        this.game.send(p, { type: 'notice', text: `You were kicked from that studio — try again in ~${mins} min.` });
        return;
      }
    }
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
      },
    });
    this.sendState(p);
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
    const item = CATALOG_BY_ID.get(msg.itemId);
    if (!item) {
      this.game.send(p, { type: 'notice', text: 'That item is not in the catalog.' });
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
    const row = SQ.byIdOwner.get(msg.instanceItemId, p.userId);
    if (!row) {
      this.game.send(p, { type: 'notice', text: 'That is not one of your studio items.' });
      return;
    }
    const { x, y } = msg;
    const rot = msg.rot === undefined ? 0 : msg.rot;
    if (x === STUDIO_DOOR.x && y === STUDIO_DOOR.y) {
      this.game.send(p, { type: 'notice', text: 'Keep the doorway clear — nothing goes on the door tile.' });
      return;
    }
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 1 || x > STUDIO_W - 2 || y < 1 || y > STUDIO_H - 2) {
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
    this.sendState(p);
  }

  handlePickup(p, msg) {
    if (!this.isInOwnStudio(p)) {
      this.game.send(p, { type: 'notice', text: 'You can only pick up furniture in your own studio.' });
      return;
    }
    const row = SQ.byIdOwner.get(msg.instanceItemId, p.userId);
    if (!row) {
      this.game.send(p, { type: 'notice', text: 'That is not one of your studio items.' });
      return;
    }
    SQ.unplace.run(row.id, p.userId);
    this.broadcastFurniture(p.userId);
    this.sendState(p);
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
      default: break;
    }
  }
}

module.exports = {
  init, StudioSystem,
  CATALOG, CATALOG_BY_ID,
  STUDIO_W, STUDIO_H, STUDIO_DOOR, MAX_PLACED, KICK_BLOCK_MS,
  STUDIO_ROWS, studioMapFor, studioMapForId, parseStudioId, isStudioId,
  getPlaced, getInventory, blockVisitor, blockedUntil,
};
