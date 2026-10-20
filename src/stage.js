'use strict';

/**
 * Solarion — stage performances (Phase 2, soul doc §2 + §9.1–9.6).
 *
 * One stage per map that defines one (Solstice Bay in Phase 2). Flow:
 *
 *   player in the map with ≥1 saved mix sends {type:'stage-join', mixId}
 *   → they enter the visible queue (broadcast to the whole map).
 *   When the stage is free, the front of the queue performs: the server
 *   broadcasts performance-start (full mix data + startAt ≈ now+1.2s)
 *   and every client schedules the mix locally — close-enough sync for
 *   a social toy. The performer holds the mic (p.performing) and their
 *   chat goes room-wide (see game.handleChat).
 *   Listeners in the same map vote 👍/👎 during the performance or a
 *   10s grace window after it. One vote per listener per performance,
 *   no self-votes — all enforced here, server-side.
 *   At the end: performance-end is broadcast with the tallies and the
 *   performer is paid +5z per thumbs-up, hard-capped at 350z/day from
 *   performance earnings (perf_earnings table, server-local day).
 *   Performers wait out a 60s cooldown before rejoining a queue.
 *
 * The module owns a 250ms timer (started from server.js) that starts
 * queued performances, ends finished ones, and sweeps queue entries
 * whose owners disconnected or left the map.
 */

const music = require('./music');
const { localDay } = require('./game');

const START_DELAY_MS = 1200;      // clients get this long to schedule playback
const GRACE_MS = 10_000;          // voting window after the music stops
const COOLDOWN_MS = 60_000;       // performer re-queue cooldown
const TICK_MS = 250;

class Stage {
  constructor(game, mapId, stageDef) {
    this.game = game;
    this.mapId = mapId;
    this.def = stageDef;
    this.queue = [];              // [{ userId, name, mixId, mixName }]
    this.current = null;          // active performance (see startPerformance)
    this.nextPerfId = 1;
    this.cooldownUntil = new Map(); // userId -> timestamp
  }

  publicQueue() {
    return {
      type: 'stage-queue',
      mapId: this.mapId,
      queue: this.queue.map(e => ({ userId: e.userId, name: e.name, mixName: e.mixName })),
      current: this.current
        ? { userId: this.current.performerId, name: this.current.performerName, mixName: this.current.mixName }
        : null,
    };
  }

  broadcastQueue() {
    this.game.broadcastToMap(this.mapId, this.publicQueue());
  }

  sendQueueTo(p) {
    this.game.send(p, this.publicQueue());
  }

  // ------------------------------------------------------------- queue

  join(p, mixId) {
    if (p.mapId !== this.mapId) return;
    if (!Number.isInteger(mixId)) { // Phase 5: wire value, never trust its type
      this.game.send(p, { type: 'notice', text: 'Pick one of your saved mixes to perform.' });
      return;
    }
    if (this.current && this.current.performerId === p.userId) {
      this.game.send(p, { type: 'notice', text: 'You are already performing!' });
      return;
    }
    if (this.queue.some(e => e.userId === p.userId)) {
      this.game.send(p, { type: 'notice', text: 'You are already in the stage queue.' });
      return;
    }
    const until = this.cooldownUntil.get(p.userId) || 0;
    if (Date.now() < until) {
      const s = Math.ceil((until - Date.now()) / 1000);
      this.game.send(p, { type: 'notice', text: `Take a breather — you can perform again in ${s}s.` });
      return;
    }
    const mix = music.getMix(p.userId, mixId);
    if (!mix) {
      this.game.send(p, { type: 'notice', text: 'Pick one of your saved mixes to perform.' });
      return;
    }
    this.queue.push({ userId: p.userId, name: p.name, mixId: mix.id, mixName: mix.name, mixData: mix.data });
    this.game.send(p, { type: 'notice', text: `You're in the queue to perform "${mix.name}" 🎤` });
    this.broadcastQueue();
  }

