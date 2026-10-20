'use strict';

/**
 * Solarion — appearance options (Phase 6: character creation).
 *
 * THE single source of truth for what a legal look is. The server
 * validates every look against these lists (auth.js), the client
 * fetches them from GET /api/appearance and builds BOTH the character
 * creation screen and the in-game look editor from them — creation and
 * editing can never drift apart, and neither can client and server.
 *
 * Per-gender axes (face / eyes / nose / lips / hair_style /
 * bottom_style) validate against the list for the character's gender;
 * the pixel art for each id lives client-side in public/sprites.js,
 * keyed by these exact ids.
 *
 * Color axes split in two:
 *  - Whitelisted palettes: skin_tone, eye_color, shoe_color.
 *  - Free #rrggbb (the v1 model, kept): hair_color, body_color (top),
 *    accent_color (bottom). The UI offers 12-swatch palettes for these
 *    (HAIR_COLORS / CLOTH_COLORS below) plus a custom color input.
 */

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const GENDERS = ['M', 'F'];

// 8 tones — the four v1 tones are all still here (#ffe0bd, #f1c27d,
// #e0ac69, #8d5524) so migrated avatars keep their exact skin.
const SKIN_TONES = [
  '#ffe0bd', '#ffcd94', '#f1c27d', '#e0ac69',
  '#c68642', '#8d5524', '#6f4420', '#4e2e15',
];

// 10 face shapes per gender (head/jaw/cheek geometry in sprites.js).
const FACES = {
  M: ['classic', 'square', 'round', 'long', 'sharp', 'wide', 'chiseled', 'angular', 'oval', 'soft'],
  F: ['classic', 'round', 'heart', 'oval', 'soft', 'petite', 'long', 'square', 'wide', 'sharp'],
};

// 10 eye styles per gender (shape / expression / lash variation).
const EYES = {
  M: ['round', 'dot', 'tall', 'narrow', 'happy', 'sleepy', 'sharp', 'wink', 'gentle', 'bold'],
  F: ['round', 'dot', 'tall', 'lash', 'double-lash', 'happy', 'sleepy', 'wink', 'winged', 'gentle'],
};
const EYE_COLORS = [
  '#20242c', '#5b3a1e', '#8a5a2b', '#2e5e1e',
  '#1e4d8f', '#6e2a8f', '#8f1e3a', '#0d7a75',
];

// 10 nose styles per gender.
const NOSES = {
  M: ['button', 'dot', 'small', 'pointed', 'wide', 'long', 'snub', 'straight', 'shadow', 'none'],
  F: ['button', 'dot', 'small', 'pointed', 'wide', 'tiny', 'snub', 'straight', 'shadow', 'none'],
};

// 10 lip styles per gender (shape + tint live in sprites.js).
const LIPS = {
  M: ['natural', 'small', 'full', 'wide', 'thin', 'smile', 'smirk', 'flat', 'soft', 'bold'],
  F: ['natural', 'rose', 'red', 'pink', 'plum', 'coral', 'gloss', 'cupid', 'full', 'small'],
};

// 10 hair styles per gender (mix of shared + gender-specific). The v1
// styles (short / spiky / long) exist in BOTH lists so migrated v1
// avatars are always valid for their backfilled gender.
const HAIR_STYLES = {
  M: ['buzz', 'short', 'spiky', 'swept', 'mohawk', 'messy', 'wavy', 'curtains', 'long', 'bald'],
  F: ['long', 'ponytail', 'bob', 'bun', 'twintails', 'wavy', 'pixie', 'swept', 'spiky', 'braids'],
};
// UI palette (12) — the server still accepts any #rrggbb hair color.
const HAIR_COLORS = [
  '#191410', '#3a2a1c', '#6b4423', '#a5713a', '#d9a066', '#e8c88a',
  '#8a8f98', '#e8e4da', '#c0392b', '#e67e22', '#2e6fc2', '#7d3ac2',
];

// 6 top styles (shared ids; the fit/silhouette differs per gender).
const TOP_STYLES = ['tee', 'hoodie', 'jacket', 'tank', 'sweater', 'button-up'];
// UI palette (12) for top/bottom colors — server accepts any #rrggbb.
const CLOTH_COLORS = [
  '#3aa7e0', '#2b3a55', '#e04a3a', '#ffd23f', '#39b06e', '#e67e22',
  '#e5639e', '#7d3ac2', '#e8e4da', '#23262b', '#7a4a21', '#2a9d8f',
];

// 5 bottom styles per gender (F set includes the skirt).
const BOTTOM_STYLES = {
  M: ['pants', 'jeans', 'shorts', 'cargo', 'joggers'],
  F: ['pants', 'jeans', 'shorts', 'skirt', 'leggings'],
};

// 8 shoe colors (whitelisted; '#23262b' is the v1 shoe color).
const SHOE_COLORS = [
  '#23262b', '#5a3a22', '#8f1e3a', '#1e4d8f',
  '#e8e4da', '#ffd23f', '#14663c', '#7d3ac2',
];

