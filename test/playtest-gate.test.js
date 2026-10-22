'use strict';

/**
 * Playtest Gate tooling (Zan's challenge, 2026-10-21): the visual
 * level of the Gatekeeper. These tests pin the CHECKER, not the
 * game: the PNG codec round-trips, the screen-space projection
 * matches the client's math, and — the important part — every
 * image-space check FAILS BY NAME on a doctored fixture
 * (runSelftest). No server, no ports, no captures needed: the
 * fixtures are synthetic, so this runs in every gate tier.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import(path.join(__dirname, '..', 'scripts', 'playtest-check.mjs'));

test('playtest checker: PNG codec round-trips losslessly', async () => {
  const M = await load();
  const img = { w: 5, h: 3, data: new Uint8Array(5 * 3 * 4) };
  for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) % 256;
  const back = M.decodePng(M.encodePng(img));
  assert.equal(back.w, 5);
  assert.equal(back.h, 3);
  assert.deepEqual([...back.data], [...img.data]);
});

test('playtest checker: screenOf matches the client projection', async () => {
  const M = await load();
  // Camera actor renders at canvas centre (+ page offset).
  const entry = { canvas: { w: 1440, h: 900, ox: 3, oy: 4 }, camera: { x: 500, y: 300 } };
  assert.deepEqual(M.screenOf(entry, 500, 300), [723, 454]);
  // One tile east: proj delta (+TILE*ZOOM, +TILE*ZOOM/2).
  const [x, y] = M.screenOf(entry, 532, 300);
  assert.ok(Math.abs(x - (723 + 32 * 0.72)) < 1e-9, `x=${x}`);
  assert.ok(Math.abs(y - (454 + 32 * 0.36)) < 1e-9, `y=${y}`);
  // The marker pants are findable, ordinary trousers are not.
  assert.ok(M.isGreenMarker(43, 255, 94));
  assert.ok(!M.isGreenMarker(60, 90, 60));
});

test('playtest checker: every check fails by name on a broken fixture', async () => {
  const M = await load();
  const { ok, cases } = M.runSelftest();
  assert.ok(cases.length >= 9, `expected >=9 selftest cases, got ${cases.length}`);
  const names = cases.map(c => c.name).join(' | ');
  for (const need of ['BACK VISIBILITY', 'LEGS UNDER TABLES', 'ROW ALIGNMENT', 'CLEAR ZONES', 'CROWDING', 'EDGE MARGIN']) {
    assert.ok(names.includes(need), `selftest is missing a negative fixture for ${need}`);
  }
  assert.ok(ok, `selftest failures: ${cases.filter(c => !c.ok).map(c => `${c.name} — ${c.detail}`).join('; ')}`);
});

test('playtest gate: tier is wired into the Gatekeeper', () => {
  const gate = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'gate.mjs'), 'utf8');
  assert.ok(gate.includes('playtest'), 'gate.mjs must know the playtest tier');
  assert.ok(gate.includes('playtest.mjs'), 'gate.mjs must run scripts/playtest.mjs for the playtest tier');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts['gate:playtest'], 'package.json must expose gate:playtest');
});
