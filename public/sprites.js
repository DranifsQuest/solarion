'use strict';

/**
 * Solarion — ORIGINAL V-ego-style pixel avatar sprites.
 *
 * Inspired by the Coke Music / Coke Studios V-ego look (big expressive
 * heads, compact bodies) but drawn entirely from scratch in code below.
 * No Coke/Habbo assets are used or referenced — these pixel maps are
 * original creations for Solarion.
 *
 * Layers (rendered bottom to top, tinted independently):
 *   base: S = skin tone, E = eyes, M = mouth, T = shirt, P = pants,
 *         O = shoes (fixed dark), '.' = transparent
 *   hair: H = hair color, per style ('short' | 'spiky' | 'long'), per dir
 *
 * Directions: 'down' (front), 'up' (back), 'side' (profile; flipped for
 * left vs right at draw time).
 */

const SPR_W = 20;
const SPR_H = 25;
const PX = 2; // sprite pixel size on the pre-rendered canvas

// ------------------------------------------------------------------ base
const BASE_DOWN = [
  '....................',
  '....SSSSSSSSSSSS....',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSEESSSSEESSSS..',
  '..SSSSSSSMMMSSSSS...', // placeholder, replaced below
  '..SSSSSSSSSSSSSSSS..',
  '.SSSSSSSSSSSSSSSSSS.',
  '......SSSSSSSS......',
  '....TTTTTTTTTTTT....',
  '...TTTTTTTTTTTTTT...',
  '..SSTTTTTTTTTTTTSS..',
  '..SSTTTTTTTTTTTTSS..',
  '..SSTTTTTTTTTTTTSS..',
  '..SSTTTTTTTTTTTTSS..',
  '..SSTTTTTTTTTTTTSS..',
  '....TTTTTTTTTTTT....',
  '....PPPPPPPPPPPP....',
  '....PPPP....PPPP....',
  '....PPPP....PPPP....',
  '....PPPP....PPPP....',
  '....PPPP....PPPP....',
  '....OOOO....OOOO....',
];
BASE_DOWN[7] = '..SS' + 'SSSSSMMSSSSS' + 'SS..'; // mouth row, exactly 20

const BASE_UP = [
  '....................',
  '....SSSSSSSSSSSS....',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '..SSSSSSSSSSSSSSSS..',
  '.SSSSSSSSSSSSSSSSSS.',
  '......SSSSSSSS......',
  '....TTTTTTTTTTTT....',
  '...TTTTTTTTTTTTTT...',
  '..SSTTTTTTTTTTTTSS..',
  '..SSTTTTTTTTTTTTSS..',
  '..SSTTTTTTTTTTTTSS..',
  '..SSTTTTTTTTTTTTSS..',
  '..SSTTTTTTTTTTTTSS..',
  '....TTTTTTTTTTTT....',
  '....PPPPPPPPPPPP....',
  '....PPPP....PPPP....',
  '....PPPP....PPPP....',
  '....PPPP....PPPP....',
  '....PPPP....PPPP....',
  '....OOOO....OOOO....',
];

const BASE_SIDE = [
  '....................',
  '.....SSSSSSSSSS.....',
  '....SSSSSSSSSSSS....',
  '....SSSSSSSSSSSS....',
  '....SSSSSSSSSSSS....',
  '....SSSSSSSSSSSS....',
  '....SSESSSSSSSSS....',
  '....MMSSSSSSSSSS....',
  '....SSSSSSSSSSSS....',
  '.....SSSSSSSSSS.....',
  '.......SSSS.........',
  '......TTTTTT........',
  '.....STTTTTTS.......',
  '.....STTTTTTS.......',
  '.....STTTTTTS.......',
  '.....STTTTTTS.......',
  '.....STTTTTTS.......',
  '.....STTTTTTS.......',
  '......TTTTTT........',
  '......PPPPPP........',
  '......PPPPP.........',
  '......PPPPP.........',
  '......PPPPP.........',
  '......PPPP..........',
  '.....OOOOO..........',
];

// ------------------------------------------------------------------ hair
// 'H' marks hair pixels; every row exactly 20 chars.
const HAIR_DOWN_SHORT = [
  '....................',
  '....HHHHHHHHHHHH....',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHH..........HHH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];
