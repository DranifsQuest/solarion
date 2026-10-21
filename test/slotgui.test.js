'use strict';

/**
 * Slot GUI reel-settle contract (v1.2, Item H): the planner in
 * public/slotreels.js is pure presentation logic — given the
 * SERVER's decided symbols it must land each GUI reel exactly on
 * them, settling left to right, and its payline match mask must
 * mirror the server paytable's pair/triple rules (src/casino.js
 * slotPayout: any pair pays, three of a kind pays, a==c counts).
 * No outcome is ever generated client-side — this suite pins that
 * the display can only ever END where the server said.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const SR = require('../public/slotreels.js');
const IDS = ['sun', 'zcoin', 'palm', 'dice', 'wave', 'star', 'shell'];

test('slot GUI planner: reels land exactly on the server symbols, left to right', () => {
  for (const result of [
    ['sun', 'sun', 'sun'],
    ['wave', 'star', 'wave'],
    ['shell', 'shell', 'dice'],
    ['zcoin', 'palm', 'star'],
  ]) {
    const plan = SR.planReels(result, IDS);
    assert.equal(plan.length, 3, 'three reels planned');
    plan.forEach((reel, r) => {
      assert.equal(reel.finalId, result[r], `reel ${r} final is the server symbol`);
      assert.equal(reel.strip[reel.finalIndex], result[r], `reel ${r} strip ends on the server symbol`);
      assert.equal(reel.finalIndex, reel.strip.length - 1, 'final symbol is the last strip cell');
      assert.ok(reel.strip.length >= 10, 'strip is long enough to read as a tumble');
      for (const id of reel.strip) assert.ok(IDS.includes(id), 'strip only uses the real symbol set');
    });
    assert.ok(plan[0].settleMs < plan[1].settleMs && plan[1].settleMs < plan[2].settleMs,
      'reels settle strictly left to right');
  }
});

test('slot GUI planner: match mask mirrors the server paytable', () => {
  assert.deepEqual(SR.matchMask(['sun', 'sun', 'sun']), [true, true, true], 'triple highlights all');
  assert.deepEqual(SR.matchMask(['palm', 'palm', 'dice']), [true, true, false], 'left pair');
  assert.deepEqual(SR.matchMask(['dice', 'palm', 'palm']), [false, true, true], 'right pair');
  assert.deepEqual(SR.matchMask(['wave', 'star', 'wave']), [true, false, true], 'split pair (a==c pays server-side)');
  assert.deepEqual(SR.matchMask(['zcoin', 'palm', 'star']), [false, false, false], 'no match, no highlight');
  assert.equal(SR.isJackpot(['sun', 'sun', 'sun']), true);
  assert.equal(SR.isJackpot(['sun', 'sun', 'star']), false);
});
