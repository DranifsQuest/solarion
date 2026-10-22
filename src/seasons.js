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
      // Café Corner (v1.2.2, Items 7/8; v1.2.3, Items 3/4): the
      // café door sits on its FRONT (south) face at (62,36) and
      // the pair FLANKS the whole doorstep composition from the
      // doorstep row's outer tiles — terrace tables at (57,38)/
      // (67,38), lamps at (55,38)/(69,38) — never on its tiles.
      // v1.3.1: shifted one tile further out with the respaced
      // terrace (the tables' north chairs now sit at (57,36)/
      // (67,36) themselves).
      ['jackolantern', 56, 36], ['pumpkin', 68, 36],
      // A pair at every gatehouse mouth, flanking the path.
      ['pumpkin', 4, 5], ['jackolantern', 9, 5],
      ['pumpkin', 18, 5], ['jackolantern', 23, 5],
      ['pumpkin', 32, 5], ['jackolantern', 37, 5],
      ['pumpkin', 46, 5], ['jackolantern', 51, 5],
      ['pumpkin', 60, 5], ['jackolantern', 65, 5],
      // Cobwebs on the two facade corners.
      ['cobweb', 58, 28], ['cobweb', 4, 19],
    ],
    'gateway-cafe': [
      ['jackolantern', 29, 17], ['pumpkin', 2, 13],
      ['cobweb', 30, 2],
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
      // v1.2.3: flanking the bigger casino's foyer doorstep.
      ['jackolantern', 14, 20], ['jackolantern', 19, 20],
      ['cobweb', 2, 2], ['cobweb', 33, 2],
    ],
    'neon-casino': [
      ['jackolantern', 14, 20], ['jackolantern', 19, 20],
      ['cobweb', 2, 2], ['cobweb', 33, 2],
    ],
    'neon-district': [
      // Stage ends (the NEON signs' tiles, one step further out).
      ['jackolantern', 31, 5], ['jackolantern', 46, 5],
      // Casino doorstep (v1.2.2, Items 7/8): the casino door moved
      // to its FRONT (south) face at (61,38), lantern at (60,39) —
      // the pair flanks the new doorstep from its outer tiles.
      ['pumpkin', 59, 39], ['jackolantern', 63, 39],
      ['cobweb', 57, 31],
      // Club Mirage doorstep (v1.4): the club door sits on its
      // FRONT (south) face at (9,38), lantern at (8,39) — the pair
      // flanks the doorstep from its outer tiles, same doctrine.
      ['pumpkin', 6, 39], ['jackolantern', 12, 39],
      ['cobweb', 5, 31],
    ],
    'club-mirage': [
      // v1.4: lit pumpkins flanking the foyer doorstep (the door
      // is at (30,24), 2 wide — the pair stands clear of its
      // apron), a web in the west stage corner.
      ['jackolantern', 28, 22], ['jackolantern', 33, 22],
      ['cobweb', 2, 2],
    ],
    'cinder-mesa': [
      // Flanking the pit mouth of the rebuilt NORTH venue (v1.3.1),
      // outside pit + seat block. (The old pair flanked the retired
      // east-rim stage.)
      ['pumpkin', 32, 7], ['pumpkin', 44, 7],
      // Hearth Plaza (the old forge nook, v1.5.1).
      ['jackolantern', 25, 25],
      // Hookah facade corner.
      ['cobweb', 27, 32],
    ],
    'hookah-lounge': [
      ['jackolantern', 3, 12], ['cobweb', 18, 2],
    ],
    'frosthaven': [
      // Snowy pumpkins at the rebuilt north stage's ends (v1.3.1).
      ['pumpkin', 21, 6], ['pumpkin', 32, 6],
      // Gatehouse mouth pair.
      ['jackolantern', 33, 4], ['jackolantern', 38, 4],
      // v1.3.1 (Item 15): the pond-shore nook pumpkin went with its
      // trash cluster — deleted, not relocated.
    ],
    'verdant-hollow': [
      // Stage ends (v1.3.1: the rebuilt north stage's ends).
      ['jackolantern', 32, 8], ['jackolantern', 43, 8],
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
      ['wreath', 62, 35],           // Gateway Café FRONT face (door (62,36); face moved north in v1.2.3 Item 3)
      ['wreath', 6, 22],            // Homes face (door (7,22))
      // Holiday lights joining the fountain nook.
      ['holidaylights', 36, 29],
    ],
    'gateway-cafe': [
      ['wreath', 14, 17],           // beside the door (door (15,18) since v1.2.3)
      ['holidaylights', 6, 3],      // garland along the counter
    ],
    'solstice-bay': [
      ['wreath', 14, 37],           // casino face, beside the door
      // Lights at the boardwalk's ends, by the stalls.
      ['holidaylights', 10, 10], ['holidaylights', 62, 10],
    ],
    'casino-lounge': [
      ['wreath', 15, 22],           // beside the entry door (door (16,22) since v1.2.3)
      ['holidaylights', 23, 1],     // garland over the slots wall
    ],
    'neon-casino': [
      ['wreath', 15, 22],
      ['holidaylights', 23, 1],
    ],
    'neon-district': [
      // Stage ends — where the jack-o'-lanterns stood.
      ['holidaylights', 31, 5], ['holidaylights', 46, 5],
      ['wreath', 62, 37],           // casino FRONT face, beside the door (door (61,38), v1.2.2 Item 8)
      ['giftpile', 36, 26],         // by the market-square nook (nook moved south in v1.2.2)
      ['wreath', 10, 37],           // Club Mirage FRONT face, beside the door (door (9,38), v1.4)
    ],
    'club-mirage': [
      ['wreath', 29, 24],           // beside the door (door (30,24), v1.4)
      ['holidaylights', 7, 20],     // garland over the bar
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
