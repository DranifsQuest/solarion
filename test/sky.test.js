'use strict';

/*
 * test/sky.test.js — day/night + weather (X's spec 2026-10-26).
 *
 * Pure-function suite, no server boot: the schedule, the ground
 * curves, the lightning resolution and the map exclusions are all
 * proven here without waiting for 8 PM or a storm. The wire
 * (hello.sky, sky broadcasts, strike messages) is proven by the
 * live-verify sky leg + the hello.sky assertion in test/test.js.
 *
 * Run: node --test test/sky.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SkySystem, skyState, isNightAt, ctParts, typeForCycle, groundLevel,
  markAlpha, pruneMarks, resolveStrikes, pickStrikePoint, isOutdoorMapId,
  OUTDOOR_MAPS, WEATHER_TYPES, EVENT_MS, DECAY_MS, MARK_MS,
} = require('../src/sky');
const { MAPS } = require('../src/maps');

/** A Date whose Chicago wall clock reads y-mo-d h:mi (normal days). */
function ctDate(y, mo, d, h, mi) {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const p = ctParts(new Date(guess));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (asUtc === target) return new Date(guess);
    guess += target - asUtc;
  }
  throw new Error('ctDate did not converge');
}

/** Next even-hour cycle key after key ("YYYY-M-D#H"). */
function nextCycleKey(key) {
  const [d, h] = key.split('#');
  const hour = Number(h);
  if (hour < 22) return `${d}#${hour + 2}`;
  const [y, mo, da] = d.split('-').map(Number);
  const next = new Date(Date.UTC(y, mo - 1, da) + 86400000);
  return `${next.getUTCFullYear()}-${next.getUTCMonth() + 1}-${next.getUTCDate()}#0`;
}

// ------------------------------------------------------------ day/night

test('day/night boundaries are sharp at 08:00 and 20:00 CT', () => {
  assert.equal(isNightAt(ctDate(2026, 10, 27, 7, 59)), true, '07:59 is still night');
  assert.equal(isNightAt(ctDate(2026, 10, 27, 8, 0)), false, '08:00 is day');
  assert.equal(isNightAt(ctDate(2026, 10, 27, 12, 0)), false, 'noon is day');
  assert.equal(isNightAt(ctDate(2026, 10, 27, 19, 59)), false, '19:59 is day');
  assert.equal(isNightAt(ctDate(2026, 10, 27, 20, 0)), true, '20:00 is night');
  assert.equal(isNightAt(ctDate(2026, 10, 27, 0, 0)), true, 'midnight is night');
  assert.equal(isNightAt(ctDate(2026, 10, 27, 3, 30)), true, '03:30 is night');
});

test('skyState reports isNight from the same clock', () => {
  assert.equal(skyState(ctDate(2026, 10, 27, 10, 0)).isNight, false);
  assert.equal(skyState(ctDate(2026, 10, 27, 22, 0)).isNight, true);
});

// ------------------------------------------------------------ scheduler

test('weather events last 20 minutes inside each 2-hour cycle', () => {
  const at = (h, m) => skyState(ctDate(2026, 10, 27, h, m));
  assert.ok(at(14, 0).active, 'event active at cycle start');
  assert.ok(at(14, 19).active, 'event active at minute 19');
  assert.equal(at(14, 20).active, null, 'event over at minute 20');
  assert.equal(at(15, 30).active, null, 'clear mid-cycle');
  assert.ok(at(16, 0).active, 'next cycle has its own event');
  const ev = at(14, 5).active;
  assert.equal(ev.endsAt - ev.startedAt, EVENT_MS, 'event spans exactly 20 minutes');
  assert.ok(WEATHER_TYPES.includes(ev.type), 'event type is a known weather type');
});

test('consecutive cycles never repeat the event type', () => {
  let key = '2026-10-27#0';
  let prev = null;
  for (let i = 0; i < 48; i++) {
    const t = typeForCycle(key);
    assert.ok(WEATHER_TYPES.includes(t), `${key} has a known type`);
    if (prev !== null) assert.notEqual(t, prev, `${key} must differ from the previous cycle`);
    prev = t;
    key = nextCycleKey(key);
  }
});

test('cycle types are deterministic and cover all three weathers', () => {
  assert.equal(typeForCycle('2026-10-27#14'), typeForCycle('2026-10-27#14'), 'same key, same type');
  let key = '2026-10-27#0';
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    seen.add(typeForCycle(key));
    key = nextCycleKey(key);
  }
  assert.deepEqual([...seen].sort(), [...WEATHER_TYPES].sort(), 'all three types appear');
});