  leave(p) {
    const i = this.queue.findIndex(e => e.userId === p.userId);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.broadcastQueue();
    }
  }

  /** Player disconnected or changed map: drop queue entry, end a live set early. */
  handlePlayerGone(userId) {
    const i = this.queue.findIndex(e => e.userId === userId);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.broadcastQueue();
    }
    if (this.current && this.current.performerId === userId) {
      this.finishPerformance(true);
    }
  }

  // ------------------------------------------------------------- voting

  vote(p, value) {
    const cur = this.current;
    if (!cur) return;
    if (value !== 1 && value !== -1) return;            // Phase 5: strict vote values
    if (p.mapId !== this.mapId) return;                 // must be in the room
    if (p.userId === cur.performerId) {                 // no self-votes
      this.game.send(p, { type: 'notice', text: "You can't vote on your own performance." });
      return;
    }
    if (Date.now() > cur.votingEndsAt) return;          // window closed
    if (cur.votes.has(p.userId)) {                      // one vote per listener
      this.game.send(p, { type: 'notice', text: 'You already voted on this performance.' });
      return;
    }
    cur.votes.set(p.userId, value === -1 ? -1 : 1);
    this.game.send(p, { type: 'vote-ack', performanceId: cur.id, value: cur.votes.get(p.userId) });
  }

  // ------------------------------------------------------------- engine

  tick() {
    // Sweep queue entries whose owners left the map or went offline.
    let swept = false;
    this.queue = this.queue.filter(e => {
      const p = this.game.getPlayer(e.userId);
      const ok = p && p.mapId === this.mapId;
      if (!ok) swept = true;
      return ok;
    });
    if (swept) this.broadcastQueue();

    if (this.current) {
      const performer = this.game.getPlayer(this.current.performerId);
      if (!performer || performer.mapId !== this.mapId) {
        this.finishPerformance(true);
      } else if (Date.now() >= this.current.finalizeAt) {
        this.finishPerformance(false);
      }
    }
    if (!this.current && this.queue.length) {
      const next = this.queue[0];
      const p = this.game.getPlayer(next.userId);
      if (p && p.mapId === this.mapId) {
        this.queue.shift();
        this.startPerformance(p, next);
        this.broadcastQueue();
      }
    }
  }

  startPerformance(p, entry) {
    const now = Date.now();
    const durationMs = music.mixDurationMs(entry.mixData);
    const startAt = now + START_DELAY_MS;
    // Walk the performer up onto the stage (soul doc §9.2 — the
    // procession matters; snapping to centre stage is our version).
    p.x = this.def.x + this.def.w / 2;
    p.y = this.def.y + this.def.h / 2;
    p.performing = true;
    p.keys = {};
    this.game.savePosition(p);
    this.current = {
      id: this.nextPerfId++,
      performerId: p.userId,
      performerName: p.name,
      mixId: entry.mixId,
      mixName: entry.mixName,
      mixData: entry.mixData,
      startAt,
      votingEndsAt: startAt + durationMs + GRACE_MS,
      finalizeAt: startAt + durationMs + GRACE_MS,
      votes: new Map(),
    };
    this.game.broadcastToMap(this.mapId, {
      type: 'performance-start',
      performanceId: this.current.id,
      performerId: p.userId,
      performerName: p.name,
      mixName: entry.mixName,
      mix: entry.mixData,
      startAt,
      durationMs,
    });
  }

  finishPerformance(early) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    let up = 0, down = 0;
    for (const v of cur.votes.values()) { if (v > 0) up++; else down++; }

    // Pay: +5z per thumbs-up, hard daily cap of 350z from performing.
    const today = localDay();
    const already = music.perfEarnedOn(cur.performerId, today);
    const raw = up * music.PERF_PAY_PER_UP;
    const earned = Math.max(0, Math.min(raw, music.PERF_DAILY_CAP - already));
    let balance = null;
    if (earned > 0) {
      music.setPerfEarned(cur.performerId, today, already + earned);
      balance = music.addZCoins(cur.performerId, earned);
    }

    const performer = this.game.getPlayer(cur.performerId);
    if (performer) {
      performer.performing = false;
      this.cooldownUntil.set(cur.performerId, Date.now() + COOLDOWN_MS);
      if (balance !== null) this.game.send(performer, { type: 'zcoins', zcoins: balance });
    } else {
      this.cooldownUntil.set(cur.performerId, Date.now() + COOLDOWN_MS);
    }

    this.game.broadcastToMap(this.mapId, {
      type: 'performance-end',
      performanceId: cur.id,
      performerId: cur.performerId,
      performerName: cur.performerName,
      mixName: cur.mixName,
      up, down, earned,
      early: Boolean(early),
    });
    this.broadcastQueue();
  }
}

class StageManager {
  constructor(game) {
    this.game = game;
    this.stages = new Map(); // mapId -> Stage
    this.timer = null;
  }

  registerMap(mapId, stageDef) {
    this.stages.set(mapId, new Stage(this.game, mapId, stageDef));
  }

  stageFor(p) {
    return this.stages.get(p.mapId) || null;
  }

  start() {
    this.timer = setInterval(() => {
      for (const s of this.stages.values()) s.tick();
    }, TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  handleJoin(p, mixId) {
    const s = this.stageFor(p);
    if (!s) {
      this.game.send(p, { type: 'notice', text: 'There is no stage in this room.' });
      return;
    }
    s.join(p, mixId);
  }

  handleLeave(p) {
    const s = this.stageFor(p);
    if (s) s.leave(p);
  }

  handleVote(p, value) {
    const s = this.stageFor(p);
    if (s) s.vote(p, value);
  }

  handlePlayerGone(userId) {
    for (const s of this.stages.values()) s.handlePlayerGone(userId);
  }

  /** Send the current queue state for the player's map (on join/map entry). */
  syncPlayer(p) {
    const s = this.stageFor(p);
    if (s) s.sendQueueTo(p);
  }
}

module.exports = { StageManager, START_DELAY_MS, GRACE_MS, COOLDOWN_MS };
