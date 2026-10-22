'use strict';

/**
 * Solarion Phase 6 — sprite renderer tests.
 *
 * Loads public/sprites.js in Node with a recording canvas stub and
 * proves the pixel art behind the creation axes is real:
 *   1. every hand-authored pixel row is exactly 20 chars (SPR_W)
 *   2. every legal value of every axis renders, both genders,
 *      all 3 directions, without throwing
 *   3. every face / eye / nose / lip / hair / top / bottom option
 *      renders DIFFERENTLY from its siblings (no fake options)
 *   4. male and female renders of the "same" look differ
 *      (distinct silhouettes, not a palette swap)
 *
 * Run:  node --test test/sprites.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// --- recording canvas stub (must exist before sprites.js loads) ---
function makeCtx(cv) {
  return {
    fillStyle: '',
    fillRect(x, y, w, h) { cv._px[(x / 2) + ',' + (y / 2)] = this.fillStyle; },
  };
}
global.document = {
  createElement: () => {
    const cv = { width: 0, height: 0, _px: {}, getContext() { return makeCtx(cv); } };
    return cv;
  },
};

const S = require('../public/sprites.js');
const A = require('../src/appearance');

function render(cfg, dir) {
  S.spriteCache.clear();
  const cv = S.makeSprite(cfg, dir);
  return JSON.stringify(Object.keys(cv._px).sort().map(k => k + '=' + cv._px[k]));
}
const baseFor = (g) => ({ ...A.defaultsFor(g) });

test('all authored pixel rows are exactly SPR_W wide', () => {
  const check = (name, rows) => rows.forEach((r, i) => {
    assert.equal(typeof r, 'string', `${name} row ${i}`);
    assert.equal(r.length, S.SPR_W, `${name} row ${i} length ${r.length}: "${r}"`);
  });
  for (const [k, v] of Object.entries(S.HAIR_DOWN)) check('HAIR_DOWN.' + k, v);
  for (const [k, v] of Object.entries(S.HAIR_UP)) check('HAIR_UP.' + k, v);
  for (const [k, v] of Object.entries(S.HAIR_SIDE)) check('HAIR_SIDE.' + k, v);
  for (const [k, v] of Object.entries(S.TORSO_TEMPLATES)) check('TORSO.' + k, v);
  for (const [k, v] of Object.entries(S.TANK_TEMPLATES)) check('TANK.' + k, v);
  check('SIDE_TORSO', S.SIDE_TORSO);
  check('SIDE_TANK', S.SIDE_TANK);
  for (const [g, styles] of Object.entries(S.LEGS)) {
    for (const [k, v] of Object.entries(styles)) check(`LEGS.${g}.${k}`, v);
  }
  check('SIDE_LEGS', S.SIDE_LEGS);
  for (const [k, v] of Object.entries(S.SEATED_LEGS)) check(`SEATED_LEGS.${k}`, v);
  check('SEATED_SIDE_LEGS', S.SEATED_SIDE_LEGS);
});

test('face profiles: 10 per gender, 9 rows, spans on-canvas', () => {
  for (const g of ['M', 'F']) {
    assert.equal(Object.keys(S.FACE_PROFILES[g]).length, 10, `${g} has 10 faces`);
    assert.deepEqual(Object.keys(S.FACE_PROFILES[g]).sort(), [...A.FACES[g]].sort(),
      `${g} sprite faces match appearance.js faces`);
    for (const [face, prof] of Object.entries(S.FACE_PROFILES[g])) {
      assert.equal(prof.length, 9, `${g}/${face} has 9 rows`);
      for (const [l, r] of prof) assert.ok(l >= 0 && r <= 19 && l < r, `${g}/${face} span ${l}..${r}`);
    }
  }
});

test('every axis value renders for both genders in all directions', () => {
  for (const g of ['M', 'F']) {
    for (const dir of ['down', 'up', 'side']) {
      for (const axis of A.AXIS_NAMES) {
        const def = A.AXES[axis];
        const vals = def.kind === 'enum' ? def.values
          : def.kind === 'perGender' ? def.lists[g] : ['#123456'];
        for (const v of vals) {
          const cfg = { ...baseFor(g), [axis]: v };
          const cv = S.makeSprite(cfg, dir);
          assert.equal(cv.width, S.SPR_W * S.PX);
          assert.equal(cv.height, S.SPR_H * S.PX);
          assert.ok(Object.keys(cv._px).length > 100, `${g}/${dir}/${axis}=${v} drew a sprite`);
        }
      }
    }
  }
});

test('every face option renders distinctly (10/10 per gender)', () => {
  for (const g of ['M', 'F']) {
    const seen = new Set(A.FACES[g].map(f => render({ ...baseFor(g), face: f }, 'down')));
    assert.equal(seen.size, 10, `${g} faces: ${seen.size}/10 distinct`);
  }
});

test('every eye / nose / lip / hair option renders distinctly', () => {
  for (const g of ['M', 'F']) {
    for (const [axis, list] of [['eyes', A.EYES[g]], ['nose', A.NOSES[g]], ['lips', A.LIPS[g]], ['hair_style', A.HAIR_STYLES[g]]]) {
      const seen = new Set(list.map(v => render({ ...baseFor(g), [axis]: v }, 'down')));
      assert.equal(seen.size, list.length, `${g} ${axis}: ${seen.size}/${list.length} distinct`);
    }
  }
});

test('every top and bottom style renders distinctly', () => {
  for (const g of ['M', 'F']) {
    const tops = new Set(A.TOP_STYLES.map(v => render({ ...baseFor(g), top_style: v }, 'down')));
    assert.equal(tops.size, A.TOP_STYLES.length, `${g} tops distinct`);
    const bottoms = new Set(A.BOTTOM_STYLES[g].map(v => render({ ...baseFor(g), bottom_style: v }, 'down')));
    assert.equal(bottoms.size, A.BOTTOM_STYLES[g].length, `${g} bottoms distinct`);
    const accs = new Set(A.ACCESSORIES.map(v => render({ ...baseFor(g), accessory: v }, 'down')));
    assert.equal(accs.size, A.ACCESSORIES.length, `${g} accessories distinct`);
  }
});

test('seated variant (Phase B): renders for both genders and differs from standing', () => {
  const renderSeated = (cfg, dir) => {
    S.spriteCache.clear();
    const cv = S.makeSprite(cfg, dir, { seated: true });
    return JSON.stringify(Object.keys(cv._px).sort().map(k => k + '=' + cv._px[k]));
  };
  for (const g of ['M', 'F']) {
    for (const dir of ['down', 'up', 'side']) {
      for (const bottom of A.BOTTOM_STYLES[g]) {
        const cfg = { ...baseFor(g), bottom_style: bottom };
        const standing = render(cfg, dir);
        const seated = renderSeated(cfg, dir);
        assert.ok(seated.length > 500, `${g}/${dir}/${bottom} seated renders`);
        assert.notEqual(seated, standing, `${g}/${dir}/${bottom} seated differs from standing`);
      }
    }
  }
});

test('seated legs stay TOGETHER (v1.2.2 Item 2: the straddle fix)', () => {
  // The pre-v1.2.2 seated art splayed the legs around the
  // furniture: split thighs, shins at the outer edges, shoes wide
  // apart. The invariant that kills the read, for every bottom
  // style: below the hip rows, the leg mass is ONE contiguous
  // column (no empty gap between the legs in rows 2-4), and the
  // shoes land adjacent at the centre (row 5 spans <= 10 cols).
  for (const [style, rows] of Object.entries(S.SEATED_LEGS)) {
    assert.equal(rows.length, 6, `${style}: six seated leg rows`);
    for (let r = 2; r <= 4; r++) {
      const filled = [...rows[r]].map((c, i) => (c === '.' ? -1 : i)).filter(i => i >= 0);
      assert.ok(filled.length > 0, `${style} row ${r} has leg pixels`);
      const span = filled[filled.length - 1] - filled[0] + 1;
      assert.equal(span, filled.length, `${style} row ${r} has a gap between the legs (straddle): "${rows[r]}"`);
    }
    const shoeCols = [...rows[5]].map((c, i) => (c === 'O' ? i : -1)).filter(i => i >= 0);
    assert.ok(shoeCols.length > 0, `${style}: shoes present`);
    const shoeSpan = shoeCols[shoeCols.length - 1] - shoeCols[0] + 1;
    assert.ok(shoeSpan <= 10, `${style}: shoes span ${shoeSpan} cols — they must land together at the centre`);
  }
});

test('male and female are genuinely different sprites, not palette swaps', () => {
  // Same nominal choices, both genders: renders must differ in the
  // down AND side views (silhouette + hair anchors + fit).
  const shared = {
    face: 'classic', eyes: 'round', nose: 'button', lips: 'natural',
    hair_style: 'long', top_style: 'tee', bottom_style: 'pants',
  };
  for (const dir of ['down', 'side', 'up']) {
    const m = render({ ...baseFor('M'), ...shared }, dir);
    const f = render({ ...baseFor('F'), ...shared }, dir);
    assert.notEqual(m, f, `M vs F differ facing ${dir}`);
  }
  // And every F hair style renders (the F set is its own art).
  for (const h of A.HAIR_STYLES.F) {
    assert.ok(render({ ...baseFor('F'), hair_style: h }, 'down').length > 500, `F hair ${h} renders`);
  }
});
