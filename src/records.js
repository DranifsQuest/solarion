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
    // v1.7.1: the money/stock moves are single atomic statements —
    // a guarded relative debit (changes === 1 iff the balance
    // covered the price), a relative credit (compensating refunds),
    // a relative stock increment (upsert), and a guarded stock
    // decrement (changes === 1 iff a blank was really there). No
    // manual BEGIN/COMMIT anywhere: that pattern does not hold
    // over the remote Hrana driver (see buyBlanks).
    debitZ: db.prepare('UPDATE avatars SET zcoins = zcoins - ? WHERE user_id = ? AND zcoins >= ?'),
    addZ: db.prepare('UPDATE avatars SET zcoins = zcoins + ? WHERE user_id = ?'),
    addStock: db.prepare('INSERT INTO cd_stock (user_id, blanks) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET blanks = blanks + excluded.blanks'),
    decStock: db.prepare('UPDATE cd_stock SET blanks = blanks - 1 WHERE user_id = ? AND blanks >= 1'),
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
 * { ok:false, error }.
 *
 * v1.7.1: NO manual transaction. The old BEGIN IMMEDIATE sat
 * OUTSIDE the try, and over the remote (Hrana) driver the whole
 * BEGIN…COMMIT sequence does not hold an interactive transaction
 * anyway — production logged `cannot rollback - no transaction is
 * active` while the statements ran unwrapped, and the throw
 * escaped to the WS handler so the client heard silence. Now: one
 * guarded atomic debit (its .changes IS the funds check), one
 * relative stock upsert, and — if the credit step fails after the
 * debit landed — a compensating credit makes the player whole.
 * Every failure returns { ok:false } (never throws) so stage.js
 * always has an error to show the player; the real error is
 * logged server-side.
 */
function buyBlanks(userId) {
  const avatar = q.avatarByUser.get(userId);
  if (!avatar) return { ok: false, error: 'no avatar' };
  let debited;
  try {
    debited = SQ.debitZ.run(BLANK_PACK_PRICE, userId, BLANK_PACK_PRICE);
  } catch (e) {
    console.error(`[records] buyBlanks debit failed for user ${userId}:`, e && e.message ? e.message : e);
    return { ok: false, error: 'Buying blanks hit a snag — no coins were spent. Please try again.' };
  }
  if (debited.changes !== 1) {
    return { ok: false, error: `A pack of ${BLANK_PACK_COUNT} blank CDs costs ${BLANK_PACK_PRICE}z.` };
  }
  try {
    SQ.addStock.run(userId, BLANK_PACK_COUNT);
  } catch (e) {
    console.error(`[records] buyBlanks stock credit failed for user ${userId} after the debit landed — refunding:`, e && e.message ? e.message : e);
    try { SQ.addZ.run(BLANK_PACK_PRICE, userId); }
    catch (e2) { console.error(`[records] buyBlanks REFUND failed for user ${userId} (${BLANK_PACK_PRICE}z):`, e2 && e2.message ? e2.message : e2); }
    return { ok: false, error: 'Buying blanks hit a snag — your coins were refunded. Please try again.' };
  }
  const fresh = q.avatarByUser.get(userId);
  return { ok: true, blanks: blankCount(userId), balance: fresh ? fresh.zcoins : avatar.zcoins - BLANK_PACK_PRICE };
}

/**
 * Burn one blank into a CD of `mixId`. Ownership is the caller's
 * job — music.getMix(userId, mixId) is already user-scoped, so a
 * non-null mix there IS the user's own.
 *
 * v1.7.1: same no-manual-transaction pattern as buyBlanks — one
 * guarded decrement consumes the blank (changes === 1 iff one was
 * really there), one insert mints the CD, and a failed mint is
 * compensated by returning the blank. Failures return
 * { ok:false } instead of throwing into the WS handler.
 */
function burnCd(userId, mixId) {
  let consumed;
  try {
    consumed = SQ.decStock.run(userId);
  } catch (e) {
    console.error(`[records] burnCd stock decrement failed for user ${userId}:`, e && e.message ? e.message : e);
    return { ok: false, error: 'Burning hit a snag — no blank CD was used. Please try again.' };
  }
  if (consumed.changes !== 1) {
    return { ok: false, error: `No blank CDs — a pack of ${BLANK_PACK_COUNT} is ${BLANK_PACK_PRICE}z.` };
  }
  try {
    SQ.addCd.run(userId, mixId, Date.now());
  } catch (e) {
    console.error(`[records] burnCd mint failed for user ${userId} after a blank was consumed — restoring it:`, e && e.message ? e.message : e);
    try { SQ.addStock.run(userId, 1); }
    catch (e2) { console.error(`[records] burnCd blank RESTORE failed for user ${userId}:`, e2 && e2.message ? e2.message : e2); }
    return { ok: false, error: 'Burning hit a snag — your blank CD was restored. Please try again.' };
  }
  return { ok: true, blanks: blankCount(userId) };
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
