'use strict';

/**
 * Solarion — fishing (v1.1.1, Zan's ruling 2026-10-21).
 *
 * Pond fishing: stand on a shore spot (map data: `fishing`), press E
 * to cast, wait out the cast, and the server rolls. One fish every
 * 3–6 casts on average — CATCH_P = 0.22 puts the mean at ~4.5 casts.
 * Every species pays the same flat 1z (variety is flavour, never a
 * payout tier), credited exactly once per catch. All state, RNG and
 * money are server-side (src/game.js drives the flow); this module
 * is just the shared constants + the pure roll/pick helpers so the
 * suite can pin the probability contract with a seeded RNG.
 */

const CAST_MS = 2500;      // line in the water: a couple of seconds
const CATCH_P = 0.22;      // mean casts per fish = 1 / 0.22 ≈ 4.5
const PAYOUT_Z = 1;        // flat: 1z per fish, whatever the species
const HOLD_MS = 1000;      // the hold-it-up celebration: ~1 second

const FISH = [
  { id: 'minnow', name: 'Minnow' },
  { id: 'bluegill', name: 'Bluegill' },
  { id: 'sunfish', name: 'Sunfish' },
  { id: 'perch', name: 'Perch' },
  { id: 'trout', name: 'Trout' },
  { id: 'bass', name: 'Bass' },
  { id: 'catfish', name: 'Catfish' },
  { id: 'koi', name: 'Koi' },
  { id: 'golden-carp', name: 'Golden Carp' },
  { id: 'moonfish', name: 'Moonfish' },
];

/** One cast's roll: true = a fish takes the bait. */
function rollCatch(rng = Math.random) {
  return rng() < CATCH_P;
}

/** Uniform pick across the species list (flat pay = uniform odds). */
function pickFish(rng = Math.random) {
  return FISH[Math.min(FISH.length - 1, Math.floor(rng() * FISH.length))];
}

module.exports = { CAST_MS, CATCH_P, PAYOUT_Z, HOLD_MS, FISH, rollCatch, pickFish };