test('the clear gap reports the just-ended event as last', () => {
  const gap = skyState(ctDate(2026, 10, 27, 14, 25));
  assert.equal(gap.active, null);
  assert.ok(gap.last, 'gap has a last event');
  assert.equal(gap.last.type, typeForCycle('2026-10-27#14'), 'last is the 14:00 event');
  const ev = skyState(ctDate(2026, 10, 27, 14, 5)).active;
  assert.equal(gap.last.endedAt, ev.endsAt, 'last ends where the event ended');
});

test('adjacent cycles differ: 14:00 vs 16:00 events', () => {
  const a = skyState(ctDate(2026, 10, 27, 14, 5)).active;
  const b = skyState(ctDate(2026, 10, 27, 16, 5)).active;
  assert.notEqual(a.type, b.type, '16:00 event differs from 14:00 event');
});

// ------------------------------------------------------------ ground curves

test('snow coverage grows across the event, then melts away', () => {
  const T = Date.UTC(2026, 9, 27, 19, 0); // 14:00 CDT
  const during = { active: { type: 'snow', startedAt: T, endsAt: T + EVENT_MS }, last: null };
  assert.equal(groundLevel(during, 'snow', T), 0, 'no snow at event start');
  assert.equal(groundLevel(during, 'snow', T + EVENT_MS / 2), 0.5, 'half coverage mid-event');
  assert.equal(groundLevel(during, 'snow', T + EVENT_MS), 1, 'full coverage at event end');
  assert.equal(groundLevel(during, 'rain', T + EVENT_MS / 2), 0, 'rain level stays zero during snow');
  const after = { active: null, last: { type: 'snow', endedAt: T + EVENT_MS } };
  assert.equal(groundLevel(after, 'snow', T + EVENT_MS), 1, 'full right after the event');
  assert.equal(groundLevel(after, 'snow', T + EVENT_MS + DECAY_MS / 2), 0.5, 'half melted mid-decay');
  assert.equal(groundLevel(after, 'snow', T + EVENT_MS + DECAY_MS), 0, 'gone after the melt window');
  assert.equal(groundLevel(after, 'snow', T + EVENT_MS + DECAY_MS + 3600000), 0, 'stays gone');
});

test('rain puddles form and evaporate on the same curve', () => {
  const T = Date.UTC(2026, 9, 27, 19, 0);
  const during = { active: { type: 'rain', startedAt: T, endsAt: T + EVENT_MS }, last: null };
  assert.equal(groundLevel(during, 'rain', T + EVENT_MS / 4), 0.25, 'puddles grow during rain');
  assert.equal(groundLevel(during, 'snow', T + EVENT_MS / 4), 0, 'snow stays zero during rain');
  const after = { active: null, last: { type: 'rain', endedAt: T + EVENT_MS } };
  assert.equal(groundLevel(after, 'rain', T + EVENT_MS + DECAY_MS), 0, 'puddles evaporated');
});

// ------------------------------------------------------------ lightning

test('scorch marks hold, then fade across their final 30s', () => {
  const T = 1000000000000;
  const mark = { until: T + MARK_MS };
  assert.equal(markAlpha(mark, T), 1, 'fresh mark is full');
  assert.equal(markAlpha(mark, T + MARK_MS - 30000), 1, 'still full at fade start');
  assert.equal(markAlpha(mark, T + MARK_MS - 15000), 0.5, 'half faded');
  assert.equal(markAlpha(mark, T + MARK_MS), 0, 'gone at expiry');
  assert.equal(markAlpha(mark, T + MARK_MS + 1000), 0, 'stays gone');
  assert.deepEqual(
    pruneMarks([{ until: T - 1 }, { until: T + 1000 }], T).map(m => m.until),
    [T + 1000],
    'prune drops expired marks only',
  );
});

test('a strike on a character tile reacts that character only', () => {
  const players = [
    { userId: 1, mapId: 'the-gateway', x: 100, y: 100, zcoins: 5000 },
    { userId: 2, mapId: 'the-gateway', x: 500, y: 500, zcoins: 3000 },
    { userId: 3, mapId: 'solstice-bay', x: 100, y: 100, zcoins: 7000 },
  ];
  // (100,100) is tile (3,3) at TILE=32.
  const snap = players.map(p => ({ ...p }));
  assert.deepEqual(resolveStrikes(players, { mapId: 'the-gateway', tx: 3, ty: 3 }), [1], 'only the struck tile reacts');
  assert.deepEqual(resolveStrikes(players, { mapId: 'the-gateway', tx: 0, ty: 0 }), [], 'empty tile reacts nobody');
  assert.deepEqual(resolveStrikes(players, { mapId: 'solstice-bay', tx: 3, ty: 3 }), [3], 'same tile on another map reacts that map only');
  assert.deepEqual(players, snap, 'resolution mutates nothing');
});

