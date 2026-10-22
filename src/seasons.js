'use strict';

/**
 * Solarion — seasonal themes (Zan's standing annual rule,
 * 2026-10-21): "From 10/1 to 11/1 lets have Halloween themes run
 * in all zones. 12/1 - 1/1 Xmas themes."
 *
 * The SERVER owns the calendar: seasonAt() resolves the active
 * season from the wall clock in America/Chicago — Halloween is
 * Oct 1 00:00 → Nov 1 00:00 local, Christmas is Dec 1 00:00 →
 * Jan 1 00:00 local, every year, no toggles and no deploys at the
 * boundaries. (Both windows align exactly to local month starts,
 * so the local month decides.) The season rides the hello / map
 * payloads (`season`), and clients key their palette shifts off it.
 *
 * Dressing is a LAYER, never an edit to the base maps: SEASONAL
 * below is overlay data per map, in TILE coordinates, merged into
 * the client's prop list by clientMap() only while its season is
 * active. The base dressing in src/maps.js is untouched, and the
 * Bake Shop validator runs every layer through the same rules as
 * the base (venue purity, portal clearance, composed placements).
 *
 * Placement doctrine (learned the hard way in v1.2): composed
 * arrangements at door aprons, gatehouse mouths, stage ends and
 * existing nooks — never scatter, never inside a venue's seat
 * block / pit / platform.
 *
 * DOORSTEP LAW (v1.2.2, Item 7): a doorstep is a finished
 * composition in the base layer — seasonal pieces FLANK it from
 * clear tiles beside it, never ON it. No seasonal prop may share
 * a tile with a base prop, and none may sit inside a doorstep
 * apron (the door/gateway rect and its landing, framed by one
 * tile) — the one exception is the wreath, which hangs ON the
 * door's facade by design. The Bake Shop validator enforces all
 * of this; a placement that fails it does not ship.
 */

const { TILE } = require('./maps');

const TIME_ZONE = 'America/Chicago';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, month: 'numeric', day: 'numeric',
});

/** 'halloween' | 'christmas' | null for a given instant. */
function seasonAt(date = new Date()) {
  const parts = fmt.formatToParts(date);
  let month = 0;
  for (const p of parts) if (p.type === 'month') month = Number(p.value);
  if (month === 10) return 'halloween';   // Oct 1 00:00 → Nov 1 00:00 CT
  if (month === 12) return 'christmas';   // Dec 1 00:00 → Jan 1 00:00 CT
  return null;
}

const SEASONS = ['halloween', 'christmas'];

/** The prop kinds the client knows how to draw for seasonal use. */
const SEASONAL_KINDS = new Set([
  'pumpkin', 'jackolantern', 'pumpkinstack', 'cobweb',          // halloween
  'wreath', 'giftpile', 'holidaylights', 'snowman',             // christmas
]);