const HAIR_DOWN_SPIKY = [
  '....H..HHHHHH..H....',
  '...HHHHHHHHHHHHHH...',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHH..........HHH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];
const HAIR_DOWN_LONG = [
  '....................',
  '....HHHHHHHHHHHH....',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];

const HAIR_UP_SHORT = [
  '....................',
  '....HHHHHHHHHHHH....',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '.HHHHHHHHHHHHHHHHHH.',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];
const HAIR_UP_SPIKY = [
  '....H..HHHHHH..H....',
  '...HHHHHHHHHHHHHH...',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '.HHHHHHHHHHHHHHHHHH.',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];
const HAIR_UP_LONG = [
  '....................',
  '....HHHHHHHHHHHH....',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '..HHHHHHHHHHHHHHHH..',
  '.HHHHHHHHHHHHHHHHHH.',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '..HH............HH..',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];

// Side view faces left (flip horizontally for 'right').
const HAIR_SIDE_SHORT = [
  '....................',
  '.....HHHHHHHHHH.....',
  '....HHHHHHHHHHHH....',
  '....HHHHHHHHHHHH....',
  '....SSSSHHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '.....SSSSSSHH.......',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];
const HAIR_SIDE_SPIKY = [
  '....H..HHHHHH.......',
  '....HHHHHHHHHHH.....',
  '....HHHHHHHHHHHH....',
  '....HHHHHHHHHHHH....',
  '....SSSSHHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '.....SSSSSSHH.......',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];
const HAIR_SIDE_LONG = [
  '....................',
  '.....HHHHHHHHHH.....',
  '....HHHHHHHHHHHH....',
  '....HHHHHHHHHHHH....',
  '....SSSSHHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '....SSSSSHHHHHHH....',
  '.....SSSSSSHHH......',
  '...........HHH......',
  '...........HHH......',
  '...........HHH......',
  '...........HHH......',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
  '....................',
];

const BASES = { down: BASE_DOWN, up: BASE_UP, side: BASE_SIDE };
const HAIRS = {
  down: { short: HAIR_DOWN_SHORT, spiky: HAIR_DOWN_SPIKY, long: HAIR_DOWN_LONG },
  up: { short: HAIR_UP_SHORT, spiky: HAIR_UP_SPIKY, long: HAIR_UP_LONG },
  side: { short: HAIR_SIDE_SHORT, spiky: HAIR_SIDE_SPIKY, long: HAIR_SIDE_LONG },
};

const FIXED = {
  E: '#20242c', // eyes
  M: '#b3543f', // mouth
  O: '#23262b', // shoes
};

/**
 * Pre-render a sprite for a given appearance + direction to an offscreen
 * canvas. Cache keeps per-frame cost to a drawImage per player.
 */
const spriteCache = new Map();

function makeSprite(cfg, dir) {
  const style = (cfg.hair_style === 'spiky' || cfg.hair_style === 'long') ? cfg.hair_style : 'short';
  const key = [dir, style, cfg.skin_tone, cfg.hair_color, cfg.shirt, cfg.pants].join('|');
  let cv = spriteCache.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = SPR_W * PX;
  cv.height = SPR_H * PX;
  const g = cv.getContext('2d');
  const palette = {
    S: cfg.skin_tone || '#f1c27d',
    E: FIXED.E, M: FIXED.M,
    T: cfg.shirt || '#3aa7e0',
    P: cfg.pants || '#2b3a55',
    O: FIXED.O,
  };
  const base = BASES[dir] || BASES.down;
  const hair = (HAIRS[dir] || HAIRS.down)[style];
  for (let y = 0; y < SPR_H; y++) {
    for (let x = 0; x < SPR_W; x++) {
      const hc = hair[y][x];
      const bc = hc !== '.' ? null : base[y][x];
      const c = hc !== '.' ? hc : bc;
      if (!c || c === '.') continue;
      g.fillStyle = c === 'H' ? (cfg.hair_color || '#3a2a1c') : (palette[c] || '#ff00ff');
      g.fillRect(x * PX, y * PX, PX, PX);
    }
  }
  spriteCache.set(key, cv);
  return cv;
}

const API = { makeSprite, spriteCache, SPR_W, SPR_H, PX, BASES, HAIRS };
if (typeof window !== 'undefined') window.SolarionSprites = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