test('strike resolution never touches coins or stats (no-damage invariant)', () => {
  const frozen = Object.freeze([
    Object.freeze({ userId: 9, mapId: 'the-gateway', x: 64, y: 64, zcoins: 1234 }),
  ]);
  assert.deepEqual(resolveStrikes(frozen, { mapId: 'the-gateway', tx: 2, ty: 2 }), [9]);
  assert.equal(frozen[0].zcoins, 1234, 'coins untouched by a strike');
});

test('strike points are walkable ground, biased near players', () => {
  const map = MAPS['the-gateway'];
  const player = { userId: 1, mapId: 'the-gateway', x: 1000, y: 1000 };
  // Force the near-player branch, then offsets (0,0) → the player's own tile.
  const seq = [0.1, 0.0, 0.5, 0.5];
  let i = 0;
  const pt = pickStrikePoint(map, [player], () => seq[i++ % seq.length]);
  assert.ok(pt, 'a point is picked');
  assert.equal(pt.tx, Math.floor(1000 / 32), 'near strike lands on the player tile with zero offsets');
  assert.equal(pt.ty, Math.floor(1000 / 32));
  // Force the random branch on a fully solid fake map → null, never an invalid point.
  const solid = { tiles: { w: 2, h: 2, rows: ['##', '##'] } };
  assert.equal(pickStrikePoint(solid, [], () => 0.9), null, 'no walkable ground means no strike');
});

// ------------------------------------------------------------ scope

test('weather + night apply to outdoor maps only', () => {
  for (const id of OUTDOOR_MAPS) assert.equal(isOutdoorMapId(id), true, `${id} is outdoor`);
  for (const id of ['the-threshold', 'elsewhere', 'gateway-cafe', 'casino-lounge', 'neon-casino', 'club-mirage', 'hookah-lounge', 'studio:abc123']) {
    assert.equal(isOutdoorMapId(id), false, `${id} gets no weather or night`);
  }
});

test('SkySystem only strikes populated outdoor maps', () => {
  const sent = [];
  const stub = {
    players: new Map([
      [1, { userId: 1, mapId: 'gateway-cafe', x: 100, y: 100 }],
    ]),
    send: (p, m) => sent.push(['send', p.userId, m.type]),
    broadcastToMap: (id, m) => sent.push(['broadcast', id, m.type]),
  };
  const sky = new SkySystem(stub);
  clearInterval(sky.timer);
  sky.fireStrike(Date.now());
  assert.deepEqual(sent, [], 'no strike when nobody is outdoors');
  stub.players.set(2, { userId: 2, mapId: 'the-gateway', x: 1000, y: 1000 });
  sky.fireStrike(Date.now());
  const strikes = sent.filter(s => s[1] === 'the-gateway' && s[2] === 'lightning');
  assert.equal(strikes.length, 1, 'one strike broadcast to the populated outdoor map');
  assert.ok(sky.marks.get('the-gateway').length >= 1, 'the strike left a mark');
  sky.stop();
});

test('SkySystem broadcasts sky state only on change', () => {
  const sent = [];
  const stub = {
    players: new Map([[1, { userId: 1, mapId: 'the-gateway', x: 0, y: 0 }]]),
    send: (p, m) => sent.push(m),
    broadcastToMap: () => {},
  };
  const sky = new SkySystem(stub);
  clearInterval(sky.timer);
  const d1 = ctDate(2026, 10, 27, 10, 0); // day, clear gap
  sky.tick(d1);
  assert.equal(sent.filter(m => m.type === 'sky').length, 1, 'first tick broadcasts');
  sky.tick(d1);
  assert.equal(sent.filter(m => m.type === 'sky').length, 1, 'unchanged state does not rebroadcast');
  sky.tick(ctDate(2026, 10, 27, 20, 0)); // night flips
  assert.equal(sent.filter(m => m.type === 'sky').length, 2, 'day/night flip rebroadcasts');
  sky.stop();
});