// Accessory layer: none + 5 (cap, beanie, glasses, sunglasses, headband).
const ACCESSORIES = ['none', 'cap', 'beanie', 'glasses', 'sunglasses', 'headband'];

/** The axes, in canonical order, with how each one validates. */
const AXES = {
  gender:       { kind: 'enum',      values: GENDERS },
  face:         { kind: 'perGender', lists: FACES },
  eyes:         { kind: 'perGender', lists: EYES },
  eye_color:    { kind: 'enum',      values: EYE_COLORS },
  nose:         { kind: 'perGender', lists: NOSES },
  lips:         { kind: 'perGender', lists: LIPS },
  skin_tone:    { kind: 'enum',      values: SKIN_TONES },
  hair_style:   { kind: 'perGender', lists: HAIR_STYLES },
  hair_color:   { kind: 'color' },
  top_style:    { kind: 'enum',      values: TOP_STYLES },
  body_color:   { kind: 'color' },
  bottom_style: { kind: 'perGender', lists: BOTTOM_STYLES },
  accent_color: { kind: 'color' },
  shoe_color:   { kind: 'enum',      values: SHOE_COLORS },
  accessory:    { kind: 'enum',      values: ACCESSORIES },
};
const AXIS_NAMES = Object.keys(AXES);

/** Human labels for error messages / UI. */
const AXIS_LABELS = {
  gender: 'gender', face: 'face', eyes: 'eyes', eye_color: 'eye color',
  nose: 'nose', lips: 'lips', skin_tone: 'skin tone', hair_style: 'hair style',
  hair_color: 'hair color', top_style: 'top', body_color: 'top color',
  bottom_style: 'bottoms', accent_color: 'bottom color', shoe_color: 'shoe color',
  accessory: 'accessory',
};

/** Is `value` a legal value for `axis` on a `gender` character? */
function axisValid(axis, gender, value) {
  const def = AXES[axis];
  if (!def || typeof value !== 'string') return false;
  if (def.kind === 'color') return COLOR_RE.test(value);
  if (def.kind === 'enum') return def.values.includes(value);
  const list = def.lists[gender] || def.lists.M;
  return list.includes(value);
}

/** Default look for a gender (also the migration backfill for 'M'). */
function defaultsFor(gender) {
  const g = gender === 'F' ? 'F' : 'M';
  return {
    gender: g,
    face: 'classic',
    eyes: 'round',
    eye_color: '#20242c',
    nose: 'button',
    lips: 'natural',
    skin_tone: '#f1c27d',
    hair_style: g === 'F' ? 'long' : 'short',
    hair_color: '#3a2a1c',
    top_style: 'tee',
    body_color: '#3aa7e0',
    bottom_style: 'pants',
    accent_color: '#2b3a55',
    shoe_color: '#23262b',
    accessory: 'none',
  };
}

/**
 * Merge a partial look update onto `current` for the (possibly new)
 * gender, validating every PROVIDED field strictly. Per-gender axes
 * left over from a gender switch that are invalid for the new gender
 * are reset to that gender's default (e.g. skirt -> pants).
 * Returns { look } or { error }.
 */
function mergeLook(current, input) {
  input = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const gender = input.gender !== undefined ? input.gender : current.gender;
  if (typeof gender !== 'string' || !GENDERS.includes(gender)) {
    return { error: 'Invalid gender. Choose: M, F.' };
  }
  const look = { ...current, gender };
  for (const axis of AXIS_NAMES) {
    if (axis === 'gender') continue;
    if (input[axis] !== undefined) {
      if (!axisValid(axis, gender, input[axis])) {
        return { error: `Invalid ${AXIS_LABELS[axis]}.` };
      }
      look[axis] = input[axis];
    }
  }
  // Normalize: anything invalid for the final gender (e.g. carried
  // over from the other gender's list) falls back to the default.
  const dflts = defaultsFor(gender);
  for (const axis of AXIS_NAMES) {
    if (!axisValid(axis, gender, look[axis])) look[axis] = dflts[axis];
  }
  return { look };
}

/** Full client-facing option payload (GET /api/appearance). */
function clientOptions() {
  return {
    genders: GENDERS,
    faces: FACES,
    eyes: EYES,
    eyeColors: EYE_COLORS,
    noses: NOSES,
    lips: LIPS,
    skinTones: SKIN_TONES,
    hairStyles: HAIR_STYLES,
    hairColors: HAIR_COLORS,
    topStyles: TOP_STYLES,
    clothColors: CLOTH_COLORS,
    bottomStyles: BOTTOM_STYLES,
    shoeColors: SHOE_COLORS,
    accessories: ACCESSORIES,
    defaults: { M: defaultsFor('M'), F: defaultsFor('F') },
  };
}

module.exports = {
  COLOR_RE, GENDERS, SKIN_TONES, FACES, EYES, EYE_COLORS, NOSES, LIPS,
  HAIR_STYLES, HAIR_COLORS, TOP_STYLES, CLOTH_COLORS, BOTTOM_STYLES,
  SHOE_COLORS, ACCESSORIES, AXES, AXIS_NAMES, AXIS_LABELS,
  axisValid, defaultsFor, mergeLook, clientOptions,
};
