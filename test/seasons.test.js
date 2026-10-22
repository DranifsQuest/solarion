'use strict';

/**
 * Seasonal themes (Zan's standing annual rule, 2026-10-21):
 * Halloween Oct 1 → Nov 1, Christmas Dec 1 → Jan 1, computed by
 * the server in America/Chicago. This suite pins the boundaries
 * EXACTLY — including UTC instants that straddle the local
 * boundary — plus the overlay-layer contract: real maps only,
 * known kinds only, the client can draw every kind used, the
 * layer is empty off-season, and clientMap merges the layer in
 * (and only in) its season. The fish emote's registry entry is
 * pinned here too (its live behavior is covered by phase9).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// game.js pulls the DB layer; point it at a throwaway file first.
process.env.SOLARION_DB_PATH = path.join(os.tmpdir(), `solarion-seasons-test-${process.pid}.db`);

const { seasonAt, overlayProps, SEASONAL, SEASONAL_KINDS } = require('../src/seasons');
const { MAPS, clientMap } = require('../src/maps');
const { EMOTES } = require('../src/game');

const at = (iso) => seasonAt(new Date(iso));

test('season boundaries: Halloween Oct 1 → Nov 1 (America/Chicago)', () => {
  // CDT is UTC-5, CST is UTC-6; DST ends Nov 1 2026, so Nov 1
  // 00:00 local is still CDT (05:00Z).
  assert.equal(at('2026-09-30T12:00:00Z'), null, 'Sep 30 → none');
  assert.equal(at('2026-10-01T04:59:00Z'), null, 'Sep 30 23:59 CT → none');
  assert.equal(at('2026-10-01T05:00:00Z'), 'halloween', 'Oct 1 00:00 CT → halloween');
  assert.equal(at('2026-10-15T18:00:00Z'), 'halloween', 'mid-October → halloween');
  assert.equal(at('2026-10-31T12:00:00Z'), 'halloween', 'Oct 31 → halloween');
  assert.equal(at('2026-11-01T04:59:00Z'), 'halloween', 'Oct 31 23:59 CT → halloween');
  assert.equal(at('2026-11-01T05:00:00Z'), null, 'Nov 1 00:00 CT → none');
  assert.equal(at('2026-11-30T18:00:00Z'), null, 'Nov 30 → none');
});

test('season boundaries: Christmas Dec 1 → Jan 1 (America/Chicago)', () => {
  assert.equal(at('2026-12-01T05:59:00Z'), null, 'Nov 30 23:59 CT → none');
  assert.equal(at('2026-12-01T06:00:00Z'), 'christmas', 'Dec 1 00:00 CT → christmas');
  assert.equal(at('2026-12-25T18:00:00Z'), 'christmas', 'Dec 25 → christmas');
  assert.equal(at('2026-12-31T12:00:00Z'), 'christmas', 'Dec 31 → christmas');
  assert.equal(at('2027-01-01T05:59:00Z'), 'christmas', 'Dec 31 23:59 CT → christmas');
  assert.equal(at('2027-01-01T06:00:00Z'), null, 'Jan 1 00:00 CT → none');
});

test('season uses Chicago time, not UTC', () => {
  // Oct 1 in UTC but still Sep 30 in Chicago → no Halloween yet.
  assert.equal(at('2026-10-01T02:00:00Z'), null, 'UTC Oct 1 / CT Sep 30 → none');
  // Dec 1 in UTC but still Nov 30 in Chicago → no Christmas yet.
  assert.equal(at('2026-12-01T02:00:00Z'), null, 'UTC Dec 1 / CT Nov 30 → none');
  // Jan 1 in UTC but still Dec 31 in Chicago → still Christmas.
  assert.equal(at('2027-01-01T02:00:00Z'), 'christmas', 'UTC Jan 1 / CT Dec 31 → christmas');
});

test('overlay layers: real maps, known kinds, drawable kinds', () => {
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');
  for (const [season, layer] of Object.entries(SEASONAL)) {
    for (const [mapId, entries] of Object.entries(layer)) {
      assert.ok(MAPS[mapId], `${season} layer names a real map (${mapId})`);
      assert.ok(entries.length > 0, `${season}/${mapId} layer is not empty`);
      for (const [kind] of entries) {
        assert.ok(SEASONAL_KINDS.has(kind), `${season}/${mapId} uses a known kind (${kind})`);
        assert.ok(clientSrc.includes(`case '${kind}'`), `client drawProp handles '${kind}'`);
      }
      const props = overlayProps(mapId, season);
      assert.equal(props.length, entries.length, `${season}/${mapId} overlay converts 1:1`);
      for (const p of props) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'overlay props carry pixel coords');
      }
    }
  }
});

test('overlay is empty off-season and for layer-less maps', () => {
  assert.deepEqual(overlayProps('the-gateway', null), []);
  assert.deepEqual(overlayProps('the-gateway', 'none'), []);
  assert.deepEqual(overlayProps('no-such-map', 'halloween'), []);
});

test('clientMap merges the active layer — and only that layer', () => {
  for (const season of ['halloween', 'christmas']) {
    const gw = MAPS['the-gateway'];
    const merged = clientMap(gw, season);
    const overlay = overlayProps('the-gateway', season);
    assert.equal(merged.props.length, gw.props.length + overlay.length,
      `${season}: client props = base + overlay`);
    for (const p of overlay) {
      assert.ok(merged.props.some(mp => mp.kind === p.kind && mp.x === p.x && mp.y === p.y),
        `${season}: overlay prop ${p.kind} present in clientMap`);
    }
    const other = season === 'halloween' ? 'christmas' : 'halloween';
    const otherKinds = new Set(overlayProps('the-gateway', other).map(p => p.kind));
    for (const p of merged.props) {
      if (!gw.props.some(bp => bp.kind === p.kind && bp.x === p.x && bp.y === p.y)) {
        assert.ok(!otherKinds.has(p.kind), `${season}: no ${other} props leak in`);
      }
    }
  }
  const off = clientMap(MAPS['the-gateway'], null);
  assert.equal(off.props.length, MAPS['the-gateway'].props.length, 'off-season: base props only');
});

test('today is inside the Halloween window (ships live)', () => {
  // The build ships 2026-10-21; the calendar must say Halloween
  // with no override anywhere in the live path.
  assert.equal(seasonAt(new Date('2026-10-21T20:00:00-05:00')), 'halloween');
});

test('fish emote is registered with a positive duration', () => {
  assert.ok(Object.hasOwn(EMOTES, 'fish'), 'EMOTES carries fish');
  assert.ok(Number.isFinite(EMOTES.fish) && EMOTES.fish > 0, 'fish duration is positive');
});
