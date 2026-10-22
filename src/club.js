'use strict';

/**
 * Solarion — Club Mirage (v1.4): the go-go bar's one interaction
 * beyond the bar itself (drinks ride the shared vice model in
 * game.js — the club's bar is a bar like any other).
 *
 * TIP A DANCER: a preset-amount gift to a dancer NPC. She is a
 * fixture, not a player, so the money is a pure SINK — the guarded
 * debit is the whole ledger move and nobody is credited (unlike
 * stage tips, which pay the performer). In return the room gets a
 * 'dancer-flourish' broadcast and the dancer does her flourish
 * (clients animate it). Server-authoritative throughout: the
 * amount must be one of the stage tip box's presets, the tipper
 * must be standing in the club within reach of THAT dancer's
 * stage, and a per-player cooldown (2.5s) keeps flourish spam —
 * and accidental double-taps — from draining anyone.
 */

const { db } = require('./db');

const TIP_AMOUNTS = [5, 10, 25, 50, 100]; // the stage tip box's presets (src/stage.js)
const TIP_RADIUS = 170;                   // px from the dancer — ringside, not across the room
const TIP_COOLDOWN_MS = 2500;

const debitZ = db.prepare('UPDATE avatars SET zcoins = zcoins - ? WHERE user_id = ? AND zcoins >= ?');
const zOf = db.prepare('SELECT zcoins FROM avatars WHERE user_id = ?');

class ClubSystem {
  constructor(game) {
    this.game = game;
    this.clubs = new Map();       // mapId -> club def
    this.lastTipAt = new Map();   // userId -> epoch-ms of last accepted tip
  }

  initFromMaps(MAPS) {
    for (const [mapId, map] of Object.entries(MAPS)) {
      if (map.club) this.clubs.set(mapId, map.club);
    }
  }

  /** The dancer a tip targets: an explicit id wins; otherwise the
   *  nearest dancer in the room (the tray tips whoever's stage
   *  you're standing at). Returns { stage, dancer } or null. */
  resolveDancer(mapId, club, dancerId) {
    if (typeof dancerId === 'string' && dancerId) {
      for (const stage of club.stages) {
        if (stage.dancer && stage.dancer.id === dancerId) return { stage, dancer: stage.dancer };
      }
      return null;
    }
    return null; // no id: caller falls back to nearest by position
  }

  nearestDancer(club, x, y) {
    let best = null, bestD = Infinity;
    for (const stage of club.stages) {
      if (!stage.dancer) continue;
      const d = Math.hypot(stage.dancer.x - x, stage.dancer.y - y);
      if (d < bestD) { bestD = d; best = { stage, dancer: stage.dancer, dist: d }; }
    }
    return best;
  }

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
      const near = this.nearestDancer(club, p.x, p.y);
      if (near) target = { stage: near.stage, dancer: near.dancer, dist: near.dist };
    }
    if (!target) {
      this.game.send(p, { type: 'notice', text: 'No dancer on stage right now.' });
      return;
    }
    const dist = target.dist !== undefined
      ? target.dist
      : Math.hypot(target.dancer.x - p.x, target.dancer.y - p.y);
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
    this.game.send(p, { type: 'notice', text: `💸 You tipped ${target.dancer.name} ${amount}z!` });
    // The room sees it: she flourishes (clients animate the spin +
    // hearts off this one event).
    this.game.broadcastToMap(p.mapId, {
      type: 'dancer-flourish',
      dancer: target.dancer.id,
      name: target.dancer.name,
      amount,
      from: p.name,
    });
  }

  handle(p, msg) {
    if (msg.type === 'tip-dancer') this.handleTipDancer(p, msg.dancer, msg.amount);
  }
}

module.exports = { ClubSystem, TIP_AMOUNTS, TIP_RADIUS, TIP_COOLDOWN_MS };
