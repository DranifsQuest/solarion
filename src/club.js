'use strict';

/**
 * Solarion — Club Mirage (v1.4; v1.6 the follow): the go-go bar's
 * interactions beyond the bar itself (drinks ride the shared vice
 * model in game.js — the club's bar is a bar like any other).
 *
 * TIP A DANCER: a preset-amount gift to a dancer NPC. She is a
 * fixture, not a player, so the money is a pure SINK — the guarded
 * debit is the whole ledger move and nobody is credited (unlike
 * stage tips, which pay the performer). In return the room gets a
 * 'dancer-flourish' broadcast and the dancer does her flourish
 * (clients animate it). Server-authoritative throughout: the
 * amount must be one of the presets, the tipper must be standing
 * in the club within reach of THAT dancer, and a per-player
 * cooldown (2.5s) keeps flourish spam — and accidental
 * double-taps — from draining anyone.
 *
 * THE 500z FOLLOW (v1.6, Zan's order): a single 500z tip buys one
 * minute of company. The dancer steps off her stage and FOLLOWS
 * the tipper around the club as a server-driven entity — her
 * position streams to the whole room ('dancer-state', snapshot
 * cadence) so she is a shared sight, not a local illusion. She
 * trails at a natural distance on the game's own movement rules
 * (player walk speed; she only hurries — run multiplier — when
 * she would otherwise be left behind), routes around the room
 * with the same BFS pathfinder click-to-move uses, and never
 * leaves the club: when the minute ends, or the tipper leaves
 * the club or disconnects, she WALKS back to her stage anchor
 * and resumes her dance loop. Concurrency (flagged to Zan):
 *   - one follow per dancer — a 500z tip while she is off her
 *     stage is refused with a notice and NO charge (the busy
 *     check runs BEFORE the debit, always);
 *   - one dancer per tipper — a second 500z while you already
 *     have company is likewise refused, uncharged;
 *   - regular tips (5-100z) work exactly as before; tipped
 *     mid-follow she flourishes WHERE SHE STANDS (the radius is
 *     measured to her live position, not her empty stage).
 */

const { db } = require('./db');
const { MAPS, TILE, collides } = require('./maps');
const { findPath } = require('./pathfind');
const { screenFacing } = require('../public/input-guard');

const TIP_AMOUNTS = [5, 10, 25, 50, 100, 500]; // the stage tip box's presets + the 500z follow
const FOLLOW_TIP = 500;
const TIP_RADIUS = 170;                   // px from the dancer — ringside, not across the room
const TIP_COOLDOWN_MS = 2500;
// Test builds run the follow on a short clock so the suite can
// watch a whole minute elapse; production is the real 60s.
const FOLLOW_MS = process.env.SOLARION_TEST === '1' ? 12000 : 60000;
const FOLLOW_DIST = 46;                   // px she trails behind the tipper
const WALK_SPEED = 175;                   // mirrors game.SPEED
const RUN_MULT = 1.55;                    // mirrors game.RUN_MULT (catch-up only)
const TICK_MS = 50;                       // 20Hz, the game's tick
const DANCER_RADIUS = 12;                 // mirrors game.PLAYER_RADIUS

const debitZ = db.prepare('UPDATE avatars SET zcoins = zcoins - ? WHERE user_id = ? AND zcoins >= ?');
const zOf = db.prepare('SELECT zcoins FROM avatars WHERE user_id = ?');

class ClubSystem {
  constructor(game) {
    this.game = game;
    this.clubs = new Map();       // mapId -> club def
    this.dancers = new Map();     // mapId -> Map(dancerId -> live state)
    this.lastTipAt = new Map();   // userId -> epoch-ms of last accepted tip
    this.timer = null;
  }

