'use strict';

/**
 * Solarion — owner accounts (ONE source of truth).
 *
 * X's accounts. Two standing perks key off this set:
 *  - the balance floor (1,000,000z top-up on every WS connect,
 *    applied in src/server.js), and
 *  - fast travel (v1.2, Item J): the Navigator's travel-to-city
 *    and join-friend warps are owner-only; everyone else walks
 *    through the gatehouses. Enforced server-side in
 *    src/social.js; the client merely hides the controls.
 *
 * Matching is by lowercase username, exactly like the original
 * OWNER_TOPUPS map this module replaces.
 */

const OWNERS = new Set(['zantheon', 'upem']);
const OWNER_FLOOR_Z = 1000000;

function isOwnerName(username) {
  return OWNERS.has(String(username || '').toLowerCase());
}

/** The balance floor for a username, or null for non-owners. */
function ownerFloorFor(username) {
  return isOwnerName(username) ? OWNER_FLOOR_Z : null;
}

module.exports = { OWNERS, OWNER_FLOOR_Z, isOwnerName, ownerFloorFor };