// Overlay entries are [kind, tx, ty] in tile coordinates — the
// same convention as maps.js's prop(). Converted to pixel-centre
// props by overlayProps().
const SEASONAL = {
  halloween: {
    'the-gateway': [
      // The centerpiece: a pumpkin stack on the plaza stone,
      // just south of the fountain.
      ['pumpkinstack', 36, 26],
      // Lit pumpkins flanking the fountain basin.
      ['jackolantern', 31, 21], ['jackolantern', 40, 21],
      // Café Corner (v1.2.2, Items 7/8): the café door moved to
      // its FRONT (south) face at (62,42) and the pair FLANKS the
      // whole doorstep composition from outside it — booths at
      // (60,43)/(64,43), lights at (62,43) — never on its tiles.
      ['jackolantern', 58, 42], ['pumpkin', 66, 42],
      // A pair at every gatehouse mouth, flanking the path.
      ['pumpkin', 4, 5], ['jackolantern', 9, 5],
      ['pumpkin', 18, 5], ['jackolantern', 23, 5],
      ['pumpkin', 32, 5], ['jackolantern', 37, 5],
      ['pumpkin', 46, 5], ['jackolantern', 51, 5],
      ['pumpkin', 60, 5], ['jackolantern', 65, 5],
      // Cobwebs on the two facade corners.
      ['cobweb', 58, 34], ['cobweb', 4, 19],
    ],
    'gateway-cafe': [
      ['jackolantern', 24, 13], ['pumpkin', 2, 13],
      ['cobweb', 24, 2],
    ],
    'solstice-bay': [
      // Stage ends, flanking the pit mouth (outside pit + seats).
      ['jackolantern', 32, 10], ['jackolantern', 43, 10],
      // Beach pumpkins along the boardwalk's south edge.
      ['pumpkin', 18, 13], ['pumpkin', 54, 13],
      // Casino door apron + a web on the facade corner.
      ['jackolantern', 13, 37], ['cobweb', 4, 34],
    ],
    'casino-lounge': [
      ['jackolantern', 11, 17], ['jackolantern', 18, 17],
      ['cobweb', 2, 2], ['cobweb', 27, 2],
    ],
    'neon-casino': [
      ['jackolantern', 11, 17], ['jackolantern', 18, 17],
      ['cobweb', 2, 2], ['cobweb', 27, 2],
    ],
    'neon-district': [
      // Stage ends (the NEON signs' tiles, one step further out).
      ['jackolantern', 31, 5], ['jackolantern', 46, 5],
      // Casino doorstep (v1.2.2, Items 7/8): the casino door moved
      // to its FRONT (south) face at (61,38), lantern at (60,39) —
      // the pair flanks the new doorstep from its outer tiles.
      ['pumpkin', 59, 39], ['jackolantern', 63, 39],
      ['cobweb', 57, 31],
    ],
    'cinder-mesa': [
      // Flanking the pit mouth, outside pit + seat block.
      ['pumpkin', 57, 16], ['pumpkin', 57, 27],
      // Forge Plaza.
      ['jackolantern', 25, 25],
      // Hookah facade corner.
      ['cobweb', 27, 32],
    ],
    'hookah-lounge': [
      ['jackolantern', 3, 12], ['cobweb', 18, 2],
    ],
    'frosthaven': [
      // Snowy pumpkins at the stage ends.
      ['pumpkin', 31, 38], ['pumpkin', 44, 38],
      // Gatehouse mouth pair.
      ['jackolantern', 33, 4], ['jackolantern', 38, 4],
      // Pond-shore nook.
      ['pumpkin', 22, 14],
    ],
    'verdant-hollow': [
      // Stage ends.
      ['jackolantern', 31, 22], ['jackolantern', 44, 22],
      // Pond north bank.
      ['pumpkin', 27, 39], ['pumpkin', 41, 39],
      // A web in the Great Tree's branches.
      ['cobweb', 27, 14],
    ],
  },
  christmas: {
    'the-gateway': [
      // The centerpiece: a composed gift display where the
      // pumpkin stack stood, snowman standing guard west of it.
      ['giftpile', 36, 26], ['snowman', 29, 26],
      // Wreaths on the facades, centred over each door.
      ['wreath', 62, 41],           // Gateway Café FRONT face (door (62,42), v1.2.2 Item 8)
      ['wreath', 6, 22],            // Homes face (door (7,22))
      // Holiday lights joining the fountain nook.
      ['holidaylights', 36, 29],
    ],
    'gateway-cafe': [
      ['wreath', 11, 14],           // beside the door
      ['holidaylights', 6, 3],      // garland along the counter
    ],
    'solstice-bay': [
      ['wreath', 14, 37],           // casino face, beside the door
      // Lights at the boardwalk's ends, by the stalls.
      ['holidaylights', 10, 10], ['holidaylights', 62, 10],
    ],
    'casino-lounge': [
      ['wreath', 13, 18],           // beside the entry door
      ['holidaylights', 21, 1],     // garland over the slots wall
    ],
    'neon-casino': [
      ['wreath', 13, 18],
      ['holidaylights', 21, 1],
    ],
    'neon-district': [
      // Stage ends — where the jack-o'-lanterns stood.
      ['holidaylights', 31, 5], ['holidaylights', 46, 5],
      ['wreath', 62, 37],           // casino FRONT face, beside the door (door (61,38), v1.2.2 Item 8)
      ['giftpile', 36, 26],         // by the market-square nook (nook moved south in v1.2.2)
    ],
    'cinder-mesa': [
      ['wreath', 29, 37],           // hookah FRONT face, beside the door (door (30,38), v1.2.2 Item 8)
      ['holidaylights', 32, 38],    // the (new, south) doorstep terrace
    ],
    'hookah-lounge': [
      ['wreath', 8, 12],            // beside the door
    ],
    'frosthaven': [
      // A composed pair by the ice sculpture hero.
      ['giftpile', 45, 9], ['snowman', 50, 10],
    ],
    'verdant-hollow': [
      ['giftpile', 29, 16],         // under the Great Tree
      ['holidaylights', 34, 38],    // the pond shore
    ],
  },
};

/**
 * The overlay props for one map in one season, as client-ready
 * pixel-centre props ([] when the season is off or the map has
 * no layer). `season` may be null/'none' for an explicit off.
 */
function overlayProps(mapId, season) {
  if (!season || season === 'none') return [];
  const layer = SEASONAL[season];
  if (!layer) return [];
  const entries = layer[mapId];
  if (!entries) return [];
  return entries.map(([kind, tx, ty]) => ({
    kind, x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2,
  }));
}

module.exports = { seasonAt, overlayProps, SEASONAL, SEASONAL_KINDS, SEASONS, TIME_ZONE };
