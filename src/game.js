'use strict';

/**
 * Solarion — world simulation (Phase 1).
 *
 * Server-authoritative: clients send input intents (which keys are held);
 * the server moves avatars, resolves collisions, detects gateway steps and
 * broadcasts position snapshots per map. Nothing important is trusted from
 * the client.
 *
 * Chat is per-map, rate-limited (6 messages per 10s sliding window).
 * The daily +100z login bonus is claimed atomically in the DB (see db.js).
 */

const { MAPS, TILE, collides, gatewayAt, doorAt } = require('./maps');
const { q } = require('./db');
// NOTE: studio is required lazily inside methods (not at the top) to
// keep the require graph acyclic: studio.js requires maps.js only,
// and studio-system handlers call back into Game via the instance.
function studioOf(sceneId) {
  return require('./studio').studioMapForId(sceneId);
}

const PLAYER_RADIUS = 12;
const SPEED = 175;              // px per second
const TICK_HZ = 20;             // simulation
const SNAPSHOT_HZ = 10;         // broadcast
const CHAT_LIMIT = 6;           // messages ...
const CHAT_WINDOW_MS = 10e3;    // ... per window
const CHAT_MAX_LEN = 240;
const CHAT_HISTORY = 40;        // messages kept per map for joiners
const POSITION_SAVE_MS = 15e3;  // periodic crash-safe position flush
const TRANSFER_MS = 3000;       // Phase B: fixed load-screen window on every scene transfer
const SIT_RADIUS = 52;          // px: how close to a seat `interact` must be
const FURN_ROT_DIRS = ['down', 'left', 'up', 'right']; // studio furniture rot -> facing

