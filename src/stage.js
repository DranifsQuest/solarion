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
const records = require('./records');
const { localDay } = require('./game');
const { db } = require('./db');

// v1.1 tips: the Stage panel's preset drop box. The debit is the
// casino pattern — a guarded UPDATE that can never overdraw.
const TIP_AMOUNTS = [5, 10, 25, 50, 100];
const debitZ = db.prepare('UPDATE avatars SET zcoins = zcoins - ? WHERE user_id = ? AND zcoins >= ?');
const zOf = db.prepare('SELECT zcoins FROM avatars WHERE user_id = ?');

const START_DELAY_MS = 1200;      // clients get this long to schedule playback
const GRACE_MS = 10_000;          // voting window after the music stops
const COOLDOWN_MS = 60_000;       // performer re-queue cooldown
// X (2026-10-23): a set never runs past 5:00, however long the mix
// is. Mixes may run to 160 bars (≈9 min at 70bpm) for CDs/radios,
// but on stage the set is cut at the cap — the broadcast durationMs
// is the capped length, so every client clips its playback at the
// same instant and the room falls silent together.
const PERF_MAX_MS = 300_000;      // 5:00 flat, tempo-independent
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
    // Phase 9 ritual: no CD, no stage. The CD is checked here and
    // again when the set actually starts (v1.1: never consumed —
    // a burned CD is a permanent collection piece until deleted).
    const cd = records.findCd(p.userId, mix.id);
    if (!cd) {
      this.game.send(p, {
        type: 'notice',
        text: `🔥 Burn "${mix.name}" to a CD first — blanks come in packs of ${records.BLANK_PACK_COUNT} for ${records.BLANK_PACK_PRICE}z (Stage panel), then burn and take the stage.`,
      });
      return;
    }
    this.queue.push({ userId: p.userId, name: p.name, mixId: mix.id, mixName: mix.name, mixData: mix.data, cdId: cd.id });
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
    // v1.1: one ACTIVE vote per listener — clicking the opposite
    // thumb SWITCHES it. Re-clicking the SAME thumb is a silent
    // no-op (hammering it must not spam acks or recount).
    const prev = cur.votes.get(p.userId);
    if (prev === value) return;
    cur.votes.set(p.userId, value);
    this.game.send(p, { type: 'vote-ack', performanceId: cur.id, value: cur.votes.get(p.userId) });
    // Phase 9 (voting juice): the room SEES each vote float by.
    // v1.1: the broadcast carries the live tallies so the performer
    // (and everyone) watches the 👍/👎 counts move in real time.
    let up = 0, down = 0;
    for (const v of cur.votes.values()) { if (v > 0) up++; else down++; }
    this.game.broadcastToMap(this.mapId, { type: 'vote-fx', performanceId: cur.id, performerId: cur.performerId, value: cur.votes.get(p.userId), up, down });
  }

  // ------------------------------------------------------------- tips

  /**
   * v1.1 tip drop box: a preset-amount gift from a listener to the
   * live performer. Server-authoritative and atomic — the guarded
   * debit can never take the tipper negative; self-tips and tips
   * with nobody on stage are refused with a notice.
   */
  tip(p, amount) {
    const cur = this.current;
    if (!cur) {
      this.game.send(p, { type: 'notice', text: 'Nobody is performing right now — tips land when the stage is live.' });
      return;
    }
    if (!TIP_AMOUNTS.includes(amount)) {
      this.game.send(p, { type: 'notice', text: 'Pick one of the preset tip amounts.' });
      return;
    }
    if (p.mapId !== this.mapId) return;
    if (p.userId === cur.performerId) {
      this.game.send(p, { type: 'notice', text: "You can't tip your own performance." });
      return;
    }
    const debited = debitZ.run(amount, p.userId, amount);
    if (debited.changes !== 1) {
      this.game.send(p, { type: 'notice', text: `A ${amount}z tip needs ${amount}z in your pocket.` });
      return;
    }
    const performerBalance = music.addZCoins(cur.performerId, amount);
    const mine = zOf.get(p.userId);
    this.game.send(p, { type: 'zcoins', zcoins: mine ? mine.zcoins : 0 });
    this.game.send(p, { type: 'notice', text: `💸 You tipped ${cur.performerName} ${amount}z!` });
    const performer = this.game.getPlayer(cur.performerId);
    if (performer) {
      this.game.send(performer, { type: 'zcoins', zcoins: performerBalance });
      this.game.send(performer, { type: 'notice', text: `💰 ${p.name} tipped you ${amount}z!` });
    }
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
    // v1.1 (X): CDs are REUSABLE — the set checks the CD is still
    // in the collection (it may have been deleted while queued) but
    // never consumes it. The Phase 9 consume-on-perform rule is gone.
    const cd = records.findCd(p.userId, entry.mixId);
    if (!cd) {
      this.game.send(p, { type: 'notice', text: '💿 That CD left your collection — burn the mix again to perform.' });
      return;
    }
    const now = Date.now();
    const durationMs = Math.min(music.mixDurationMs(entry.mixData), PERF_MAX_MS);
    const startAt = now + START_DELAY_MS;
    // Walk the performer up onto the stage (soul doc §9.2 — the
    // procession matters; snapping to centre stage is our version).
    // v1.1: the artist's held keys are NOT cleared — movement input
    // keeps flowing and the sim clamps them to the platform, so
    // playing keys can never desync or cancel the set.
    p.x = this.def.x + this.def.w / 2;
    p.y = this.def.y + this.def.h / 2;
    p.performing = true;
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
    // Phase 9: the set goes on the record — lifetime up-votes on
    // this mix earn Gold (25) / Platinum (100) wall trophies.
    const awards = records.recordPerformance(cur.mixId, cur.performerId, up, down);
    if (awards.length && this.onTrophy) {
      for (const kind of awards) this.onTrophy(cur.performerId, kind, cur.mixName);
    }
    this.broadcastQueue();
  }
}

