'use strict';

/**
 * Solarion — ORIGINAL V-ego-style pixel avatar sprites (Phase 6).
 *
 * Inspired by the Coke Music / Coke Studios V-ego look (big expressive
 * heads, compact bodies) but drawn entirely from scratch in code below.
 * No Coke/Habbo assets are used or referenced — all pixel data here is
 * original to Solarion.
 *
 * Phase 6 rebuilt the renderer around the character-creation axes
 * (src/appearance.js owns the legal value lists; this file owns the
 * pixel art for each id):
 *
 *   gender M/F — distinct silhouettes, face sets, hair anchors, fits
 *   face       — 10 head shapes per gender (span profiles, rows 1..9)
 *   eyes       — 10 styles per gender (patterns) + eye_color
 *   nose       — 10 styles per gender (shading patterns)
 *   lips       — 10 styles per gender (pattern + tint)
 *   skin_tone  — 8 tones        hair_style — 10 per gender (16 maps)
 *   top_style  — 6 styles, gender fit, sleeve/collar/pocket detail
 *   bottom_style — 5 per gender (F includes skirt), shoe_color, accessory
 *
 * Rendering stamps layers into a char grid, bottom to top:
 *   body (legs, torso, neck, head skin) -> face features -> hair ->
 *   accessory. Directions: 'down' (front), 'up' (back), 'side'
 *   (profile; flipped for left vs right at draw time).
 *
 * Palette chars: S skin, N skin shade, E eye color, K ink (#14161c),
 * W white, L lip tint, T top color, D top shade, P bottom color,
 * d bottom shade, U undershirt, O shoe color, H hair color,
 * A accessory color, G sunglass lens.
 */

const SPR_W = 20;
const SPR_H = 25;
const PX = 2; // sprite pixel size on the pre-rendered canvas

function shade(hex, amt) {
  const n = parseInt(String(hex || '#888888').slice(1), 16);
  if (!Number.isFinite(n)) return '#888888';
  const c = (v) => Math.max(0, Math.min(255, v));
  const r = c((n >> 16) + amt), g = c(((n >> 8) & 0xff) + amt), b = c((n & 0xff) + amt);
  return `rgb(${r},${g},${b})`;
}

/** Pad a row list to SPR_H rows of empty strings. */
function pad(rows) {
  const out = rows.slice(0, SPR_H);
  while (out.length < SPR_H) out.push('....................');
  return out;
}

// ------------------------------------------------------------- faces
// Front-view head outline: spans [left, right] (inclusive skin cols)
// for rows 1..9. Row 0 is always empty; row 10 is the neck.
const FACE_PROFILES = {
  M: {
    classic:  [[4,15],[2,17],[2,17],[2,17],[2,17],[2,17],[2,17],[2,17],[1,18]],
    square:   [[4,15],[2,17],[2,17],[2,17],[2,17],[2,17],[2,17],[2,17],[2,17]],
    round:    [[5,14],[3,16],[2,17],[2,17],[2,17],[3,16],[3,16],[4,15],[6,13]],
    long:     [[5,14],[3,16],[3,16],[3,16],[3,16],[3,16],[4,15],[4,15],[5,14]],
    sharp:    [[4,15],[2,17],[2,17],[3,16],[3,16],[4,15],[5,14],[6,13],[8,11]],
    wide:     [[3,16],[1,18],[1,18],[1,18],[1,18],[1,18],[2,17],[2,17],[3,16]],
    chiseled: [[4,15],[2,17],[2,17],[2,17],[3,16],[3,16],[2,17],[2,17],[4,15]],
    angular:  [[3,16],[2,17],[3,16],[3,16],[4,15],[4,15],[5,14],[5,14],[7,12]],
    oval:     [[4,15],[2,17],[2,17],[3,16],[3,16],[4,15],[4,15],[5,14],[6,13]],
    soft:     [[4,15],[2,17],[2,17],[2,17],[3,16],[3,16],[5,14],[5,14],[7,12]],
  },
  F: {
    classic: [[4,15],[2,17],[2,17],[2,17],[2,17],[3,16],[3,16],[4,15],[5,14]],
    round:   [[5,14],[3,16],[2,17],[2,17],[3,16],[3,16],[4,15],[5,14],[7,12]],
    heart:   [[3,16],[2,17],[2,17],[2,17],[3,16],[4,15],[5,14],[6,13],[8,11]],
    oval:    [[4,15],[2,17],[3,16],[3,16],[3,16],[4,15],[4,15],[5,14],[6,13]],
    soft:    [[4,15],[2,17],[2,17],[3,16],[3,16],[4,15],[5,14],[6,13],[7,12]],
    petite:  [[5,14],[3,16],[3,16],[3,16],[4,15],[5,14],[5,14],[6,13],[7,12]],
    long:    [[5,14],[3,16],[3,16],[3,16],[4,15],[4,15],[5,14],[5,14],[6,13]],
    square:  [[4,15],[2,17],[2,17],[2,17],[2,17],[2,17],[3,16],[3,16],[3,16]],
    wide:    [[3,16],[1,18],[1,18],[1,18],[2,17],[2,17],[3,16],[3,16],[4,15]],
    sharp:   [[4,15],[2,17],[2,17],[3,16],[4,15],[4,15],[5,14],[6,13],[8,11]],
  },
};
// Profile (side) head: base spans per gender + per-face left-edge
// (face-front) deltas, keyed by row index (1..9) -> new left edge.
const SIDE_BASE = {
  M: [[5,14],[4,15],[4,15],[4,15],[4,15],[4,15],[4,15],[4,15],[5,14]],
  F: [[5,14],[4,15],[4,15],[4,15],[4,15],[4,15],[5,14],[5,14],[6,13]],
};
const SIDE_DELTAS = {
  square: { 8: 3, 9: 4 }, round: { 1: 6, 2: 5 }, long: { 7: 4, 8: 4, 9: 5 },
  sharp: { 8: 3, 9: 6 }, wide: { 2: 3, 3: 3, 4: 3 }, heart: { 8: 5, 9: 7 },
  petite: { 1: 6, 2: 5 }, chiseled: { 7: 3, 8: 3 }, angular: { 5: 5, 8: 4 },
};