/** Server-local calendar day, YYYY-MM-DD (daily-bonus day boundary). */
function localDay(now = new Date()) {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

class Game {
  constructor() {
    this.players = new Map();        // userId -> player
    this.chatHistory = new Map();    // mapId -> [ {from, text, at} ]
    this.tickTimer = null;
    this.snapTimer = null;
    this.saveTimer = null;
    // Phase 5: tick health (surfaced on /health): how many sim ticks
    // ran, the worst tick duration, and how many ticks/snapshots fired
    // >1.5 intervals late (event-loop stalls) since boot.
    this.tickStats = { ticks: 0, tickOverruns: 0, tickMaxMs: 0, snaps: 0, snapOverruns: 0, snapMaxMs: 0 };
    // Optional hook (set by server.js): called when a player disconnects
    // or changes map, so the stage can dequeue/end their performance.
    this.onPlayerGone = null;
    // Optional hook: called right after a player lands in a new map.
    this.onMapEntered = null;
  }

  start() {
    const tickMs = 1000 / TICK_HZ;
    let lastTick = performance.now();
    this.tickTimer = setInterval(() => {
      const t0 = performance.now();
      if (t0 - lastTick > tickMs * 1.5 && this.tickStats.ticks > 0) this.tickStats.tickOverruns++;
      lastTick = t0;
      this.tick();
      const dur = performance.now() - t0;
      this.tickStats.ticks++;
      if (dur > this.tickStats.tickMaxMs) this.tickStats.tickMaxMs = Math.round(dur * 10) / 10;
    }, tickMs);
    const snapMs = 1000 / SNAPSHOT_HZ;
    let lastSnap = performance.now();
    this.snapTimer = setInterval(() => {
      const t0 = performance.now();
      if (t0 - lastSnap > snapMs * 1.5 && this.tickStats.snaps > 0) this.tickStats.snapOverruns++;
      lastSnap = t0;
      this.broadcastSnapshots();
      const dur = performance.now() - t0;
      this.tickStats.snaps++;
      if (dur > this.tickStats.snapMaxMs) this.tickStats.snapMaxMs = Math.round(dur * 10) / 10;
    }, snapMs);
    this.saveTimer = setInterval(() => this.saveAllPositions(), POSITION_SAVE_MS);
  }

  stop() {
    clearInterval(this.tickTimer);
    clearInterval(this.snapTimer);
    clearInterval(this.saveTimer);
    this.saveAllPositions();
  }

  // ---------------------------------------------------------- scenes
  /**
   * Resolve ANY scene id — a static public map id, or an instanced
   * studio scene id (`studio:<ownerUserId>`, Phase 4) — to the
   * map-shaped object the sim collides/moves against. Studios are
   * built from the one template in studio.js; everything downstream
   * (movement, snapshots, chat keyed by scene id) treats them exactly
   * like maps, which is what makes instance isolation automatic.
   */
  sceneFor(sceneId) {
    if (MAPS[sceneId]) return MAPS[sceneId];
    return studioOf(sceneId);
  }

  isStudioScene(sceneId) {
    return require('./studio').isStudioId(sceneId);
  }

  // ---------------------------------------------------------- connections

  addPlayer(ws, { user, avatar }) {
    // One live connection per account: a fresh login replaces a stale one.
    const existing = this.players.get(user.id);
    if (existing && existing.ws !== ws) {
      try { existing.ws.close(4000, 'replaced'); } catch (e) { /* already gone */ }
    }
    // Studios are session-only scenes and are never a respawn point:
    // savePosition() skips them, so a saved map_id is always a public
    // map (anything unrecognized falls back to the Gateway, as before).
    let mapId = MAPS[avatar.map_id] ? avatar.map_id : 'the-gateway';
    const map = MAPS[mapId];
    let { x, y } = avatar;
    if (collides(map, x, y, PLAYER_RADIUS)) { x = map.spawn.x; y = map.spawn.y; }
    const p = {
      userId: user.id,
      name: avatar.name,
      // Phase 6: full appearance (creation-screen axes). Older rows
      // always carry these post-migration; the || defaults are belt
      // and braces for any pre-v2 shape slipping through.
      gender: avatar.gender || 'M',
      face: avatar.face || 'classic',
      eyes: avatar.eyes || 'round',
      eye_color: avatar.eye_color || '#20242c',
      nose: avatar.nose || 'button',
      lips: avatar.lips || 'natural',
      body_color: avatar.body_color,
      accent_color: avatar.accent_color,
      skin_tone: avatar.skin_tone,
      hair_style: avatar.hair_style,
      hair_color: avatar.hair_color,
      top_style: avatar.top_style || 'tee',
      bottom_style: avatar.bottom_style || 'pants',
      shoe_color: avatar.shoe_color || '#23262b',
      accessory: avatar.accessory || 'none',
      ws,
      mapId,
      x, y,
      dir: 'down',
      keys: {},
      chatTimes: [],
      lastGatewayAt: 0,
      transferUntil: 0,   // Phase B: movement locked until this epoch-ms (load screen)
      seated: null,       // Phase B: { id, dir, kind } while sitting, else null
      performing: false,
      returnTo: null,   // Phase 4: public map/pos to return to from a studio
    };
    this.players.set(user.id, p);
    return p;
  }

  removePlayer(userId) {
    const p = this.players.get(userId);
    if (!p) return;
    p.performing = false;
    if (this.onPlayerGone) this.onPlayerGone(userId);
    this.savePosition(p);
    this.players.delete(userId);
  }

  getPlayer(userId) {
    return this.players.get(userId) || null;
  }

  savePosition(p) {
    // Never persist a studio scene as a respawn point — a player who
    // disconnects mid-visit re-enters at their last public position
    // (the row still holds it, untouched, from before they entered).
    if (this.isStudioScene(p.mapId)) return;
    q.saveAvatarPos.run(p.mapId, Math.round(p.x), Math.round(p.y), p.userId);
  }

  saveAllPositions() {
    for (const p of this.players.values()) this.savePosition(p);
  }

  // ---------------------------------------------------------- daily bonus

  /** Claim today's +100z. Returns true exactly once per account per day. */
  claimDailyBonus(userId) {
    const today = localDay();
    const r = q.claimDailyBonus.run(today, userId, today);
    return r.changes === 1;
  }

  // ---------------------------------------------------------- messaging

  send(p, msg) {
    try { p.ws.send(JSON.stringify(msg)); } catch (e) { /* socket dying */ }
  }

  /** Broadcast to everyone in a scene (public map OR studio instance). */
  broadcastToMap(sceneId, msg, exceptUserId = null) {
    for (const p of this.players.values()) {
      if (p.mapId === sceneId && p.userId !== exceptUserId) this.send(p, msg);
    }
  }

  mapCounts() {
    const counts = {};
    for (const id of Object.keys(MAPS)) counts[id] = 0;
    for (const p of this.players.values()) counts[p.mapId] = (counts[p.mapId] || 0) + 1;
    return counts;
  }

  publicPlayer(p) {
    return {
      id: p.userId,
      name: p.name,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      // While seated the avatar faces the seat's way and snapshots say so.
      dir: p.seated ? p.seated.dir : p.dir,
      seated: Boolean(p.seated),
      gender: p.gender,
      face: p.face,
      eyes: p.eyes,
      eye_color: p.eye_color,
      nose: p.nose,
      lips: p.lips,
      body_color: p.body_color,
      accent_color: p.accent_color,
      skin_tone: p.skin_tone,
      hair_style: p.hair_style,
      hair_color: p.hair_color,
      top_style: p.top_style,
      bottom_style: p.bottom_style,
      shoe_color: p.shoe_color,
      accessory: p.accessory,
      performing: Boolean(p.performing),
    };
  }

  /** Players in a scene (public map OR studio instance). */
  playersInMap(sceneId) {
    const out = [];
    for (const p of this.players.values()) if (p.mapId === sceneId) out.push(this.publicPlayer(p));
    return out;
  }

  broadcastSnapshots() {
    // Group by scene id — public maps and studio instances alike — so
    // players only ever see the occupants of their own scene.
    const byScene = new Map();
    for (const p of this.players.values()) {
      if (!byScene.has(p.mapId)) byScene.set(p.mapId, []);
      byScene.get(p.mapId).push(p);
    }
    for (const inScene of byScene.values()) {
      const players = inScene.map(p => this.publicPlayer(p));
      for (const p of inScene) this.send(p, { type: 'snapshot', players });
    }
  }

  // ---------------------------------------------------------- input

  handleInput(p, keys) {
    p.keys = {
      up: Boolean(keys && keys.up),
      down: Boolean(keys && keys.down),
      left: Boolean(keys && keys.left),
      right: Boolean(keys && keys.right),
    };
  }

  // ---------------------------------------------------------- chat

  handleChat(p, rawText) {
    const text = String(rawText == null ? '' : rawText).trim().slice(0, CHAT_MAX_LEN);
    if (!text) return;
    const now = Date.now();
    p.chatTimes = p.chatTimes.filter(t => now - t < CHAT_WINDOW_MS);
    if (p.chatTimes.length >= CHAT_LIMIT) {
      this.send(p, { type: 'notice', text: 'Slow down — you are chatting too fast.' });
      return;
    }
    p.chatTimes.push(now);
    const msg = { type: 'chat', from: p.name, fromId: p.userId, text, at: now };
    // Soul doc §2/§9.4: while performing, the performer's chat is the
    // room's voice — it broadcasts room-wide in "sing" mode regardless
    // of anything else. (Phase 1 chat is already per-map; the rate limit
    // above stays as the abuse guard, and `sing` flags the message so
    // clients render it as a performance shout.)
    if (p.performing) msg.sing = true;
    const hist = this.chatHistory.get(p.mapId) || [];
    hist.push({ from: p.name, text, at: now });
    while (hist.length > CHAT_HISTORY) hist.shift();
    this.chatHistory.set(p.mapId, hist);
    this.broadcastToMap(p.mapId, msg);
  }

  historyFor(mapId) {
    return this.chatHistory.get(mapId) || [];
  }

  // ---------------------------------------------------------- simulation

  tick() {
    const dt = 1 / TICK_HZ;
    const now = Date.now();
    for (const p of this.players.values()) {
      const map = this.sceneFor(p.mapId);
      if (!map) continue;
      // Phase B transfer lock: while the load screen is up the server
      // holds the player exactly where the transfer placed them —
      // movement input is ignored until the window ends.
      if (p.transferUntil && now < p.transferUntil) continue;
      let dx = 0, dy = 0;
      if (p.keys.left) dx -= 1;
      if (p.keys.right) dx += 1;
      if (p.keys.up) dy -= 1;
      if (p.keys.down) dy += 1;
      if (dx === 0 && dy === 0) continue;
      // Phase B sitting: any movement input stands you up (and is
      // consumed — you don't slide off the chair in the same tick).
      if (p.seated) {
        p.seated = null;
        p.keys = {};
        this.send(p, { type: 'sit-state', seated: false });
        continue;
      }
      const len = Math.hypot(dx, dy);
      dx = (dx / len) * SPEED * dt;
      dy = (dy / len) * SPEED * dt;

      // Axis-separated movement → wall sliding for free.
      const nx = p.x + dx;
      if (!collides(map, nx, p.y, PLAYER_RADIUS)) p.x = nx;
      const ny = p.y + dy;
      if (!collides(map, p.x, ny, PLAYER_RADIUS)) p.y = ny;

      if (Math.abs(dx) > Math.abs(dy)) p.dir = dx > 0 ? 'right' : 'left';
      else p.dir = dy > 0 ? 'down' : 'up';

      this.checkPortals(p);
    }
  }

  /**
   * Portal check after movement (also called by the test-only
   * debug-teleport hook): gateway arches (hub<->cities) and doors
   * (interior sub-areas) both trigger a full scene transfer — 3s
   * load screen, input locked (see switchScene / TRANSFER_MS).
   */
  checkPortals(p) {
    const map = this.sceneFor(p.mapId);
    if (!map) return;
    const gw = gatewayAt(map, p.x, p.y);
    const dr = gw ? null : doorAt(map, p.x, p.y);
    if (!gw && !dr) return;
    // Debounce so a player standing on a spot can't bounce between maps.
    if (Date.now() - p.lastGatewayAt < 1500) return;
    if (gw) {
      const target = MAPS[gw.target];
      if (!target) {
        p.lastGatewayAt = Date.now();
        this.send(p, { type: 'notice', text: `${gw.label} isn't open yet — coming in a later phase.` });
        return;
      }
      this.switchMap(p, target);
      return;
    }
    const target = MAPS[dr.target];
    if (!target) return;
    this.switchScene(p, target, { spawn: dr.targetSpawn || target.spawn });
  }

  // Back-compat alias (older callers/tests used the gateway name).
  checkGateway(p) { this.checkPortals(p); }

  switchMap(p, target) {
    this.switchScene(p, target);
  }

  /**
   * Move a player to ANY scene (public map def or studio scene object).
   * opts.spawn overrides the scene spawn; opts.extra is merged into
   * the `map` message (studio entry carries its furniture payload).
   */
  switchScene(p, scene, opts = {}) {
    p.lastGatewayAt = Date.now();
    p.performing = false; // never carry a performance across scenes
    p.seated = null;      // ... or a chair
    // Phase B: EVERY scene transfer runs the fixed load-screen window.
    // The server places the player immediately and locks movement for
    // TRANSFER_MS; the client lifts its screen only after the window
    // AND the new scene's first snapshot, so nobody pops in.
    p.transferUntil = Date.now() + TRANSFER_MS;
    if (this.onPlayerGone) this.onPlayerGone(p.userId);
    p.mapId = scene.id;
    const spawn = opts.spawn || scene.spawn;
    p.x = spawn.x;
    p.y = spawn.y;
    if (collides(scene, p.x, p.y, PLAYER_RADIUS)) { p.x = scene.spawn.x; p.y = scene.spawn.y; }
    p.keys = {};
    this.savePosition(p);
    const { clientMap } = require('./maps');
    this.send(p, {
      type: 'map',
      map: clientMap(scene),
      players: this.playersInMap(scene.id),
      chat: this.historyFor(scene.id),
      you: this.publicPlayer(p),
      transferMs: TRANSFER_MS,
      ...(opts.extra || {}),
    });
    if (this.onMapEntered) this.onMapEntered(p);
  }

  // ---------------------------------------------------------- sitting

  /**
   * All sittable spots in the player's current scene: the map's
   * static seats (benches/chairs/sofas/café seats baked into the map
   * data) plus, inside a studio, any placed furniture whose catalog
   * type is 'seating' (cozy chairs, cloud couches).
   */
  seatsInScene(p) {
    const out = [];
    const map = this.sceneFor(p.mapId);
    if (map && map.seats) out.push(...map.seats);
    const st = studioOf(p.mapId);
    if (st) {
      const { getPlaced } = require('./studio');
      for (const f of getPlaced(st.ownerId)) {
        if (f.type !== 'seating') continue;
        out.push({
          id: `furn:${f.instanceId}`,
          x: f.x * TILE + TILE / 2,
          y: f.y * TILE + TILE / 2,
          dir: FURN_ROT_DIRS[f.rot || 0] || 'down',
          kind: f.itemId,
        });
      }
    }
    return out;
  }

  /**
   * `interact` (E key / Sit button): toggle sitting. Standing next to
   * a free seat sits you on it (snapped into place, facing the seat's
   * way); interacting again stands. Movement input also stands (see
   * tick). Chat works seated — nothing here touches chat.
   */
  handleInteract(p) {
    if (p.transferUntil && Date.now() < p.transferUntil) return;
    if (p.seated) {
      p.seated = null;
      this.send(p, { type: 'sit-state', seated: false });
      return;
    }
    const taken = new Set();
    for (const q2 of this.players.values()) {
      if (q2 !== p && q2.mapId === p.mapId && q2.seated) taken.add(q2.seated.id);
    }
    const near = this.seatsInScene(p)
      .map(s => ({ s, d: Math.hypot(s.x - p.x, s.y - p.y) }))
      .filter(e => e.d <= SIT_RADIUS)
      .sort((a, b) => a.d - b.d);
    if (!near.length) {
      this.send(p, { type: 'notice', text: 'Nothing to sit on here — walk up to a chair, bench, sofa or café table.' });
      return;
    }
    const free = near.find(e => !taken.has(e.s.id));
    if (!free) {
      this.send(p, { type: 'notice', text: 'That seat is taken.' });
      return;
    }
    const s = free.s;
    p.x = s.x;
    p.y = s.y;
    p.keys = {};
    p.seated = { id: s.id, dir: s.dir, kind: s.kind };
    this.savePosition(p);
    this.send(p, { type: 'sit-state', seated: true });
  }
}

module.exports = { Game, localDay, PLAYER_RADIUS, SPEED, CHAT_LIMIT, TRANSFER_MS };