class StageManager {
  constructor(game) {
    this.game = game;
    this.stages = new Map(); // mapId -> Stage
    this.timer = null;
    // Phase 9 hooks, wired by server.js: trophy fanfare + CD wallet
    // refreshes after consumption.
    this.onTrophy = null;      // (userId, kind, mixName)
  }

  registerMap(mapId, stageDef) {
    const s = new Stage(this.game, mapId, stageDef);
    s.onTrophy = (userId, kind, mixName) => { if (this.onTrophy) this.onTrophy(userId, kind, mixName); };
    s.onCdsChanged = (p) => this.sendCds(p);
    this.stages.set(mapId, s);
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

  handleTip(p, amount) {
    const s = this.stageFor(p);
    if (s) s.tip(p, amount);
    else this.game.send(p, { type: 'notice', text: 'Nobody is performing right now — tips land when the stage is live.' });
  }

  handlePlayerGone(userId) {
    for (const s of this.stages.values()) s.handlePlayerGone(userId);
  }

  /** Send the current queue state for the player's map (on join/map entry). */
  syncPlayer(p) {
    const s = this.stageFor(p);
    if (s) s.sendQueueTo(p);
    this.sendCds(p);
  }

  // ------------------------------------------------- Phase 9: CD economy + chart

  /** The player's CD wallet: blank count + burned CDs with titles. */
  sendCds(p) {
    const names = new Map(music.listMixes(p.userId).map(m => [m.id, m.name]));
    this.game.send(p, {
      type: 'cds',
      blanks: records.blankCount(p.userId),
      cds: records.listCds(p.userId).map(c => ({ id: c.id, mixId: c.mixId, createdAt: c.createdAt, name: names.get(c.mixId) || '(deleted mix)' })),
    });
  }

  handle(p, msg) {
    switch (msg.type) {
      case 'buy-blanks': {
        const r = records.buyBlanks(p.userId);
        if (!r.ok) { this.game.send(p, { type: 'notice', text: r.error }); return; }
        this.game.send(p, { type: 'zcoins', zcoins: r.balance });
        this.game.send(p, { type: 'notice', text: `💿 Bought a pack of ${records.BLANK_PACK_COUNT} blank CDs (${records.BLANK_PACK_PRICE}z). Burn a mix from the Stage panel!` });
        this.sendCds(p);
        break;
      }
      case 'burn-cd': {
        const mix = music.getMix(p.userId, msg.mixId);
        if (!mix) { this.game.send(p, { type: 'notice', text: 'You can only burn your own mixes.' }); return; }
        const r = records.burnCd(p.userId, mix.id);
        if (!r.ok) { this.game.send(p, { type: 'notice', text: r.error }); return; }
        this.game.send(p, { type: 'notice', text: `🔥 Burned "${mix.name}" to a CD — take it to a stage!` });
        this.sendCds(p);
        break;
      }
      case 'delete-cd': {
        // v1.1 collection management: removes exactly that CD. The
        // mix itself is untouched (it lives in the mixer/studio).
        const r = records.deleteCd(p.userId, msg.cdId);
        if (!r.ok) { this.game.send(p, { type: 'notice', text: r.error }); return; }
        this.game.send(p, { type: 'notice', text: '🗑 CD removed from your collection.' });
        this.sendCds(p);
        break;
      }
      case 'cds':
        this.sendCds(p);
        break;
      case 'chart':
        this.game.send(p, { type: 'chart', windowDays: 7, entries: records.chart() });
        break;
      default:
        break;
    }
  }
}

module.exports = { StageManager, START_DELAY_MS, GRACE_MS, COOLDOWN_MS };
