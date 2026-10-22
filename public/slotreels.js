'use strict';
/**
 * Solarion — slot reel-settle planner (v1.2, Item H).
 *
 * Pure logic for the slot-machine GUI: given the SERVER's decided
 * symbols, plan each reel's spin — a strip of filler symbols that
 * tumbles past and lands EXACTLY on the server symbol, reels
 * settling LEFT to RIGHT, one at a time. No outcome is ever
 * generated here: the strip is presentation only, built around
 * the result the server already returned (slot-result.reels).
 *
 * Kept dependency-free and DOM-free so the casino suite can test
 * the settle contract headlessly (final symbol per reel, settle
 * order, payline match mask mirrors src/casino.js slotPayout).
 */

const REEL_SETTLE_MS = [700, 1050, 1400];  // left, middle, right
const REEL_STEPS = [16, 22, 28];           // filler symbols per reel

/**
 * Plan the three reels for one spin.
 * finalIds:  [id, id, id] — the server's symbols (slot-result.reels)
 * symbolIds: the full symbol id list (slot-info order)
 * Returns [{ strip: [ids… finalId], finalIndex, finalId, settleMs }]
 * where strip[finalIndex] === finalId for every reel and settleMs
 * strictly increases left → right.
 */
function planReels(finalIds, symbolIds) {
  const ids = Array.isArray(symbolIds) && symbolIds.length ? symbolIds : ['sun'];
  return (finalIds || []).map((finalId, r) => {
    const steps = REEL_STEPS[r] !== undefined ? REEL_STEPS[r] : 16 + r * 6;
    const strip = [];
    for (let i = 0; i < steps; i++) strip.push(ids[(i * 2 + r * 3) % ids.length]);
    strip.push(finalId);
    return {
      strip,
      finalIndex: strip.length - 1,
      finalId,
      settleMs: REEL_SETTLE_MS[r] !== undefined ? REEL_SETTLE_MS[r] : 700 + r * 350,
    };
  });
}

/**
 * Which reels belong to the paying match — mirrors the server
 * paytable (any pair pays; three of a kind pays): triple → all
 * three; exactly one pair → the two matching; the a==c pair
 * counts too (server: a.id===c.id pays). No match → all false.
 */
function matchMask(finalIds) {
  const [a, b, c] = finalIds || [];
  if (a === undefined) return [false, false, false];
  if (a === b && b === c) return [true, true, true];
  if (a === b) return [true, true, false];
  if (b === c) return [false, true, true];
  if (a === c) return [true, false, true];
  return [false, false, false];
}

/** Jackpot = three suns (the server pays the shared pool). */
function isJackpot(finalIds) {
  return Array.isArray(finalIds) && finalIds.length === 3 && finalIds.every(s => s === 'sun');
}

if (typeof window !== 'undefined') {
  window.SolarionSlotReels = { planReels, matchMask, isJackpot, REEL_SETTLE_MS, REEL_STEPS };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planReels, matchMask, isJackpot, REEL_SETTLE_MS, REEL_STEPS };
}
