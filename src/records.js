'use strict';

/**
 * Solarion — records & the performance ritual (Phase 9, soul doc §2/§3).
 *
 * The original's loop was: build a mix → BURN it to a CD → carry the
 * CD to the stage → perform → votes → records on the wall. Solarion
 * restores that ritual:
 *
 *  - Blank CDs come in packs of 10 for 20z (anywhere — the Stage
 *    panel sells them; there is no shop NPC to walk to).
 *  - { type:'burn-cd', mixId } consumes one blank and mints a CD of
 *    one of YOUR mixes. (v1.1: performing no longer consumes
 *    the CD — CDs are reusable collection pieces until deleted.)
 *  - Every finished performance is recorded (perf_history). Lifetime
 *    up-votes ON ONE MIX earn its performer wall trophies:
 *    Gold record at 25, Platinum record at 100 (awarded once each,
 *    as home furniture — they are earned, never sold).
 *  - The Top-40 chart ranks mixes by up-votes over the trailing
 *    7 days (ties: fewer down-votes, then more performances).
 */

const { db, q } = require('./db');

const BLANK_PACK_COUNT = 10;
const BLANK_PACK_PRICE = 20;
const TROPHY_GOLD_VOTES = 25;
const TROPHY_PLATINUM_VOTES = 100;
const CHART_WINDOW_MS = 7 * 24 * 3600 * 1000;
const CHART_SIZE = 40;

let SQ = null;
function init() {
  if (SQ) return;
  db.exec(`
  CREATE TABLE IF NOT EXISTS cd_stock (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blanks INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mix_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS perf_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mix_id INTEGER NOT NULL,
    performer_id INTEGER NOT NULL,
    up INTEGER NOT NULL DEFAULT 0,
    down INTEGER NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trophy_awards (
    user_id INTEGER NOT NULL,
    mix_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (user_id, mix_id, kind)
  );
  `);
  SQ = {
    stock: db.prepare('SELECT blanks FROM cd_stock WHERE user_id = ?'),
    setStock: db.prepare('INSERT INTO cd_stock (user_id, blanks) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET blanks = excluded.blanks'),
    addCd: db.prepare('INSERT INTO cds (user_id, mix_id, created_at) VALUES (?, ?, ?)'),
    cdById: db.prepare('SELECT * FROM cds WHERE id = ?'),
    cdsOf: db.prepare('SELECT * FROM cds WHERE user_id = ? ORDER BY id'),
    cdFor: db.prepare('SELECT * FROM cds WHERE user_id = ? AND mix_id = ? ORDER BY id LIMIT 1'),
    delCd: db.prepare('DELETE FROM cds WHERE id = ?'),
    delCdsOfMix: db.prepare('DELETE FROM cds WHERE user_id = ? AND mix_id = ?'),
    addPerf: db.prepare('INSERT INTO perf_history (mix_id, performer_id, up, down, ts) VALUES (?, ?, ?, ?, ?)'),
    lifetimeUps: db.prepare('SELECT COALESCE(SUM(up), 0) AS ups FROM perf_history WHERE mix_id = ?'),
    hasTrophy: db.prepare('SELECT 1 FROM trophy_awards WHERE user_id = ? AND mix_id = ? AND kind = ?'),
    addTrophy: db.prepare('INSERT INTO trophy_awards (user_id, mix_id, kind) VALUES (?, ?, ?)'),
    addInventory: db.prepare('INSERT INTO studio_items (owner_id, item_id, x, y, rot, created_at) VALUES (?, ?, NULL, NULL, 0, ?)'),
    chart: db.prepare(`
      SELECT ph.mix_id AS mixId, SUM(ph.up) AS ups, SUM(ph.down) AS downs,
             COUNT(*) AS perfs, m.name AS title, u.username AS performer
      FROM perf_history ph
      JOIN mixes m ON m.id = ph.mix_id
      JOIN users u ON u.id = ph.performer_id
      WHERE ph.ts > ?
      GROUP BY ph.mix_id
      ORDER BY ups DESC, downs ASC, perfs DESC
      LIMIT ?
    `),
  };
}

function blankCount(userId) {
  const row = SQ.stock.get(userId);
  return row ? row.blanks : 0;
}