// ------------------------------------------------------- face features
// Eye patterns stamp at eyeY=5; left eye centred on col 6, right on
// col 13. `mirror` flips the pattern horizontally for the right eye
// (lash flicks / wings belong on the OUTER corner). Wink styles give
// explicit l/r patterns. Chars: E eye color, K ink, W white.
const EYE_Y = 5;
const EYE_PATTERNS = {
  M: {
    round:  { rows: ['EE', 'EE'] },
    dot:    { dy: 1, rows: ['E'] },
    tall:   { rows: ['E', 'E', 'E'] },
    narrow: { dy: 1, rows: ['EEE'] },
    happy:  { rows: ['.E.', 'E.E'] },
    sleepy: { rows: ['KKK', 'EEE'] },
    sharp:  { rows: ['EE.', '.EE'] },
    wink:   { l: { dy: 1, rows: ['KKK'] }, r: { rows: ['EE', 'EE'] } },
    gentle: { rows: ['EE', 'EW'] },
    bold:   { dy: -1, rows: ['KKK', 'EE', 'EE'] },
  },
  F: {
    round:  { rows: ['EE', 'EE'] },
    dot:    { dy: 1, rows: ['E'] },
    tall:   { rows: ['E', 'E', 'E'] },
    lash:   { dy: -1, rows: ['K..', 'EEE', 'EEE'], mirror: true },
    'double-lash': { dy: -1, rows: ['K.K', 'EEE', 'EEE'], mirror: true },
    happy:  { rows: ['.E.', 'E.E'] },
    sleepy: { rows: ['KKK', 'EEE'] },
    wink:   { l: { dy: 1, rows: ['KKK'] }, r: { rows: ['EEE', 'EEE'] } },
    winged: { dy: -1, rows: ['..K', 'EEE', 'EEE'], mirror: true },
    gentle: { rows: ['EE', 'EW'] },
  },
};
// Nose patterns stamp at row 6+dy, centred on the face midline.
// Char: N (skin shade).
const NOSE_PATTERNS = {
  M: {
    button:   { dy: 0, rows: ['N.', 'NN'] },
    dot:      { dy: 1, rows: ['N'] },
    small:    { dy: 1, rows: ['NN'] },
    pointed:  { dy: 0, rows: ['.N', 'NN'] },
    wide:     { dy: 1, rows: ['NNN'] },
    long:     { dy: 0, rows: ['N', 'N', 'N'] },
    snub:     { dy: 0, rows: ['.N.', 'N.N'] },
    straight: { dy: 0, rows: ['NN', 'NN'] },
    shadow:   { dy: 0, rows: ['.N.', '..N'] },
    none:     { rows: [] },
  },
  F: {
    button:   { dy: 0, rows: ['N.', 'NN'] },
    dot:      { dy: 1, rows: ['N'] },
    small:    { dy: 1, rows: ['NN'] },
    pointed:  { dy: 0, rows: ['.N', 'NN'] },
    wide:     { dy: 1, rows: ['NNN'] },
    tiny:     { dy: 0, rows: ['N'] },
    snub:     { dy: 0, rows: ['.N.', 'N.N'] },
    straight: { dy: 0, rows: ['NN', 'NN'] },
    shadow:   { dy: 0, rows: ['.N.', '..N'] },
    none:     { rows: [] },
  },
};
// Lip patterns stamp at row 8, centred. Chars: L tint, W white.
const LIP_PATTERNS = {
  M: {
    natural: { rows: ['LLL'], tint: '#b3543f' },
    small:   { rows: ['LL'], tint: '#a34a38' },
    full:    { rows: ['LLLL', 'LLLL'], tint: '#a34a38' },
    wide:    { rows: ['LLLLL'], tint: '#ac5138' },
    thin:    { rows: ['LLL'], tint: '#9c5a48' },
    smile:   { rows: ['L...L', '.LLL.'], tint: '#b3543f' },
    smirk:   { rows: ['..LLL', 'LLL..'], tint: '#a34a38' },
    flat:    { rows: ['LLLL'], tint: '#a05240' },
    soft:    { rows: ['LLL'], tint: '#c07a5a' },
    bold:    { rows: ['LLLL', '.LL.'], tint: '#93402e' },
  },
  F: {
    natural: { rows: ['LLL'], tint: '#c06a52' },
    rose:    { rows: ['LLL'], tint: '#d46a7a' },
    red:     { rows: ['LLLL', '.LL.'], tint: '#c22730' },
    pink:    { rows: ['LLL'], tint: '#e58bb0' },
    plum:    { rows: ['LLLL'], tint: '#8e3a63' },
    coral:   { rows: ['LLL'], tint: '#e2704e' },
    gloss:   { rows: ['LLLL', 'LWLL'], tint: '#d94f5c' },
    cupid:   { rows: ['L.L.L', '.LLL.'], tint: '#cf4a5e' },
    full:    { rows: ['LLLL', 'LLLL'], tint: '#b83a4a' },
    small:   { rows: ['LL'], tint: '#cf7285' },
  },
};

