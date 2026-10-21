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
const { db, q } = require('./db');
// The screen<->world direction mapping lives in the shared client
// module (single source for the input + facing rules; it is written
// require-able for exactly this).
const { screenFacing } = require('../public/input-guard');
const FISHING = require('./fishing');

// Phase B amendment — vice money moves (atomic debit, same pattern
// as the casino's ledger: the WHERE guard makes overspend impossible).
const VQ = {
  debit: db.prepare('UPDATE avatars SET zcoins = zcoins - ? WHERE user_id = ? AND zcoins >= ?'),
  credit: db.prepare('UPDATE avatars SET zcoins = zcoins + ? WHERE user_id = ?'),
  zOf: db.prepare('SELECT zcoins FROM avatars WHERE user_id = ?'),
};
const BAR_TIP_Z = 10; // Phase 9: the house's daily tip to its regulars
// NOTE: studio is required lazily inside methods (not at the top) to
// keep the require graph acyclic: studio.js requires maps.js only,
// and studio-system handlers call back into Game via the instance.
function studioOf(sceneId) {
  return require('./studio').studioMapForId(sceneId);
}

const PLAYER_RADIUS = 12;
const SPEED = 175;              // px per second
const RUN_MULT = 1.55;          // Phase 9: run-toggle speed multiplier
// Phase 9 — the world clock: a 12-minute day/night cycle, anchored
// to a fixed epoch so every client (and the server) agrees on the
// phase from the payload alone. Phase 0.0 = sunrise, 0.5 = sunset.
const DAY_CYCLE = { periodMs: 12 * 60 * 1000, anchor: 1767225600000 };
const TICK_HZ = 20;             // simulation
const SNAPSHOT_HZ = 10;         // broadcast
const CHAT_LIMIT = 6;           // messages ...
const CHAT_WINDOW_MS = 10e3;    // ... per window
const CHAT_MAX_LEN = 240;
const CHAT_HISTORY = 40;        // messages kept per map for joiners
const POSITION_SAVE_MS = 15e3;  // periodic crash-safe position flush
const TRANSFER_MS = 3000;       // Phase B: fixed load-screen window on every scene transfer
const SIT_RADIUS = 52;          // px: how close to a seat `interact` must be

// Phase B amendment — vices (bar drinks + hookah puffs). All state
// is server-tracked per player; clients only render the effects.
// v1.1 model (Zan, 2026-10-21): the ENTIRE drunk / high state lives
// in a 30-second window from the LAST drink / puff — haze, wobble,
// level, pass-out, hippy, all of it. Each new drink/puff refreshes
// the window and stacks the level toward THRESHOLD. When the window
// lapses the player is simply sober (level 0, effects off) — the old
// −1-per-minute decay and wake-at-2 are gone. Pass-out (20s at 10
// drinks) and hippy (20s at 10 puffs) fit inside the window; waking
// from either leaves the player sober, no residual level.
const VICE = {
  DRINK_COST: 5, PUFF_COST: 5,
  WINDOW_MS: 30e3,
  THRESHOLD: 10,
  PASSOUT_MS: 20e3,
  HIPPY_MS: 20e3,
  BAR_RADIUS: 90,        // px from the bar's patron spot to buy a drink
};
const FURN_ROT_DIRS = ['down', 'left', 'up', 'right']; // studio furniture rot -> facing

