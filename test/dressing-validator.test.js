'use strict';

/**
 * Dressing validator — negative tests (v1.4.1, the seat audit).
 *
 * The Playtest Gate's checker selftests its image checks against
 * doctored fixtures before its verdicts are trusted; this suite
 * does the same for the dressing validator's SEAT FOOTPRINT LAW.
 * It copies the validator + map data into a throwaway tree, runs
 * the validator as a subprocess, and asserts:
 *   - the clean tree PASSES;
 *   - each of Zan's three live-playtest exhibits, reintroduced as
 *     a data doctoring, FAILS BY NAME:
 *       1. club counter back to an extruded '#' cube
 *          ("chairs by the bar are still ON the bar"),
 *       2. an audience seat kind off the audience art path
 *          (v1.5.1: audience seats resolve to kind 'audience';
 *          doctored back to the generic table 'chair' here),
 *       3. the east slot stools back at their v1.3.1 offset
 *          ("still chairs on top of slot machines"),
 *     plus the north slot row at its old offset (the borderline
 *     back-panel clip the old test modelled away).
 *   v1.6 adds: a reintroduced bar stool fails by name (the stools
 *   are gone game-wide), a city venue stripped of its audience
 *   seats fails while the REGISTERED pit-only club does not, and
 *   a prop inside the club's stage pit fails the pit-only purity
 *   rule.
 *
 * No server, no ports: pure subprocess runs of the validator.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solarion-validator-test-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const f of ['maps.js', 'seasons.js']) {
    fs.copyFileSync(path.join(ROOT, 'src', f), path.join(dir, 'src', f));
  }
  fs.copyFileSync(
    path.join(ROOT, 'scripts', 'validate-dressing.mjs'),
    path.join(dir, 'scripts', 'validate-dressing.mjs'));
  return dir;
}

function runValidator(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'validate-dressing.mjs')], {
    cwd: dir, encoding: 'utf8', timeout: 60000,
  });
  return { code: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

function doctor(dir, file, from, to) {
  const p = path.join(dir, file);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes(from), `doctoring anchor not found in ${file}: ${from}`);
  fs.writeFileSync(p, src.replace(from, to));
}

test('validator passes on the clean tree', () => {
  const dir = makeTree();
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `clean tree must pass:\n${out}`);
  assert.match(out, /VERDICT: ✅ PASS/);
});

test('exhibit 1: an extruded club counter fails by name (bar construction)', () => {
  const dir = makeTree();
  doctor(dir, 'src/maps.js',
    "setRect(g, 3, 23, 10, 1, 'B');   // the bar counter (south-west)",
    "setRect(g, 3, 23, 10, 1, '#');   // the bar counter (south-west)");
  const { code, out } = runValidator(dir);
  assert.equal(code, 1, `doctored tree must fail:\n${out}`);
  assert.match(out, /\[club-mirage\] bar construction: interior '#'/);
  // v1.6: the seat-footprint half of this exhibit is retired with
  // the bar stools themselves — the stools whose cushions landed
  // on the doctored counter no longer exist (see exhibit 1c).
});

test('exhibit 1c: a reintroduced bar stool fails by name (v1.6: no bar stools)', () => {
  const dir = makeTree();
  doctor(dir, 'src/maps.js',
    "      // (v1.6: the two bar stools that stood here are GONE — Zan's",
    "      seat(id, 13, 5, 22, 'down', 'stool'), // doctored back in\n      // (v1.6: the two bar stools that stood here are GONE — Zan's");
  const { code, out } = runValidator(dir);
  assert.equal(code, 1, `doctored tree must fail:\n${out}`);
  assert.match(out, /bar stool club-mirage-seat-13 .* bar stools were removed game-wide/);
});

test('exhibit 4: a city venue stripped of its audience seats fails (pit-only is registered, not general)', () => {
  const dir = makeTree();
  doctor(dir, 'src/maps.js',
    "out.push(seat(id, n++, tx, ty, dir, 'audience'));",
    '/* audience seats doctored out */');
  const { code, out } = runValidator(dir);
  assert.equal(code, 1, `doctored tree must fail:\n${out}`);
  assert.match(out, /venue geometry: this stage has NO audience seats/);
  assert.doesNotMatch(out, /\[club-mirage\] venue geometry: this stage has NO audience seats/,
    'the registered pit-only club must NOT be flagged for its missing grid');
});

test('exhibit 5: a prop in the club stage pit fails by name (pit-only purity)', () => {
  const dir = makeTree();
  doctor(dir, 'src/maps.js',
    "prop('lantern', 28, 23), prop('lantern', 33, 23),",
    "prop('lantern', 28, 23), prop('lantern', 33, 23), prop('lamp', 34, 16),");
  const { code, out } = runValidator(dir);
  assert.equal(code, 1, `doctored tree must fail:\n${out}`);
  assert.match(out, /venue purity \(pit-only\): \[base\] prop "lamp" intrudes into the stage pit \(34,16\)/);
});

test('exhibit 1b: an extruded casino counter fails by name', () => {
  const dir = makeTree();
  doctor(dir, 'src/maps.js',
    "setRect(g, 2, 21, 9, 1, 'B'); // bar counter (bartender stands behind it)",
    "setRect(g, 2, 21, 9, 1, 'W'); // bar counter (bartender stands behind it)");
  const { code, out } = runValidator(dir);
  assert.equal(code, 1, `doctored tree must fail:\n${out}`);
  assert.match(out, /bar construction: interior 'W' tile/);
});

test('exhibit 2: an audience seat off the audience-art path fails by name (sprite path)', () => {
  const dir = makeTree();
  doctor(dir, 'src/maps.js',
    "out.push(seat(id, n++, tx, ty, dir, 'audience'));",
    "out.push(seat(id, n++, tx, ty, dir, 'chair'));");
  const { code, out } = runValidator(dir);
  assert.equal(code, 1, `doctored tree must fail:\n${out}`);
  assert.match(out, /sprite path: audience seat .* is kind 'chair'/);
});

test('exhibit 3: east slot stools at the v1.3.1 offset fail by name (slot footprint)', () => {
  const dir = makeTree();
  doctor(dir, 'src/maps.js',
    'x: cx(34), y: cy(ty), ix: cx(34) - 64, iy: cy(ty) + 16,',
    'x: cx(34), y: cy(ty), ix: cx(34) - 52, iy: cy(ty),');
  const { code, out } = runValidator(dir);
  assert.equal(code, 1, `doctored tree must fail:\n${out}`);
  assert.match(out, /slot footprint: .*slot-[6-9]'s stool \(dir 'right'\) intersects its cabinet/);
});

test('exhibit 3b: north slot stools at the old offset fail by name (slot footprint)', () => {
  const dir = makeTree();
  doctor(dir, 'src/maps.js',
    'x: cx(tx), y: cy(2) - 10, ix: cx(tx), iy: cy(3) + 28,',
    'x: cx(tx), y: cy(2) - 10, ix: cx(tx), iy: cy(3),');
  const { code, out } = runValidator(dir);
  assert.equal(code, 1, `doctored tree must fail:\n${out}`);
  assert.match(out, /slot footprint: .*slot-[1-5]'s stool \(dir 'up'\) intersects its cabinet/);
});