// ---------------------------------------------------------------- hair
// 'H' = hair color. Maps are authored for the rows that carry pixels
// and padded to 25. DOWN maps keyed by style id (the per-gender legal
// lists live in appearance.js; a style id has ONE map set).
const R1 = '....HHHHHHHHHHHH....';
const R2 = '..HHHHHHHHHHHHHHHH..';
const SIDE_H = '..HH............HH..';
const HAIR_DOWN = {
  buzz: pad(['....................', R1, R2, R2,
    '..HH............HH..', '..HH............HH..']),
  short: pad(['....................', R1, R2, R2,
    '..HHH..........HHH..', SIDE_H, SIDE_H, SIDE_H, SIDE_H]),
  spiky: pad(['....H..HHHHHH..H....',
    '...HHHHHHHHHHHHHH...', R2, R2,
    '..HHH..........HHH..', SIDE_H, SIDE_H, SIDE_H, SIDE_H]),
  swept: pad(['....................', R1, R2, R2,
    '..HHHHHHHHHHHH..HH..', SIDE_H, SIDE_H, SIDE_H]),
  mohawk: pad(['........HHHH........',
    '.......HHHHHH.......', '.......HHHHHH.......', '.......HHHHHH.......',
    '.......HHHHHH.......', '.......HHHHHH.......', '.......HHHHHH.......',
    '........HHHH........', '........HHHH........']),
  messy: pad(['....................', R1, R2, R2,
    '..HHHH..HHHH..HHH...', SIDE_H, SIDE_H, SIDE_H]),
  wavy: pad(['....................', R1, R2, R2,
    '..HH.HHH.HHH.HHH.HH.', SIDE_H, SIDE_H, SIDE_H, SIDE_H, SIDE_H, SIDE_H]),
  curtains: pad(['....................', R1, R2, R2,
    '..HHHHH.....HHHHH...', SIDE_H, SIDE_H, SIDE_H]),
  long: pad(['....................', R1, R2, R2,
    SIDE_H, SIDE_H, SIDE_H, SIDE_H, SIDE_H, SIDE_H, SIDE_H, SIDE_H, SIDE_H, SIDE_H]),
  ponytail: pad(['....................', R1, R2, R2,
    '..HHH..........HHH..', SIDE_H, SIDE_H, SIDE_H, SIDE_H,
    '....................',
    '.........HH.........', '.........HH.........', '.........HH.........',
    '..........H.........']),
  bob: pad(['....................', R1, R2, R2,
    '..HHH..........HHH..', '..HHH..........HHH..', '..HHH..........HHH..',
    '..HHH..........HHH..', '..HHH..........HHH..', '..HHH..........HHH..',
    '..HHH..........HHH..', '..HHH..........HHH..']),
  bun: pad(['........HHHH........', R1, R2, R2,
    '..HHH..........HHH..', SIDE_H, SIDE_H, SIDE_H]),
  twintails: pad(['....................', R1, R2, R2,
    '..HHH..........HHH..',
    '.HHH............HHH.', '.HHH............HHH.', '.HHH............HHH.',
    '.HHH............HHH.', '.HHH............HHH.', '.HHH............HHH.',
    '.HHH............HHH.', '.HHH............HHH.', '.HHH............HHH.',
    '.HH..............HH.']),
  braids: pad(['....................', R1, R2, R2,
    '..HHH..........HHH..', SIDE_H, SIDE_H, SIDE_H, SIDE_H,
    '....................',
    '...HH...............', '...HH...............',
    '....................',
    '....HH..............', '....HH..............',
    '....................',
    '.....HH.............']),
  pixie: pad(['....................', R1, R2, R2,
    '..HHHHHHHHH.........', SIDE_H, '..H..............H..']),
  bald: pad([]),
};
// Back view: full-coverage caps (the v1 up-maps, kept) + per-style tails.
const CAP_UP = pad(['....................', R1, R2, R2, R2, R2, R2, R2, R2,
  '.HHHHHHHHHHHHHHHHHH.']);
const HAIR_UP = {
  buzz: pad(['....................', R1, R2, R2, R2, R2, R2, R2, R2, R2]),
  short: CAP_UP, swept: CAP_UP, messy: CAP_UP, curtains: CAP_UP, pixie: CAP_UP,
  spiky: pad(['....H..HHHHHH..H....',
    '...HHHHHHHHHHHHHH...', R2, R2, R2, R2, R2, R2, R2,
    '.HHHHHHHHHHHHHHHHHH.']),
  mohawk: pad(['........HHHH........',
    '.......HHHHHH.......', '.......HHHHHH.......', '.......HHHHHH.......',
    '.......HHHHHH.......', '.......HHHHHH.......', '.......HHHHHH.......',
    '.......HHHHHH.......', '.......HHHHHH.......', '........HHHH........']),
  long: pad(['....................', R1, R2, R2, R2, R2, R2, R2, R2,
    '.HHHHHHHHHHHHHHHHHH.', SIDE_H, SIDE_H, SIDE_H, SIDE_H]),
  wavy: null, // alias of long, set below
  bob: pad(['....................', R1, R2, R2, R2, R2, R2, R2, R2,
    '.HHHHHHHHHHHHHHHHHH.', '..HHH..........HHH..', '..HHH..........HHH..']),
  bun: pad(['........HHHH........', R1, R2, R2, R2, R2, R2, R2, R2,
    '.HHHHHHHHHHHHHHHHHH.']),
  ponytail: pad(['....................', R1, R2, R2, R2, R2, R2, R2, R2,
    '.HHHHHHHHHHHHHHHHHH.',
    '.........HH.........', '.........HH.........', '.........HH.........',
    '.........HH.........', '.........HH.........', '..........H.........']),
  twintails: pad(['....................', R1, R2, R2, R2, R2, R2, R2, R2,
    '.HHHHHHHHHHHHHHHHHH.',
    '.HHH............HHH.', '.HHH............HHH.', '.HHH............HHH.',
    '.HHH............HHH.', '.HH..............HH.']),
  braids: null, // long + braid, set below
  bald: pad([]),
};
HAIR_UP.wavy = HAIR_UP.long;
HAIR_UP.braids = pad(['....................', R1, R2, R2, R2, R2, R2, R2, R2,
  '.HHHHHHHHHHHHHHHHHH.',
  '.........HH.........', '.........HH.........',
  '....................',
  '..........HH........', '..........HH........']);