// Phase 9 — emotes: one-shot social expressions. The server tracks
// the active emote per player (snapshots carry it, so late viewers
// see it too) and broadcasts the start. Dance lasts longest and is
// cancelled by walking.
const EMOTES = { wave: 2600, dance: 6000, laugh: 2600, thumbsup: 2600 };

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
      path: null,         // Phase 9: server-owned waypoint route (click/tap-to-move)
      run: false,         // Phase 9: run toggle (both input modes)
      emote: null,        // Phase 9: { name, until } while emoting
      chatTimes: [],
      lastGatewayAt: 0,
      transferUntil: 0,   // Phase B: movement locked until this epoch-ms (load screen)
      seated: null,       // Phase B: { id, dir, kind } while sitting, else null
      vice: { drinks: { count: 0, at: 0 }, puffs: { count: 0, at: 0 } }, // Phase B amendment
      passedOutUntil: 0,  // Phase B amendment: epoch-ms while out cold
      hippyUntil: 0,      // Phase B amendment: epoch-ms while hippified
      performing: false,
      pokerPending: null, // v1.1.1: { tableId, dir } while a buy-in offer is open
      casting: null,      // v1.1.1 fishing: { until, spot } while a line is out
      heldFish: null,     // v1.1.1 fishing: { id, until } during the hold-up
      fishForce: null,    // TEST ONLY: debug-fish outcome override
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

  /**
   * Claim today's bonus. Returns the amount granted (0 = not today):
   * 5,000z for a brand-new account's first-ever claim, else 100z.
   * The first-claim read and the atomic UPDATE run back-to-back in
   * this synchronous process, so the amount can't race the claim.
   */
  claimDailyBonus(userId) {
    const today = localDay();
    const before = q.avatarByUser.get(userId);
    const firstClaim = Boolean(before && before.last_bonus_day == null);
    const r = q.claimDailyBonus.run(today, userId, today);
    if (r.changes !== 1) return 0;
    return firstClaim ? 5000 : 100;
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
    const now = Date.now();
    const hippy = Boolean(p.hippyUntil && now < p.hippyUntil);
    const pub = {
      id: p.userId,
      name: p.name,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      // While seated the avatar faces the seat's way and snapshots say so.
      dir: p.seated ? p.seated.dir : p.dir,
      seated: Boolean(p.seated),
      // Phase B amendment — vice state, visible to everyone in scene.
      drinks: this.viceCount(p, 'drinks', now),
      puffs: this.viceCount(p, 'puffs', now),
      fallen: Boolean(p.passedOutUntil && now < p.passedOutUntil),
      hippy,
      // v1.1.1 fishing: a line in the water, and the just-caught
      // fish held overhead while its second lasts (room-visible).
      casting: Boolean(p.casting),
      heldFish: p.heldFish && now < p.heldFish.until ? p.heldFish.id : null,
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
      emote: p.emote && now < p.emote.until ? p.emote.name : null,
    };
    if (hippy) {
      // The trip is a view-layer override only: the stored avatar is
      // never mutated, so the real look returns when the window ends.
      pub.body_color = '#ff5da2';    // tie-dye pink
      pub.accent_color = '#ffd23f';  // sunshine yellow
      pub.accessory = 'headband';
    }
    return pub;
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
    // Phase 9: grabbing the keys cancels any click-to-move route.
    if (p.keys.up || p.keys.down || p.keys.left || p.keys.right) p.path = null;
  }

  // ---------------------------------------------------------- Phase 9: path movement

  /**
   * { type:'move-to', x, y } — click/tap-to-move. The destination is
   * validated (finite, inside the scene), snapped to the nearest
   * walkable tile, and routed server-side (src/pathfind.js). The
   * player then walks the route in tick(); keyboard input cancels.
   */
  handleMoveTo(p, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (p.transferUntil && Date.now() < p.transferUntil) return;
    if (p.passedOutUntil && Date.now() < p.passedOutUntil) return;
    const map = this.sceneFor(p.mapId);
    if (!map) return;
    const maxX = map.tiles.w * TILE, maxY = map.tiles.h * TILE;
    const tx = Math.max(0, Math.min(maxX - 1, x));
    const ty = Math.max(0, Math.min(maxY - 1, y));
    const { findPath } = require('./pathfind');
    const path = findPath(map, p.x, p.y, tx, ty);
    if (!path || !path.length) {
      this.send(p, { type: 'notice', text: "Can't get there from here." });
      return;
    }
    p.path = path;
  }

  /** { type:'run', on } — the run toggle (×1.55 speed, both input modes). */
  handleRun(p, on) {
    p.run = Boolean(on);
  }

  /** { type:'emote', emote } — wave / dance / laugh / thumbsup. */
  handleEmote(p, name) {
    if (typeof name !== 'string' || !Object.hasOwn(EMOTES, name)) return;
    if (p.passedOutUntil && Date.now() < p.passedOutUntil) return;
    p.emote = { name, until: Date.now() + EMOTES[name] };
    this.broadcastToMap(p.mapId, { type: 'emote', userId: p.userId, emote: name });
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
      // v1.1: vice windows lapse in-zone — when the 30s window from
      // the last drink/puff closes, the stored level clears and the
      // client hears about it right here (vice-state + snapshots),
      // no zone change involved. A lapse during pass-out wakes the
      // player sober on the spot (pass-out can never outlive it).
      for (const kind of ['drinks', 'puffs']) {
        const v = p.vice[kind];
        if (v && v.count > 0 && now - v.at >= VICE.WINDOW_MS) {
          p.vice[kind] = { count: 0, at: 0 };
          if (kind === 'drinks' && p.passedOutUntil) {
            p.passedOutUntil = 0;
            this.send(p, { type: 'notice', text: 'You wake up on the floor — stone sober.' });
          }
          this.sendVice(p);
        }
      }
      // Phase B amendment — passed out cold: no movement at all until
      // the window ends (chat is handled outside the tick and still
      // works). Waking up = sober: the level clears with the window.
      if (p.passedOutUntil) {
        if (now >= p.passedOutUntil) {
          p.passedOutUntil = 0;
          p.vice.drinks = { count: 0, at: 0 };
          this.send(p, { type: 'notice', text: 'You wake up on the floor — stone sober.' });
          this.sendVice(p);
        } else {
          continue;
        }
      }
      if (p.hippyUntil && now >= p.hippyUntil) {
        p.hippyUntil = 0;
        this.sendVice(p);
      }
      // v1.1.1 fishing: a cast resolves on its timer, right here in
      // the zone it was made. Wandering off the spot reels it in.
      if (p.casting) {
        if (now >= p.casting.until) {
          p.casting = null;
          this.resolveCast(p, now);
        } else if (Math.hypot(p.x - p.casting.spot.x, p.y - p.casting.spot.y) > 80) {
          p.casting = null;
          this.send(p, { type: 'notice', text: 'You wander off — the line comes with you. Cast cancelled.' });
        }
      }
      let dx = 0, dy = 0;
      if (p.keys.left) dx -= 1;
      if (p.keys.right) dx += 1;
      if (p.keys.up) dy -= 1;
      if (p.keys.down) dy += 1;
      if ((dx !== 0 || dy !== 0) && p.emote && p.emote.name === 'dance') p.emote = null; // walking ends the dance
      // Phase 9: no keys held → follow the click-to-move route, if any.
      if (dx === 0 && dy === 0 && p.path && p.path.length) {
        const wp = p.path[0];
        const ddx = wp.x - p.x, ddy = wp.y - p.y;
        const dist = Math.hypot(ddx, ddy);
        if (dist <= 6) {
          p.path.shift();
          if (!p.path.length) p.path = null;
        } else {
          dx = ddx / dist; dy = ddy / dist;
        }
      }
      if (dx === 0 && dy === 0) continue;
      // Phase B sitting: any movement input stands you up (and is
      // consumed — you don't slide off the chair in the same tick).
      if (p.seated) {
        p.seated = null;
        p.keys = {};
        p.path = null;
        this.send(p, { type: 'sit-state', seated: false });
        continue;
      }
      const speed = SPEED * (p.run ? RUN_MULT : 1);
      const len = Math.hypot(dx, dy);
      dx = (dx / len) * speed * dt;
      dy = (dy / len) * speed * dt;
      // Phase B amendment — drunk wobble: from 3 drinks the walk
      // direction sways sinusoidally (server-side, so everyone sees
      // the same stagger); strength grows with the count.
      const drinksNow = this.viceCount(p, 'drinks', now);
      if (drinksNow >= 3) {
        const sway = Math.sin(now / 300 + p.userId * 1.7) * 0.22 * Math.min(1, (drinksNow - 2) / 6);
        const c = Math.cos(sway), s = Math.sin(sway);
        const rx = dx * c - dy * s, ry = dx * s + dy * c;
        dx = rx; dy = ry;
      }

      // Axis-separated movement → wall sliding for free.
      const nx = p.x + dx;
      if (!collides(map, nx, p.y, PLAYER_RADIUS)) p.x = nx;
      const ny = p.y + dy;
      if (!collides(map, p.x, ny, PLAYER_RADIUS)) p.y = ny;

      // v1.1 facing (Zan: "walk right, face right"): dir names the
      // SCREEN direction of travel. dx/dy here are world axes; the
      // shared mapping projects them through the iso transform and
      // takes the dominant screen axis. (The old world-axis read was
      // the Lane B quirk: screen-right is world (+1,-1) — a tie the
      // old code fell through to 'up'.)
      p.dir = screenFacing(dx, dy);

      // v1.1: while performing, the artist stays ON the platform —
      // movement clamps to the stage rect instead of walking off,
      // and never cancels the set (it ends at mix end / scene change
      // / disconnect, as the stage module already handles).
      if (p.performing && map.stage) {
        const st = map.stage;
        p.x = Math.max(st.x + PLAYER_RADIUS, Math.min(st.x + st.w - PLAYER_RADIUS, p.x));
        p.y = Math.max(st.y + PLAYER_RADIUS, Math.min(st.y + st.h - PLAYER_RADIUS, p.y));
      }

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
    // Phase 10: inside a home, the door is a REAL door — stepping
    // onto its tile walks you out (the studio system handles the
    // return trip). Studio scenes have no other portals.
    if (map.isStudio) {
      const d = map.studio && map.studio.door;
      if (d && p.x >= d.x && p.x < d.x + d.w && p.y >= d.y && p.y < d.y + d.h) {
        if (Date.now() - p.lastGatewayAt >= 1500 && this.studioSystem) {
          this.studioSystem.handleLeave(p);
        }
      }
      return;
    }
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
      // Lane C: gateways are gatehouses — arrival means stepping
      // OUT of the matching gatehouse in the target map. Land at
      // that gatehouse's spawnOut (just outside its mouth, clear of
      // its trigger) instead of the map's generic spawn.
      const back = (target.gateways || []).find(g2 => g2.target === p.mapId);
      this.switchScene(p, target, back && back.spawnOut ? { spawn: back.spawnOut } : {});
      return;
    }
    // Phase 10: the Gateway's "My Home" door — its target is the
    // walker's OWN studio, resolved by the studio system.
    if (dr.target === 'studio:self') {
      if (this.studioSystem) this.studioSystem.handleHomeDoor(p);
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
    p.casting = null;     // ... or a fishing line (v1.1.1)
    p.seated = null;      // ... or a chair
    p.path = null;        // ... or a walking route
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
      dayCycle: DAY_CYCLE,
      ...(opts.extra || {}),
    });
    this.sendVice(p);
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

  // ---------------------------------------------------------- vices
  // Phase B amendment: drinks (casino bars) + puffs (hookah lounge).
  // Counts live in the 30s window from the last consumption (see the
  // VICE block); everything money-shaped is server-side and atomic.

  /**
   * Effective count for 'drinks' or 'puffs' under the v1.1 window
   * model: the stacked level while the 30s window from the last
   * drink/puff is open, else 0 (sober). No per-minute decay.
   */
  viceCount(p, kind, now = Date.now()) {
    const v = p.vice[kind];
    if (!v || !v.count) return 0;
    return now - v.at < VICE.WINDOW_MS ? v.count : 0;
  }

  /** Add one drink/puff: refreshes the 30s window, stacks the level. */
  viceAdd(p, kind, now = Date.now()) {
    const next = this.viceCount(p, kind, now) + 1;
    p.vice[kind] = { count: next, at: now };
    return next;
  }

  viceStateMsg(p, now = Date.now()) {
    return {
      type: 'vice-state',
      drinks: this.viceCount(p, 'drinks', now),
      puffs: this.viceCount(p, 'puffs', now),
      passedOut: Boolean(p.passedOutUntil && now < p.passedOutUntil),
      hippy: Boolean(p.hippyUntil && now < p.hippyUntil),
    };
  }

  sendVice(p) { this.send(p, this.viceStateMsg(p)); }

  zcoinsOf(userId) {
    const r = VQ.zOf.get(userId);
    return r ? r.zcoins : 0;
  }

  /**
   * Buy a drink (5z) at a casino bar: stand at the bar's patron spot.
   * The 10th drink knocks the player out cold for PASSOUT_MS.
   */
  handleBuyDrink(p) {
    const now = Date.now();
    if (p.passedOutUntil && now < p.passedOutUntil) {
      this.send(p, { type: 'notice', text: 'You are out cold — the drinks can wait.' });
      return;
    }
    const map = this.sceneFor(p.mapId);
    const bar = map && map.casino && map.casino.bar;
    if (!bar) {
      this.send(p, { type: 'notice', text: 'There is no bar here.' });
      return;
    }
    if (Math.hypot(p.x - bar.x, p.y - bar.y) > VICE.BAR_RADIUS) {
      this.send(p, { type: 'notice', text: 'Head to the bar — the bartender pours there.' });
      return;
    }
    // Phase 9 — the bartender's daily ritual: the FIRST drink of
    // the day (at either bartender) is on the house AND the house
    // tips YOU 10z ("regulars eat free once a day"). Server-enforced
    // via avatars.last_bar_day; independent of the login bonus.
    const today = localDay();
    const av = q.avatarByUser.get(p.userId);
    const dailyTreat = Boolean(av && av.last_bar_day !== today);
    if (!dailyTreat) {
      const debited = VQ.debit.run(VICE.DRINK_COST, p.userId, VICE.DRINK_COST);
      if (debited.changes !== 1) {
        this.send(p, { type: 'notice', text: `A drink costs ${VICE.DRINK_COST}z — you don't have enough.` });
        return;
      }
    } else {
      q.setLastBarDay.run(today, p.userId);
      VQ.credit.run(BAR_TIP_Z, p.userId);
    }
    const count = this.viceAdd(p, 'drinks', now);
    this.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(p.userId) });
    this.send(p, {
      type: 'notice',
      text: dailyTreat
        ? `🍸 The bartender waves off your coins — "First one's on the house, regular." And slips you a ${BAR_TIP_Z}z tip back?! (Drink #${count}.)`
        : `🍸 Drink #${count} slides across the bar (${VICE.DRINK_COST}z).`,
    });
    if (count >= VICE.THRESHOLD) {
      p.passedOutUntil = now + VICE.PASSOUT_MS;
      p.keys = {};
      if (p.seated) {
        p.seated = null;
        this.send(p, { type: 'sit-state', seated: false });
      }
      this.send(p, { type: 'notice', text: '🍸 The room spins… you PASS OUT cold for 20 seconds!' });
    }
    this.sendVice(p);
  }

  /** Take a hookah puff (5z) while seated at a hookah station. */
  handlePuff(p) {
    const now = Date.now();
    const debited = VQ.debit.run(VICE.PUFF_COST, p.userId, VICE.PUFF_COST);
    if (debited.changes !== 1) {
      this.send(p, { type: 'notice', text: `A puff costs ${VICE.PUFF_COST}z — you don't have enough.` });
      return;
    }
    const count = this.viceAdd(p, 'puffs', now);
    this.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(p.userId) });
    this.send(p, { type: 'notice', text: `💨 Puff #${count} (${VICE.PUFF_COST}z). The colours get louder…` });
    if (count >= VICE.THRESHOLD) {
      p.hippyUntil = now + VICE.HIPPY_MS;
      p.vice.puffs = { count: 0, at: now }; // the trip burns the count off
      this.send(p, { type: 'notice', text: '🌈 Far out! You are a full-blown HIPPY for 20 seconds!' });
    }
    this.sendVice(p);
  }

  // ---------------------------------------------------------- fishing
  // v1.1.1 (Zan): pond fishing. State, RNG and money all live here on
  // the server; src/fishing.js carries the shared math + species.

  /** Nearest fishing spot within reach of the player, or null. */
  fishingSpotNear(p) {
    const map = this.sceneFor(p.mapId);
    const spots = (map && map.fishing) || [];
    let best = null, bestD = Infinity;
    for (const s of spots) {
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return bestD <= SIT_RADIUS ? best : null;
  }

  /** Cast a line from a shore spot: face the water, wait it out. */
  handleFish(p, spot) {
    const now = Date.now();
    if (p.casting) {
      this.send(p, { type: 'notice', text: 'Your line is already in the water…' });
      return;
    }
    p.dir = spot.dir;
    p.casting = { until: now + FISHING.CAST_MS, spot };
    this.send(p, { type: 'notice', text: '🎣 You cast your line…' });
  }

  /** Settle a finished cast: roll; on a catch, pay 1z + hold it up. */
  resolveCast(p, now = Date.now()) {
    const forced = p.fishForce; p.fishForce = null;
    const caught = forced ? forced === 'catch' : FISHING.rollCatch();
    if (!caught) {
      this.send(p, { type: 'notice', text: '🎣 …a nibble, then nothing. Cast again!' });
      return;
    }
    const fish = FISHING.pickFish();
    VQ.credit.run(FISHING.PAYOUT_Z, p.userId);
    p.heldFish = { id: fish.id, until: now + FISHING.HOLD_MS };
    this.send(p, { type: 'zcoins', zcoins: this.zcoinsOf(p.userId) });
    this.send(p, { type: 'notice', text: `🎣 Caught a ${fish.name}! +${FISHING.PAYOUT_Z}z` });
    this.broadcastToMap(p.mapId, {
      type: 'fish-caught', playerId: p.userId, fish: fish.id, name: fish.name,
    });
  }

  /**
   * `interact` (E key / Sit button): toggle sitting. Standing next to
   * a free seat sits you on it (snapped into place, facing the seat's
   * way); interacting again stands. Movement input also stands (see
   * tick). Chat works seated — nothing here touches chat.
   * Phase B amendment: while seated at a hookah station, interact
   * takes a puff instead of standing.
   */
  handleInteract(p) {
    if (p.transferUntil && Date.now() < p.transferUntil) return;
    if (p.passedOutUntil && Date.now() < p.passedOutUntil) return; // out cold
    if (p.seated) {
      if (p.seated.kind === 'hookah') { this.handlePuff(p); return; }
      if (p.seated.kind === 'poker') {
        this.send(p, { type: 'notice', text: 'Use Stand / Cash out in the poker tray to leave the table.' });
        return;
      }
      p.seated = null;
      this.send(p, { type: 'sit-state', seated: false });
      return;
    }
    // v1.1.1 fishing: at a pond spot, interact casts a line — spots
    // win over seats (a shore is for fishing, not sitting).
    const fishSpot = this.fishingSpotNear(p);
    if (fishSpot) { this.handleFish(p, fishSpot); return; }
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
    if (s.kind === 'hookah') {
      this.send(p, { type: 'notice', text: `Settled in. Press E to take a puff — ${VICE.PUFF_COST}z each.` });
    } else if (String(s.id).includes('-slotseat-')) {
      this.send(p, { type: 'notice', text: 'Seated at the slot machine — hit SPIN 🎰!' });
    }
  }
}

module.exports = { Game, localDay, PLAYER_RADIUS, SPEED, RUN_MULT, CHAT_LIMIT, TRANSFER_MS, VICE, EMOTES, BAR_TIP_Z, DAY_CYCLE };