/**
 * Buy a pack of blanks. Returns { ok, blanks, balance } or
 * { ok:false, error }. Coin debit + stock credit are one transaction.
 */
function buyBlanks(userId) {
  const avatar = q.avatarByUser.get(userId);
  if (!avatar) return { ok: false, error: 'no avatar' };
  if (avatar.zcoins < BLANK_PACK_PRICE) return { ok: false, error: `A pack of ${BLANK_PACK_COUNT} blank CDs costs ${BLANK_PACK_PRICE}z.` };
  db.exec('BEGIN IMMEDIATE');
  try {
    q.setZCoins.run(avatar.zcoins - BLANK_PACK_PRICE, userId);
    SQ.setStock.run(userId, blankCount(userId) + BLANK_PACK_COUNT);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, blanks: blankCount(userId), balance: avatar.zcoins - BLANK_PACK_PRICE };
}

/**
 * Burn one blank into a CD of `mixId`. Ownership is the caller's
 * job — music.getMix(userId, mixId) is already user-scoped, so a
 * non-null mix there IS the user's own.
 */
function burnCd(userId, mixId) {
  const blanks = blankCount(userId);
  if (blanks <= 0) return { ok: false, error: `No blank CDs — a pack of ${BLANK_PACK_COUNT} is ${BLANK_PACK_PRICE}z.` };
  db.exec('BEGIN IMMEDIATE');
  try {
    SQ.setStock.run(userId, blanks - 1);
    SQ.addCd.run(userId, mixId, Date.now());
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true, blanks: blanks - 1 };
}

function listCds(userId, mixNameOf) {
  return SQ.cdsOf.all(userId).map(c => ({ id: c.id, mixId: c.mix_id, createdAt: c.created_at, name: mixNameOf ? mixNameOf(c.mix_id) : null }));
}

function findCd(userId, mixId) {
  return SQ.cdFor.get(userId, mixId) || null;
}

function consumeCd(cdId) {
  SQ.delCd.run(cdId);
}

/**
 * v1.1 collection management: delete exactly one CD, only ever the
 * owner's own. The underlying mix is NOT touched. (Performing no
 * longer consumes CDs — this is the only way a CD leaves a
 * collection besides its mix being deleted.)
 */
function deleteCd(userId, cdId) {
  if (!Number.isInteger(cdId)) return { ok: false, error: 'Pick a CD to remove.' };
  const cd = SQ.cdById.get(cdId);
  if (!cd || cd.user_id !== userId) return { ok: false, error: 'That CD is not in your collection.' };
  SQ.delCd.run(cdId);
  return { ok: true };
}

/** A deleted mix takes its unplayed CDs with it. */
function onMixDeleted(userId, mixId) {
  SQ.delCdsOfMix.run(userId, mixId);
}

/**
 * Record a finished performance; award any newly-earned trophies.
 * Returns an array of award kinds earned by THIS performance
 * ('gold-record' / 'platinum-record').
 */
function recordPerformance(mixId, performerId, up, down) {
  SQ.addPerf.run(mixId, performerId, up, down, Date.now());
  const ups = SQ.lifetimeUps.get(mixId).ups;
  const earned = [];
  for (const [kind, threshold] of [['gold-record', TROPHY_GOLD_VOTES], ['platinum-record', TROPHY_PLATINUM_VOTES]]) {
    if (ups >= threshold && !SQ.hasTrophy.get(performerId, mixId, kind)) {
      SQ.addTrophy.run(performerId, mixId, kind);
      SQ.addInventory.run(performerId, kind, Date.now());
      earned.push(kind);
    }
  }
  return earned;
}

function chart(now = Date.now()) {
  return SQ.chart.all(now - CHART_WINDOW_MS, CHART_SIZE)
    .map((r, i) => ({ rank: i + 1, mixId: r.mixId, title: r.title, performer: r.performer, ups: r.ups, downs: r.downs, performances: r.perfs }));
}

module.exports = {
  init, blankCount, buyBlanks, burnCd, listCds, findCd, consumeCd, deleteCd,
  onMixDeleted, recordPerformance, chart,
  BLANK_PACK_COUNT, BLANK_PACK_PRICE, TROPHY_GOLD_VOTES, TROPHY_PLATINUM_VOTES,
  CHART_WINDOW_MS, CHART_SIZE,
};