// Side view (faces left; flipped for right at draw time).
const CAP_SIDE = pad(['....................',
  '.....HHHHHHHHHH.....', '....HHHHHHHHHHHH....', '....HHHHHHHHHHHH....',
  '....SSSSHHHHHHHH....', '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....', '.....SSSSSSHH.......']);
const HAIR_SIDE = {
  buzz: pad(['....................',
    '.....HHHHHHHHHH.....', '....HHHHHHHHHHHH....', '....HHHHHHHHHHHH....']),
  short: CAP_SIDE, swept: CAP_SIDE, messy: CAP_SIDE, curtains: CAP_SIDE, pixie: CAP_SIDE,
  spiky: pad(['....H..HHHHHH.......',
    '....HHHHHHHHHHH.....', '....HHHHHHHHHHHH....', '....HHHHHHHHHHHH....',
    '....SSSSHHHHHHHH....', '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....',
    '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....', '.....SSSSSSHH.......']),
  mohawk: pad(['......HHHHHH........',
    '.....HHHHHHHH.......', '.....HHHHHHHH.......', '......HHHHHH........']),
  long: pad(['....................',
    '.....HHHHHHHHHH.....', '....HHHHHHHHHHHH....', '....HHHHHHHHHHHH....',
    '....SSSSHHHHHHHH....', '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....',
    '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....', '.....SSSSSSHHH......',
    '...........HHH......', '...........HHH......', '...........HHH......',
    '...........HHH......']),
  bob: pad(['....................',
    '.....HHHHHHHHHH.....', '....HHHHHHHHHHHH....', '....HHHHHHHHHHHH....',
    '....SSSSHHHHHHHH....', '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....',
    '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....', '.....SSSSSHHHHHH....',
    '...........HHHHH....', '...........HHHHH....']),
  bun: pad(['.............HHHH...',
    '.....HHHHHHHHHH.....', '....HHHHHHHHHHHH....', '....HHHHHHHHHHHH....',
    '....SSSSHHHHHHHH....', '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....',
    '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....', '.....SSSSSSHH.......']),
  ponytail: pad(['....................',
    '.....HHHHHHHHHH.....', '....HHHHHHHHHHHH....', '....HHHHHHHHHHHH....',
    '....SSSSHHHHHHHH....', '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....',
    '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....', '.....SSSSSSHHHHHH...',
    '.............HHH....', '.............HHH....', '.............HHH....',
    '.............HHH....']),
  braids: pad(['....................',
    '.....HHHHHHHHHH.....', '....HHHHHHHHHHHH....', '....HHHHHHHHHHHH....',
    '....SSSSHHHHHHHH....', '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....',
    '....SSSSSHHHHHHH....', '....SSSSSHHHHHHH....', '.....SSSSSSHH.......',
    '.............HH.....', '.............HH.....',
    '....................',
    '............HH......', '............HH......']),
  bald: pad([]),
};
HAIR_SIDE.wavy = HAIR_SIDE.long;
HAIR_SIDE.twintails = HAIR_SIDE.ponytail;

// ---------------------------------------------------------------- body
// Torso templates (rows 11..18). 'a' = arm, resolved per sleeve mode:
// long -> T; short -> T on row 13 only, S below. Tank has its own maps.
const TORSO_TEMPLATES = {
  M: [
    '....TTTTTTTTTTTT....',
    '...TTTTTTTTTTTTTT...',
    '..aaTTTTTTTTTTTTaa..',
    '..aaTTTTTTTTTTTTaa..',
    '..aaTTTTTTTTTTTTaa..',
    '..aaTTTTTTTTTTTTaa..',
    '..aaTTTTTTTTTTTTaa..',
    '....TTTTTTTTTTTT....',
  ],
  F: [
    '.....TTTTTTTTTT.....',
    '....TTTTTTTTTTTT....',
    '...aTTTTTTTTTTTTa...',
    '...aTTTTTTTTTTTTa...',
    '...aTTTTTTTTTTTTa...',
    '...aTTTTTTTTTTTTa...',
    '...aTTTTTTTTTTTTa...',
    '.....TTTTTTTTTT.....',
  ],
};
const TANK_TEMPLATES = {
  M: [
    '......TTTTTTTT......',
    '.....TTTTTTTTTT.....',
    '..SSSTTTTTTTTTTSSS..',
    '..SSSTTTTTTTTTTSSS..',
    '..SSSTTTTTTTTTTSSS..',
    '..SSSTTTTTTTTTTSSS..',
    '..SSSTTTTTTTTTTSSS..',
    '......TTTTTTTT......',
  ],
  F: [
    '.......TTTTTT.......',
    '......TTTTTTTT......',
    '...SSTTTTTTTTTTSS...',
    '...SSTTTTTTTTTTSS...',
    '...SSTTTTTTTTTTSS...',
    '...SSTTTTTTTTTTSS...',
    '...SSTTTTTTTTTTSS...',
    '.......TTTTTT.......',
  ],
};
const SIDE_TORSO = [
  '......TTTTTT........',
  '.....aTTTTTTS.......',
  '.....aTTTTTTS.......',
  '.....aTTTTTTS.......',
  '.....aTTTTTTS.......',
  '.....aTTTTTTS.......',
  '.....aTTTTTTS.......',
  '......TTTTTT........',
];
const SIDE_TANK = [
  '.......TTTT.........',
  '.....SSTTTTSS.......',
  '.....SSTTTTSS.......',
  '.....SSTTTTSS.......',
  '.....SSTTTTSS.......',
  '.....SSTTTTSS.......',
  '.....SSTTTTSS.......',
  '.......TTTT.........',
];
// Club Mirage (v1.4): the CURVY figure — a fixture-only variant
// (dancer NPC looks carry `figure: 'curvy'`; it is NOT a character
// creation axis, so no player look can ever carry it). Fuller bust
// (the widest rows sit high), a pinched waist, and a hip flare at
// the hem; the profile pushes the bust toward the facing edge and
// the hip toward the back. Same 'a' arm placeholders as the plain
// torsos, so the sleeve logic applies unchanged.
const CURVY_TEMPLATES = [
  '.....TTTTTTTTTT.....',
  '....TTTTTTTTTTTT....',
  '..aaTTTTTTTTTTTTaa..',
  '..aaTTTTTTTTTTTTaa..',
  '....aTTTTTTTTTTa....',
  '....aTTTTTTTTTTa....',
  '..aaTTTTTTTTTTTTaa..',
  '....TTTTTTTTTT......',
];
const CURVY_SIDE = [
  '......TTTTTT........',
  '.....aTTTTTTS.......',
  '....aaTTTTTTS.......',
  '....aaTTTTTTS.......',
  '.....aTTTTTTS.......',
  '.....aTTTTTT........',
  '....aaTTTTTTS.......',
  '......TTTTTT........',
];
// The curvy skirt flares a step wider than the plain F skirt.
const CURVY_SKIRT = [
  '....PPPPPPPPPPPP....',
  '..PPPPPPPPPPPPPPPP..',
  '.PPPPPPPPPPPPPPPPPP.',
  '....SSSS....SSSS....',
  '....SSSS....SSSS....',
  '....OOOO....OOOO....',
];
const SLEEVES = { tee: 'short', 'button-up': 'short', hoodie: 'long', jacket: 'long', sweater: 'long', tank: 'bare' };