  initFromMaps(maps) {
    for (const [mapId, map] of Object.entries(maps)) {
      if (!map.club) continue;
      this.clubs.set(mapId, map.club);
      const live = new Map();
      for (const stage of map.club.stages) {
        if (!stage.dancer) continue;
        live.set(stage.dancer.id, {
          stage, dancer: stage.dancer,
          x: stage.dancer.x, y: stage.dancer.y, dir: 'down',
          mode: 'stage',            // 'stage' | 'follow' | 'return'
          followUserId: null, followName: null, endsAt: 0,
          path: null, pathGoal: null, lastTx: 0, lastTy: 0,
        });
      }
      this.dancers.set(mapId, live);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Live state for one dancer (null when the map/dancer is unknown). */
  dancerState(mapId, dancerId) {
    const live = this.dancers.get(mapId);
    return live ? live.get(dancerId) || null : null;
  }

  /** The dancer a tip targets: an explicit id wins; otherwise the
   *  nearest dancer in the room (the tray tips whoever's stage
   *  you're standing at). Positions are LIVE — a dancer mid-follow
   *  is where she stands, not where her stage is. */
  resolveDancer(mapId, club, dancerId) {
    if (typeof dancerId === 'string' && dancerId) {
      for (const stage of club.stages) {
        if (stage.dancer && stage.dancer.id === dancerId) {
          const st = this.dancerState(mapId, dancerId);
          return { stage, dancer: stage.dancer, state: st };
        }
      }
      return null;
    }
    return null; // no id: caller falls back to nearest by position
  }

  nearestDancer(mapId, club, x, y) {
    let best = null, bestD = Infinity;
    for (const stage of club.stages) {
      if (!stage.dancer) continue;
      const st = this.dancerState(mapId, stage.dancer.id);
      const dx = st ? st.x : stage.dancer.x, dy = st ? st.y : stage.dancer.y;
      const d = Math.hypot(dx - x, dy - y);
      if (d < bestD) { bestD = d; best = { stage, dancer: stage.dancer, state: st, dist: d }; }
    }
    return best;
  }

  // ------------------------------------------------------------ the follow

  /** The dancer currently following this user, if any. */
  followerOf(userId) {
    for (const [mapId, live] of this.dancers) {
      for (const st of live.values()) {
        if (st.mode === 'follow' && st.followUserId === userId) return { mapId, state: st };
      }
    }
    return null;
  }

  startFollow(mapId, st, p, now) {
    st.mode = 'follow';
    st.followUserId = p.userId;
    st.followName = p.name;
    st.endsAt = now + FOLLOW_MS;
    st.path = null; st.pathGoal = null;
    this.game.broadcastToMap(mapId, {
      type: 'dancer-follow', dancer: st.dancer.id, name: st.dancer.name,
      from: p.name, endsAt: st.endsAt,
    });
    this.streamMap(mapId);
  }

  /** End a follow (expiry, tipper gone): she walks home. */
  endFollow(mapId, st, reason) {
    if (st.mode !== 'follow') return;
    st.mode = 'return';
    st.path = null; st.pathGoal = null;
    this.game.broadcastToMap(mapId, {
      type: 'dancer-return', dancer: st.dancer.id, name: st.dancer.name, reason,
    });
  }

  /** game.onPlayerGone: disconnect OR any map change — a tipper
   *  who is no longer in the club loses the follow on the spot
   *  (Zan: "if you leave the club she automatically goes back"). */
  handlePlayerGone(userId) {
    for (const [mapId, live] of this.dancers) {
      for (const st of live.values()) {
        if (st.mode === 'follow' && st.followUserId === userId) {
          this.endFollow(mapId, st, 'left');
        }
      }
    }
  }

  /** game.onMapEntered: a fresh arrival in the club gets the live
   *  dancer states, so a follow in progress is visible at once. */
  syncPlayer(p) {
    if (this.clubs.has(p.mapId)) this.streamMap(p.mapId, p);
  }

  /** Stream every non-stage dancer's live position to the room
   *  (or to one player, for syncPlayer). On-stage dancers are the
   *  client's static fixtures and are never streamed — a state
   *  whose mode reads 'stage' tells the client to hand her back
   *  to the fixture draw. */
  streamMap(mapId, onlyPlayer = null) {
    const live = this.dancers.get(mapId);
    if (!live) return;
    const dancers = [...live.values()].map(st => ({
      id: st.dancer.id, x: Math.round(st.x), y: Math.round(st.y), dir: st.dir,
      mode: st.mode,
      withUserId: st.mode === 'follow' ? st.followUserId : null,
      withName: st.mode === 'follow' ? st.followName : null,
      endsAt: st.mode === 'follow' ? st.endsAt : 0,
    }));
    const msg = { type: 'dancer-state', dancers };
    if (onlyPlayer) this.game.send(onlyPlayer, msg);
    else this.game.broadcastToMap(mapId, msg);
  }

  tick() {
    const now = Date.now();
    const dt = TICK_MS / 1000;
    for (const [mapId, live] of this.dancers) {
      const map = MAPS[mapId];
      if (!map) continue;
      let active = false;
      for (const st of live.values()) {
        if (st.mode === 'follow') {
          active = true;
          const tipper = this.game.getPlayer(st.followUserId);
          if (!tipper || tipper.mapId !== mapId || now >= st.endsAt) {
            this.endFollow(mapId, st, !tipper || tipper.mapId !== mapId ? 'left' : 'time');
            continue;
          }
          this.stepFollow(map, st, tipper, dt);
        } else if (st.mode === 'return') {
          active = true;
          this.stepReturn(map, st, dt);
        }
      }
      // Snapshot cadence for the room while anyone is off-stage;
      // stepReturn sends the final all-home state itself.
      if (active) this.streamMap(mapId);
    }
  }

  /** One movement step for a following dancer: trail the tipper
   *  at FOLLOW_DIST, on the game's own movement conventions —
   *  waypoint routes from the shared pathfinder when the straight
   *  line won't do, axis-separated collision, walk speed, with a
   *  run-multiplier hurry only when she is falling behind. */
  stepFollow(map, st, tipper, dt) {
    const dx = tipper.x - st.x, dy = tipper.y - st.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= FOLLOW_DIST) { st.path = null; st.pathGoal = null; return; }
    // The point she wants: FOLLOW_DIST from the tipper, on the
    // line back to where she stands (she closes in, never stacks
    // onto his tile).
    const gx = tipper.x - (dx / dist) * FOLLOW_DIST;
    const gy = tipper.y - (dy / dist) * FOLLOW_DIST;
    const speed = dist > 170 ? WALK_SPEED * RUN_MULT : WALK_SPEED;
    if (!this.stepToward(map, st, gx, gy, speed, dt)) {
      // The straight line is blocked (the bar counter, a stage):
      // route with the pathfinder, refreshed as the tipper moves.
      const gtx = Math.floor(tipper.x / TILE), gty = Math.floor(tipper.y / TILE);
      if (!st.path || !st.path.length || st.pathGoal !== `${gtx},${gty}`) {
        st.path = findPath(map, st.x, st.y, tipper.x, tipper.y);
        st.pathGoal = `${gtx},${gty}`;
      }
      this.stepPath(map, st, speed, dt);
    } else if (dist < 90) {
      st.path = null; st.pathGoal = null; // close again: drop any stale route
    }
  }

  /** Walk home to the stage anchor; on arrival she resumes her
   *  dance loop (mode 'stage', one final stream so clients hand
   *  her back to the fixture draw at the exact anchor). */
  stepReturn(map, st, dt) {
    const ax = st.dancer.x, ay = st.dancer.y;
    const dist = Math.hypot(ax - st.x, ay - st.y);
    if (dist <= 6) {
      st.x = ax; st.y = ay; st.dir = 'down';
      st.mode = 'stage'; st.path = null; st.pathGoal = null;
      st.followUserId = null; st.followName = null; st.endsAt = 0;
      this.streamMap(map.id);
      return;
    }
    const speed = dist > 170 ? WALK_SPEED * RUN_MULT : WALK_SPEED;
    if (!this.stepToward(map, st, ax, ay, speed, dt)) {
      if (!st.path || !st.path.length) {
        st.path = findPath(map, st.x, st.y, ax, ay);
        st.pathGoal = 'home';
      }
      this.stepPath(map, st, speed, dt);
    }
  }

  /** Axis-separated step toward (tx, ty) — the game's wall-slide
   *  convention. Returns false when the step made no progress
   *  (blocked), so callers can fall back to a routed path. */
  stepToward(map, st, tx, ty, speed, dt) {
    const dx = tx - st.x, dy = ty - st.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return true;
    const step = Math.min(dist, speed * dt);
    const mx = (dx / dist) * step, my = (dy / dist) * step;
    const ox = st.x, oy = st.y;
    if (!collides(map, st.x + mx, st.y, DANCER_RADIUS)) st.x += mx;
    if (!collides(map, st.x, st.y + my, DANCER_RADIUS)) st.y += my;
    if (st.x !== ox || st.y !== oy) st.dir = screenFacing(st.x - ox, st.y - oy);
    return Math.hypot(st.x - ox, st.y - oy) > step * 0.25;
  }

  /** Follow a waypoint route (the game's click-to-move shape). */
  stepPath(map, st, speed, dt) {
    if (!st.path || !st.path.length) return;
    const wp = st.path[0];
    if (Math.hypot(wp.x - st.x, wp.y - st.y) <= 6) { st.path.shift(); return; }
    this.stepToward(map, st, wp.x, wp.y, speed, dt);
  }

  // ------------------------------------------------------------ tips

  handleTipDancer(p, dancerId, amount) {
    const club = this.clubs.get(p.mapId);
    if (!club) {
      this.game.send(p, { type: 'notice', text: 'There is no dancer to tip here.' });
      return;
    }
    if (!TIP_AMOUNTS.includes(amount)) {
      this.game.send(p, { type: 'notice', text: 'Pick one of the preset tip amounts.' });
      return;
    }
    let target = this.resolveDancer(p.mapId, club, dancerId);
    if (!target) {
      const near = this.nearestDancer(p.mapId, club, p.x, p.y);
      if (near) target = { stage: near.stage, dancer: near.dancer, state: near.state, dist: near.dist };
    }
    if (!target) {
      this.game.send(p, { type: 'notice', text: 'No dancer on stage right now.' });
      return;
    }
    const st = target.state || this.dancerState(p.mapId, target.dancer.id);
    const dist = target.dist !== undefined
      ? target.dist
      : Math.hypot((st ? st.x : target.dancer.x) - p.x, (st ? st.y : target.dancer.y) - p.y);
    if (dist > TIP_RADIUS) {
      this.game.send(p, { type: 'notice', text: `Sidle up to ${target.dancer.name}'s stage to tip her.` });
      return;
    }
    const now = Date.now();
    const last = this.lastTipAt.get(p.userId) || 0;
    if (now - last < TIP_COOLDOWN_MS) {
      this.game.send(p, { type: 'notice', text: 'She\'s still twirling from the last one — give it a beat.' });
      return;
    }
    const isFollow = amount === FOLLOW_TIP;
    if (isFollow) {
      // Busy checks run BEFORE any money moves: a follow that
      // can't start is never charged for.
      if (!st || st.mode !== 'stage') {
        this.game.send(p, { type: 'notice', text: `💃 ${target.dancer.name} is off her stage right now — she'll be back soon.` });
        return;
      }
      if (this.followerOf(p.userId)) {
        this.game.send(p, { type: 'notice', text: '💃 You already have a dancer\'s company — one at a time.' });
        return;
      }
    }
    // The sink: a guarded debit and nothing else. The WHERE guard
    // makes overspend impossible (same pattern as stage tips).
    const debited = debitZ.run(amount, p.userId, amount);
    if (debited.changes !== 1) {
      this.game.send(p, { type: 'notice', text: `A ${amount}z tip needs ${amount}z in your pocket.` });
      return;
    }
    this.lastTipAt.set(p.userId, now);
    const zr = zOf.get(p.userId);
    this.game.send(p, { type: 'zcoins', zcoins: zr ? zr.zcoins : 0 });
    this.game.send(p, {
      type: 'notice',
      text: isFollow
        ? `💃 You tipped ${target.dancer.name} ${amount}z — she steps down to keep you company!`
        : `💸 You tipped ${target.dancer.name} ${amount}z!`,
    });
    // The room sees it: she flourishes (clients animate the spin +
    // hearts off this one event — at her stage, or where she
    // stands when she is mid-follow).
    this.game.broadcastToMap(p.mapId, {
      type: 'dancer-flourish',
      dancer: target.dancer.id,
      name: target.dancer.name,
      amount,
      from: p.name,
    });
    if (isFollow && st) this.startFollow(p.mapId, st, p, now);
  }

  handle(p, msg) {
    if (msg.type === 'tip-dancer') this.handleTipDancer(p, msg.dancer, msg.amount);
  }
}

module.exports = { ClubSystem, TIP_AMOUNTS, TIP_RADIUS, TIP_COOLDOWN_MS, FOLLOW_TIP, FOLLOW_MS, FOLLOW_DIST };