// Legs (rows 19..24). P = bottom color, d = bottom shade, S skin, O shoes.
const LEGS = {
  M: {
    pants: [
      '....PPPPPPPPPPPP....',
      '....PPPP....PPPP....',
      '....PPPP....PPPP....',
      '....PPPP....PPPP....',
      '....PPPP....PPPP....',
      '....OOOO....OOOO....',
    ],
    jeans: [
      '....PPPPPPPPPPPP....',
      '....PPPP....PPPP....',
      '....PdPP....PPdP....',
      '....PdPP....PPdP....',
      '....dddd....dddd....',
      '....OOOO....OOOO....',
    ],
    shorts: [
      '....PPPPPPPPPPPP....',
      '....PPPP....PPPP....',
      '....PPPP....PPPP....',
      '....SSSS....SSSS....',
      '....SSSS....SSSS....',
      '....OOOO....OOOO....',
    ],
    cargo: [
      '....PPPPPPPPPPPP....',
      '....PPPP....PPPP....',
      '....ddPP....PPdd....',
      '....ddPP....PPdd....',
      '....PPPP....PPPP....',
      '....OOOO....OOOO....',
    ],
    joggers: [
      '....PPPPPPPPPPPP....',
      '....PPPP....PPPP....',
      '....PPPP....PPPP....',
      '....PPPP....PPPP....',
      '....dddd....dddd....',
      '....OOOO....OOOO....',
    ],
  },
  F: {
    pants: [
      '....PPPPPPPPPPPP....',
      '.....PPPP..PPPP.....',
      '.....PPPP..PPPP.....',
      '.....PPPP..PPPP.....',
      '.....PPPP..PPPP.....',
      '.....OOOO..OOOO.....',
    ],
    jeans: [
      '....PPPPPPPPPPPP....',
      '.....PPPP..PPPP.....',
      '.....PPPP..PPPP.....',
      '.....PPPP..PPPP.....',
      '.....dddd..dddd.....',
      '.....OOOO..OOOO.....',
    ],
    shorts: [
      '....PPPPPPPPPPPP....',
      '.....PPPP..PPPP.....',
      '.....PPPP..PPPP.....',
      '.....SSSS..SSSS.....',
      '.....SSSS..SSSS.....',
      '.....OOOO..OOOO.....',
    ],
    skirt: [
      '....PPPPPPPPPPPP....',
      '...PPPPPPPPPPPPPP...',
      '..PPPPPPPPPPPPPPPP..',
      '....SSSS....SSSS....',
      '....SSSS....SSSS....',
      '....OOOO....OOOO....',
    ],
    leggings: [
      '....PPPPPPPPPPPP....',
      '.....PPP....PPP.....',
      '.....PPP....PPP.....',
      '.....PPP....PPP.....',
      '.....PPP....PPP.....',
      '.....OOOO..OOOO.....',
    ],
  },
};
const SIDE_LEGS = [
  '......PPPPPP........',
  '......PPPPP.........',
  '......PPPPP.........',
  '......PPPPP.........',
  '......PPPP..........',
  '.....OOOOO..........',
];

// Seated legs (Phase B — sitting; v1.2.2 legs-together pass).
// Front/back view: the hips sit ON the cushion (wide top rows),
// then the legs come TOGETHER — thighs side by side, knees
// together, shins dropping as one column, shoes adjacent at the
// centre. The pre-v1.2.2 art splayed the legs apart around the
// furniture (the "straddle" Zan kept flagging): thighs split,
// shins at the outer edges, shoes wide. Keyed by bottom style;
// both genders share the shapes (the torso/head carry the gender
// read, as with SIDE_LEGS). test/sprites.test.js pins the
// together invariant: rows 2-4 have no gap between the legs.
const SEATED_LEGS = {
  pants: [
    '....PPPPPPPPPPPP....',
    '....PPPPPPPPPPPP....',
    '.....PPPPPPPPPP.....',
    '......PPPPPPPP......',
    '......PPPPPPPP......',
    '.....OOOO..OOOO.....',
  ],
  jeans: [
    '....PPPPPPPPPPPP....',
    '....PPdPPPPPPdPP....',
    '.....PPPPPPPPPP.....',
    '......dddddddd......',
    '......dddddddd......',
    '.....OOOO..OOOO.....',
  ],
  cargo: [
    '....PPPPPPPPPPPP....',
    '....PPPPPPPPPPPP....',
    '.....ddPPPPPPdd.....',
    '......PPPPPPPP......',
    '......PPPPPPPP......',
    '.....OOOO..OOOO.....',
  ],
  joggers: [
    '....PPPPPPPPPPPP....',
    '.....PPPPPPPPPP.....',
    '.....PPPPPPPPPP.....',
    '......PPPPPPPP......',
    '......dddddddd......',
    '.....OOOO..OOOO.....',
  ],
  leggings: [
    '....PPPPPPPPPPPP....',
    '.....PPPPPPPPPP.....',
    '.....PPPPPPPPPP.....',
    '......PPPPPPPP......',
    '......PPPPPPPP......',
    '.....OOOO..OOOO.....',
  ],
  shorts: [
    '....PPPPPPPPPPPP....',
    '....PPPPPPPPPPPP....',
    '.....SSSSSSSSSS.....',
    '......SSSSSSSS......',
    '......SSSSSSSS......',
    '.....OOOO..OOOO.....',
  ],
  skirt: [
    '...PPPPPPPPPPPPPP...',
    '..PPPPPPPPPPPPPPPP..',
    '.....SSSSSSSSSS.....',
    '......SSSSSSSS......',
    '......SSSSSSSS......',
    '.....OOOO..OOOO.....',
  ],
};
// Seated side view: the sprite faces left, so the thigh reaches
// LEFT (forward) from the hip and the shin drops at the knee.
const SEATED_SIDE_LEGS = [
  '......PPPPPP........',
  '...PPPPPPPPPP.......',
  '...PPPP.............',
  '...PPPP.............',
  '...PPPP.............',
  '..OOOOOO............',
];

// Style detail overlays for the torso, as [col, row, char] stamps.
const TOP_DETAILS_FRONT = {
  hoodie: [
    [4, 10, 'T'], [5, 10, 'T'], [14, 10, 'T'], [15, 10, 'T'],
    [9, 12, 'D'], [10, 13, 'D'],
    [7, 16, 'D'], [12, 16, 'D'],
    [7, 17, 'D'], [8, 17, 'D'], [9, 17, 'D'], [10, 17, 'D'], [11, 17, 'D'], [12, 17, 'D'],
  ],
  'button-up': [
    [7, 11, 'U'], [12, 11, 'U'],
    [10, 12, 'K'], [10, 14, 'K'], [10, 16, 'K'],
  ],
  tee: [
    [12, 14, 'D'], [13, 14, 'D'], [12, 15, 'D'], [13, 15, 'D'],
  ],
};
const TOP_DETAILS_BACK = {
  hoodie: [
    [4, 10, 'T'], [5, 10, 'T'], [6, 10, 'T'], [13, 10, 'T'], [14, 10, 'T'], [15, 10, 'T'],
  ],
};

// ------------------------------------------------------------ accessories
const ACCESSORY_COLORS = { cap: '#c0392b', beanie: '#2a9d8f', headband: '#ffd23f' };
function accessoryPixels(acc, dir) {
  const px = [];
  const A = 'A', K = 'K', G = 'G';
  if (acc === 'cap') {
    if (dir === 'side') {
      px.push(...box(5, 1, 10, 2, A), ...box(3, 3, 7, 3, A)); // dome + front brim
    } else {
      px.push(...box(4, 1, 15, 1, A), ...box(2, 2, 17, 4, A));
    }
  } else if (acc === 'beanie') {
    if (dir === 'side') px.push(...box(5, 1, 14, 1, A), ...box(4, 2, 15, 4, A), [10, 0, A], [11, 0, A]);
    else px.push(...box(9, 0, 10, 0, A), ...box(4, 1, 15, 1, A), ...box(2, 2, 17, 4, A));
  } else if (acc === 'headband') {
    if (dir === 'side') px.push(...box(4, 3, 15, 3, A));
    else px.push(...box(2, 3, 17, 3, A));
  } else if (acc === 'glasses' || acc === 'sunglasses') {
    const lens = acc === 'sunglasses' ? G : null;
    if (dir === 'down') {
      for (const cx of [6, 13]) {
        px.push([cx - 1, 4, K], [cx, 4, K], [cx + 1, 4, K]);
        px.push([cx - 1, 7, K], [cx, 7, K], [cx + 1, 7, K]);
        px.push([cx - 2, 5, K], [cx - 2, 6, K], [cx + 1, 5, K], [cx + 1, 6, K]);
        if (lens) {
          px.push([cx - 1, 5, lens], [cx, 5, lens], [cx - 1, 6, lens], [cx, 6, lens]);
          px.push([cx - 1, 5, 'W']);
        }
      }
      px.push([8, 5, K], [9, 5, K], [10, 5, K]); // bridge
      px.push([3, 5, K], [16, 5, K]);            // temples
    } else if (dir === 'side') {
      px.push([5, 4, K], [6, 4, K], [7, 4, K], [5, 7, K], [6, 7, K], [7, 7, K]);
      px.push([4, 5, K], [4, 6, K], [7, 5, K], [7, 6, K]);
      if (lens) px.push([5, 5, lens], [6, 5, lens], [5, 6, lens], [6, 6, lens], [5, 5, 'W']);
      px.push([8, 5, K], [9, 5, K], [10, 5, K], [11, 5, K], [12, 5, K]); // temple arm
    } else {
      px.push([2, 5, K], [17, 5, K]); // temple tips behind the ears
    }
  }
  return px;
}
function box(x0, y0, x1, y1, ch) {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([x, y, ch]);
  return out;
}

// ------------------------------------------------------------- rendering
function stampRows(grid, rows, topRow) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    if (!row) continue;
    for (let x = 0; x < row.length && x < SPR_W; x++) {
      const c = row[x];
      if (c && c !== '.') grid[topRow + y][x] = c;
    }
  }
}
function stampPixels(grid, pixels) {
  for (const [x, y, c] of pixels) {
    if (x >= 0 && x < SPR_W && y >= 0 && y < SPR_H) grid[y][x] = c;
  }
}
function stampPattern(grid, pattern, cx, topRow) {
  if (!pattern || !pattern.rows) return;
  for (let y = 0; y < pattern.rows.length; y++) {
    const row = pattern.rows[y];
    const x0 = cx - Math.floor(row.length / 2);
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c && c !== '.') grid[topRow + y][x0 + x] = c;
    }
  }
}

function headSpans(gender, face, dir) {
  if (dir === 'side') {
    const base = SIDE_BASE[gender] || SIDE_BASE.M;
    const deltas = SIDE_DELTAS[face] || {};
    return base.map(([l, r], i) => {
      const d = deltas[i + 1];
      return [d !== undefined ? d : l, r];
    });
  }
  const prof = (FACE_PROFILES[gender] || FACE_PROFILES.M)[face] || FACE_PROFILES.M.classic;
  return prof;
}

function buildBodyGrid(cfg, dir, seated) {
  const grid = Array.from({ length: SPR_H }, () => Array(SPR_W).fill('.'));
  const gender = cfg.gender === 'F' ? 'F' : 'M';
  const topStyle = cfg.top_style || 'tee';
  const bottomStyle = cfg.bottom_style || 'pants';

  // head (skin spans) + neck
  const spans = headSpans(gender, cfg.face, dir);
  for (let i = 0; i < 9; i++) {
    const [l, r] = spans[i];
    const row = Array(SPR_W).fill('.');
    for (let x = l; x <= r; x++) row[x] = 'S';
    grid[i + 1] = row;
  }
  const neck = dir === 'side' ? [7, 10] : [6, 13];
  for (let x = neck[0]; x <= neck[1]; x++) grid[10][x] = 'S';

  // torso
  const sleeve = SLEEVES[topStyle] || 'short';
  const curvy = cfg.figure === 'curvy' && gender === 'F';
  let torso;
  if (dir === 'side') {
    torso = (curvy ? CURVY_SIDE : (topStyle === 'tank' ? SIDE_TANK : SIDE_TORSO)).slice();
  } else if (curvy) {
    torso = CURVY_TEMPLATES.slice();
  } else {
    torso = (topStyle === 'tank' ? TANK_TEMPLATES[gender] : TORSO_TEMPLATES[gender]).slice();
  }
  torso = torso.map((rowStr, i) => {
    if (!rowStr.includes('a')) return rowStr;
    const armChar = sleeve === 'long' ? 'T' : (i === 1 || i === 2 ? 'T' : 'S');
    return rowStr.split('a').join(armChar);
  });
  if (topStyle === 'sweater' && dir !== 'side') {
    torso = torso.map((rowStr, i) => (i === 2 || i === 5 || i === 7) ? rowStr.split('T').join('D') : rowStr);
  }
  if (topStyle === 'jacket' && dir === 'down') {
    torso = torso.map((rowStr, i) => {
      const r = rowStr.split('');
      r[9] = 'U'; r[10] = 'U';
      if (i >= 1 && i <= 6) { r[8] = 'D'; r[11] = 'D'; }
      return r.join('');
    });
  }
  stampRows(grid, torso, 11);
  if (dir === 'down') stampPixels(grid, TOP_DETAILS_FRONT[topStyle] || []);
  if (dir === 'up') stampPixels(grid, TOP_DETAILS_BACK[topStyle] || []);

  // legs
  let legs;
  if (dir === 'side') {
    legs = (seated ? SEATED_SIDE_LEGS : SIDE_LEGS).slice();
    if (bottomStyle === 'shorts' || bottomStyle === 'skirt') {
      legs[3] = legs[3].split('P').join('S');
      legs[4] = legs[4].split('P').join('S');
    }
    if (bottomStyle === 'skirt') {
      if (seated) {
        legs[1] = '..PPPPPPPPPPPP......';
        legs[2] = '..PPPP..............';
      } else {
        legs[1] = '.....PPPPPPPP.......';
        legs[2] = '....PPPPPPPPPP......';
      }
    }
  } else if (seated) {
    legs = (SEATED_LEGS[bottomStyle] || SEATED_LEGS.pants).slice();
  } else if (curvy && bottomStyle === 'skirt') {
    legs = CURVY_SKIRT.slice();
  } else {
    legs = (LEGS[gender][bottomStyle] || LEGS[gender].pants).slice();
  }
  stampRows(grid, legs, 19);
  return grid;
}

function buildFaceGrid(cfg, grid, dir) {
  const gender = cfg.gender === 'F' ? 'F' : 'M';
  if (dir === 'up') return; // back of head: no features
  if (dir === 'side') {
    // Profile features at the face edge (sprite faces left, edge col 4).
    const eyeStyle = cfg.eyes || 'round';
    const closed = ['narrow', 'sleepy', 'happy', 'wink'].includes(eyeStyle);
    if (eyeStyle === 'dot') stampPixels(grid, [[6, 6, 'E']]);
    else if (closed) stampPixels(grid, [[5, 6, 'K'], [6, 6, 'K']]);
    else stampPixels(grid, [[5, 6, 'E'], [6, 6, 'E']]);
    if (['lash', 'double-lash', 'winged'].includes(eyeStyle)) stampPixels(grid, [[4, 5, 'K']]);
    const nose = cfg.nose || 'button';
    if (nose !== 'none') {
      stampPixels(grid, [[4, 7, 'N']]);
      if (nose === 'pointed' || nose === 'long') stampPixels(grid, [[3, 7, 'N']]);
    }
    const lip = (LIP_PATTERNS[gender][cfg.lips] || LIP_PATTERNS[gender].natural);
    grid._lipTint = lip.tint;
    stampPixels(grid, [[4, 8, 'L']]);
    if (['full', 'bold', 'red', 'gloss'].includes(cfg.lips)) stampPixels(grid, [[5, 8, 'L']]);
    return;
  }
  // front: eyes (per-eye patterns, optional mirroring), nose, lips
  const eyeDef = (EYE_PATTERNS[gender][cfg.eyes] || EYE_PATTERNS[gender].round);
  const drawEye = (def, cx, mirror) => {
    if (!def) return;
    const rows = mirror ? def.rows.map(r => r.split('').reverse().join('')) : def.rows;
    stampPattern(grid, { rows }, cx, EYE_Y + (def.dy || 0));
  };
  if (eyeDef.l || eyeDef.r) {
    drawEye(eyeDef.l, 6, false);
    drawEye(eyeDef.r, 13, false);
  } else {
    drawEye(eyeDef, 6, false);
    drawEye(eyeDef, 13, Boolean(eyeDef.mirror));
  }
  const noseDef = (NOSE_PATTERNS[gender][cfg.nose] || NOSE_PATTERNS[gender].button);
  stampPattern(grid, noseDef, 10, 6 + (noseDef.dy || 0));
  const lipDef = (LIP_PATTERNS[gender][cfg.lips] || LIP_PATTERNS[gender].natural);
  stampPattern(grid, lipDef, 10, 8);
  grid._lipTint = lipDef.tint;
}

/**
 * Pre-render a sprite for a full appearance + direction to an
 * offscreen canvas. cfg uses the canonical appearance field names
 * (the publicPlayer shape). Cache keeps per-frame cost to a drawImage.
 */
const spriteCache = new Map();

function makeSprite(cfg, dir, opts) {
  cfg = cfg || {};
  const seated = Boolean(opts && opts.seated);
  const gender = cfg.gender === 'F' ? 'F' : 'M';
  const key = [dir, gender, cfg.face, cfg.eyes, cfg.eye_color, cfg.nose, cfg.lips,
    cfg.skin_tone, cfg.hair_style, cfg.hair_color, cfg.top_style, cfg.body_color,
    cfg.bottom_style, cfg.accent_color, cfg.shoe_color, cfg.accessory,
    cfg.figure || '', seated ? 'sit' : 'stand'].join('|');
  let cv = spriteCache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = SPR_W * PX;
  cv.height = SPR_H * PX;
  const g = cv.getContext('2d');

  const grid = buildBodyGrid(cfg, dir, seated);
  buildFaceGrid(cfg, grid, dir);
  const lipTint = grid._lipTint || '#b3543f';

  const hairStyle = cfg.hair_style || 'short';
  const hairMap = (dir === 'down' ? HAIR_DOWN : dir === 'up' ? HAIR_UP : HAIR_SIDE)[hairStyle]
    || HAIR_DOWN.short;
  stampRows(grid, hairMap, 0);
  stampPixels(grid, accessoryPixels(cfg.accessory || 'none', dir));

  const skin = cfg.skin_tone || '#f1c27d';
  const palette = {
    S: skin,
    N: shade(skin, -42),
    E: cfg.eye_color || '#20242c',
    K: '#14161c',
    W: '#ffffff',
    L: lipTint,
    T: cfg.body_color || '#3aa7e0',
    D: shade(cfg.body_color || '#3aa7e0', -42),
    P: cfg.accent_color || '#2b3a55',
    d: shade(cfg.accent_color || '#2b3a55', -42),
    U: '#e8e4da',
    O: cfg.shoe_color || '#23262b',
    H: cfg.hair_color || '#3a2a1c',
    A: ACCESSORY_COLORS[cfg.accessory] || '#c0392b',
    G: '#1b1e26',
  };
  for (let y = 0; y < SPR_H; y++) {
    for (let x = 0; x < SPR_W; x++) {
      const c = grid[y][x];
      if (!c || c === '.') continue;
      g.fillStyle = palette[c] || '#ff00ff';
      g.fillRect(x * PX, y * PX, PX, PX);
    }
  }
  spriteCache.set(key, cv);
  return cv;
}

const API = {
  makeSprite, spriteCache, SPR_W, SPR_H, PX,
  FACE_PROFILES, SIDE_BASE, EYE_PATTERNS, NOSE_PATTERNS, LIP_PATTERNS,
  HAIR_DOWN, HAIR_UP, HAIR_SIDE, TORSO_TEMPLATES, TANK_TEMPLATES,
  CURVY_TEMPLATES, CURVY_SIDE, CURVY_SKIRT,
  SIDE_TORSO, SIDE_TANK, LEGS, SIDE_LEGS, SEATED_LEGS, SEATED_SIDE_LEGS, ACCESSORY_COLORS,
};
if (typeof window !== 'undefined') window.SolarionSprites = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
